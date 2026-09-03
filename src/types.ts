import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

export type ProfileSource = "builtin" | "user" | "project";

export interface AgentProfile {
	name: string;
	description: string;
	whenToUse?: string;
	tools?: string[];
	disallowedTools?: string[];
	subagents?: string[];
	override: boolean;
	internal?: boolean;
	systemPrompt: string;
	source: ProfileSource;
	filePath: string;
}

export interface ModelPoolEntry {
	model: string;
	description: string;
	thinkingLevel?: ThinkingLevel;
}

export interface SecondaryModelConfig {
	defaultModel?: string;
	models?: Record<string, ModelPoolEntry>;
	force?: boolean;
	defaultThinkingLevel?: ThinkingLevel;
}

export interface PluginConfig {
	subagent: {
		timeoutMs: number;
		summaryMinChars: number;
		summaryRetries: number;
		outputCapBytes: number;
	};
	swarm: {
		timeoutMs: number;
		maxConcurrency?: number;
		maxSubagents: number;
		initialLaunchLimit: number;
		launchIntervalMs: number;
	};
	secondaryModel?: SecondaryModelConfig;
	experimental: {
		tower: boolean;
	};
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
	contextTokens: number;
}

export type AgentRunStatus = "running" | "completed" | "failed" | "aborted" | "timed_out" | "lost";

export interface AgentRecord {
	agentId: string;
	parentSessionId: string;
	profileName: string;
	description: string;
	cwd: string;
	sessionFile: string;
	model: string;
	thinkingLevel: ThinkingLevel;
	createdAt: string;
	updatedAt: string;
	status: AgentRunStatus;
	lastTaskId?: string;
	internalProfile?: boolean;
	projectTrusted?: boolean;
}

export interface TaskRecord {
	taskId: string;
	agentId: string;
	description: string;
	status: AgentRunStatus;
	detached: boolean;
	startedAt: string;
	endedAt?: string;
	stopReason?: string;
	outputPreview: string;
	outputPath: string;
}

export interface SpawnSpec {
	agentId: string;
	parentSessionId: string;
	profile: AgentProfile;
	prompt: string;
	description: string;
	cwd: string;
	sessionFile: string;
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	tools: string[];
	timeoutMs: number;
	summaryMinChars: number;
	summaryRetries: number;
	profileBinding?: ProfileBinding;
	projectTrusted: boolean;
}

export interface ResumeSpec extends Omit<SpawnSpec, "profile" | "model" | "thinkingLevel" | "tools"> {
	profile: AgentProfile;
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	tools: string[];
}

export interface AgentRunResult {
	agentId: string;
	profileName: string;
	status: Exclude<AgentRunStatus, "running" | "lost">;
	result: string;
	error?: string;
	usage: UsageTotals;
	model: string;
	sessionFile: string;
}

export interface AgentHandle {
	agentId: string;
	profileName: string;
	session: AgentSession;
	completion: Promise<AgentRunResult>;
	abort(reason?: string): Promise<void>;
}

export interface RuntimeUpdate {
	agentId: string;
	kind: "text" | "tool" | "retry";
	text: string;
	toolName?: string;
	toolArgs?: unknown;
}

export interface RuntimeHooks {
	onUpdate?(update: RuntimeUpdate): void;
	onRateLimit?(agentId: string, message: string): void;
}

export interface SubagentRuntime {
	spawn(spec: SpawnSpec, signal?: AbortSignal, hooks?: RuntimeHooks): Promise<AgentHandle>;
	resume(spec: ResumeSpec, signal?: AbortSignal, hooks?: RuntimeHooks): Promise<AgentHandle>;
	abort(agentId: string, reason?: string): Promise<void>;
	dispose(): Promise<void>;
}

export interface ModelBinding {
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	alias: string;
	source: "inherited" | "primary" | "secondary" | "forced";
}

export interface ProfileBinding {
	profileName: string;
	allowedSubagents: string[];
}
