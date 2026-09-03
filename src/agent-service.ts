import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { resolveModelBinding } from "./model-binding.ts";
import { discoverProfiles, effectiveTools } from "./profiles.ts";
import { PiAgentSessionRuntime } from "./runtime.ts";
import { StateStore } from "./state.ts";
import type {
	AgentHandle,
	AgentProfile,
	AgentRecord,
	AgentRunResult,
	PluginConfig,
	ProfileBinding,
	RuntimeHooks,
	RuntimeUpdate,
	SubagentRuntime,
	TaskRecord,
} from "./types.ts";

export interface AgentRequest {
	description: string;
	prompt?: string;
	subagentType?: string;
	resume?: string;
	runInBackground?: boolean;
	model?: string;
	timeoutMs?: number;
	cwd?: string;
	internalProfile?: boolean;
	forcePrimary?: boolean;
	projectTrusted?: boolean;
}

export interface AgentInvocation {
	background: boolean;
	agentId: string;
	taskId: string;
	profileName: string;
	result?: AgentRunResult;
}

export interface AgentInvocationHooks extends RuntimeHooks {
	onTaskUpdate?(task: TaskRecord, update: RuntimeUpdate): void;
}

const PROFILE_BINDING_ENTRY = "kimi-like-subagent-profile-binding";
const DELEGATION_TOOLS = new Set(["Agent", "AgentSwarm", "TaskList", "TaskOutput", "TaskStop"]);

function parseModel(value: string, ctx: ExtensionContext): Model<Api> {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) throw new Error(`Invalid stored model reference: ${value}`);
	const model = ctx.modelRegistry.find(value.slice(0, slash), value.slice(slash + 1));
	if (!model) throw new Error(`Stored model is no longer available: ${value}`);
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error(`No configured authentication for stored model: ${value}`);
	return model;
}

function currentBinding(ctx: ExtensionContext): ProfileBinding | undefined {
	let binding: ProfileBinding | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === PROFILE_BINDING_ENTRY) binding = entry.data as ProfileBinding;
	}
	return binding;
}

function allowedBy(binding: ProfileBinding | undefined, profileName: string): boolean {
	if (!binding) return true;
	return binding.allowedSubagents.includes("*") || binding.allowedSubagents.includes(profileName);
}

function delegationExplicit(profile: AgentProfile): boolean {
	return profile.source === "builtin" || profile.tools?.some((name) => name === "*" || DELEGATION_TOOLS.has(name)) === true;
}

function profileBinding(profile: AgentProfile): ProfileBinding {
	return {
		profileName: profile.name,
		allowedSubagents: profile.subagents ?? ["coder", "explore", "plan"],
	};
}

function bytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

export function capOutput(text: string, maxBytes: number): string {
	if (bytes(text) <= maxBytes) return text;
	const marker = `\n\n[output truncated to ${maxBytes} bytes]`;
	const budget = Math.max(0, maxBytes - bytes(marker));
	let end = Math.min(text.length, budget);
	while (end > 0 && bytes(text.slice(0, end)) > budget) end--;
	return text.slice(0, end) + marker;
}

export function capTailOutput(text: string, maxBytes: number): string {
	if (bytes(text) <= maxBytes) return text;
	const fullMarker = "[older output truncated]\n";
	const marker = bytes(fullMarker) < maxBytes ? fullMarker : "";
	const budget = Math.max(0, maxBytes - bytes(marker));
	let start = Math.max(0, text.length - budget);
	while (start < text.length && bytes(text.slice(start)) > budget) start++;
	return marker + text.slice(start);
}

