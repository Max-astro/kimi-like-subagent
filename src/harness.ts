import { PromptCatalog } from "./prompts.ts";

export interface HarnessPromptOptions {
	activeTools: string[];
	swarmMode: "off" | "manual" | "task";
	towerMode: boolean;
	towerEnabled: boolean;
}

export function buildHarnessPrompt(
	basePrompt: string,
	prompts: PromptCatalog,
	options: HarnessPromptOptions,
): string {
	const sections: string[] = [];
	if (options.activeTools.includes("Agent")) sections.push(prompts.mode("delegation"));
	if (options.swarmMode !== "off" && options.activeTools.includes("AgentSwarm")) sections.push(prompts.mode("swarm"));
	if (options.towerEnabled && options.towerMode) sections.push(prompts.mode("tower"));
	return sections.length === 0 ? basePrompt : `${basePrompt.trimEnd()}\n\n${sections.join("\n\n")}`;
}
