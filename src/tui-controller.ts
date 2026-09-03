import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, type Component, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import type { AgentService } from "./agent-service.ts";
import { CONFIG_PATH, saveTuiConfig } from "./config.ts";
import { isExecutingPhase, type MonitorProjection, type MonitorSnapshot, type TaskView } from "./monitor.ts";
import type { PluginConfig, TuiConfig } from "./types.ts";
import { renderTaskWidget, sanitizeDisplayText, selectMonitorRows } from "./tui.ts";
import { SubagentSettingsView, TasksBrowserView } from "./tui-dialogs.ts";

export const TASK_WIDGET_KEY = "kimi-like-subagent:tasks";

class TaskWidget implements Component {
	constructor(
		private readonly monitor: MonitorProjection,
		private readonly config: () => TuiConfig,
		private readonly theme: ExtensionContext["ui"]["theme"],
	) {}

	render(width: number): string[] {
		return renderTaskWidget(this.monitor.snapshot(), this.config(), this.theme, width);
	}

	invalidate(): void {}
}

class StaticLines implements Component {
	constructor(private readonly lines: string[]) {}
	render(width: number): string[] {
		return this.lines.map((line) => truncateToWidth(line, Math.max(1, width)));
	}
	invalidate(): void {}
}

export class SubagentUiController {
	private ctx?: ExtensionContext;
	private unsubscribe?: () => void;
	private widgetRegistered = false;
	private widgetTui?: TUI;
	private ticker?: ReturnType<typeof setInterval>;
	private pendingRefresh?: ReturnType<typeof setTimeout>;
	private latestSnapshot?: MonitorSnapshot;
	private lastStructure = "";
	private lastRefreshAt = 0;

	constructor(
		private readonly monitor: MonitorProjection,
		private readonly config: PluginConfig,
	) {}

	attach(ctx: ExtensionContext): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		if (this.pendingRefresh) clearTimeout(this.pendingRefresh);
		this.pendingRefresh = undefined;
		this.stopTicker();
		this.ctx = ctx;
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		this.unsubscribe = this.monitor.subscribe((snapshot) => this.scheduleSurface(snapshot));
		this.ensureWidget(ctx);
		this.updateSurface(this.monitor.snapshot());
	}

	applyTuiConfig(config: TuiConfig): void {
		this.config.tui = { ...config };
		this.updateSurface(this.monitor.snapshot());
	}

	private structure(snapshot: MonitorSnapshot): string {
		return JSON.stringify({
			tasks: snapshot.tasks.map((task) => [task.taskId, task.phase, task.toolCount, task.detached]),
			swarms: snapshot.swarms.map((swarm) => [swarm.groupId, swarm.counts]),
		});
	}

	private scheduleSurface(snapshot: MonitorSnapshot): void {
		this.latestSnapshot = snapshot;
		const structure = this.structure(snapshot);
		if (structure !== this.lastStructure || Date.now() - this.lastRefreshAt >= 200) {
			if (this.pendingRefresh) clearTimeout(this.pendingRefresh);
			this.pendingRefresh = undefined;
			this.updateSurface(snapshot);
			return;
		}
		if (!this.pendingRefresh) {
			this.pendingRefresh = setTimeout(() => {
				this.pendingRefresh = undefined;
				this.updateSurface(this.latestSnapshot ?? this.monitor.snapshot());
			}, Math.max(1, 200 - (Date.now() - this.lastRefreshAt)));
			this.pendingRefresh.unref?.();
		}
	}

	private updateSurface(snapshot: MonitorSnapshot): void {
		this.lastRefreshAt = Date.now();
		this.lastStructure = this.structure(snapshot);
		const ctx = this.ctx;
		if (!ctx?.hasUI || ctx.mode !== "tui") return;
		const activeTasks = snapshot.tasks.filter(
			(task) =>
				isExecutingPhase(task.phase) &&
				(this.config.tui.taskScope === "all" || task.detached),
		);
		if (this.config.tui.mode === "minimal") {
			this.widgetTui?.requestRender();
			const count = activeTasks.length;
			ctx.ui.setStatus(
				TASK_WIDGET_KEY,
				count > 0
					? ctx.ui.theme.fg("accent", `● ${count} ${count === 1 ? "subagent" : "subagents"} active · /tasks`)
					: undefined,
			);
			this.stopTicker();
			return;
		}

		ctx.ui.setStatus(TASK_WIDGET_KEY, undefined);
		const hasRows = selectMonitorRows(snapshot, this.config.tui, ctx.ui.theme).length > 0;
		if (!hasRows) {
			this.widgetTui?.requestRender();
			this.stopTicker();
			return;
		}
		this.widgetTui?.requestRender();
		this.startTicker();
	}

	private ensureWidget(ctx: ExtensionContext): void {
		if (this.widgetRegistered) return;
		ctx.ui.setWidget(
			TASK_WIDGET_KEY,
			(tui, theme) => {
				this.widgetTui = tui;
				return new TaskWidget(this.monitor, () => this.config.tui, theme);
			},
			{ placement: "aboveEditor" },
		);
		this.widgetRegistered = true;
	}

	private removeWidget(): void {
		if (!this.widgetRegistered) return;
		this.ctx?.ui.setWidget(TASK_WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.widgetTui = undefined;
	}

	private clearStatus(): void {
		if (this.ctx?.hasUI && this.ctx.mode === "tui") this.ctx.ui.setStatus(TASK_WIDGET_KEY, undefined);
	}

	private startTicker(): void {
		if (this.ticker) return;
		this.ticker = setInterval(() => this.widgetTui?.requestRender(), 1_000);
		this.ticker.unref?.();
	}

	private stopTicker(): void {
		if (!this.ticker) return;
		clearInterval(this.ticker);
		this.ticker = undefined;
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.removeWidget();
		this.clearStatus();
		this.stopTicker();
		if (this.pendingRefresh) clearTimeout(this.pendingRefresh);
		this.pendingRefresh = undefined;
		this.latestSnapshot = undefined;
		this.ctx = undefined;
	}
}

