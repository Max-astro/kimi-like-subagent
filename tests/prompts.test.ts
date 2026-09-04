import { describe, expect, it } from "vitest";
import { PromptCatalog } from "../src/prompts.ts";

const CORE_TOOLS = ["Agent", "AgentSwarm", "TaskList", "TaskOutput", "TaskStop"] as const;

describe("PromptCatalog snippets and guidelines", () => {
	const catalog = new PromptCatalog();

	it("returns a non-empty single-line snippet for every core tool", () => {
		for (const name of CORE_TOOLS) {
			const snippet = catalog.snippet(name);
			expect(snippet.length).toBeGreaterThan(0);
			expect(snippet).not.toMatch(/[\r\n]/);
		}
	});

	it("parses guideline bullets that each name their tool", () => {
		for (const name of CORE_TOOLS) {
			const guidelines = catalog.guidelines(name);
			expect(guidelines.length).toBeGreaterThan(0);
			for (const guideline of guidelines) {
				expect(guideline).toContain(name);
				expect(guideline).not.toMatch(/^\s*-/);
			}
		}
	});

	it("drops blank lines and strips bullet prefixes", () => {
		const guidelines = catalog.guidelines("Agent");
		expect(guidelines).toHaveLength(3);
		expect(guidelines.every((line) => line.trim().length > 0)).toBe(true);
	});
});
