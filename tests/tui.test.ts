import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { MonitorProjection } from "../src/monitor.ts";
import { renderAgentStatus, renderSwarmStatus, renderTaskWidget, selectAgentToolView, selectSwarmToolView } from "../src/tui.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as never;

function populatedMonitor(): MonitorProjection {
	const monitor = new MonitorProjection(() => 3_000);
	monitor.apply({
		type: "task_started",
		taskId: "task-agent",
		agentId: "agent-1",
		description: "inspect runtime",
		profileName: "explore",
		model: "provider/model",
		detached: false,
		startedAt: 1_000,
		origin: { kind: "agent", parentToolCallId: "call-agent" },
	});
	monitor.apply({
		type: "activity",
		taskId: "task-agent",
		activity: { type: "tool_started", toolCallId: "read-1", toolName: "Read", args: { path: "src/runtime.ts" } },
		at: 1_200,
	});
	monitor.apply({
		type: "swarm_registered",
		groupId: "call-swarm",
		parentToolCallId: "call-swarm",
		description: "inspect renderers",
		profileName: "explore",
		members: [1, 2, 3].map((index) => ({ memberId: `call-swarm:${index}`, index, label: `member ${index}` })),
		at: 1_500,
	});
	monitor.apply({
		type: "task_started",
		taskId: "task-member",
		agentId: "agent-2",
		description: "inspect renderers #1",
		profileName: "explore",
		model: "provider/model",
		detached: false,
		startedAt: 1_600,
		origin: {
			kind: "swarm",
			parentToolCallId: "call-swarm",
			groupId: "call-swarm",
			memberId: "call-swarm:1",
		},
	});
	monitor.apply({
		type: "task_started",
		taskId: "task-hidden",
		agentId: "agent-3",
		description: "write docs",
		profileName: "coder",
		model: "provider/model",
		detached: true,
		startedAt: 2_000,
		origin: { kind: "agent", parentToolCallId: "call-hidden" },
	});
	return monitor;
}

describe("compact task widget", () => {
	it("uses two stable top-level rows and aggregates swarm members", () => {
		const lines = renderTaskWidget(
			populatedMonitor().snapshot(),
			{ mode: "compact", taskScope: "all", maxVisibleTasks: 2 },
			theme,
			100,
		);

		expect(lines).toEqual([
			"Subagents  3 active · 2 queued · +1 hidden · /tasks",
			"● explore  inspect runtime · Read src/runtime.ts · 2s",
			"● Swarm  inspect renderers · 1 running · 2 queued · 0/3 done · 2s",
		]);
	});

	it("never exceeds the available terminal width", () => {
		const lines = renderTaskWidget(
			populatedMonitor().snapshot(),
			{ mode: "compact", taskScope: "all", maxVisibleTasks: 2 },
			theme,
			40,
		);

		expect(lines).toHaveLength(3);
		expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
	});
});

describe("inline subagent cards", () => {
	it("keeps Agent status to two result lines when collapsed", () => {
		const snapshot = populatedMonitor().snapshot();
		const view = selectAgentToolView(snapshot, "call-agent");
		const lines = renderAgentStatus(view, false, snapshot.now, theme, 80);

		expect(lines).toEqual(["● running · 2s · 1 tool", "  Read src/runtime.ts"]);
	});

	it("aggregates Swarm status and exposes members only when expanded", () => {
		const snapshot = populatedMonitor().snapshot();
		const view = selectSwarmToolView(snapshot, "call-swarm");

		expect(renderSwarmStatus(view, false, snapshot.now, theme, 100)).toEqual([
			"● 1 running · 2 queued · 0/3 done · 2s",
			"  active: #1 member 1",
		]);
		expect(renderSwarmStatus(view, true, snapshot.now, theme, 100)).toEqual([
			"● 1 running · 2 queued · 0/3 done · 2s",
			"  ● #1 member 1",
			"  ○ #2 member 2",
			"  ○ #3 member 3",
		]);
	});
});
