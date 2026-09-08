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
	it("keeps active background descriptions and activity safe at narrow widths", () => {
		const monitor = new MonitorProjection(() => 3_000);
		monitor.apply({
			type: "task_started", taskId: "background", agentId: "coder", profileName: "coder",
			description: "Bounded task\n\u001b[2J\u001b]0;bad title\u0007" + "界".repeat(80),
			model: "openai/gpt-5.6-sol", detached: true, startedAt: 1_000,
		});
		monitor.apply({ type: "activity", taskId: "background", at: 2_000, activity: { type: "text_delta", delta: "Needs follow-up\r\n\t\u001b[2J" } });
		for (const width of [20, 40, 80]) {
			const lines = renderTaskWidget(monitor.snapshot(), { mode: "compact", taskScope: "background", maxVisibleTasks: 2 }, theme, width);
			expect(lines).toHaveLength(2);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(lines.join("").replace(/\u001b\[[0-9;]*m/g, "")).not.toMatch(/[\r\n\t\u001b\u0007]/);
		}
	});

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
	it("renders a bounded coder handoff without terminal controls or stale active rows", () => {
		const monitor = populatedMonitor();
		monitor.apply({
			type: "task_finished",
			taskId: "task-hidden",
			status: "completed",
			endedAt: 3_000,
			summary: "Needs follow-up\n\u001b[2J\u001b]0;bad title\u0007Changed src/parser.ts\rChecks passed\tRemaining: migration " + "界".repeat(100),
		});
		const snapshot = monitor.snapshot();
		const task = snapshot.tasks.find((candidate) => candidate.taskId === "task-hidden");
		for (const width of [20, 40, 80]) {
			for (const expanded of [false, true]) {
				const lines = renderAgentStatus(task, expanded, snapshot.now, theme, width);
				expect(lines.length).toBeGreaterThan(0);
				expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
				expect(lines.join("").replace(/\u001b\[[0-9;]*m/g, "")).not.toMatch(/[\r\n\t\u001b\u0007]/);
				expect(lines.join("")).not.toMatch(/NaN|undefined/);
			}
		}
		expect(renderAgentStatus(task, false, snapshot.now, theme, 80).join(" ")).toContain("Needs follow-up");
		expect(renderTaskWidget(snapshot, { mode: "compact", taskScope: "background", maxVisibleTasks: 2 }, theme, 40)).toEqual([]);
	});

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
