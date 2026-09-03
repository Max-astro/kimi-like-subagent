import { describe, expect, it } from "vitest";
import { createSwarmSpecs } from "../src/tools.ts";

describe("createSwarmSpecs", () => {
	it("puts resume entries before item-based spawns", () => {
		const specs = createSwarmSpecs(
			{
				description: "Review modules",
				resume_agent_ids: { "agent-old": "continue with tests" },
				prompt_template: "Review {{item}}",
				items: ["src/a.ts", "src/b.ts"],
			},
			128,
		);
		expect(specs).toEqual([
			{ kind: "resume", index: 1, agentId: "agent-old", prompt: "continue with tests" },
			{ kind: "spawn", index: 2, item: "src/a.ts", prompt: "Review src/a.ts" },
			{ kind: "spawn", index: 3, item: "src/b.ts", prompt: "Review src/b.ts" },
		]);
	});

	it("rejects a one-item non-resume swarm", () => {
		expect(() =>
			createSwarmSpecs({ description: "Review", prompt_template: "Review {{item}}", items: ["only"] }, 128),
		).toThrow(/at least 2 items/i);
	});

	it("rejects duplicate expanded prompts before launching anything", () => {
		expect(() =>
			createSwarmSpecs(
				{ description: "Review", prompt_template: "Same prompt {{item}}{{item}}", items: ["x", "x"] },
				128,
			),
		).toThrow(/duplicate subagent prompts/i);
	});
});
