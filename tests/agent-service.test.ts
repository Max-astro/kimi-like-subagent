import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentService } from "../src/agent-service.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { StateStore } from "../src/state.ts";
import type { AgentHandle, AgentRunResult, SpawnSpec, SubagentRuntime } from "../src/types.ts";

function extensionRoot(): string {
	return new URL("..", import.meta.url).pathname.replace(/\/$/, "");
}

function fixture() {
	let seen: SpawnSpec | undefined;
	const pi = {
		appendEntry() {},
		sendMessage() {},
		getActiveTools: () => ["read", "grep", "find", "ls", "TowerReview", "TowerSend", "TowerStatus"],
		getAllTools: () => ["read", "grep", "find", "ls", "TowerReview", "TowerSend", "TowerStatus"].map((name) => ({ name })),
	} as never;
	function completed(spec: SpawnSpec): AgentHandle {
		seen = spec;
		const result: AgentRunResult = {
			agentId: spec.agentId,
			profileName: spec.profile.name,
			status: "completed",
			result: "done",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, contextTokens: 0 },
			model: `${spec.model.provider}/${spec.model.id}`,
			sessionFile: spec.sessionFile,
		};
		return { agentId: spec.agentId, profileName: spec.profile.name, session: {} as never, completion: Promise.resolve(result), abort: async () => {} };
	}
	const runtime: SubagentRuntime = {
		async spawn(spec) {
			return completed(spec);
		},
		async resume(spec) {
			return completed(spec);
		},
		async abort() {},
		async dispose() {},
	};
	const state = new StateStore(pi, { dataDir: mkdtempSync(path.join(tmpdir(), "kimi-service-")) });
	const service = new AgentService(pi, structuredClone(DEFAULT_CONFIG), extensionRoot(), runtime, state);
	const ctx = {
		cwd: process.cwd(),
		model: { provider: "provider", id: "model" },
		thinkingLevel: "medium",
		modelRegistry: {
			find: (provider: string, id: string) => provider === "provider" && id === "model" ? { provider, id } : undefined,
			hasConfiguredAuth: () => true,
		},
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => "parent-session", getEntries: () => [] },
	} as never;
	service.restore(ctx);
	return { service, ctx, seen: () => seen };
}

describe("AgentService workflow boundaries", () => {
	it("can force an internal reviewer to ignore project-controlled resources", async () => {
		const { service, ctx, seen } = fixture();
		await service.invoke(
			{
				description: "review",
				prompt: "review the branch",
				subagentType: "tower-reviewer",
				internalProfile: true,
				projectTrusted: false,
			},
			ctx,
		);
		expect(seen()?.projectTrusted).toBe(false);
		expect([...service.state.agents.values()][0].projectTrusted).toBe(false);
	});

	it("does not expose internal workflow agents to generic resume", async () => {
		const { service, ctx } = fixture();
		const started = await service.invoke(
			{
				description: "review",
				prompt: "review the branch",
				subagentType: "tower-reviewer",
				internalProfile: true,
			},
			ctx,
		);
		await expect(service.invoke({ description: "resume review", resume: started.agentId }, ctx)).rejects.toThrow(/owning workflow/i);
	});

	it("lets an owning workflow authorize resume of its registered internal agent", async () => {
		const { service, ctx } = fixture();
		const started = await service.invoke(
			{
				description: "review",
				prompt: "review the branch",
				subagentType: "tower-reviewer",
				internalProfile: true,
			},
			ctx,
		);
		let authorized = "";
		service.setInternalResumeGuard(async (record) => {
			authorized = record.agentId;
		});
		const resumed = await service.invoke({ description: "resume review", resume: started.agentId }, ctx);
		expect(authorized).toBe(started.agentId);
		expect(resumed.result?.status).toBe("completed");
	});
});
