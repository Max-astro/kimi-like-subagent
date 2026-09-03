import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentProfile, ProfileSource } from "./types.ts";

type Frontmatter = {
	name?: unknown;
	description?: unknown;
	whenToUse?: unknown;
	when_to_use?: unknown;
	override?: unknown;
	tools?: unknown;
	disallowedTools?: unknown;
	disallowed_tools?: unknown;
	subagents?: unknown;
	internal?: unknown;
};

const TOOL_ALIASES: Record<string, string> = {
	Read: "read",
	Write: "write",
	Edit: "edit",
	Bash: "bash",
	Grep: "grep",
	Glob: "find",
	Find: "find",
	Ls: "ls",
	Agent: "Agent",
	AgentSwarm: "AgentSwarm",
	TaskList: "TaskList",
	TaskOutput: "TaskOutput",
	TaskStop: "TaskStop",
};

function stringList(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	return raw.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
}

export function normalizeToolName(name: string): string {
	return TOOL_ALIASES[name] ?? name;
}

function loadFile(filePath: string, source: ProfileSource): AgentProfile | undefined {
	let content: string;
	try {
		content = readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
	const { frontmatter, body } = parseFrontmatter<Frontmatter>(content);
	const fallbackName = path.basename(filePath, ".md");
	const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : fallbackName;
	if (!/^[a-z][a-z0-9-]*$/.test(name) || typeof frontmatter.description !== "string") return undefined;
	return {
		name,
		description: frontmatter.description.trim(),
		whenToUse:
			typeof frontmatter.whenToUse === "string"
				? frontmatter.whenToUse.trim()
				: typeof frontmatter.when_to_use === "string"
					? frontmatter.when_to_use.trim()
					: undefined,
		override: frontmatter.override === true,
		internal: frontmatter.internal === true,
		tools: stringList(frontmatter.tools)?.map(normalizeToolName),
		disallowedTools: stringList(frontmatter.disallowedTools ?? frontmatter.disallowed_tools)?.map(normalizeToolName),
		subagents: stringList(frontmatter.subagents),
		systemPrompt: body.trim(),
		source,
		filePath,
	};
}

function walk(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...walk(full));
		else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md")) files.push(full);
	}
	return files;
}

function nearestProjectAgents(cwd: string): string | undefined {
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, CONFIG_DIR_NAME, "agents");
		try {
			if (statSync(candidate).isDirectory()) return candidate;
		} catch {}
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export interface ProfileCatalogResult {
	profiles: AgentProfile[];
	diagnostics: string[];
	projectAgentsDir?: string;
}

export function discoverProfiles(
	extensionRoot: string,
	cwd: string,
	options: { includeProject?: boolean } = {},
): ProfileCatalogResult {
	const diagnostics: string[] = [];
	const map = new Map<string, AgentProfile>();
	const builtinDir = path.join(extensionRoot, "agents");
	for (const file of walk(builtinDir)) {
		const profile = loadFile(file, "builtin");
		if (profile) map.set(profile.name, profile);
		else diagnostics.push(`Skipped invalid built-in profile: ${file}`);
	}
	const builtinNames = new Set(map.keys());
	const reservedNames = new Set([...map.values()].filter((profile) => profile.internal).map((profile) => profile.name));
	for (const file of walk(path.join(getAgentDir(), "agents"))) {
		const profile = loadFile(file, "user");
		if (!profile) diagnostics.push(`Skipped invalid user profile: ${file}`);
		else if (reservedNames.has(profile.name)) {
			diagnostics.push(`Ignored ${file}: internal profile name ${profile.name} is reserved`);
		}
		else if (map.get(profile.name)?.source === "builtin" && !profile.override) {
			diagnostics.push(`Ignored ${file}: override: true is required to replace built-in ${profile.name}`);
		} else map.set(profile.name, profile);
	}
	const projectAgentsDir = options.includeProject === false ? undefined : nearestProjectAgents(cwd);
	if (projectAgentsDir) {
		for (const file of walk(projectAgentsDir)) {
			const profile = loadFile(file, "project");
			const existing = profile ? map.get(profile.name) : undefined;
			if (!profile) diagnostics.push(`Skipped invalid project profile: ${file}`);
			else if (reservedNames.has(profile.name)) {
				diagnostics.push(`Ignored ${file}: internal profile name ${profile.name} is reserved`);
			}
			else if (builtinNames.has(profile.name) && !profile.override) {
				diagnostics.push(`Ignored ${file}: override: true is required to replace built-in ${profile.name}`);
			} else map.set(profile.name, profile);
		}
	}
	return { profiles: [...map.values()], diagnostics, projectAgentsDir };
}

export function effectiveTools(profile: AgentProfile, activeTools: string[], allTools: string[]): string[] {
	const available = new Set(allTools);
	let selected = profile.tools === undefined || profile.tools.includes("*") ? [...activeTools] : profile.tools;
	if (selected.some((name) => name.startsWith("mcp__") && name.endsWith("*"))) {
		const expanded: string[] = [];
		for (const name of selected) {
			if (name.startsWith("mcp__") && name.endsWith("*")) {
				const prefix = name.slice(0, -1);
				expanded.push(...allTools.filter((tool) => tool.startsWith(prefix)));
			} else expanded.push(name);
		}
		selected = expanded;
	}
	const denied = (profile.disallowedTools ?? []).map(normalizeToolName);
	const isDenied = (name: string) => denied.some((pattern) =>
		pattern.startsWith("mcp__") && pattern.endsWith("*")
			? name.startsWith(pattern.slice(0, -1))
			: name === pattern,
	);
	return [...new Set(selected.map(normalizeToolName))].filter((name) => available.has(name) && !isDenied(name));
}

export function profileDescription(profiles: AgentProfile[]): string {
	return profiles
		.map((profile) => {
			const details = [profile.description, profile.whenToUse].filter(Boolean).join(" ");
			return `- ${profile.name}: ${details}`;
		})
		.join("\n");
}
