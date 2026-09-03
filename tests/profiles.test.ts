import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverProfiles, effectiveTools } from "../src/profiles.ts";

function profile(root: string, relative: string, content: string): void {
	const file = path.join(root, relative);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, content, "utf8");
}

describe("profile catalog", () => {
	it("loads nearest project profiles and structurally removes denied tools", () => {
		const extensionRoot = mkdtempSync(path.join(tmpdir(), "kimi-profile-ext-"));
		const project = mkdtempSync(path.join(tmpdir(), "kimi-profile-project-"));
		profile(
			extensionRoot,
			"agents/coder.md",
			"---\nname: coder\ndescription: Built-in coder\ntools: read, bash, edit, write\n---\nCode carefully.",
		);
		profile(
			project,
			".pi/agents/auditor.md",
			"---\nname: auditor\ndescription: Read-only audit\ntools: read, grep, edit\ndisallowed_tools: edit\n---\nAudit only.",
		);

		const result = discoverProfiles(extensionRoot, project);
		const auditor = result.profiles.find((item) => item.name === "auditor");
		expect(auditor?.source).toBe("project");
		expect(effectiveTools(auditor!, ["read", "edit"], ["read", "grep", "edit"])).toEqual(["read", "grep"]);
	});

	it("expands an explicitly allowed MCP server prefix only", () => {
		const tools = effectiveTools(
			{
				name: "docs",
				description: "Docs",
				override: false,
				tools: ["read", "mcp__docs__*"],
				systemPrompt: "Read docs.",
				source: "user",
				filePath: "docs.md",
			},
			["read"],
			["read", "mcp__docs__search", "mcp__other__search"],
		);
		expect(tools).toEqual(["read", "mcp__docs__search"]);
	});

	it("applies MCP wildcard denies to expanded concrete tools", () => {
		const tools = effectiveTools(
			{
				name: "docs",
				description: "Docs",
				override: false,
				tools: ["read", "mcp__docs__*", "mcp__github__*"],
				disallowedTools: ["mcp__github__*"],
				systemPrompt: "Read docs.",
				source: "user",
				filePath: "docs.md",
			},
			["read"],
			["read", "mcp__docs__search", "mcp__github__issue"],
		);
		expect(tools).toEqual(["read", "mcp__docs__search"]);
	});

	it("requires every later layer to opt in before replacing a built-in profile", () => {
		const extensionRoot = mkdtempSync(path.join(tmpdir(), "kimi-profile-ext-"));
		const project = mkdtempSync(path.join(tmpdir(), "kimi-profile-project-"));
		profile(extensionRoot, "agents/coder.md", "---\nname: coder\ndescription: Built in\n---\nbuilt-in");
		profile(project, ".pi/agents/coder.md", "---\nname: coder\ndescription: Project\n---\nproject");

		const result = discoverProfiles(extensionRoot, project);
		expect(result.profiles.find((item) => item.name === "coder")?.source).toBe("builtin");
		expect(result.diagnostics.join("\n")).toMatch(/override: true/i);
	});

	it("can omit project profiles entirely before a trust decision", () => {
		const extensionRoot = mkdtempSync(path.join(tmpdir(), "kimi-profile-ext-"));
		const project = mkdtempSync(path.join(tmpdir(), "kimi-profile-project-"));
		profile(extensionRoot, "agents/coder.md", "---\nname: coder\ndescription: Built in\n---\nbuilt-in");
		profile(project, ".pi/agents/injected.md", "---\nname: injected\ndescription: Untrusted\n---\nuntrusted");

		const result = discoverProfiles(extensionRoot, project, { includeProject: false });
		expect(result.profiles.map((item) => item.name)).toEqual(["coder"]);
		expect(result.projectAgentsDir).toBeUndefined();
	});

	it("lets higher-priority project files replace non-builtin user profiles without override", () => {
		const extensionRoot = mkdtempSync(path.join(tmpdir(), "kimi-profile-ext-"));
		const project = mkdtempSync(path.join(tmpdir(), "kimi-profile-project-"));
		const agentDir = process.env.PI_CODING_AGENT_DIR;
		try {
			const userRoot = mkdtempSync(path.join(tmpdir(), "kimi-profile-user-"));
			process.env.PI_CODING_AGENT_DIR = userRoot;
			profile(userRoot, "agents/auditor.md", "---\nname: auditor\ndescription: User\n---\nuser");
			profile(project, ".pi/agents/auditor.md", "---\nname: auditor\ndescription: Project\n---\nproject");
			const result = discoverProfiles(extensionRoot, project);
			expect(result.profiles.find((item) => item.name === "auditor")?.source).toBe("project");
		} finally {
			if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = agentDir;
		}
	});

	it("does not let project files replace internal workflow profiles", () => {
		const extensionRoot = mkdtempSync(path.join(tmpdir(), "kimi-profile-ext-"));
		const project = mkdtempSync(path.join(tmpdir(), "kimi-profile-project-"));
		profile(extensionRoot, "agents/tower-reviewer.md", "---\nname: tower-reviewer\ndescription: Internal\ninternal: true\ntools: read\n---\nreview safely");
		profile(project, ".pi/agents/tower-reviewer.md", "---\nname: tower-reviewer\ndescription: Replacement\noverride: true\ntools: bash, write\n---\nreplace reviewer");

		const result = discoverProfiles(extensionRoot, project);
		const reviewer = result.profiles.find((item) => item.name === "tower-reviewer");
		expect(reviewer).toMatchObject({ source: "builtin", internal: true, tools: ["read"] });
		expect(result.diagnostics.join("\n")).toMatch(/internal profile name.*reserved/i);
	});
});
