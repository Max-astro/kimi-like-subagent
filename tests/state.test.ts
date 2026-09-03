import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../src/state.ts";
import type { AgentRunResult } from "../src/types.ts";

describe("StateStore task output", () => {
	it("does not append a streamed final answer twice", () => {
		const entries: unknown[] = [];
		const state = new StateStore({ appendEntry: (...args: unknown[]) => entries.push(args) } as never, {
			dataDir: mkdtempSync(path.join(tmpdir(), "kimi-state-")),
		});
		state.restore({ sessionManager: { getSessionId: () => "session", getEntries: () => [] } } as never);
		const agent = state.createAgent({
			agentId: "agent-1",
			profileName: "coder",
			description: "task",
			cwd: "/tmp",
			sessionFile: "/tmp/session.jsonl",
			model: "provider/model",
			thinkingLevel: "medium",
			status: "running",
		});
		const task = state.createTask(agent.agentId, "task", false);
		state.appendTaskOutput(task.taskId, "final answer");
		const result: AgentRunResult = {
			agentId: agent.agentId,
			profileName: "coder",
			status: "completed",
			result: "final answer",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, contextTokens: 0 },
			model: "provider/model",
			sessionFile: "/tmp/session.jsonl",
		};
		state.finishTask(task.taskId, result);
		expect(state.readOutput(task)).toBe("final answer");
	});
});
