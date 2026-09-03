import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import {
	deriveSwarmPhase,
	isExecutingPhase,
	sanitizeMonitorText,
	type MonitorPhase,
	type MonitorSnapshot,
	type SwarmView,
	type TaskView,
} from "./monitor.ts";
import type { TuiConfig } from "./types.ts";

export interface MonitorRow {
	id: string;
	kind: "agent" | "swarm";
	startedAt: number;
	text: string;
	phase: MonitorPhase;
}

export const sanitizeDisplayText = sanitizeMonitorText;

function elapsed(startedAt: number, now: number, endedAt?: number): string {
	const seconds = Math.max(0, Math.round(((endedAt ?? now) - startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	if (minutes < 60) return rest ? `${minutes}m${rest}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m`;
}

function phaseGlyph(phase: MonitorPhase, theme: Theme): string {
	if (phase === "retrying") return theme.fg("warning", "↻");
	if (phase === "running") return theme.fg("accent", "●");
	if (phase === "queued") return theme.fg("muted", "○");
	if (phase === "completed") return theme.fg("success", "✓");
	if (phase === "aborted") return theme.fg("muted", "■");
	return theme.fg("error", "✗");
}

function agentRow(task: TaskView, snapshot: MonitorSnapshot, theme: Theme): MonitorRow {
	const activity = task.latestActivity ? ` · ${task.latestActivity}` : "";
	return {
		id: task.taskId,
		kind: "agent",
		startedAt: task.startedAt,
		phase: task.phase,
		text: `${phaseGlyph(task.phase, theme)} ${theme.fg("accent", task.profileName)}  ${task.description}${activity} · ${elapsed(task.startedAt, snapshot.now, task.endedAt)}`,
	};
}

function swarmRow(swarm: SwarmView, snapshot: MonitorSnapshot, theme: Theme): MonitorRow {
	const phase = deriveSwarmPhase(swarm.counts);
	const done = swarm.counts.completed + swarm.counts.failed;
	const status = [
		swarm.counts.running ? `${swarm.counts.running} running` : "",
		swarm.counts.retrying ? `${swarm.counts.retrying} retrying` : "",
		swarm.counts.queued ? `${swarm.counts.queued} queued` : "",
		`${done}/${swarm.members.length} done`,
	]
		.filter(Boolean)
		.join(" · ");
	const latestEnd = Math.max(0, ...swarm.members.map((member) => member.endedAt ?? 0));
	return {
		id: swarm.groupId,
		kind: "swarm",
		startedAt: swarm.createdAt,
		phase,
		text: `${phaseGlyph(phase, theme)} ${theme.fg("accent", "Swarm")}  ${swarm.description} · ${status} · ${elapsed(swarm.createdAt, snapshot.now, latestEnd || undefined)}`,
	};
}

export function selectMonitorRows(snapshot: MonitorSnapshot, config: TuiConfig, theme: Theme): MonitorRow[] {
	const tasksById = new Map(snapshot.tasks.map((task) => [task.taskId, task]));
	const standalone = snapshot.tasks.filter((task) => {
		if (!isExecutingPhase(task.phase)) return false;
		if (task.origin?.kind === "swarm") return false;
		if (config.taskScope === "background" && !task.detached) return false;
		return true;
	});
	const swarms = snapshot.swarms.filter((swarm) => {
		if (config.taskScope === "background") {
			return swarm.members.some((member) => member.taskId && tasksById.get(member.taskId)?.detached);
		}
		return swarm.members.some((member) => member.phase === "queued" || isExecutingPhase(member.phase));
	});
	return [
		...standalone.map((task) => agentRow(task, snapshot, theme)),
		...swarms.map((swarm) => swarmRow(swarm, snapshot, theme)),
	].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
}

export function renderTaskWidget(snapshot: MonitorSnapshot, config: TuiConfig, theme: Theme, width: number): string[] {
	if (config.mode !== "compact") return [];
	const rows = selectMonitorRows(snapshot, config, theme);
	if (rows.length === 0) return [];
	const includedTasks = snapshot.tasks.filter(
		(task) => isExecutingPhase(task.phase) && (config.taskScope === "all" || task.detached),
	);
	const active = includedTasks.length;
	const queued = config.taskScope === "all"
		? snapshot.swarms.reduce((total, swarm) => total + swarm.counts.queued, 0)
		: 0;
	const hidden = Math.max(0, rows.length - config.maxVisibleTasks);
	const stats = [
		`${active} active`,
		queued ? `${queued} queued` : "",
		hidden ? `+${hidden} hidden` : "",
		"/tasks",
	]
		.filter(Boolean)
		.join(" · ");
	const lines = [`${theme.bold("Subagents")}  ${stats}`, ...rows.slice(0, config.maxVisibleTasks).map((row) => row.text)];
	return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
}

export function selectAgentToolView(snapshot: MonitorSnapshot, parentToolCallId: string): TaskView | undefined {
	return snapshot.tasks.find(
		(task) => task.origin?.kind !== "swarm" && task.origin?.parentToolCallId === parentToolCallId,
	);
}

export function selectSwarmToolView(snapshot: MonitorSnapshot, parentToolCallId: string): SwarmView | undefined {
	return snapshot.swarms.find((swarm) => swarm.parentToolCallId === parentToolCallId);
}

function toolWord(count: number): string {
	return `${count} ${count === 1 ? "tool" : "tools"}`;
}

function tokenText(task: TaskView): string {
	const tokens = task.usage?.contextTokens ?? 0;
	if (!tokens) return "";
	if (tokens < 1_000) return `${tokens} tokens`;
	return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k tokens`;
}

export function renderAgentStatus(
	task: TaskView | undefined,
	expanded: boolean,
	now: number,
	theme: Theme,
	width: number,
): string[] {
	if (!task) return [truncateToWidth(`${phaseGlyph("queued", theme)} queued`, width)];
	if (task.detached && isExecutingPhase(task.phase)) {
		return [
			truncateToWidth(`${theme.fg("accent", "↗")} background · ${task.taskId} · monitor in /tasks`, width),
		];
	}
	const stats = [task.phase, elapsed(task.startedAt, now, task.endedAt), toolWord(task.toolCount), tokenText(task)]
		.filter(Boolean)
		.join(" · ");
	const first = `${phaseGlyph(task.phase, theme)} ${stats}`;
	const current = task.error ?? task.summary ?? task.latestActivity ?? "waiting for activity…";
	if (!expanded) return [first, `  ${current}`].map((line) => truncateToWidth(line, width));
	const activity = task.activities.slice(-20).map((entry) => `  ${entry.isError ? "✗" : "·"} ${entry.label}`);
	return [first, ...(activity.length > 0 ? activity : [`  ${current}`])].map((line) => truncateToWidth(line, width));
}

export function renderSwarmStatus(
	swarm: SwarmView | undefined,
	expanded: boolean,
	now: number,
	theme: Theme,
	width: number,
): string[] {
	if (!swarm) return [truncateToWidth(`${phaseGlyph("queued", theme)} preparing members…`, width)];
	const phase = deriveSwarmPhase(swarm.counts);
	const done = swarm.counts.completed + swarm.counts.failed;
	const stats = [
		swarm.counts.running ? `${swarm.counts.running} running` : "",
		swarm.counts.retrying ? `${swarm.counts.retrying} retrying` : "",
		swarm.counts.queued ? `${swarm.counts.queued} queued` : "",
		`${done}/${swarm.members.length} done`,
		elapsed(swarm.createdAt, now, Math.max(0, ...swarm.members.map((member) => member.endedAt ?? 0)) || undefined),
	]
		.filter(Boolean)
		.join(" · ");
	const first = `${phaseGlyph(phase, theme)} ${stats}`;
	if (!expanded) {
		const active = swarm.members.find((member) => member.phase === "retrying" || member.phase === "running")
			?? swarm.members.find((member) => member.phase === "queued")
			?? swarm.members.at(-1);
		const label = active
			? `  ${active.phase === "queued" ? "queued" : "active"}: #${active.index} ${active.label}${active.latestActivity ? ` · ${active.latestActivity}` : ""}`
			: "  no members";
		return [first, label].map((line) => truncateToWidth(line, width));
	}
	const rank = (member: SwarmView["members"][number]) => {
		if (member.phase === "retrying") return 0;
		if (member.phase === "running") return 1;
		if (member.phase === "failed" || member.phase === "timed_out" || member.phase === "lost") return 2;
		if (member.phase === "queued") return 3;
		return 4;
	};
	const members = [...swarm.members]
		.sort((a, b) => rank(a) - rank(b) || a.index - b.index)
		.slice(0, 20)
		.map((member) => `  ${phaseGlyph(member.phase, theme)} #${member.index} ${member.label}${member.latestActivity ? ` · ${member.latestActivity}` : ""}`);
	if (swarm.members.length > members.length) members.push(`  … +${swarm.members.length - members.length} members · /tasks`);
	return [first, ...members].map((line) => truncateToWidth(line, width));
}

export function formatElapsed(startedAt: number, now: number, endedAt?: number): string {
	return elapsed(startedAt, now, endedAt);
}

export function monitorPhaseGlyph(phase: MonitorPhase, theme: Theme): string {
	return phaseGlyph(phase, theme);
}

class LinesComponent implements Component {
	constructor(private readonly lines: (width: number) => string[]) {}
	render(width: number): string[] {
		return this.lines(width);
	}
	invalidate(): void {}
}

export function agentStatusComponent(task: TaskView | undefined, expanded: boolean, theme: Theme): Component {
	return new LinesComponent((width) => renderAgentStatus(task, expanded, Date.now(), theme, width));
}

export function swarmStatusComponent(swarm: SwarmView | undefined, expanded: boolean, theme: Theme): Component {
	return new LinesComponent((width) => renderSwarmStatus(swarm, expanded, Date.now(), theme, width));
}

export function singleLineComponent(line: string): Component {
	return new LinesComponent((width) => [truncateToWidth(line, Math.max(1, width))]);
}
