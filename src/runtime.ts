import { mkdirSync } from "node:fs";
import * as path from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
	AgentHandle,
	AgentRunResult,
	ResumeSpec,
	RuntimeHooks,
	SpawnSpec,
	SubagentRuntime,
	UsageTotals,
} from "./types.ts";

const SUMMARY_CONTINUATION =
	"Your final handoff is too brief. Continue once with a technically complete, self-contained summary: what you found or changed, relevant paths, verification performed and results, and anything left undone.";

function emptyUsage(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 };
}

function assistantText(message: AssistantMessage | undefined): string {
	if (!message) return "";
	return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
}

function usageFromMessages(messages: AgentMessage[]): UsageTotals {
	const result = emptyUsage();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const usage = message.usage;
		result.turns += 1;
		if (!usage) continue;
		result.input += usage.input ?? 0;
		result.output += usage.output ?? 0;
		result.cacheRead += usage.cacheRead ?? 0;
		result.cacheWrite += usage.cacheWrite ?? 0;
		result.cost += usage.cost?.total ?? 0;
		result.contextTokens = usage.totalTokens ?? result.contextTokens;
	}
	return result;
}

function lastAssistant(messages: AgentMessage[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role === "assistant") return message;
	}
	return undefined;
}

function looksRateLimited(message: string): boolean {
	return /(?:\b429\b|rate.?limit|too many requests)/i.test(message) &&
		!/(?:quota exceeded|insufficient_quota|billing|out of budget)/i.test(message);
}

function abortError(reason: string): Error {
	const error = new Error(reason);
	error.name = "AbortError";
	return error;
}

export class PiAgentSessionRuntime implements SubagentRuntime {
	private readonly active = new Map<string, AgentHandle>();

	async spawn(spec: SpawnSpec, signal?: AbortSignal, hooks?: RuntimeHooks): Promise<AgentHandle> {
		return this.start(spec, signal, hooks);
	}

	async resume(spec: ResumeSpec, signal?: AbortSignal, hooks?: RuntimeHooks): Promise<AgentHandle> {
		return this.start(spec, signal, hooks);
	}

