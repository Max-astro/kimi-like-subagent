import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModelPoolEntry, PluginConfig, SecondaryModelConfig, TuiConfig } from "./types.ts";

export const PLUGIN_DATA_DIR = path.join(getAgentDir(), "kimi-like-subagent");
export const CONFIG_PATH = path.join(PLUGIN_DATA_DIR, "config.json");

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const DEFAULT_CONFIG: PluginConfig = {
	subagent: {
		timeoutMs: 2 * 60 * 60 * 1000,
		summaryMinChars: 200,
		summaryRetries: 1,
		outputCapBytes: 50 * 1024,
	},
	swarm: {
		timeoutMs: 2 * 60 * 60 * 1000,
		maxSubagents: 128,
		initialLaunchLimit: 5,
		launchIntervalMs: 700,
	},
	tui: { mode: "compact", taskScope: "all", maxVisibleTasks: 2 },
	experimental: { tower: false },
};

const TOP_LEVEL_KEYS = new Set(["subagent", "swarm", "secondary_model", "tui", "experimental"]);
const SUBAGENT_KEYS = new Set(["timeout_ms", "summary_min_chars", "summary_retries", "output_cap_bytes"]);
const SWARM_KEYS = new Set([
	"timeout_ms",
	"max_concurrency",
	"max_subagents",
	"initial_launch_limit",
	"launch_interval_ms",
]);
const SECONDARY_KEYS = new Set(["default_model", "models", "force", "default_effort"]);
const TUI_KEYS = new Set(["mode", "task_scope", "max_visible_tasks"]);
const EXPERIMENTAL_KEYS = new Set(["tower"]);
const MODEL_ENTRY_KEYS = new Set(["model", "description", "thinking_level"]);

function record(value: unknown, field: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
	return value as Record<string, unknown>;
}

function assertKeys(value: Record<string, unknown>, allowed: Set<string>, field: string): void {
	const unknown = Object.keys(value).filter((key) => !allowed.has(key));
	if (unknown.length > 0) throw new Error(`${field} has unknown key(s): ${unknown.join(", ")}`);
}

function integer(value: unknown, field: string, min: number): number {
	if (!Number.isInteger(value) || (value as number) < min) throw new Error(`${field} must be an integer >= ${min}`);
	return value as number;
}

function boundedInteger(value: unknown, field: string, min: number, max: number): number {
	const result = integer(value, field, min);
	if (result > max) throw new Error(`${field} must be at most ${max}`);
	return result;
}

function optionalThinking(value: unknown, field: string): ThinkingLevel | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !THINKING_LEVELS.has(value)) {
		throw new Error(`${field} must be one of: ${[...THINKING_LEVELS].join(", ")}`);
	}
	return value as ThinkingLevel;
}

function parseSecondary(value: unknown): SecondaryModelConfig {
	const section = record(value, "secondary_model");
	assertKeys(section, SECONDARY_KEYS, "secondary_model");
	const result: SecondaryModelConfig = {};
	if (section.default_model !== undefined) {
		if (typeof section.default_model !== "string" || !section.default_model.trim()) {
			throw new Error("secondary_model.default_model must be a non-empty string");
		}
		result.defaultModel = section.default_model;
	}
	if (section.force !== undefined) {
		if (typeof section.force !== "boolean") throw new Error("secondary_model.force must be boolean");
		result.force = section.force;
	}
	result.defaultThinkingLevel = optionalThinking(section.default_effort, "secondary_model.default_effort");
	if (section.models !== undefined) {
		const entries = record(section.models, "secondary_model.models");
		result.models = {};
		for (const [alias, raw] of Object.entries(entries)) {
			if (!alias.trim() || alias === "primary") throw new Error(`invalid secondary model alias: ${alias || "(empty)"}`);
			const item = record(raw, `secondary_model.models.${alias}`);
			assertKeys(item, MODEL_ENTRY_KEYS, `secondary_model.models.${alias}`);
			if (typeof item.model !== "string" || !item.model.includes("/")) {
				throw new Error(`secondary_model.models.${alias}.model must be provider/model`);
			}
			if (item.description !== undefined && typeof item.description !== "string") {
				throw new Error(`secondary_model.models.${alias}.description must be a string`);
			}
			const parsed: ModelPoolEntry = {
				model: item.model,
				description: typeof item.description === "string" ? item.description : "",
				thinkingLevel: optionalThinking(item.thinking_level, `secondary_model.models.${alias}.thinking_level`),
			};
			result.models[alias] = parsed;
		}
	}
	if (result.force && !result.defaultModel) throw new Error("secondary_model.force requires default_model");
	if (result.defaultModel && !result.models) throw new Error("secondary_model.default_model requires models");
	if (result.force && result.models && Object.keys(result.models).length > 1) {
		throw new Error("secondary_model.force cannot be combined with a multi-model pool");
	}
	if (result.models) {
		if (!result.defaultModel) throw new Error("secondary_model.models requires default_model");
		if (!result.models[result.defaultModel]) {
			throw new Error(`secondary_model.default_model must name a configured alias: ${Object.keys(result.models).join(", ")}`);
		}
	}
	return result;
}

