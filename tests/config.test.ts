import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, parseConfig, saveTuiConfig } from "../src/config.ts";

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

	it("parses compact TUI defaults and validates the visible row budget", () => {
		expect(parseConfig({}).tui).toEqual({ mode: "compact", taskScope: "all", maxVisibleTasks: 2 });
		expect(parseConfig({ tui: { mode: "minimal", task_scope: "background", max_visible_tasks: 4 } }).tui).toEqual({
			mode: "minimal",
			taskScope: "background",
			maxVisibleTasks: 4,
		});
		expect(() => parseConfig({ tui: { max_visible_tasks: 5 } })).toThrow(/at most 4/i);
	});

	it("updates only the TUI section when settings are saved", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "kimi-config-"));
		const configPath = path.join(dir, "config.json");
		writeFileSync(configPath, JSON.stringify({ swarm: { max_concurrency: 3 }, experimental: { tower: true } }));

		const saved = saveTuiConfig({ mode: "minimal", taskScope: "background", maxVisibleTasks: 1 }, configPath);
		const raw = JSON.parse(readFileSync(configPath, "utf8"));

		expect(saved.tui).toEqual({ mode: "minimal", taskScope: "background", maxVisibleTasks: 1 });
		expect(raw).toEqual({
			swarm: { max_concurrency: 3 },
			experimental: { tower: true },
			tui: { mode: "minimal", task_scope: "background", max_visible_tasks: 1 },
		});
	});

	it("creates a missing config with only the explicit TUI section", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "kimi-config-new-"));
		const configPath = path.join(dir, "nested", "config.json");

		const saved = saveTuiConfig({ mode: "compact", taskScope: "all", maxVisibleTasks: 3 }, configPath);

		expect(saved.tui.maxVisibleTasks).toBe(3);
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
			tui: { mode: "compact", task_scope: "all", max_visible_tasks: 3 },
		});
	});
});
