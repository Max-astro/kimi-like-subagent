import { describe, expect, it } from "vitest";
import { FleetScheduler } from "../src/scheduler.ts";

describe("FleetScheduler", () => {
	it("launches the initial batch together and paces later starts", async () => {
		const starts: number[] = [];
		const scheduler = new FleetScheduler({ initialLaunchLimit: 2, launchIntervalMs: 35 });
		const result = await scheduler.run(
			[0, 1, 2].map((value) => ({
				async run() {
					starts.push(Date.now());
					return value;
				},
			})),
		);

		expect(result).toEqual([0, 1, 2]);
		expect(starts[1] - starts[0]).toBeLessThan(20);
		expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(25);
	});

	it("honors an explicitly configured concurrency limit", async () => {
		let active = 0;
		let peak = 0;
		const scheduler = new FleetScheduler({ initialLaunchLimit: 5, launchIntervalMs: 0, maxConcurrency: 2 });
		await scheduler.run(
			[0, 1, 2, 3].map(() => ({
				async run() {
					active++;
					peak = Math.max(peak, active);
					await new Promise((resolve) => setTimeout(resolve, 10));
					active--;
					return true;
				},
			})),
		);
		expect(peak).toBe(2);
	});

	it("does not launch queued work after one member fails", async () => {
		const started: number[] = [];
		const scheduler = new FleetScheduler({ initialLaunchLimit: 1, launchIntervalMs: 1, maxConcurrency: 1 });
		await expect(
			scheduler.run(
				[0, 1, 2].map((value) => ({
					async run() {
						started.push(value);
						if (value === 0) throw new Error("boom");
						return value;
					},
				})),
			),
		).rejects.toThrow("boom");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(started).toEqual([0]);
	});
});
