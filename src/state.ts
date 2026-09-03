import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PLUGIN_DATA_DIR } from "./config.ts";
import type { AgentRecord, AgentRunResult, TaskRecord } from "./types.ts";

const ENTRY_TYPE = "kimi-like-subagent-state";

interface Snapshot {
	version: 1;
	agents: AgentRecord[];
	tasks: TaskRecord[];
	swarmMode: "off" | "manual" | "task";
	towerMode: boolean;
}

function id(prefix: string): string {
	return `${prefix}-${randomBytes(4).toString("hex")}`;
}

function tail(text: string, max = 4096): string {
	return text.length <= max ? text : text.slice(text.length - max);
}

export class StateStore {
	readonly agents = new Map<string, AgentRecord>();
	readonly tasks = new Map<string, TaskRecord>();
	swarmMode: Snapshot["swarmMode"] = "off";
	towerMode = false;
	private parentSessionId = "unknown";

	private readonly dataDir: string;

	constructor(private readonly pi: ExtensionAPI, options: { dataDir?: string } = {}) {
		this.dataDir = options.dataDir ?? PLUGIN_DATA_DIR;
	}

	restore(ctx: ExtensionContext): void {
		this.parentSessionId = ctx.sessionManager.getSessionId();
		let snapshot: Snapshot | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE) snapshot = entry.data as Snapshot;
		}
		this.agents.clear();
		this.tasks.clear();
		if (snapshot?.version === 1) {
			for (const agent of snapshot.agents) this.agents.set(agent.agentId, { ...agent });
			for (const task of snapshot.tasks) this.tasks.set(task.taskId, { ...task });
			this.swarmMode = snapshot.swarmMode;
			this.towerMode = snapshot.towerMode;
		}
		let changed = false;
		for (const task of this.tasks.values()) {
			if (task.status === "running") {
				task.status = "lost";
				task.endedAt = new Date().toISOString();
				task.stopReason = "Parent process ended before the task settled";
				const agent = this.agents.get(task.agentId);
				if (agent) agent.status = "lost";
				changed = true;
			}
		}
		if (changed) this.persist();
	}

	persist(): void {
		const snapshot: Snapshot = {
			version: 1,
			agents: [...this.agents.values()],
			tasks: [...this.tasks.values()],
			swarmMode: this.swarmMode,
			towerMode: this.towerMode,
		};
		this.pi.appendEntry(ENTRY_TYPE, snapshot);
	}

	newAgentId(): string {
		return id("agent");
	}

	newTaskId(): string {
		return id("task");
	}

	getAgent(agentId: string): AgentRecord | undefined {
		return this.agents.get(agentId);
	}

	getTask(taskId: string): TaskRecord | undefined {
		return this.tasks.get(taskId);
	}

	markAgentRunning(agentId: string, description: string): AgentRecord {
		const agent = this.agents.get(agentId);
		if (!agent) throw new Error(`Unknown agent: ${agentId}`);
		agent.status = "running";
		agent.description = description;
		agent.updatedAt = new Date().toISOString();
		this.persist();
		return agent;
	}

	getParentSessionId(): string {
		return this.parentSessionId;
	}

	sessionFile(agentId: string): string {
		const dir = path.join(this.dataDir, "sessions", this.parentSessionId);
		mkdirSync(dir, { recursive: true });
		return path.join(dir, `${agentId}.jsonl`);
	}

	createAgent(record: Omit<AgentRecord, "parentSessionId" | "createdAt" | "updatedAt">): AgentRecord {
		const now = new Date().toISOString();
		const full: AgentRecord = { ...record, parentSessionId: this.parentSessionId, createdAt: now, updatedAt: now };
		this.agents.set(full.agentId, full);
		this.persist();
		return full;
	}

	createTask(agentId: string, description: string, detached: boolean): TaskRecord {
		const taskId = this.newTaskId();
		const outputDir = path.join(this.dataDir, "tasks", this.parentSessionId, taskId);
		mkdirSync(outputDir, { recursive: true });
		const task: TaskRecord = {
			taskId,
			agentId,
			description,
			status: "running",
			detached,
			startedAt: new Date().toISOString(),
			outputPreview: "",
			outputPath: path.join(outputDir, "output.log"),
		};
		this.tasks.set(taskId, task);
		const agent = this.agents.get(agentId);
		if (agent) agent.lastTaskId = taskId;
		this.persist();
		return task;
	}

	appendTaskOutput(taskId: string, text: string): void {
		const task = this.tasks.get(taskId);
		if (!task || !text) return;
		mkdirSync(path.dirname(task.outputPath), { recursive: true });
		appendFileSync(task.outputPath, text, "utf8");
		task.outputPreview = tail(task.outputPreview + text);
	}

	finishTask(taskId: string, result: AgentRunResult): TaskRecord | undefined {
		const task = this.tasks.get(taskId);
		if (!task) return undefined;
		task.status = result.status;
		task.endedAt = new Date().toISOString();
		task.stopReason = result.error;
		const hasStreamedOutput = existsSync(task.outputPath) && statSync(task.outputPath).size > 0;
		if (result.result && !hasStreamedOutput) this.appendTaskOutput(taskId, result.result);
		const agent = this.agents.get(result.agentId);
		if (agent) {
			agent.status = result.status;
			agent.updatedAt = task.endedAt;
		}
		this.persist();
		return task;
	}

	readOutput(task: TaskRecord): string {
		if (!existsSync(task.outputPath)) return task.outputPreview;
		try {
			return readFileSync(task.outputPath, "utf8");
		} catch {
			return task.outputPreview;
		}
	}

	markLiveTasksLost(reason: string): void {
		let changed = false;
		for (const task of this.tasks.values()) {
			if (task.status !== "running") continue;
			task.status = "lost";
			task.endedAt = new Date().toISOString();
			task.stopReason = reason;
			const agent = this.agents.get(task.agentId);
			if (agent) agent.status = "lost";
			changed = true;
		}
		if (changed) this.persist();
	}
}