	private async start(
		spec: SpawnSpec | ResumeSpec,
		signal?: AbortSignal,
		hooks?: RuntimeHooks,
	): Promise<AgentHandle> {
		if (this.active.has(spec.agentId)) throw new Error(`Agent ${spec.agentId} is already running`);
		if (signal?.aborted) throw abortError("Aborted before subagent start");
		mkdirSync(path.dirname(spec.sessionFile), { recursive: true });
		const sessionManager = SessionManager.open(spec.sessionFile, path.dirname(spec.sessionFile), spec.cwd);
		if (spec.profileBinding) {
			sessionManager.appendCustomEntry("kimi-like-subagent-profile-binding", spec.profileBinding);
		}
		const settingsManager = SettingsManager.create(spec.cwd, getAgentDir(), { projectTrusted: spec.projectTrusted });
		const profilePrompt = spec.profile.systemPrompt.trim();
		const loader = new DefaultResourceLoader({
			cwd: spec.cwd,
			agentDir: getAgentDir(),
			settingsManager,
			noPromptTemplates: true,
			noContextFiles: !spec.projectTrusted,
			...(spec.profile.source === "builtin"
				? { appendSystemPrompt: profilePrompt ? [profilePrompt] : [] }
				: { systemPrompt: profilePrompt || undefined }),
		});
		await loader.reload();
		const { session } = await createAgentSession({
			cwd: spec.cwd,
			agentDir: getAgentDir(),
			model: spec.model,
			thinkingLevel: spec.thinkingLevel,
			tools: spec.tools,
			resourceLoader: loader,
			sessionManager,
			settingsManager,
		});
		if (signal?.aborted) {
			session.dispose();
			throw abortError("Aborted before subagent start");
		}

		let timedOut = false;
		let explicitAbort: string | undefined;
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				hooks?.onUpdate?.({ agentId: spec.agentId, kind: "text", text: event.assistantMessageEvent.delta });
			}
			if (event.type === "tool_execution_start") {
				hooks?.onUpdate?.({
					agentId: spec.agentId,
					kind: "tool",
					text: event.toolName,
					toolName: event.toolName,
					toolArgs: event.args,
				});
			}
			if (event.type === "auto_retry_start") {
				hooks?.onUpdate?.({ agentId: spec.agentId, kind: "retry", text: event.errorMessage });
				if (looksRateLimited(event.errorMessage)) hooks?.onRateLimit?.(spec.agentId, event.errorMessage);
			}
		});

		let timeout: ReturnType<typeof setTimeout> | undefined;
		const handle: AgentHandle = {
			agentId: spec.agentId,
			profileName: spec.profile.name,
			session,
			completion: Promise.resolve(undefined as never),
			abort: async (reason = "Stopped") => {
				explicitAbort = reason;
				await session.abort();
			},
		};

		const onAbort = () => void handle.abort(signal?.reason instanceof Error ? signal.reason.message : "Aborted");
		signal?.addEventListener("abort", onAbort, { once: true });

		handle.completion = (async (): Promise<AgentRunResult> => {
			try {
				if (spec.timeoutMs > 0) {
					timeout = setTimeout(() => {
						timedOut = true;
						void session.abort();
					}, spec.timeoutMs);
				}
				await session.prompt(spec.prompt, { expandPromptTemplates: false });
				let finalMessage = lastAssistant(session.messages);
				let result = assistantText(finalMessage);
				for (let attempt = 0; attempt < spec.summaryRetries && result.length < spec.summaryMinChars; attempt++) {
					if (["error", "aborted", "length"].includes(finalMessage?.stopReason ?? "")) break;
					await session.prompt(SUMMARY_CONTINUATION, { expandPromptTemplates: false });
					finalMessage = lastAssistant(session.messages);
					result = assistantText(finalMessage);
				}
				const stopReason = finalMessage?.stopReason;
				const status = timedOut
					? "timed_out"
					: explicitAbort || stopReason === "aborted"
						? "aborted"
						: stopReason === "error" || stopReason === "length"
							? "failed"
							: "completed";
				return {
					agentId: spec.agentId,
					profileName: spec.profile.name,
					status,
					result,
					error:
						timedOut
							? "Agent timed out"
							: explicitAbort ?? (stopReason === "length" ? "Agent output was truncated at the model token limit" : finalMessage?.errorMessage),
					usage: usageFromMessages(session.messages),
					model: `${spec.model.provider}/${spec.model.id}`,
					sessionFile: spec.sessionFile,
				};
			} catch (error) {
				return {
					agentId: spec.agentId,
					profileName: spec.profile.name,
					status: timedOut ? "timed_out" : explicitAbort || signal?.aborted ? "aborted" : "failed",
					result: "",
					error: error instanceof Error ? error.message : String(error),
					usage: usageFromMessages(session.messages),
					model: `${spec.model.provider}/${spec.model.id}`,
					sessionFile: spec.sessionFile,
				};
			} finally {
				if (timeout) clearTimeout(timeout);
				signal?.removeEventListener("abort", onAbort);
				unsubscribe();
				this.active.delete(spec.agentId);
				session.dispose();
			}
		})();
		this.active.set(spec.agentId, handle);
		return handle;
	}

	async abort(agentId: string, reason?: string): Promise<void> {
		const handle = this.active.get(agentId);
		if (!handle) throw new Error(`Agent ${agentId} is not running`);
		await handle.abort(reason);
	}

	async dispose(): Promise<void> {
		const handles = [...this.active.values()];
		await Promise.allSettled(handles.map((handle) => handle.abort("Parent session closed")));
		await Promise.allSettled(handles.map((handle) => handle.completion));
	}
}
