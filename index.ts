import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AgentService } from "./src/agent-service.ts";
import { loadConfig } from "./src/config.ts";
import { buildHarnessPrompt } from "./src/harness.ts";
import { PromptCatalog } from "./src/prompts.ts";
import { profileDescription } from "./src/profiles.ts";
import { registerCoreTools } from "./src/tools.ts";
import { registerTower } from "./src/tower.ts";
import { TowerStore } from "./src/tower-store.ts";
import { registerSubagentUi } from "./src/tui-controller.ts";

const EXTENSION_ROOT = path.dirname(fileURLToPath(import.meta.url));

export default function kimiLikeSubagent(pi: ExtensionAPI): void {
	const { config } = loadConfig();
	const prompts = new PromptCatalog(EXTENSION_ROOT);
	const service = new AgentService(pi, config, EXTENSION_ROOT);
	const blockedSwarmCalls = new Set<string>();

	registerCoreTools(pi, service, config, prompts);
	if (config.experimental.tower) registerTower(pi, service, prompts);
	const subagentUi = registerSubagentUi(pi, service, config);

	pi.on("session_start", async (_event, ctx) => {
		service.restore(ctx);
		subagentUi.attach(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		let systemPrompt = buildHarnessPrompt(event.systemPrompt, prompts, {
			activeTools: pi.getActiveTools(),
			swarmMode: service.state.swarmMode,
			towerMode: service.state.towerMode,
			towerEnabled: config.experimental.tower,
		});
		if (pi.getActiveTools().includes("Agent")) {
			systemPrompt += `\n\nAvailable subagent profiles for this caller:\n${profileDescription(service.profiles(ctx)) || "(none)"}`;
		}
		return { systemPrompt };
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		const calls = (event.message as AssistantMessage).content.filter((part) => part.type === "toolCall");
		if (calls.some((call) => call.name === "AgentSwarm") && calls.length !== 1) {
			for (const call of calls) if (call.name === "AgentSwarm") blockedSwarmCalls.add(call.id);
		}
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "AgentSwarm" || !blockedSwarmCalls.delete(event.toolCallId)) return;
		return {
			block: true,
			reason: "AgentSwarm must be the only tool call in an assistant response. Call it alone in the next response.",
		};
	});

	pi.on("agent_settled", async () => {
		if (service.state.swarmMode === "task") {
			service.state.swarmMode = "off";
			service.state.persist();
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			await service.shutdown();
		} finally {
			subagentUi.dispose();
			if (config.experimental.tower) {
				try {
					const store = await TowerStore.fromCwd(ctx.cwd);
					if (store.actor(ctx.cwd) === "tower") await store.release(ctx.sessionManager.getSessionId());
				} catch {
					// Tower mode may be enabled before a workspace has been initialized.
				}
			}
		}
	});

	pi.registerCommand("swarm", {
		description: "Control swarm prompting: /swarm on, /swarm off, or /swarm <task>",
		handler: async (args, ctx) => {
			const value = args.trim();
			if (!value) {
				ctx.ui.notify(`Swarm mode: ${service.state.swarmMode}`, "info");
				return;
			}
			if (value === "on" || value === "off") {
				service.state.swarmMode = value === "on" ? "manual" : "off";
				service.state.persist();
				ctx.ui.notify(`Swarm mode ${value}`, "info");
				return;
			}
			service.state.swarmMode = "task";
			service.state.persist();
			pi.sendUserMessage(value);
		},
	});
}
