import { describe, expect, it, vi } from "vitest";
import { MonitorProjection } from "../src/monitor.ts";
import { registerSubagentUi, SubagentUiController } from "../src/tui-controller.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as never;

describe("SubagentUiController", () => {
	it("registers the user-facing task and settings commands plus completion renderer", () => {
		const commands: string[] = [];
		const renderers: string[] = [];
		const pi = {
			registerCommand(name: string) { commands.push(name); },
			registerMessageRenderer(name: string) { renderers.push(name); },
		} as never;
		const monitor = new MonitorProjection();
		const service = { monitor } as never;

		registerSubagentUi(pi, service, structuredClone(DEFAULT_CONFIG));

		expect(commands).toEqual(["tasks", "subagents"]);
		expect(renderers).toEqual(["kimi-like-subagent-notification"]);
	});

	it("owns one widget key and switches to composable footer status without replacing other UI", () => {
		const monitor = new MonitorProjection(() => 2_000);
		const setWidget = vi.fn();
		const setStatus = vi.fn();
		const ctx = {
			hasUI: true,
			mode: "tui",
			ui: { theme, setWidget, setStatus },
		} as never;
		const config = structuredClone(DEFAULT_CONFIG);
		const controller = new SubagentUiController(monitor, config);
		controller.attach(ctx);

		monitor.apply({
			type: "task_started",
			taskId: "task-1",
			agentId: "agent-1",
			description: "inspect UI",
			profileName: "explore",
			model: "provider/model",
			detached: true,
			startedAt: 1_000,
			origin: { kind: "agent", parentToolCallId: "call-1" },
		});

		const registrations = setWidget.mock.calls.filter((call) => call[0] === "kimi-like-subagent:tasks" && typeof call[1] === "function");
		expect(registrations).toHaveLength(1);
		expect(registrations[0]?.[2]).toEqual({ placement: "aboveEditor" });

		monitor.apply({ type: "activity", taskId: "task-1", activity: { type: "text_delta", delta: "working" }, at: 1_100 });
		expect(setWidget.mock.calls.filter((call) => call[0] === "kimi-like-subagent:tasks" && typeof call[1] === "function")).toHaveLength(1);

		controller.applyTuiConfig({ mode: "minimal", taskScope: "all", maxVisibleTasks: 2 });
		expect(setWidget).not.toHaveBeenCalledWith("kimi-like-subagent:tasks", undefined);
		expect(setStatus).toHaveBeenCalledWith("kimi-like-subagent:tasks", expect.stringContaining("1 subagent active"));
		const widgetFactory = registrations[0]![1] as (tui: unknown, theme: unknown) => { render(width: number): string[] };
		expect(widgetFactory({ requestRender: vi.fn() }, theme).render(80)).toEqual([]);
		controller.dispose();
	});

	it("registers the compact widget only once across idle periods", () => {
		const monitor = new MonitorProjection(() => 2_000);
		const setWidget = vi.fn();
		const controller = new SubagentUiController(monitor, structuredClone(DEFAULT_CONFIG));
		const ctx = {
			hasUI: true,
			mode: "tui",
			ui: { theme, setWidget, setStatus: vi.fn() },
		} as never;
		controller.attach(ctx);
		controller.attach(ctx);

		for (const [index, taskId] of ["task-1", "task-2"].entries()) {
			monitor.apply({
				type: "task_started",
				taskId,
				agentId: `agent-${index}`,
				description: taskId,
				profileName: "explore",
				model: "provider/model",
				detached: false,
				startedAt: 1_000 + index,
			});
			monitor.apply({ type: "task_finished", taskId, status: "completed", endedAt: 1_100 + index });
		}

		expect(setWidget.mock.calls.filter((call) => typeof call[1] === "function")).toHaveLength(1);
		controller.dispose();
	});

	it("does not install terminal surfaces in headless sessions", () => {
		const setWidget = vi.fn();
		const setStatus = vi.fn();
		const monitor = new MonitorProjection();
		const controller = new SubagentUiController(monitor, structuredClone(DEFAULT_CONFIG));

		controller.attach({ hasUI: false, mode: "rpc", ui: { theme, setWidget, setStatus } } as never);
		monitor.apply({
			type: "task_started",
			taskId: "headless-task",
			agentId: "headless-agent",
			description: "run without TUI",
			profileName: "explore",
			model: "provider/model",
			detached: true,
			startedAt: 1,
		});

		controller.dispose();
		expect(setWidget).not.toHaveBeenCalled();
		expect(setStatus).not.toHaveBeenCalled();
	});
});
