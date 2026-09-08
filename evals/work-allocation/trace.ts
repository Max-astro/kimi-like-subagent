import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderAgentStatus } from "../../src/tui.ts";
import type { TaskView } from "../../src/monitor.ts";

// Test-only extension, loaded in both parent and child sessions in one Pi process.
export default function trace(pi: ExtensionAPI): void {
	const tracePath = process.env.KIMI_EVAL_TRACE;
	const budgetPath = process.env.KIMI_EVAL_BUDGET;
	if (!tracePath || !budgetPath) throw new Error("Evaluation trace and budget paths are required");
	const log = (value: object) => appendFileSync(tracePath, `${JSON.stringify({ at: Date.now(), ...value })}\n`);
	const files = (cwd: string) => Object.fromEntries(readdirSync(cwd, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => [entry.name, createHash("sha256").update(readFileSync(join(cwd, entry.name))).digest("hex")]));
	const beforeTools = new Map<string, Record<string, string>>();
	let started = false;
	pi.on("before_agent_start", () => { started = true; });
	pi.on("agent_settled", (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		if (!started || entries.some((entry) => entry.type === "custom" && entry.customType === "kimi-like-subagent-profile-binding")) return;
		const state = entries.filter((entry) => entry.type === "custom" && entry.customType === "kimi-like-subagent-state").at(-1);
		const tasks = (state && "data" in state ? state.data as { tasks: { status: string }[] } : undefined)?.tasks ?? [];
		if (!ctx.hasPendingMessages() && tasks.every((task) => task.status !== "running")) {
			log({ type: "settled", sessionId: ctx.sessionManager.getSessionId() });
			ctx.shutdown();
		}
	});
	const fail = (reason: string): never => {
		log({ type: "eval_failure", reason });
		// Pi reports extension exceptions and continues; exit prevents a further paid request.
		process.exit(2);
	};
	pi.on("before_provider_request", (event, ctx) => {
		const payload = event.payload as { model?: string; reasoning?: { effort?: string } };
		if (ctx.model?.provider !== "openai" || ctx.model.id !== "gpt-5.6-sol" || payload.model !== "gpt-5.6-sol" || payload.reasoning?.effort !== "high") {
			fail("Expected openai/gpt-5.6-sol with thinking=high");
		}
		const budget = JSON.parse(readFileSync(budgetPath, "utf8"));
		if (budget.requests >= budget.maxRequests || budget.tokens >= budget.maxTokens) fail("Shared evaluation budget exhausted");
		budget.requests++;
		writeFileSync(budgetPath, JSON.stringify(budget));
		log({ type: "request", sessionId: ctx.sessionManager.getSessionId(), provider: ctx.model?.provider, model: payload.model, thinking: payload.reasoning?.effort });
		return { ...event.payload as object, max_output_tokens: 4096 };
	});
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const message = event.message;
		const budget = JSON.parse(readFileSync(budgetPath, "utf8"));
		const usage = message.usage;
		const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		budget.tokens += tokens;
		writeFileSync(budgetPath, JSON.stringify(budget));
		log({ type: "assistant", sessionId: ctx.sessionManager.getSessionId(), content: message.content.filter((part) => part.type !== "thinking"), stopReason: message.stopReason, tokens, usage });
	});
	pi.on("tool_execution_start", (event, ctx) => {
		beforeTools.set(event.toolCallId, files(ctx.cwd));
		log({ ...event, sessionId: ctx.sessionManager.getSessionId() });
	});
	pi.on("tool_execution_end", (event, ctx) => {
		const before = beforeTools.get(event.toolCallId) ?? {};
		const after = files(ctx.cwd);
		const changedPaths = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((name) => before[name] !== after[name]);
		beforeTools.delete(event.toolCallId);
		log({ ...event, changedPaths, sessionId: ctx.sessionManager.getSessionId() });
		if (event.toolName !== "Agent") return;
		const view = event.result?.details?.view as TaskView | undefined;
		if (!view) fail("Agent result has no monitor view");
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
		for (const width of [24, 80]) {
			for (const expanded of [false, true]) {
				const lines = renderAgentStatus(view, expanded, Date.now(), theme, width);
				const plain = lines.join("").replace(/\u001b\[[0-9;]*m/g, "");
				if (!lines.length || lines.some((line) => visibleWidth(line) > width) || /[\r\n\t\u001b\u0007]|NaN|undefined/.test(plain)) fail("Invalid Agent TUI rendering");
				log({ type: "tui", width, expanded, lines });
			}
		}
	});
}
