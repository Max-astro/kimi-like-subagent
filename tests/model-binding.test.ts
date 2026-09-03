import { describe, expect, it } from "vitest";
import type { PluginConfig } from "../src/types.ts";
import { resolveModelBinding } from "../src/model-binding.ts";

const primary = { provider: "primary-provider", id: "primary-model" };
const fast = { provider: "secondary-provider", id: "fast-model" };

function context() {
	return {
		model: primary,
		thinkingLevel: "high" as const,
		modelRegistry: {
			find(provider: string, id: string) {
				return provider === fast.provider && id === fast.id ? fast : undefined;
			},
			hasConfiguredAuth() {
				return true;
			},
		},
	} as never;
}

function config(secondaryModel?: PluginConfig["secondaryModel"]): PluginConfig {
	return {
		subagent: { timeoutMs: 1, summaryMinChars: 1, summaryRetries: 0, outputCapBytes: 1024 },
		swarm: { timeoutMs: 1, maxSubagents: 8, initialLaunchLimit: 2, launchIntervalMs: 1 },
		secondaryModel,
		experimental: { tower: false },
	};
}

describe("resolveModelBinding", () => {
	it("inherits the caller model when no pool exists", () => {
		const binding = resolveModelBinding(config(), context());
		expect(binding).toMatchObject({ model: primary, thinkingLevel: "high", alias: "primary", source: "inherited" });
	});

	it("uses a configured alias and its thinking level", () => {
		const binding = resolveModelBinding(
			config({
				defaultModel: "fast",
				models: { fast: { model: "secondary-provider/fast-model", description: "Fast", thinkingLevel: "low" } },
			}),
			context(),
		);
		expect(binding).toMatchObject({ model: fast, thinkingLevel: "low", alias: "fast", source: "secondary" });
	});

	it("keeps primary as an explicit quality escape hatch", () => {
		const binding = resolveModelBinding(
			config({ defaultModel: "fast", models: { fast: { model: "secondary-provider/fast-model", description: "" } } }),
			context(),
			"primary",
		);
		expect(binding).toMatchObject({ model: primary, alias: "primary", source: "primary" });
	});

	it("does not permit a call-site override in force mode", () => {
		expect(() =>
			resolveModelBinding(
				config({
					defaultModel: "fast",
					force: true,
					models: { fast: { model: "secondary-provider/fast-model", description: "" } },
				}),
				context(),
				"primary",
			),
		).toThrow(/force mode/i);
	});
});
