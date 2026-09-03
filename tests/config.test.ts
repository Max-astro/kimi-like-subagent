import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, parseConfig } from "../src/config.ts";

describe("parseConfig", () => {
	it("uses conservative defaults without inventing a concurrency cap", () => {
		const config = parseConfig({});
		expect(config).toEqual(DEFAULT_CONFIG);
		expect(config.swarm.maxConcurrency).toBeUndefined();
		expect(config.experimental.tower).toBe(false);
	});

	it("rejects misspelled keys instead of silently ignoring them", () => {
		expect(() => parseConfig({ swarm: { max_concurency: 4 } })).toThrow(/unknown key.*max_concurency/i);
	});

	it("requires forced secondary-model selection to be unambiguous", () => {
		expect(() =>
			parseConfig({
				secondary_model: {
					force: true,
					default_model: "fast",
					models: {
						fast: { model: "openai/gpt-fast" },
						cheap: { model: "openai/gpt-cheap" },
					},
				},
			}),
		).toThrow(/force cannot be combined with a multi-model pool/i);
	});

	it("does not accept a dangling default model alias", () => {
		expect(() => parseConfig({ secondary_model: { default_model: "fast", force: true } })).toThrow(
			/models requires default_model|default_model requires models/i,
		);
	});

	it("keeps the Kimi-compatible hard swarm ceiling at 128", () => {
		expect(() => parseConfig({ swarm: { max_subagents: 129 } })).toThrow(/at most 128/i);
	});
});