export function parseConfig(raw: unknown): PluginConfig {
	const root = record(raw, "config");
	assertKeys(root, TOP_LEVEL_KEYS, "config");
	const config: PluginConfig = structuredClone(DEFAULT_CONFIG);
	if (root.subagent !== undefined) {
		const section = record(root.subagent, "subagent");
		assertKeys(section, SUBAGENT_KEYS, "subagent");
		if (section.timeout_ms !== undefined) config.subagent.timeoutMs = integer(section.timeout_ms, "subagent.timeout_ms", 0);
		if (section.summary_min_chars !== undefined) config.subagent.summaryMinChars = integer(section.summary_min_chars, "subagent.summary_min_chars", 0);
		if (section.summary_retries !== undefined) config.subagent.summaryRetries = integer(section.summary_retries, "subagent.summary_retries", 0);
		if (section.output_cap_bytes !== undefined) config.subagent.outputCapBytes = integer(section.output_cap_bytes, "subagent.output_cap_bytes", 1024);
	}
	if (root.swarm !== undefined) {
		const section = record(root.swarm, "swarm");
		assertKeys(section, SWARM_KEYS, "swarm");
		if (section.timeout_ms !== undefined) config.swarm.timeoutMs = integer(section.timeout_ms, "swarm.timeout_ms", 0);
		if (section.max_concurrency !== undefined) config.swarm.maxConcurrency = integer(section.max_concurrency, "swarm.max_concurrency", 1);
		if (section.max_subagents !== undefined) {
			config.swarm.maxSubagents = boundedInteger(section.max_subagents, "swarm.max_subagents", 2, 128);
		}
		if (section.initial_launch_limit !== undefined) config.swarm.initialLaunchLimit = integer(section.initial_launch_limit, "swarm.initial_launch_limit", 1);
		if (section.launch_interval_ms !== undefined) config.swarm.launchIntervalMs = integer(section.launch_interval_ms, "swarm.launch_interval_ms", 0);
	}
	if (root.secondary_model !== undefined) config.secondaryModel = parseSecondary(root.secondary_model);
	if (root.tui !== undefined) {
		const section = record(root.tui, "tui");
		assertKeys(section, TUI_KEYS, "tui");
		if (section.mode !== undefined) {
			if (section.mode !== "compact" && section.mode !== "minimal") throw new Error("tui.mode must be compact or minimal");
			config.tui.mode = section.mode;
		}
		if (section.task_scope !== undefined) {
			if (section.task_scope !== "all" && section.task_scope !== "background") {
				throw new Error("tui.task_scope must be all or background");
			}
			config.tui.taskScope = section.task_scope;
		}
		if (section.max_visible_tasks !== undefined) {
			config.tui.maxVisibleTasks = boundedInteger(section.max_visible_tasks, "tui.max_visible_tasks", 1, 4);
		}
	}
	if (root.experimental !== undefined) {
		const section = record(root.experimental, "experimental");
		assertKeys(section, EXPERIMENTAL_KEYS, "experimental");
		if (section.tower !== undefined) {
			if (typeof section.tower !== "boolean") throw new Error("experimental.tower must be boolean");
			config.experimental.tower = section.tower;
		}
	}
	return config;
}

export function saveTuiConfig(tui: TuiConfig, configPath = CONFIG_PATH): PluginConfig {
	let root: Record<string, unknown> = {};
	if (existsSync(configPath)) {
		try {
			root = record(JSON.parse(readFileSync(configPath, "utf8")), "config");
		} catch (error) {
			throw new Error(`Cannot parse ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const nextRoot = {
		...root,
		tui: {
			mode: tui.mode,
			task_scope: tui.taskScope,
			max_visible_tasks: tui.maxVisibleTasks,
		},
	};
	const parsed = parseConfig(nextRoot);
	mkdirSync(path.dirname(configPath), { recursive: true });
	const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(tempPath, `${JSON.stringify(nextRoot, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
		renameSync(tempPath, configPath);
	} catch (error) {
		if (existsSync(tempPath)) unlinkSync(tempPath);
		throw error;
	}
	return parsed;
}

export function loadConfig(configPath = CONFIG_PATH): { config: PluginConfig; path: string; exists: boolean } {
	if (!existsSync(configPath)) return { config: structuredClone(DEFAULT_CONFIG), path: configPath, exists: false };
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(configPath, "utf8"));
	} catch (error) {
		throw new Error(`Cannot parse ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return { config: parseConfig(raw), path: configPath, exists: true };
}

export function modelPoolDescription(config: PluginConfig): string {
	const pool = config.secondaryModel;
	if (!pool?.models || pool.force) return "";
	const lines = Object.entries(pool.models).map(([alias, entry]) => {
		const markers = alias === pool.defaultModel ? " [default]" : "";
		return `- ${alias}${markers}${entry.description ? `: ${entry.description}` : ""}`;
	});
	lines.push('- primary: use the caller\'s model and thinking level for quality-sensitive work');
	return `Available models (pass via model):\n${lines.join("\n")}`;
}
