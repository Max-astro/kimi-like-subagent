import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { MonitorProjection } from "../src/monitor.ts";
import { SubagentSettingsView, TasksBrowserView, selectTaskBrowserEntries } from "../src/tui-dialogs.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as never;

function runningMonitor(): MonitorProjection {
	const monitor = new MonitorProjection(() => 2_000);
	monitor.apply({
		type: "task_started",
		taskId: "task-1",
		agentId: "agent-1",
		description: "inspect task browser",
		profileName: "explore",
		model: "provider/model",
		detached: false,
		startedAt: 1_000,
		origin: { kind: "agent", parentToolCallId: "call-1" },
	});
	return monitor;
}

describe("subagent TUI dialogs", () => {
	it("applies settings only when persistence succeeds", () => {
		const save = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
		const view = new SubagentSettingsView(
			{ mode: "compact", taskScope: "all", maxVisibleTasks: 2 },
			theme,
			save,
			vi.fn(),
		);

		view.handleInput("\r");
		expect(save).toHaveBeenLastCalledWith({ mode: "minimal", taskScope: "all", maxVisibleTasks: 2 });
		expect(view.render(58).join("\n")).toContain("compact");

		view.handleInput("\r");
		expect(view.render(58).join("\n")).toContain("minimal");
	});

	it("clips dialog chrome and content to a narrow terminal", () => {
		const view = new SubagentSettingsView(
			{ mode: "compact", taskScope: "background", maxVisibleTasks: 4 },
			theme,
			() => true,
			vi.fn(),
		);

		expect(view.render(20).every((line) => visibleWidth(line) <= 20)).toBe(true);
	});

	it("keeps swarm members grouped in the top-level task list", () => {
		const monitor = runningMonitor();
		monitor.apply({
			type: "swarm_registered",
			groupId: "swarm-1",
			parentToolCallId: "swarm-1",
			description: "inspect renderers",
			profileName: "explore",
			members: [{ memberId: "swarm-1:1", index: 1, label: "member" }],
			at: 1_100,
		});
		monitor.apply({
			type: "task_started",
			taskId: "task-member",
			agentId: "agent-2",
			description: "member",
			profileName: "explore",
			model: "provider/model",
			detached: false,
			startedAt: 1_200,
			origin: { kind: "swarm", groupId: "swarm-1", parentToolCallId: "swarm-1", memberId: "swarm-1:1" },
		});

		const entries = selectTaskBrowserEntries(
			monitor.snapshot(),
			{ mode: "compact", taskScope: "all", maxVisibleTasks: 2 },
			true,
		);
		expect(entries.map((entry) => [entry.kind, entry.id])).toEqual([
			["agent", "task-1"],
			["swarm", "swarm-1"],
		]);
	});

	it("stops a selected running task only after inline confirmation", async () => {
		const monitor = runningMonitor();
		const stopTask = vi.fn().mockResolvedValue({});
		const tui = { requestRender: vi.fn() } as never;
		const service = {
			monitor,
			stopTask,
			state: { getTask: () => ({ outputPreview: "" }) },
		} as never;
		const view = new TasksBrowserView(
			tui,
			theme,
			service,
			() => ({ mode: "compact", taskScope: "all", maxVisibleTasks: 2 }),
			vi.fn(),
			vi.fn(),
		);

		view.handleInput("\r");
		view.handleInput("s");
		expect(stopTask).not.toHaveBeenCalled();
		expect(view.render(64).join("\n")).toContain("Y confirm");
		view.handleInput("y");
		await vi.waitFor(() => expect(stopTask).toHaveBeenCalledWith("task-1", "Stopped from /tasks"));
		view.dispose();
	});

	it("removes terminal control sequences from live output previews", () => {
		const monitor = runningMonitor();
		const view = new TasksBrowserView(
			{ requestRender: vi.fn() } as never,
			theme,
			{
				monitor,
				state: { getTask: () => ({ outputPreview: "\u001b[31mred\u001b[0m\nplain" }) },
			} as never,
			() => ({ mode: "compact", taskScope: "all", maxVisibleTasks: 2 }),
			vi.fn(),
			vi.fn(),
		);

		view.handleInput("\r");
		const rendered = view.render(64).join("\n");
		expect(rendered).toContain("output  red");
		expect(rendered).not.toContain("\u001b");
		view.dispose();
	});
});
