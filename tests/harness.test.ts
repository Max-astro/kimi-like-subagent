import { describe, expect, it } from "vitest";
import { buildHarnessPrompt } from "../src/harness.ts";

const prompts = {
	mode(name: string) {
		return `<${name}-prompt>`;
	},
} as never;

describe("buildHarnessPrompt", () => {
	it("keeps the base prompt unchanged when delegation is unavailable", () => {
		expect(
			buildHarnessPrompt("base", prompts, {
				activeTools: ["read"],
				swarmMode: "manual",
				towerMode: false,
				towerEnabled: false,
			}),
		).toBe("base");
	});

	it("injects only the mode prompts justified by active tools and state", () => {
		expect(
			buildHarnessPrompt("base", prompts, {
				activeTools: ["Agent", "AgentSwarm"],
				swarmMode: "task",
				towerMode: false,
				towerEnabled: false,
			}),
		).toBe("base\n\n<delegation-prompt>\n\n<swarm-prompt>");
	});
});