export function escapeXmlText(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeXmlAttribute(value: string): string {
	return escapeXmlText(value).replaceAll('"', "&quot;");
}

export function formatAgentResult(result: AgentRunResult, maxBytes: number): string {
	const body = capOutput(escapeXmlText(result.result || result.error || "(no output)"), maxBytes);
	return [
		`<agent_result agent_id="${escapeXmlAttribute(result.agentId)}" profile="${escapeXmlAttribute(result.profileName)}" status="${result.status}">`,
		body,
		`<usage input="${result.usage.input}" output="${result.usage.output}" cache_read="${result.usage.cacheRead}" cost="${result.usage.cost.toFixed(6)}" turns="${result.usage.turns}" />`,
		`</agent_result>`,
	].join("\n");
}

export class AgentService {
	readonly state: StateStore;
	readonly runtime: SubagentRuntime;
	private closing = false;
	private readonly approvedProjectProfiles = new Set<string>();
	private internalResumeGuard?: (record: AgentRecord, ctx: ExtensionContext) => Promise<void>;

	constructor(
		private readonly pi: ExtensionAPI,
		readonly config: PluginConfig,
		private readonly extensionRoot: string,
		runtime?: SubagentRuntime,
		state?: StateStore,
	) {
		this.runtime = runtime ?? new PiAgentSessionRuntime();
		this.state = state ?? new StateStore(pi);
	}

	restore(ctx: ExtensionContext): void {
		this.closing = false;
		this.state.restore(ctx);
	}

	isChildSession(ctx: ExtensionContext): boolean {
		return currentBinding(ctx) !== undefined;
	}

	setInternalResumeGuard(guard: (record: AgentRecord, ctx: ExtensionContext) => Promise<void>): void {
		this.internalResumeGuard = guard;
	}

	private visibleProfileCatalog(ctx: ExtensionContext): AgentProfile[] {
		const safe = discoverProfiles(this.extensionRoot, ctx.cwd, { includeProject: false }).profiles;
		const profiles = ctx.isProjectTrusted()
			? discoverProfiles(this.extensionRoot, ctx.cwd).profiles
			: [
					...safe,
					...discoverProfiles(this.extensionRoot, ctx.cwd).profiles.filter(
						(profile) => profile.source === "project" && this.approvedProjectProfiles.has(profile.filePath),
					),
				];
		return [...new Map(profiles.map((profile) => [profile.name, profile])).values()];
	}

	profiles(ctx: ExtensionContext): AgentProfile[] {
		const binding = currentBinding(ctx);
		return this.visibleProfileCatalog(ctx).filter(
			(profile) => !profile.internal && allowedBy(binding, profile.name),
		);
	}

	private resolveProfile(name: string, ctx: ExtensionContext, allowInternal = false, bypassAllowlist = false): AgentProfile {
		const visible = this.visibleProfileCatalog(ctx).find((candidate) => candidate.name === name);
		const projectOnly = discoverProfiles(this.extensionRoot, ctx.cwd).profiles.find(
			(candidate) => candidate.name === name && candidate.source === "project",
		);
		const profile = visible ?? projectOnly;
		if (!profile) throw new Error(`Unknown subagent type: ${name}. Available: ${this.profiles(ctx).map((item) => item.name).join(", ") || "none"}`);
		if (profile.internal && !allowInternal) throw new Error(`Subagent type ${name} is reserved for plugin workflows`);
		const binding = currentBinding(ctx);
		if (!bypassAllowlist && !allowedBy(binding, profile.name)) {
			throw new Error(`Subagent ${binding?.profileName ?? "current"} is not allowed to launch profile: ${profile.name}`);
		}
		return profile;
	}

	async approveProfiles(names: string[], ctx: ExtensionContext): Promise<void> {
		const profiles = [...new Set(names)].map((name) => this.resolveProfile(name, ctx));
		await this.approveResolvedProfiles(profiles, ctx);
	}

	async approveResumes(agentIds: string[], ctx: ExtensionContext): Promise<void> {
		const catalog = discoverProfiles(this.extensionRoot, ctx.cwd).profiles;
		const profiles = [...new Set(agentIds)].map((agentId) => {
			const record = this.state.getAgent(agentId);
			if (!record) throw new Error(`Unknown agent id: ${agentId}`);
			const profile = catalog.find((candidate) => candidate.name === record.profileName);
			if (!profile) throw new Error(`Profile for resumed agent ${agentId} is no longer available: ${record.profileName}`);
			return profile;
		});
		await this.approveResolvedProfiles(profiles, ctx);
	}

	private async approveResolvedProfiles(profiles: AgentProfile[], ctx: ExtensionContext): Promise<void> {
		const unapproved = profiles.filter(
			(profile) => profile.source === "project" && !ctx.isProjectTrusted() && !this.approvedProjectProfiles.has(profile.filePath),
		);
		if (unapproved.length === 0) return;
		if (!ctx.hasUI) {
			throw new Error(`Project-local agents require interactive approval: ${unapproved.map((item) => item.name).join(", ")}`);
		}
		const ok = await ctx.ui.confirm(
			"Run project-local agents?",
			`Agents: ${unapproved.map((item) => item.name).join(", ")}\n\nThese profiles are controlled by the repository.`,
		);
		if (!ok) throw new Error("Project-local agent execution was not approved");
		for (const profile of unapproved) this.approvedProjectProfiles.add(profile.filePath);
	}

	private toolsFor(profile: AgentProfile): string[] {
		let tools = effectiveTools(
			profile,
			this.pi.getActiveTools(),
			this.pi.getAllTools().map((tool) => tool.name),
		);
		if (!delegationExplicit(profile)) tools = tools.filter((tool) => !DELEGATION_TOOLS.has(tool));
		return tools;
	}

	private hooks(task: TaskRecord, external?: AgentInvocationHooks): RuntimeHooks {
		return {
			onRateLimit: external?.onRateLimit,
			onUpdate: (update) => {
				const line = update.kind === "text" ? update.text : `\n[${update.kind}] ${update.text}\n`;
				this.state.appendTaskOutput(task.taskId, line);
				external?.onUpdate?.(update);
				external?.onTaskUpdate?.(task, update);
			},
		};
	}

	private failed(record: AgentRecord, message: string): AgentRunResult {
		return {
			agentId: record.agentId,
			profileName: record.profileName,
			status: "failed",
			result: "",
			error: message,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 },
			model: record.model,
			sessionFile: record.sessionFile,
		};
	}

	private settle(handle: AgentHandle, task: TaskRecord, notify: boolean): Promise<AgentRunResult> {
		return handle.completion.then((result) => {
			this.state.finishTask(task.taskId, result);
			if (notify && !this.closing) {
				this.pi.sendMessage(
					{
						customType: "kimi-like-subagent-notification",
						content: `Background subagent ${result.agentId} (${result.profileName}) ${result.status}.\n${formatAgentResult(result, this.config.subagent.outputCapBytes)}`,
						display: true,
						details: { agentId: result.agentId, taskId: task.taskId, status: result.status },
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
			}
			return result;
		});
	}

	async invoke(
		request: AgentRequest,
		ctx: ExtensionContext,
		signal?: AbortSignal,
		externalHooks?: AgentInvocationHooks,
	): Promise<AgentInvocation> {
		if (!request.description.trim()) throw new Error("description is required");
		const detached = request.runInBackground === true;
		let profile: AgentProfile;
		let record: AgentRecord;
		let handle: AgentHandle;

		if (request.resume) {
			record = this.state.getAgent(request.resume)!;
			if (!record) throw new Error(`Unknown agent id: ${request.resume}`);
			if (record.status === "running") throw new Error(`Agent ${record.agentId} is already running`);
			if (record.internalProfile === true && request.internalProfile !== true) {
				if (!this.internalResumeGuard) throw new Error(`Internal agent ${record.agentId} can only be resumed by its owning workflow`);
				await this.internalResumeGuard(record, ctx);
			}
			profile = this.resolveProfile(record.profileName, ctx, record.internalProfile === true, true);
			if (profile.source === "project") await this.approveProfiles([profile.name], ctx);
			const model = parseModel(record.model, ctx);
			this.state.markAgentRunning(record.agentId, request.description);
			const task = this.state.createTask(record.agentId, request.description, detached);
			try {
				handle = await this.runtime.resume(
					{
						agentId: record.agentId,
						parentSessionId: record.parentSessionId,
						profile,
						prompt: request.prompt?.trim() || request.description,
						description: request.description,
						cwd: record.cwd,
						sessionFile: record.sessionFile,
						model,
						thinkingLevel: record.thinkingLevel,
						tools: this.toolsFor(profile),
						timeoutMs: request.timeoutMs ?? this.config.subagent.timeoutMs,
						summaryMinChars: this.config.subagent.summaryMinChars,
						summaryRetries: this.config.subagent.summaryRetries,
						profileBinding: profileBinding(profile),
						projectTrusted: record.projectTrusted === true && ctx.isProjectTrusted(),
					},
					detached ? undefined : signal,
					this.hooks(task, externalHooks),
				);
			} catch (error) {
				const result = this.failed(record, error instanceof Error ? error.message : String(error));
				this.state.finishTask(task.taskId, result);
				return { background: false, agentId: record.agentId, taskId: task.taskId, profileName: profile.name, result };
			}
			const completion = this.settle(handle, task, detached);
			if (detached) return { background: true, agentId: record.agentId, taskId: task.taskId, profileName: profile.name };
			return { background: false, agentId: record.agentId, taskId: task.taskId, profileName: profile.name, result: await completion };
		}

		if (!request.prompt?.trim()) throw new Error("prompt is required when starting a new agent");
		profile = this.resolveProfile(request.subagentType ?? "coder", ctx, request.internalProfile === true);
		if (profile.source === "project") await this.approveProfiles([profile.name], ctx);
		const binding = request.forcePrimary
			? resolveModelBinding({ ...this.config, secondaryModel: undefined }, ctx, "primary")
			: resolveModelBinding(this.config, ctx, request.model);
		const agentId = this.state.newAgentId();
		const sessionFile = this.state.sessionFile(agentId);
		const childCwd = request.cwd ?? ctx.cwd;
		const projectTrusted = request.projectTrusted ?? ctx.isProjectTrusted();
		record = this.state.createAgent({
			agentId,
			profileName: profile.name,
			description: request.description,
			cwd: childCwd,
			sessionFile,
			model: `${binding.model.provider}/${binding.model.id}`,
			thinkingLevel: binding.thinkingLevel as ThinkingLevel,
			status: "running",
			internalProfile: request.internalProfile,
			projectTrusted,
		});
		const task = this.state.createTask(agentId, request.description, detached);
		try {
			handle = await this.runtime.spawn(
				{
					agentId,
					parentSessionId: this.state.getParentSessionId(),
					profile,
					prompt: request.prompt,
					description: request.description,
					cwd: childCwd,
					sessionFile,
					model: binding.model,
					thinkingLevel: binding.thinkingLevel,
					tools: this.toolsFor(profile),
					timeoutMs: request.timeoutMs ?? this.config.subagent.timeoutMs,
					summaryMinChars: this.config.subagent.summaryMinChars,
					summaryRetries: this.config.subagent.summaryRetries,
					profileBinding: profileBinding(profile),
					projectTrusted,
				},
				detached ? undefined : signal,
				this.hooks(task, externalHooks),
			);
		} catch (error) {
			const result = this.failed(record, error instanceof Error ? error.message : String(error));
			this.state.finishTask(task.taskId, result);
			return { background: false, agentId, taskId: task.taskId, profileName: profile.name, result };
		}
		const completion = this.settle(handle, task, detached);
		if (detached) return { background: true, agentId, taskId: task.taskId, profileName: profile.name };
		return { background: false, agentId, taskId: task.taskId, profileName: profile.name, result: await completion };
	}

	async stopTask(taskId: string, reason = "Stopped by parent"): Promise<TaskRecord> {
		const task = this.state.getTask(taskId);
		if (!task) throw new Error(`Unknown task id: ${taskId}`);
		if (task.status !== "running") return task;
		await this.runtime.abort(task.agentId, reason);
		return task;
	}

	async shutdown(): Promise<void> {
		this.closing = true;
		await this.runtime.dispose();
		this.state.markLiveTasksLost("Parent session closed before the task settled");
	}
}
