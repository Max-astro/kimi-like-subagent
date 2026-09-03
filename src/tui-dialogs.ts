import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Focusable, matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { AgentService } from "./agent-service.ts";
import { deriveSwarmPhase, isUnsettledPhase, type MonitorPhase, type MonitorSnapshot, type SwarmView, type TaskView } from "./monitor.ts";
import { formatElapsed, monitorPhaseGlyph, sanitizeDisplayText } from "./tui.ts";
import type { TuiConfig } from "./types.ts";

function padVisible(value: string, width: number): string {
	return `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
}

function frame(theme: Theme, width: number, title: string, body: string[]): string[] {
	const w = Math.max(4, width);
	const inner = Math.max(1, w - 2);
	const topTitle = truncateToWidth(`─ ${title} `, inner);
	const top = `╭${topTitle}${"─".repeat(Math.max(0, inner - visibleWidth(topTitle)))}╮`;
	const row = (content: string) => {
		const clipped = truncateToWidth(content, Math.max(1, inner - 2));
		return `${theme.fg("border", "│")} ${clipped}${" ".repeat(Math.max(0, inner - 2 - visibleWidth(clipped)))} ${theme.fg("border", "│")}`;
	};
	return [theme.fg("border", top), ...body.map(row), theme.fg("border", `╰${"─".repeat(inner)}╯`)];
}

interface SettingDescriptor {
	label: string;
	value(config: TuiConfig): string;
	next(config: TuiConfig, direction: 1 | -1): TuiConfig;
}

const SETTINGS: SettingDescriptor[] = [
	{
		label: "Display mode",
		value: (config) => config.mode,
		next: (config) => ({ ...config, mode: config.mode === "compact" ? "minimal" : "compact" }),
	},
	{
		label: "Task scope",
		value: (config) => config.taskScope,
		next: (config) => ({ ...config, taskScope: config.taskScope === "all" ? "background" : "all" }),
	},
	{
		label: "Visible task rows",
		value: (config) => String(config.maxVisibleTasks),
		next: (config, direction) => ({
			...config,
			maxVisibleTasks: ((config.maxVisibleTasks - 1 + direction + 4) % 4) + 1,
		}),
	},
];

export class SubagentSettingsView implements Focusable {
	readonly width = 58;
	focused = false;
	private cursor = 0;
	private value: TuiConfig;

	constructor(
		initial: TuiConfig,
		private readonly theme: Theme,
		private readonly save: (next: TuiConfig) => boolean,
		private readonly done: () => void,
	) {
		this.value = { ...initial };
	}

	private cycle(direction: 1 | -1): void {
		const next = SETTINGS[this.cursor]!.next(this.value, direction);
		if (this.save(next)) this.value = next;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q" || data === "Q") this.done();
		else if (matchesKey(data, "up") || data === "k") this.cursor = Math.max(0, this.cursor - 1);
		else if (matchesKey(data, "down") || data === "j") this.cursor = Math.min(SETTINGS.length - 1, this.cursor + 1);
		else if (matchesKey(data, "left")) this.cycle(-1);
		else if (matchesKey(data, "right") || matchesKey(data, "return") || data === " ") this.cycle(1);
	}

	render(width: number): string[] {
		const body = SETTINGS.map((setting, index) => {
			const prefix = index === this.cursor ? this.theme.fg("accent", ">") : " ";
			const renderedLabel = index === this.cursor ? this.theme.fg("accent", setting.label) : setting.label;
			return `${prefix} ${padVisible(renderedLabel, 20)} ${this.theme.fg("muted", setting.value(this.value))}`;
		});
		body.push("", this.theme.fg("dim", "↑↓ select · Enter change · Esc close"), this.theme.fg("dim", "Changes save instantly"));
		return frame(this.theme, Math.max(4, Math.min(this.width, width)), "Subagent Settings", body);
	}

	invalidate(): void {}
}

export interface TaskBrowserEntry {
	id: string;
	kind: "agent" | "swarm";
	phase: MonitorPhase;
	startedAt: number;
	endedAt?: number;
	label: string;
	task?: TaskView;
	swarm?: SwarmView;
}

export function selectTaskBrowserEntries(snapshot: MonitorSnapshot, config: TuiConfig, activeOnly: boolean): TaskBrowserEntry[] {
	const scoped = (task: TaskView) => config.taskScope === "all" || task.detached;
	const standalone = snapshot.tasks
		.filter((task) => task.origin?.kind !== "swarm" && scoped(task) && (!activeOnly || isUnsettledPhase(task.phase)))
		.map((task): TaskBrowserEntry => ({
			id: task.taskId,
			kind: "agent",
			phase: task.phase,
			startedAt: task.startedAt,
			endedAt: task.endedAt,
			label: `${task.profileName}  ${task.description}`,
			task,
		}));
	const byTask = new Map(snapshot.tasks.map((task) => [task.taskId, task]));
	const swarms = snapshot.swarms
		.filter((swarm) => {
			const members = swarm.members.filter((member) => {
				const task = member.taskId ? byTask.get(member.taskId) : undefined;
				return config.taskScope === "all" || task?.detached;
			});
			return members.length > 0 && (!activeOnly || members.some((member) => isUnsettledPhase(member.phase)));
		})
		.map((swarm): TaskBrowserEntry => ({
			id: swarm.groupId,
			kind: "swarm",
			phase: deriveSwarmPhase(swarm.counts),
			startedAt: swarm.createdAt,
			endedAt: Math.max(0, ...swarm.members.map((member) => member.endedAt ?? 0)) || undefined,
			label: `Swarm  ${swarm.description}`,
			swarm,
		}));
	const entries = [...standalone, ...swarms];
	const activeEntries = entries.filter((entry) => isUnsettledPhase(entry.phase)).sort((a, b) => a.startedAt - b.startedAt);
	if (activeOnly) return activeEntries;
	const recent = entries
		.filter((entry) => !isUnsettledPhase(entry.phase))
		.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
		.slice(0, 20);
	return [...activeEntries, ...recent];
}

type BrowserPage = { type: "list" } | { type: "swarm"; groupId: string } | { type: "task"; taskId: string; parentGroupId?: string };

export class TasksBrowserView implements Focusable {
	readonly width = 64;
	focused = false;
	private snapshot: MonitorSnapshot;
	private page: BrowserPage = { type: "list" };
	private cursor = 0;
	private scroll = 0;
	private activeOnly = true;
	private confirming = false;
	private stopping = false;
	private readonly unsubscribe: () => void;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly service: AgentService,
		private readonly config: () => TuiConfig,
		private readonly done: () => void,
		private readonly notify: (message: string, type?: "info" | "warning" | "error") => void,
	) {
		this.snapshot = service.monitor.snapshot();
		if (selectTaskBrowserEntries(this.snapshot, config(), true).length === 0) this.activeOnly = false;
		this.unsubscribe = service.monitor.subscribe((snapshot) => {
			this.snapshot = snapshot;
			this.clampCursor();
			this.tui.requestRender();
		});
	}

	private entries(): TaskBrowserEntry[] {
		return selectTaskBrowserEntries(this.snapshot, this.config(), this.activeOnly);
	}

	private currentEntry(): TaskBrowserEntry | undefined {
		return this.entries()[this.cursor];
	}

	private currentSwarm(): SwarmView | undefined {
		const page = this.page;
		return page.type === "swarm" ? this.snapshot.swarms.find((swarm) => swarm.groupId === page.groupId) : undefined;
	}

	private currentTask(): TaskView | undefined {
		const page = this.page;
		return page.type === "task" ? this.snapshot.tasks.find((task) => task.taskId === page.taskId) : undefined;
	}

	private clampCursor(): void {
		const length = this.page.type === "list" ? this.entries().length : this.page.type === "swarm" ? this.currentSwarm()?.members.length ?? 0 : 1;
		this.cursor = Math.max(0, Math.min(this.cursor, Math.max(0, length - 1)));
	}

	private goBack(): void {
		if (this.page.type === "task" && this.page.parentGroupId) this.page = { type: "swarm", groupId: this.page.parentGroupId };
		else if (this.page.type !== "list") this.page = { type: "list" };
		else this.done();
		this.cursor = 0;
		this.scroll = 0;
		this.confirming = false;
	}

	private openSelected(): void {
		if (this.page.type === "list") {
			const entry = this.currentEntry();
			if (!entry) return;
			this.page = entry.kind === "swarm" ? { type: "swarm", groupId: entry.id } : { type: "task", taskId: entry.id };
			this.cursor = 0;
			this.scroll = 0;
			return;
		}
		if (this.page.type === "swarm") {
			const member = this.currentSwarm()?.members[this.cursor];
			if (member?.taskId) {
				this.page = { type: "task", taskId: member.taskId, parentGroupId: this.page.groupId };
				this.scroll = 0;
			}
		}
	}

	private stopCurrent(): void {
		const task = this.currentTask();
		if (!task || !isUnsettledPhase(task.phase) || task.phase === "queued") return;
		this.confirming = true;
	}

	private confirmStop(): void {
		const task = this.currentTask();
		if (!task || this.stopping) return;
		this.confirming = false;
		this.stopping = true;
		void this.service.stopTask(task.taskId, "Stopped from /tasks").then(
			() => this.notify(`Stop requested for ${task.description}`, "info"),
			(error) => this.notify(error instanceof Error ? error.message : String(error), "error"),
		).finally(() => {
			this.stopping = false;
			this.tui.requestRender();
		});
	}

	handleInput(data: string): void {
		if (this.confirming) {
			if (data === "y" || data === "Y") this.confirmStop();
			else if (data === "n" || data === "N" || matchesKey(data, "escape")) this.confirming = false;
			return;
		}
		if (data === "q" || data === "Q") return this.done();
		if (matchesKey(data, "escape")) return this.goBack();
		if (this.page.type === "list" && matchesKey(data, "tab")) {
			this.activeOnly = !this.activeOnly;
			this.cursor = 0;
			return;
		}
		if (this.page.type === "task") {
			if (data === "s" || data === "S") return this.stopCurrent();
			if (matchesKey(data, "up") || data === "k") this.scroll = Math.max(0, this.scroll - 1);
			else if (matchesKey(data, "down") || data === "j") this.scroll++;
			return;
		}
		const length = this.page.type === "list" ? this.entries().length : this.currentSwarm()?.members.length ?? 0;
		if (matchesKey(data, "up") || data === "k") this.cursor = Math.max(0, this.cursor - 1);
		else if (matchesKey(data, "down") || data === "j") this.cursor = Math.min(Math.max(0, length - 1), this.cursor + 1);
		else if (matchesKey(data, "return")) this.openSelected();
	}

	private renderList(width: number): string[] {
		const entries = this.entries();
		const start = Math.max(0, Math.min(this.cursor - 6, Math.max(0, entries.length - 8)));
		const body = entries.slice(start, start + 8).map((entry, offset) => {
			const selected = start + offset === this.cursor;
			const prefix = selected ? this.theme.fg("accent", ">") : " ";
			let suffix = formatElapsed(entry.startedAt, this.snapshot.now, entry.endedAt);
			if (entry.swarm) {
				const done = entry.swarm.counts.completed + entry.swarm.counts.failed;
				suffix = `${entry.swarm.counts.running} running · ${done}/${entry.swarm.members.length} done · ${suffix}`;
			}
			return `${prefix} ${monitorPhaseGlyph(entry.phase, this.theme)} ${entry.label}  ${this.theme.fg("dim", suffix)}`;
		});
		if (body.length === 0) body.push(this.theme.fg("muted", "  No tasks in this view"));
		while (body.length < 8) body.push("");
		body.push(this.theme.fg("dim", "↑↓ select · Enter details · Tab active/all · Esc"));
		return frame(this.theme, width, `Subagents · ${this.activeOnly ? "Active" : "All"}`, body);
	}

	private renderSwarm(swarm: SwarmView | undefined, width: number): string[] {
		if (!swarm) return frame(this.theme, width, "Swarm", [this.theme.fg("error", "Swarm is no longer available"), "", "Esc back"]);
		const start = Math.max(0, Math.min(this.cursor - 6, Math.max(0, swarm.members.length - 8)));
		const body = swarm.members.slice(start, start + 8).map((member, offset) => {
			const selected = start + offset === this.cursor;
			const prefix = selected ? this.theme.fg("accent", ">") : " ";
			return `${prefix} ${monitorPhaseGlyph(member.phase, this.theme)} #${member.index} ${member.label}${member.latestActivity ? ` · ${member.latestActivity}` : ""}`;
		});
		while (body.length < 8) body.push("");
		body.push(this.theme.fg("dim", "↑↓ select · Enter member · Esc back"));
		return frame(this.theme, width, `Swarm · ${swarm.description}`, body);
	}

	private renderTask(task: TaskView | undefined, width: number): string[] {
		if (!task) return frame(this.theme, width, "Task", [this.theme.fg("error", "Task is no longer available"), "", "Esc back"]);
		const mode = task.detached ? "background" : "foreground";
		const meta = `${monitorPhaseGlyph(task.phase, this.theme)} ${task.phase} · ${mode} · ${task.profileName} · ${formatElapsed(task.startedAt, this.snapshot.now, task.endedAt)}`;
		const activity = task.activities.map((item) => `${new Date(item.at).toLocaleTimeString()}  ${item.label}`);
		const output = task.summary ?? task.error ?? this.service.state.getTask(task.taskId)?.outputPreview ?? "";
		const outputLines = output
			.split(/\r?\n/)
			.map((line) => sanitizeDisplayText(line))
			.filter(Boolean)
			.slice(-4)
			.map((line) => `output  ${line}`);
		const scrollable = [...activity, ...outputLines];
		const maxScroll = Math.max(0, scrollable.length - 6);
		this.scroll = Math.min(this.scroll, maxScroll);
		const body = [meta, task.description, "", ...scrollable.slice(this.scroll, this.scroll + 6)];
		while (body.length < 9) body.push("");
		if (this.confirming) body.push(this.theme.fg("warning", `Stop “${task.description}”?  Y confirm · N cancel`));
		else body.push(this.theme.fg("dim", `${isUnsettledPhase(task.phase) ? "S stop · " : ""}↑↓ scroll · Esc back · Q close`));
		return frame(this.theme, width, `Task · ${task.taskId}`, body);
	}

	render(width: number): string[] {
		const renderWidth = Math.max(4, Math.min(this.width, width));
		const rendered = this.page.type === "list"
			? this.renderList(renderWidth)
			: this.page.type === "swarm"
				? this.renderSwarm(this.currentSwarm(), renderWidth)
				: this.renderTask(this.currentTask(), renderWidth);
		return rendered;
	}

	invalidate(): void {}
	dispose(): void {
		this.unsubscribe();
	}
}
