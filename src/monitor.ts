import type { AgentRunStatus, SubagentActivityEvent, UsageTotals } from "./types.ts";

export type MonitorPhase = "queued" | "running" | "retrying" | Exclude<AgentRunStatus, "running">;

export type MonitorOrigin =
	| { kind: "agent"; parentToolCallId: string }
	| { kind: "swarm"; parentToolCallId: string; groupId: string; memberId: string }
	| { kind: "tower"; parentToolCallId?: string };

export type MonitorActivity = SubagentActivityEvent;

export type MonitorEvent =
	| { type: "reset" }
	| {
			type: "swarm_registered";
			groupId: string;
			parentToolCallId: string;
			description: string;
			profileName: string;
			members: Array<{ memberId: string; index: number; label: string }>;
			at: number;
	  }
	| { type: "swarm_finished"; groupId: string; status: "completed" | "failed" | "aborted" }
	| {
			type: "task_started";
			taskId: string;
			agentId: string;
			description: string;
			profileName: string;
			model: string;
			detached: boolean;
			startedAt: number;
			origin?: MonitorOrigin;
	  }
	| { type: "activity"; taskId: string; activity: MonitorActivity; at: number }
	| {
			type: "task_finished";
			taskId: string;
			status: Exclude<AgentRunStatus, "running">;
			endedAt: number;
			summary?: string;
			error?: string;
			usage?: UsageTotals;
	  };

export interface ActivityView {
	at: number;
	type: MonitorActivity["type"];
	label: string;
	toolCallId?: string;
	isError?: boolean;
}

export interface TaskView {
	taskId: string;
	agentId: string;
	description: string;
	profileName: string;
	model: string;
	detached: boolean;
	startedAt: number;
	endedAt?: number;
	phase: MonitorPhase;
	toolCount: number;
	latestActivity?: string;
	activities: ActivityView[];
	summary?: string;
	error?: string;
	usage?: UsageTotals;
	origin?: MonitorOrigin;
}

export interface SwarmMemberView {
	memberId: string;
	index: number;
	label: string;
	phase: MonitorPhase;
	taskId?: string;
	agentId?: string;
	latestActivity?: string;
	startedAt?: number;
	endedAt?: number;
}

export interface SwarmCounts {
	queued: number;
	running: number;
	retrying: number;
	completed: number;
	failed: number;
}

export interface SwarmView {
	groupId: string;
	parentToolCallId: string;
	description: string;
	profileName: string;
	createdAt: number;
	members: SwarmMemberView[];
	counts: SwarmCounts;
}

export interface MonitorSnapshot {
	revision: number;
	now: number;
	tasks: TaskView[];
	swarms: SwarmView[];
}

interface MutableTask extends TaskView {
	textBuffer: string;
}

interface MutableMember {
	memberId: string;
	index: number;
	label: string;
	phase: MonitorPhase;
	taskId?: string;
}

interface MutableSwarm {
	groupId: string;
	parentToolCallId: string;
	description: string;
	profileName: string;
	createdAt: number;
	members: MutableMember[];
}

const MAX_ACTIVITIES = 20;
const MAX_ACTIVITY_CHARS = 2 * 1024;
const MAX_TEXT_BUFFER_CHARS = 4 * 1024;

