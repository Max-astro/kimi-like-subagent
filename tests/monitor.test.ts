import { describe, expect, it, vi } from "vitest";
import { MonitorProjection } from "../src/monitor.ts";

describe("MonitorProjection", () => {
	it("projects queued swarm members through activity and terminal states", () => {
		const monitor = new MonitorProjection(() => 1_000);
		const listener = vi.fn();
		monitor.subscribe(listener);

		monitor.apply({
			type: "swarm_registered",
			groupId: "call-swarm",
			parentToolCallId: "call-swarm",
			description: "inspect renderers",
			profileName: "explore",
			members: [
				{ memberId: "call-swarm:1", index: 1, label: "agent card" },
				{ memberId: "call-swarm:2", index: 2, label: "tasks browser" },
			],
			at: 1_000,
		});

		expect(monitor.snapshot().swarms[0]).toMatchObject({
			groupId: "call-swarm",
			counts: { queued: 2, running: 0, retrying: 0, completed: 0, failed: 0 },
		});

		monitor.apply({
			type: "task_started",
			taskId: "task-1",
			agentId: "agent-1",
			description: "inspect renderers #1",
			profileName: "explore",
			model: "provider/model",
			detached: false,
			startedAt: 1_100,
			origin: {
				kind: "swarm",
				parentToolCallId: "call-swarm",
				groupId: "call-swarm",
				memberId: "call-swarm:1",
			},
		});
		monitor.apply({
			type: "activity",
			taskId: "task-1",
			activity: { type: "tool_started", toolCallId: "read-1", toolName: "read", args: { path: "src/tui.ts" } },
			at: 1_200,
		});
		monitor.apply({
			type: "activity",
			taskId: "task-1",
			activity: { type: "retry_started", attempt: 2, maxAttempts: 3, message: "429 rate limit" },
			at: 1_300,
		});

		let snapshot = monitor.snapshot();
		expect(snapshot.tasks[0]).toMatchObject({ phase: "retrying", toolCount: 1, latestActivity: "retry 2/3" });
		expect(snapshot.swarms[0]?.counts).toEqual({ queued: 1, running: 0, retrying: 1, completed: 0, failed: 0 });

		monitor.apply({
			type: "activity",
			taskId: "task-1",
			activity: { type: "retry_finished", success: true, attempt: 2 },
			at: 1_400,
		});
		monitor.apply({
			type: "task_finished",
			taskId: "task-1",
			status: "completed",
			endedAt: 1_500,
			summary: "found the renderer",
			usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, contextTokens: 30 },
		});

		snapshot = monitor.snapshot();
		expect(snapshot.tasks[0]).toMatchObject({ phase: "completed", summary: "found the renderer" });
		expect(snapshot.swarms[0]?.counts).toEqual({ queued: 1, running: 0, retrying: 0, completed: 1, failed: 0 });
		expect(listener).toHaveBeenCalled();
	});

	it("keeps resumed runs separate by task id", () => {
		const monitor = new MonitorProjection(() => 2_000);
		for (const taskId of ["task-old", "task-new"]) {
			monitor.apply({
				type: "task_started",
				taskId,
				agentId: "agent-same",
				description: taskId,
				profileName: "coder",
				model: "provider/model",
				detached: false,
				startedAt: 2_000,
				origin: { kind: "agent", parentToolCallId: `call-${taskId}` },
			});
			monitor.apply({ type: "task_finished", taskId, status: "completed", endedAt: 2_100, summary: taskId });
		}

		expect(monitor.snapshot().tasks.map((task) => task.taskId)).toEqual(["task-old", "task-new"]);
	});

	it("bounds and sanitizes activity while ignoring updates after settlement", () => {
		const monitor = new MonitorProjection(() => 3_000);
		monitor.apply({
			type: "task_started",
			taskId: "task-1",
			agentId: "agent-1",
			description: "activity",
			profileName: "coder",
			model: "provider/model",
			detached: false,
			startedAt: 1_000,
		});
		for (let index = 0; index < 25; index++) {
			monitor.apply({
				type: "activity",
				taskId: "task-1",
				activity: { type: "tool_started", toolCallId: `tool-${index}`, toolName: "Read", args: { path: `\u001b[31msrc/${index}.ts` } },
				at: 1_100 + index,
			});
		}
		monitor.apply({ type: "activity", taskId: "task-1", activity: { type: "thinking" }, at: 1_200 });
		monitor.apply({ type: "task_finished", taskId: "task-1", status: "completed", endedAt: 2_000, summary: "done" });
		monitor.apply({ type: "activity", taskId: "task-1", activity: { type: "text_delta", delta: "late" }, at: 2_100 });

		const task = monitor.snapshot().tasks[0]!;
		expect(task.activities).toHaveLength(20);
		expect(task.activities.some((activity) => activity.label.includes("\u001b"))).toBe(false);
		expect(task.activities.at(-1)?.label).toBe("thinking…");
		expect(task.latestActivity).toBe("done");
	});

	it("removes OSC and ANSI terminal sequences from projected text", () => {
		const monitor = new MonitorProjection();
		monitor.apply({
			type: "task_started",
			taskId: "task-control",
			agentId: "agent-control",
			description: "control sequence",
			profileName: "coder",
			model: "provider/model",
			detached: false,
			startedAt: 1,
		});
		monitor.apply({
			type: "activity",
			taskId: "task-control",
			activity: { type: "text_delta", delta: "\u001b]0;hidden title\u0007\u001b[31mvisible\u001b[0m" },
			at: 2,
		});

		expect(monitor.snapshot().tasks[0]?.latestActivity).toBe("visible");
	});

	it("does not overwrite a sibling tool when parallel updates interleave", () => {
		const monitor = new MonitorProjection();
		monitor.apply({
			type: "task_started",
			taskId: "task-parallel",
			agentId: "agent-parallel",
			description: "parallel tools",
			profileName: "coder",
			model: "provider/model",
			detached: false,
			startedAt: 1,
		});
		monitor.apply({
			type: "activity",
			taskId: "task-parallel",
			activity: { type: "tool_started", toolCallId: "read-a", toolName: "Read", args: { path: "a.ts" } },
			at: 2,
		});
		monitor.apply({
			type: "activity",
			taskId: "task-parallel",
			activity: { type: "tool_started", toolCallId: "grep-b", toolName: "Grep", args: { pattern: "needle" } },
			at: 3,
		});
		monitor.apply({
			type: "activity",
			taskId: "task-parallel",
			activity: { type: "tool_updated", toolCallId: "read-a", toolName: "Read", partialResult: { path: "a.ts:20" } },
			at: 4,
		});

		expect(monitor.snapshot().tasks[0]?.activities).toMatchObject([
			{ toolCallId: "grep-b", label: "Grep needle" },
			{ toolCallId: "read-a", label: "Read a.ts:20" },
		]);
	});
});
