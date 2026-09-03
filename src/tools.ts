import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentService, capOutput, capTailOutput, escapeXmlText, formatAgentResult } from "./agent-service.ts";
import { modelPoolDescription } from "./config.ts";
import { resolveModelBinding } from "./model-binding.ts";
import { PromptCatalog } from "./prompts.ts";
import { FleetScheduler, type ScheduledWork } from "./scheduler.ts";
import type { MonitorSnapshot, SwarmView, TaskView } from "./monitor.ts";
import { agentStatusComponent, sanitizeDisplayText, selectAgentToolView, selectSwarmToolView, singleLineComponent, swarmStatusComponent } from "./tui.ts";
import type { AgentInvocation, AgentRequest } from "./agent-service.ts";
import type { PluginConfig } from "./types.ts";

interface SwarmInput {
	description: string;
	subagent_type?: string;
	prompt_template?: string;
	items?: string[];
	resume_agent_ids?: Record<string, string>;
	model?: string;
}

interface SwarmSpec {
	kind: "spawn" | "resume";
	index: number;
	item?: string;
	prompt: string;
	agentId?: string;
}

function textResult(text: string, details: unknown = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

interface ViewWatcher<T> {
	dispose(): void;
}

function watchToolView<T>(
	service: AgentService,
	select: (snapshot: MonitorSnapshot) => T | undefined,
	phaseKey: (view: T) => string,
	onUpdate: ((result: ReturnType<typeof textResult>) => void) | undefined,
): ViewWatcher<T> {
	let current = select(service.monitor.snapshot());
	let lastEmission = 0;
	let lastPhase = current ? phaseKey(current) : "";
	let timer: ReturnType<typeof setTimeout> | undefined;
	const emit = () => {
		if (!current || !onUpdate) return;
		lastEmission = Date.now();
		onUpdate(textResult("Subagent progress updated.", { view: current }));
	};
	const unsubscribe = service.monitor.subscribe((snapshot) => {
		const next = select(snapshot);
		if (!next) return;
		current = next;
		const nextPhase = phaseKey(next);
		const immediate = !lastEmission || nextPhase !== lastPhase;
		lastPhase = nextPhase;
		if (immediate || Date.now() - lastEmission >= 200) {
			if (timer) clearTimeout(timer);
			timer = undefined;
			emit();
			return;
		}
		if (!timer) {
			timer = setTimeout(() => {
				timer = undefined;
				emit();
			}, Math.max(1, 200 - (Date.now() - lastEmission)));
			timer.unref?.();
		}
	});
	return {
		dispose() {
			unsubscribe();
			if (timer) clearTimeout(timer);
		},
	};
}

function availableModelAliases(config: PluginConfig): string[] {
	return config.secondaryModel?.models && !config.secondaryModel.force
		? [...Object.keys(config.secondaryModel.models), "primary"]
		: [];
}

function modelSchema(config: PluginConfig) {
	const aliases = availableModelAliases(config);
	return aliases.length > 0
		? StringEnum(aliases as [string, ...string[]], {
				description: "Configured secondary-model alias, or primary for the caller model. Ignored on resume.",
			})
		: undefined;
}

export function createSwarmSpecs(input: SwarmInput, maxSubagents: number): SwarmSpec[] {
	const resumeEntries = Object.entries(input.resume_agent_ids ?? {}).map(([agentId, prompt]) => ({
		agentId: agentId.trim(),
		prompt: prompt.trim(),
	}));
	const items = (input.items ?? []).map((item) => item.trim());
	if (resumeEntries.some((entry) => !entry.agentId || !entry.prompt)) throw new Error("resume_agent_ids keys and prompts must be non-empty");
	if (items.some((item) => !item)) throw new Error("items must contain non-empty strings");
	if (resumeEntries.length === 0 && items.length < 2) {
		throw new Error("AgentSwarm requires at least 2 items unless resume_agent_ids is provided");
	}
	if (resumeEntries.length + items.length > maxSubagents) {
		throw new Error(`AgentSwarm supports at most ${maxSubagents} subagents`);
	}
	const duplicateResume = resumeEntries.find((entry, index) => resumeEntries.findIndex((other) => other.agentId === entry.agentId) !== index);
	if (duplicateResume) throw new Error(`Duplicate resume agent id: ${duplicateResume.agentId}`);
	const template = input.prompt_template?.trim();
	if (items.length > 0 && !template) throw new Error("prompt_template is required when items are provided");
	if (template && !template.includes("{{item}}")) throw new Error("prompt_template must include the {{item}} placeholder");

	const specs: SwarmSpec[] = resumeEntries.map((entry, index) => ({
		kind: "resume",
		index: index + 1,
		agentId: entry.agentId,
		prompt: entry.prompt,
	}));
	const seenPrompts = new Map<string, number>();
	for (const item of items) {
		const prompt = template!.split("{{item}}").join(item);
		const previous = seenPrompts.get(prompt);
		if (previous !== undefined) {
			throw new Error(`Duplicate subagent prompts from items ${previous} and ${seenPrompts.size + 1}`);
		}
		seenPrompts.set(prompt, seenPrompts.size + 1);
		specs.push({ kind: "spawn", index: specs.length + 1, item, prompt });
	}
	return specs;
}

function escapeAttribute(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderSwarm(invocations: Array<{ spec: SwarmSpec; invocation: AgentInvocation }>, cap: number): string {
	const completed = invocations.filter(({ invocation }) => invocation.result?.status === "completed").length;
	const failed = invocations.filter(({ invocation }) => invocation.result?.status === "failed" || invocation.result?.status === "timed_out").length;
	const aborted = invocations.filter(({ invocation }) => invocation.result?.status === "aborted").length;
	const summary = [completed ? `completed: ${completed}` : "", failed ? `failed: ${failed}` : "", aborted ? `aborted: ${aborted}` : ""]
		.filter(Boolean)
		.join(", ");
	const lines = ["<agent_swarm_result>", `<summary>${summary || "no results"}</summary>`];
	if (failed + aborted > 0) {
		lines.push("<resume_hint>Use resume_agent_ids with the agent_id values below to continue unfinished work.</resume_hint>");
	}
	for (const { spec, invocation } of invocations) {
		const result = invocation.result!;
		const item = spec.item === undefined ? "" : ` item=\"${escapeAttribute(spec.item)}\"`;
		const mode = spec.kind === "resume" ? ' mode="resume"' : "";
		const body = capOutput(escapeXmlText(result.result || result.error || "(no output)"), cap);
		lines.push(`<subagent${mode} agent_id="${escapeAttribute(invocation.agentId)}"${item} outcome="${result.status}">${body}</subagent>`);
	}
	lines.push("</agent_swarm_result>");
	return lines.join("\n");
}

function taskSnapshot(service: AgentService, taskId: string): string {
	const task = service.state.getTask(taskId);
	if (!task) throw new Error(`Unknown task id: ${taskId}`);
	const output = capTailOutput(service.state.readOutput(task), Math.min(service.config.subagent.outputCapBytes, 32 * 1024));
	return [
		`task_id: ${task.taskId}`,
		`agent_id: ${task.agentId}`,
		`status: ${task.status}`,
		`description: ${task.description}`,
		`output_path: ${task.outputPath}`,
		task.stopReason ? `stop_reason: ${task.stopReason}` : "",
		"",
		output || "(no output yet)",
	]
		.filter((line) => line !== "")
		.join("\n");
}

async function runSwarm(
	toolCallId: string,
	input: SwarmInput,
	service: AgentService,
	config: PluginConfig,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<{ text: string; details: unknown }> {
	if (!input.description.trim()) throw new Error("description is required");
	const specs = createSwarmSpecs(input, config.swarm.maxSubagents);
	for (const spec of specs) {
		if (spec.kind !== "resume") continue;
		const record = service.state.getAgent(spec.agentId!);
		if (!record) throw new Error(`Unknown agent id: ${spec.agentId}`);
		if (record.status === "running") throw new Error(`Agent ${spec.agentId} is already running`);
	}
	if (specs.some((spec) => spec.kind === "spawn")) resolveModelBinding(config, ctx, input.model);
	const spawnProfile = input.subagent_type ?? "coder";
	if (specs.some((spec) => spec.kind === "spawn")) await service.approveProfiles([spawnProfile], ctx);
	await service.approveResumes(specs.filter((spec) => spec.kind === "resume").map((spec) => spec.agentId!), ctx);
	service.monitor.apply({
		type: "swarm_registered",
		groupId: toolCallId,
		parentToolCallId: toolCallId,
		description: input.description,
		profileName: spawnProfile,
		members: specs.map((spec) => ({
			memberId: `${toolCallId}:${spec.index}`,
			index: spec.index,
			label: spec.item ?? (spec.kind === "resume" ? `resume ${spec.agentId}` : `member ${spec.index}`),
		})),
		at: Date.now(),
	});

	const scheduler = new FleetScheduler({
		initialLaunchLimit: config.swarm.initialLaunchLimit,
		launchIntervalMs: config.swarm.launchIntervalMs,
		maxConcurrency: config.swarm.maxConcurrency,
	});
	const fleetAbort = new AbortController();
	const fleetSignal = signal ? AbortSignal.any([signal, fleetAbort.signal]) : fleetAbort.signal;
	const work: Array<ScheduledWork<{ spec: SwarmSpec; invocation: AgentInvocation }>> = specs.map((spec) => ({
		async run(noteRateLimit) {
			const origin = {
				kind: "swarm" as const,
				parentToolCallId: toolCallId,
				groupId: toolCallId,
				memberId: `${toolCallId}:${spec.index}`,
			};
			const request: AgentRequest =
				spec.kind === "resume"
					? { description: `${input.description} #${spec.index} (resume)`, prompt: spec.prompt, resume: spec.agentId, timeoutMs: config.swarm.timeoutMs, origin }
					: {
							description: `${input.description} #${spec.index} (${spawnProfile})`,
							prompt: spec.prompt,
							subagentType: spawnProfile,
							model: input.model,
							timeoutMs: config.swarm.timeoutMs,
							origin,
						};
			const invocation = await service.invoke(request, ctx, fleetSignal, {
				onRateLimit: (_agentId, message) => noteRateLimit(message),
			});
			return { spec, invocation };
		},
	}));
	try {
		const invocations = await scheduler.run(work, fleetSignal);
		service.monitor.apply({ type: "swarm_finished", groupId: toolCallId, status: "completed" });
		return { text: renderSwarm(invocations, config.subagent.outputCapBytes), details: { invocations } };
	} catch (error) {
		fleetAbort.abort(error);
		service.monitor.apply({
			type: "swarm_finished",
			groupId: toolCallId,
			status: signal?.aborted ? "aborted" : "failed",
		});
		throw error;
	}
}

export function registerCoreTools(
	pi: ExtensionAPI,
	service: AgentService,
	config: PluginConfig,
	prompts: PromptCatalog,
): void {
	const agentModel = modelSchema(config);
	const agentProperties = {
		prompt: Type.String({ description: "Full task prompt for the subagent" }),
		description: Type.String({ description: "Short task description (3-5 words) for UI display" }),
		subagent_type: Type.Optional(Type.String({ description: "Agent profile; defaults to coder. Do not pass when resuming." })),
		resume: Type.Optional(Type.String({ description: "Existing agent ID to resume; mutually exclusive with subagent_type." })),
		run_in_background: Type.Optional(Type.Boolean({ description: "Return immediately and deliver completion automatically." })),
		...(agentModel ? { model: Type.Optional(agentModel) } : {}),
	};
	pi.registerTool({
		name: "Agent",
		label: "Agent",
		description: [
			prompts.tool("Agent"),
			modelPoolDescription(config),
		]
			.filter(Boolean)
			.join("\n\n"),
		parameters: Type.Object(agentProperties, { additionalProperties: false }),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (params.resume?.trim() && params.subagent_type?.trim()) {
				throw new Error("Cannot set subagent_type when resuming an existing agent");
			}
			if (params.run_in_background === true) {
				if (service.isChildSession(ctx)) {
					throw new Error("Child agents cannot launch background grandchildren; use foreground Agent or AgentSwarm so descendants settle before the child exits");
				}
				const active = new Set(pi.getActiveTools());
				if (!["TaskList", "TaskOutput", "TaskStop"].every((name) => active.has(name))) {
					throw new Error("Background agent execution requires TaskList, TaskOutput, and TaskStop to be enabled");
				}
			}
			const watcher = watchToolView(
				service,
				(snapshot) => selectAgentToolView(snapshot, toolCallId),
				(view) => view.phase,
				onUpdate,
			);
			try {
				const invocation = await service.invoke(
					{
						description: params.description,
						prompt: params.prompt,
						subagentType: params.subagent_type,
						resume: params.resume,
						runInBackground: params.run_in_background,
						model: "model" in params ? (params.model as string | undefined) : undefined,
						origin: { kind: "agent", parentToolCallId: toolCallId },
					},
					ctx,
					signal,
				);
				const details = { invocation, view: selectAgentToolView(service.monitor.snapshot(), toolCallId) };
				if (invocation.background) {
					return textResult(
						`Background subagent started.\nagent_id: ${invocation.agentId}\ntask_id: ${invocation.taskId}\nCompletion will be delivered automatically; do not poll.`,
						details,
					);
				}
				return textResult(formatAgentResult(invocation.result!, config.subagent.outputCapBytes), details);
			} finally {
				watcher.dispose();
			}
		},
		renderCall(args, theme) {
			const profile = args.resume ? "resume" : args.subagent_type ?? "coder";
			return singleLineComponent(`${theme.bold(theme.fg("accent", "Agent"))} · ${sanitizeDisplayText(profile)} · ${sanitizeDisplayText(args.description)}`);
		},
		renderResult(result, options, theme) {
			const view = (result.details as { view?: TaskView } | undefined)?.view;
			return agentStatusComponent(view, options.expanded, theme);
		},
	});

	const swarmModel = modelSchema(config);
	const swarmProperties = {
		description: Type.String({ description: "Short description for the whole swarm" }),
		subagent_type: Type.Optional(Type.String({ description: "Profile used for new item-based subagents; defaults to coder" })),
		prompt_template: Type.Optional(Type.String({ description: "Prompt with an exact {{item}} placeholder" })),
		items: Type.Optional(Type.Array(Type.String(), { maxItems: config.swarm.maxSubagents })),
		resume_agent_ids: Type.Optional(Type.Record(Type.String(), Type.String({ description: "Resume prompt" }))),
		...(swarmModel ? { model: Type.Optional(swarmModel) } : {}),
	};
	pi.registerTool({
		name: "AgentSwarm",
		label: "Agent Swarm",
		description: [prompts.tool("AgentSwarm"), modelPoolDescription(config)].filter(Boolean).join("\n\n"),
		parameters: Type.Object(swarmProperties, { additionalProperties: false }),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const watcher = watchToolView(
				service,
				(snapshot) => selectSwarmToolView(snapshot, toolCallId),
				(view) => `${view.counts.queued}:${view.counts.running}:${view.counts.retrying}:${view.counts.completed}:${view.counts.failed}`,
				onUpdate,
			);
			try {
				const { text, details } = await runSwarm(
				toolCallId,
				{
					description: params.description,
					subagent_type: params.subagent_type,
					prompt_template: params.prompt_template,
					items: params.items,
					resume_agent_ids: params.resume_agent_ids,
					model: "model" in params ? (params.model as string | undefined) : undefined,
				},
				service,
				config,
				ctx,
				signal,
				);
				return textResult(text, { ...(details as object), view: selectSwarmToolView(service.monitor.snapshot(), toolCallId) });
			} finally {
				watcher.dispose();
			}
		},
		renderCall(args, theme) {
			const members = (args.items?.length ?? 0) + Object.keys(args.resume_agent_ids ?? {}).length;
			return singleLineComponent(`${theme.bold(theme.fg("accent", "Agent Swarm"))} · ${sanitizeDisplayText(args.description)}${members ? ` · ${members} members` : ""}`);
		},
		renderResult(result, options, theme) {
			const view = (result.details as { view?: SwarmView } | undefined)?.view;
			return swarmStatusComponent(view, options.expanded, theme);
		},
	});

	pi.registerTool({
		name: "TaskList",
		label: "Task List",
		description: prompts.tool("TaskList"),
		parameters: Type.Object(
			{
				active_only: Type.Optional(Type.Boolean({ description: "Only running tasks; defaults to true" })),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Newest tasks to return; defaults to 20" })),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params) {
			const tasks = [...service.state.tasks.values()]
				.filter((task) => task.detached && (!(params.active_only ?? true) || task.status === "running"))
				.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
				.slice(0, params.limit ?? 20);
			const body = tasks.length === 0
				? "No background tasks."
				: tasks.map((task) => `${task.taskId}\t${task.status}\t${task.agentId}\t${task.description}`).join("\n");
			return textResult(body, { tasks });
		},
	});

	pi.registerTool({
		name: "TaskOutput",
		label: "Task Output",
		description: prompts.tool("TaskOutput"),
		parameters: Type.Object({ task_id: Type.String() }, { additionalProperties: false }),
		async execute(_toolCallId, params) {
			return textResult(taskSnapshot(service, params.task_id), service.state.getTask(params.task_id));
		},
	});

	pi.registerTool({
		name: "TaskStop",
		label: "Task Stop",
		description: prompts.tool("TaskStop"),
		parameters: Type.Object(
			{ task_id: Type.String(), reason: Type.Optional(Type.String({ description: "Defaults to Stopped by TaskStop" })) },
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params) {
			const task = await service.stopTask(params.task_id, params.reason?.trim() || "Stopped by TaskStop");
			return textResult(`Stop requested for ${task.taskId}; current status: ${task.status}`, task);
		},
	});
}