export function sanitizeMonitorText(value: string, max = MAX_ACTIVITY_CHARS): string {
	const normalized = value
		.replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, "")
		.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1B[@-_]/g, "")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function valueAtPath(value: unknown, key: string): unknown {
	return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function toolLabel(name: string, args: unknown): string {
	for (const key of ["path", "file_path", "command", "query", "pattern", "url"]) {
		const candidate = valueAtPath(args, key);
		if (typeof candidate === "string" && candidate.trim()) return sanitizeMonitorText(`${name} ${candidate}`, 512);
	}
	return sanitizeMonitorText(name, 512);
}

function resultLabel(name: string, result: unknown, isError: boolean): string {
	const prefix = isError ? `${name} failed` : `${name} done`;
	if (typeof result === "string" && result.trim()) return sanitizeMonitorText(`${prefix}: ${result}`, 512);
	return prefix;
}

function cloneUsage(usage: UsageTotals | undefined): UsageTotals | undefined {
	return usage ? { ...usage } : undefined;
}

function cloneOrigin(origin: MonitorOrigin | undefined): MonitorOrigin | undefined {
	return origin ? { ...origin } : undefined;
}

export function isExecutingPhase(phase: MonitorPhase): boolean {
	return phase === "running" || phase === "retrying";
}

export function isUnsettledPhase(phase: MonitorPhase): boolean {
	return phase === "queued" || isExecutingPhase(phase);
}

export function deriveSwarmPhase(counts: SwarmCounts): MonitorPhase {
	if (counts.retrying > 0) return "retrying";
	if (counts.running > 0) return "running";
	if (counts.queued > 0) return "queued";
	return counts.failed > 0 ? "failed" : "completed";
}

export class MonitorProjection {
	private readonly tasks = new Map<string, MutableTask>();
	private readonly swarms = new Map<string, MutableSwarm>();
	private readonly listeners = new Set<(snapshot: MonitorSnapshot) => void>();
	private revision = 0;

	constructor(private readonly clock: () => number = Date.now) {}

	apply(event: MonitorEvent): void {
		let changed = false;
		if (event.type === "reset") {
			changed = this.tasks.size > 0 || this.swarms.size > 0;
			this.tasks.clear();
			this.swarms.clear();
		} else if (event.type === "swarm_registered") {
			this.swarms.set(event.groupId, {
				groupId: event.groupId,
				parentToolCallId: event.parentToolCallId,
				description: sanitizeMonitorText(event.description),
				profileName: sanitizeMonitorText(event.profileName, 128),
				createdAt: event.at,
				members: event.members.map((member) => ({ ...member, label: sanitizeMonitorText(member.label), phase: "queued" })),
			});
			changed = true;
		} else if (event.type === "swarm_finished") {
			const swarm = this.swarms.get(event.groupId);
			if (swarm) {
				for (const member of swarm.members) {
					if (member.phase === "queued") member.phase = event.status === "completed" ? "failed" : event.status;
				}
				changed = true;
			}
		} else if (event.type === "task_started") {
			const task: MutableTask = {
				taskId: event.taskId,
				agentId: event.agentId,
				description: sanitizeMonitorText(event.description),
				profileName: sanitizeMonitorText(event.profileName, 128),
				model: sanitizeMonitorText(event.model, 256),
				detached: event.detached,
				startedAt: event.startedAt,
				phase: "running",
				toolCount: 0,
				activities: [],
				origin: cloneOrigin(event.origin),
				textBuffer: "",
			};
			this.tasks.set(event.taskId, task);
			const origin = event.origin;
			if (origin?.kind === "swarm") {
				const member = this.swarms.get(origin.groupId)?.members.find((item) => item.memberId === origin.memberId);
				if (member) {
					member.taskId = event.taskId;
					member.phase = "running";
				}
			}
			changed = true;
		} else if (event.type === "activity") {
			const task = this.tasks.get(event.taskId);
			if (task && isExecutingPhase(task.phase)) {
				changed = this.applyActivity(task, event.activity, event.at);
			}
		} else {
			const task = this.tasks.get(event.taskId);
			if (task) {
				task.phase = event.status;
				task.endedAt = event.endedAt;
				task.summary = event.summary ? sanitizeMonitorText(event.summary, 4 * 1024) : undefined;
				task.error = event.error ? sanitizeMonitorText(event.error, 4 * 1024) : undefined;
				task.usage = cloneUsage(event.usage);
				task.latestActivity = task.error ?? task.summary ?? task.latestActivity;
				changed = true;
			}
		}

		if (!changed) return;
		this.revision++;
		const snapshot = this.snapshot();
		for (const listener of this.listeners) listener(snapshot);
	}

	private applyActivity(task: MutableTask, activity: MonitorActivity, at: number): boolean {
		let label = "";
		let isError: boolean | undefined;
		if (activity.type === "text_delta") {
			task.textBuffer = (task.textBuffer + activity.delta).slice(-MAX_TEXT_BUFFER_CHARS);
			label = sanitizeMonitorText(task.textBuffer.split(/\r?\n/).filter(Boolean).at(-1) ?? task.textBuffer);
			if (!label) return false;
			const last = task.activities.at(-1);
			if (last?.type === "text_delta") {
				last.at = at;
				last.label = label;
				task.latestActivity = label;
				return true;
			}
		} else if (activity.type === "thinking") {
			label = "thinking…";
			const last = task.activities.at(-1);
			if (last?.type === "thinking") return false;
		} else if (activity.type === "tool_started") {
			task.toolCount++;
			task.textBuffer = "";
			label = toolLabel(activity.toolName, activity.args);
		} else if (activity.type === "tool_updated") {
			label = toolLabel(activity.toolName, activity.partialResult);
			let matchingIndex = -1;
			for (let index = task.activities.length - 1; index >= 0; index--) {
				const candidate = task.activities[index]!;
				if (candidate.toolCallId === activity.toolCallId && (candidate.type === "tool_started" || candidate.type === "tool_updated")) {
					matchingIndex = index;
					break;
				}
			}
			if (matchingIndex >= 0) {
				const [matching] = task.activities.splice(matchingIndex, 1);
				matching!.type = "tool_updated";
				matching!.at = at;
				matching!.label = label;
				task.activities.push(matching!);
				task.latestActivity = label;
				return true;
			}
		} else if (activity.type === "tool_finished") {
			label = resultLabel(activity.toolName, activity.result, activity.isError);
			isError = activity.isError;
		} else if (activity.type === "retry_started") {
			task.phase = "retrying";
			label = `retry ${activity.attempt}/${activity.maxAttempts}`;
		} else {
			task.phase = activity.success ? "running" : "retrying";
			label = activity.success ? `retry ${activity.attempt} recovered` : sanitizeMonitorText(activity.finalError ?? `retry ${activity.attempt} failed`);
			isError = !activity.success;
		}

		const toolCallId = activity.type === "tool_started" || activity.type === "tool_updated" || activity.type === "tool_finished"
			? activity.toolCallId
			: undefined;
		const entry: ActivityView = {
			at,
			type: activity.type,
			label,
			...(toolCallId === undefined ? {} : { toolCallId }),
			...(isError === undefined ? {} : { isError }),
		};
		task.activities.push(entry);
		if (task.activities.length > MAX_ACTIVITIES) task.activities.splice(0, task.activities.length - MAX_ACTIVITIES);
		task.latestActivity = label;
		return true;
	}

	snapshot(): MonitorSnapshot {
		const tasks: TaskView[] = [...this.tasks.values()].map(({ textBuffer: _textBuffer, ...task }) => ({
			...task,
			activities: task.activities.map((activity) => ({ ...activity })),
			origin: cloneOrigin(task.origin),
			usage: cloneUsage(task.usage),
		}));
		const byTaskId = new Map(tasks.map((task) => [task.taskId, task]));
		const swarms: SwarmView[] = [...this.swarms.values()].map((swarm) => {
			const members = swarm.members.map((member): SwarmMemberView => {
				const task = member.taskId ? byTaskId.get(member.taskId) : undefined;
				return {
					memberId: member.memberId,
					index: member.index,
					label: member.label,
					phase: task?.phase ?? member.phase,
					taskId: member.taskId,
					agentId: task?.agentId,
					latestActivity: task?.latestActivity,
					startedAt: task?.startedAt,
					endedAt: task?.endedAt,
				};
			});
			const counts: SwarmCounts = { queued: 0, running: 0, retrying: 0, completed: 0, failed: 0 };
			for (const member of members) {
				if (member.phase === "queued") counts.queued++;
				else if (member.phase === "running") counts.running++;
				else if (member.phase === "retrying") counts.retrying++;
				else if (member.phase === "completed") counts.completed++;
				else counts.failed++;
			}
			return { ...swarm, members, counts };
		});
		return { revision: this.revision, now: this.clock(), tasks, swarms };
	}

	subscribe(listener: (snapshot: MonitorSnapshot) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

export function monitorEventTime(value: string | undefined, fallback = Date.now()): number {
	if (!value) return fallback;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}