export function registerSubagentUi(
	pi: ExtensionAPI,
	service: AgentService,
	config: PluginConfig,
	options: { configPath?: string } = {},
): SubagentUiController {
	const controller = new SubagentUiController(service.monitor, config);

	pi.registerCommand("tasks", {
		description: "Monitor foreground and background subagents",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify("/tasks requires interactive TUI mode", "warning");
				return;
			}
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) =>
					new TasksBrowserView(tui, theme, service, () => config.tui, () => done(), (message, type) => ctx.ui.notify(message, type)),
				{ overlay: true, overlayOptions: { width: 64, maxHeight: "70%", margin: 2 } },
			);
		},
	});

	pi.registerCommand("subagents", {
		description: "Configure subagent monitoring (usage: /subagents settings)",
		handler: async (args, ctx) => {
			const command = args.trim();
			if (command && command !== "settings") {
				ctx.ui.notify("Usage: /subagents settings", "warning");
				return;
			}
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify("Subagent settings require interactive TUI mode", "warning");
				return;
			}
			await ctx.ui.custom<void>(
				(_tui, theme, _keybindings, done) =>
					new SubagentSettingsView(
						config.tui,
						theme,
						(next) => {
							try {
								const saved = saveTuiConfig(next, options.configPath ?? CONFIG_PATH);
								controller.applyTuiConfig(saved.tui);
								return true;
							} catch (error) {
								ctx.ui.notify(`Could not save subagent settings: ${error instanceof Error ? error.message : String(error)}`, "error");
								return false;
							}
						},
						() => done(),
					),
				{ overlay: true, overlayOptions: { width: 58, maxHeight: "50%", margin: 2 } },
			);
		},
	});

	pi.registerMessageRenderer("kimi-like-subagent-notification", (message, { outputPad }, theme) => {
		const details = message.details as { taskId?: string; view?: TaskView } | undefined;
		const view = details?.view;
		const status = view?.phase ?? "completed";
		const color = status === "completed" ? "success" : status === "aborted" ? "muted" : "error";
		const title = `${theme.fg(color, status === "completed" ? "✓" : status === "aborted" ? "■" : "✗")} Subagent ${status}`;
		const fallbackContent = typeof message.content === "string"
			? message.content
			: message.content.find((part) => part.type === "text")?.text ?? "";
		const description = sanitizeDisplayText(view?.description ?? fallbackContent.split("\n", 1)[0] ?? "Subagent update", 512);
		const summary = sanitizeDisplayText(view?.error ?? view?.summary ?? view?.latestActivity ?? "", 512);
		const lines = [title, `  ${description}`, details?.taskId ? theme.fg("dim", `  ${details.taskId}${view?.agentId ? ` · ${view.agentId}` : ""}`) : "", summary ? `  ${summary}` : ""]
			.filter(Boolean);
		const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new StaticLines(lines));
		return box;
	});

	return controller;
}
