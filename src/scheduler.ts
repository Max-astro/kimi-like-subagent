export interface SchedulerOptions {
	initialLaunchLimit: number;
	launchIntervalMs: number;
	maxConcurrency?: number;
	rateLimitPauseMs?: number;
	recoveryIntervalMs?: number;
}

export interface ScheduledWork<T> {
	run(onRateLimit: (message: string) => void): Promise<T>;
}

export class FleetScheduler {
	private active = 0;
	private launched = 0;
	private rateLimitUntil = 0;
	private adaptiveCapacity = Number.POSITIVE_INFINITY;
	private lastRecovery = 0;

	constructor(private readonly options: SchedulerOptions) {}

	noteRateLimit(): void {
		const now = Date.now();
		this.rateLimitUntil = Math.max(this.rateLimitUntil, now + (this.options.rateLimitPauseMs ?? 3000));
		const currentCapacity = Number.isFinite(this.adaptiveCapacity)
			? this.adaptiveCapacity
			: Math.max(1, this.active);
		this.adaptiveCapacity = Math.max(1, Math.floor(currentCapacity / 2));
		this.lastRecovery = now;
	}

	private capacity(): number {
		const configured = this.options.maxConcurrency ?? Number.POSITIVE_INFINITY;
		if (Number.isFinite(this.adaptiveCapacity)) {
			const interval = this.options.recoveryIntervalMs ?? 3 * 60 * 1000;
			const elapsed = Date.now() - this.lastRecovery;
			if (elapsed >= interval) {
				const steps = Math.floor(elapsed / interval);
				this.adaptiveCapacity += steps;
				this.lastRecovery += steps * interval;
			}
		}
		return Math.min(configured, this.adaptiveCapacity);
	}

	async run<T>(work: ScheduledWork<T>[], signal?: AbortSignal): Promise<T[]> {
		if (work.length === 0) return [];
		this.active = 0;
		this.launched = 0;
		this.rateLimitUntil = 0;
		this.adaptiveCapacity = Number.POSITIVE_INFINITY;
		this.lastRecovery = 0;
		const results = new Array<T>(work.length);
		let nextIndex = 0;
		let completed = 0;
		let nextLaunchAt = Date.now();

		return new Promise<T[]>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			let settled = false;
			const cleanup = () => {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			};
			const onAbort = () => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(signal?.reason ?? new Error("Swarm aborted"));
			};
			const schedule = () => {
				if (settled) return;
				if (signal?.aborted) return onAbort();
				if (completed === work.length) {
					settled = true;
					cleanup();
					resolve(results);
					return;
				}
				const now = Date.now();
				const cap = this.capacity();
				let started = false;
				while (nextIndex < work.length && this.active < cap) {
					const gatedAt = Math.max(this.rateLimitUntil, nextLaunchAt);
					if (now < gatedAt) break;
					const index = nextIndex++;
					this.active++;
					this.launched++;
					started = true;
					if (this.launched >= this.options.initialLaunchLimit) {
						nextLaunchAt = Date.now() + this.options.launchIntervalMs;
					}
					void work[index]
						.run(() => this.noteRateLimit())
						.then((result) => {
							results[index] = result;
						})
						.catch((error) => {
							if (settled) return;
							settled = true;
							cleanup();
							reject(error);
						})
						.finally(() => {
							this.active--;
							completed++;
							schedule();
						});
					if (this.launched >= this.options.initialLaunchLimit) break;
				}
				if (completed < work.length && nextIndex < work.length && this.active < this.capacity()) {
					const delay = Math.max(1, Math.min(1000, Math.max(this.rateLimitUntil, nextLaunchAt) - Date.now()));
					if (timer) clearTimeout(timer);
					timer = setTimeout(schedule, delay);
				}
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			schedule();
		});
	}
}
