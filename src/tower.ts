import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, lstatSync } from "node:fs";
import * as path from "node:path";
import type { AgentInvocation, AgentService } from "./agent-service.ts";
import type { PromptCatalog } from "./prompts.ts";
import { matchesScope, TowerStore, type MissionPlanInput, type TowerMission, type TowerReviewWorkspace } from "./tower-store.ts";

function result(text: string, details: unknown = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

async function storeAndActor(ctx: ExtensionContext): Promise<{ store: TowerStore; actor: string }> {
	const store = await TowerStore.fromCwd(ctx.cwd);
	const actor = store.actor(ctx.cwd);
	if (actor === "tower") await store.assertOwner(ctx.sessionManager.getSessionId());
	else await store.assertParticipant();
	return { store, actor };
}

export function pathContainsSymlink(base: string, target: string): boolean {
	if (existsSync(base) && lstatSync(base).isSymbolicLink()) return true;
	const relative = path.relative(path.resolve(base), path.resolve(target));
	if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) return false;
	let current = path.resolve(base);
	for (const segment of relative.split(path.sep)) {
		current = path.join(current, segment);
		if (!existsSync(current)) return false;
		if (lstatSync(current).isSymbolicLink()) return true;
	}
	return false;
}

function missionBriefing(name: string, mission: TowerMission, worktree: string, base: string, extra?: string): string {
	const survey = mission.kind === "survey";
	return [
		`You are "${name}", a Tower worker assigned to mission ${mission.id}.`,
		`Worktree: ${worktree}`,
		`Branch: ${mission.branch} (base: ${base}${mission.spawnBase ? `; WIP snapshot: ${mission.spawnBase}` : ""})`,
		`Mission: ${mission.title}`,
		`${survey ? "Investigation scope (strictly read-only)" : "Only files matching these globs may be changed"}: ${mission.scope.join(", ")}`,
		mission.tasks.length ? `Tasks:\n${mission.tasks.map((task) => `- ${task.text}`).join("\n")}` : "",
		mission.deps.length ? `Dependencies: ${mission.deps.join(", ")}` : "",
		"Coordinate only with TowerSend/TowerInbox/TowerFinding/TowerMission/TowerStatus. Never edit .tower by hand.",
		survey
			? `Do not modify or commit repository files. When done call TowerMission(id="${mission.id}", status="completed") and send the tower a survey summary.`
			: `Commit your changes, call TowerMission(id="${mission.id}", status="completed"), then send the tower a review request.`,
		extra?.trim() ? `Additional instructions:\n${extra.trim()}` : "",
		"Finish with a self-contained summary including files, checks, results, and remaining concerns.",
	]
		.filter(Boolean)
		.join("\n\n");
}

function reviewerBriefing(name: string, workspace: TowerReviewWorkspace, author: string | undefined, extra?: string): string {
	return [
		`You are "${name}", a read-only Tower reviewer. Review branch ${workspace.mission.branch} at exact tip ${workspace.targetCommit} against ${workspace.base}.`,
		"The harness gives you a detached worktree at the target tip and no shell/write tools. Read relevant files and inspect the supplied patch. Do not modify code or .tower files.",
		"Prioritize correctness, security/data integrity, error handling, performance, tests, and maintainability.",
		`Submit the exact-tip verdict with TowerReview(target="${workspace.mission.branch}", status="clean" or "p1-Nitems"/"p2-Nitems", merge=..., findings=..., checks=..., decision=...).`,
		`Notify ${author ?? "tower"} with TowerSend after filing the verdict.`,
		extra?.trim() ? `Additional instructions:\n${extra.trim()}` : "",
		`Diff stat:\n${workspace.diffStat || "(no changed files)"}`,
		`Patch (${workspace.base}...${workspace.mission.branch}):\n<review_patch>\n${workspace.patch || "(empty)"}\n</review_patch>`,
	]
		.filter(Boolean)
		.join("\n\n");
}

function runningFleetEntries(store: TowerStore, service: AgentService, branch?: string) {
	const state = store.load();
	return state.roster.filter((entry) => {
		if (branch && entry.branch !== branch && entry.reviewTarget !== branch) return false;
		return service.state.getAgent(entry.agentId)?.status === "running" || service.state.getTask(entry.taskId)?.status === "running";
	});
}

async function towerStatus(store: TowerStore, service: AgentService): Promise<string> {
	const { state, recentActivity } = store.status();
	const missions = state.missions.length
		? state.missions.map((mission) => `${mission.id}\t${mission.status}\t${mission.kind}\t${mission.owner ?? "—"}\t${mission.title}`).join("\n")
		: "(no missions)";
	const agents = state.roster.length
		? state.roster
				.map((entry) => `${entry.name}\t${entry.kind}\t${service.state.getAgent(entry.agentId)?.status ?? service.state.getTask(entry.taskId)?.status ?? "unknown"}\t${entry.agentId}`)
				.join("\n")
		: "(no agents)";
	return [`base: ${state.base}`, "", "missions:", missions, "", "roster:", agents, "", "recent activity:", recentActivity.join("\n") || "(none)"].join("\n");
}

export function registerTower(pi: ExtensionAPI, service: AgentService, prompts: PromptCatalog): void {
	service.setInternalResumeGuard(async (record, ctx) => {
		const store = await TowerStore.fromCwd(ctx.cwd);
		if (store.actor(ctx.cwd) !== "tower") throw new Error("Tower agents can only be resumed by the owning main session");
		await store.assertOwner(ctx.sessionManager.getSessionId());
		if (!store.load().roster.some((entry) => entry.agentId === record.agentId)) {
			throw new Error(`Internal agent ${record.agentId} is not registered in the active Tower roster`);
		}
	});

	pi.registerTool({
		name: "TowerInit",
		label: "Tower Init",
		description: prompts.tool("TowerInit"),
		executionMode: "sequential",
		parameters: Type.Object({ base: Type.Optional(Type.String()) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const store = await TowerStore.fromCwd(ctx.cwd);
			const initialized = await store.init(ctx.sessionManager.getSessionId(), params.base);
			service.state.towerMode = true;
			service.state.persist();
			return result(
				`${initialized.created ? "Initialized" : "Reused"} Tower workspace.\nbase: ${initialized.state.base}\ncheckout: ${initialized.checkout}\nretired stale agents: ${initialized.retiredAgents.join(", ") || "none"}\nstate: ${store.root}/.tower/comms/state.json`,
				initialized,
			);
		},
	});

	const missionSchema = Type.Object(
		{
			title: Type.String(),
			scope: Type.Array(Type.String(), { minItems: 1 }),
			tasks: Type.Optional(Type.Array(Type.String())),
			deps: Type.Optional(Type.Array(Type.String())),
			kind: Type.Optional(StringEnum(["build", "survey"] as const)),
		},
		{ additionalProperties: false },
	);
	pi.registerTool({
		name: "TowerPlan",
		label: "Tower Plan",
		description: prompts.tool("TowerPlan"),
		executionMode: "sequential",
		parameters: Type.Object({ missions: Type.Array(missionSchema, { minItems: 1 }) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const { store, actor } = await storeAndActor(ctx);
			if (actor !== "tower") throw new Error("Only the tower may plan missions");
			const missions = await store.plan(params.missions as MissionPlanInput[]);
			return result(missions.map((mission) => `${mission.id}: ${mission.title}\n  kind: ${mission.kind}\n  branch: ${mission.branch}\n  scope: ${mission.scope.join(", ")}`).join("\n"), { missions });
		},
	});

	pi.registerTool({
		name: "TowerSpawn",
		label: "Tower Spawn",
		description: prompts.tool("TowerSpawn"),
		executionMode: "sequential",
		parameters: Type.Object(
			{
				name: Type.String(),
				kind: StringEnum(["worker", "reviewer"] as const),
				mission_id: Type.Optional(Type.String()),
				review_target: Type.Optional(Type.String()),
				instructions: Type.Optional(Type.String()),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, _signal, _update, ctx) {
			const { store, actor } = await storeAndActor(ctx);
			if (actor !== "tower") throw new Error("Only the tower may spawn fleet agents");
			const state = store.load();
			if (state.roster.some((entry) => entry.name === params.name)) throw new Error(`Tower agent name already exists: ${params.name}`);
			let prompt: string;
			let cwd: string;
			let profile: string;
			let mission: TowerMission | undefined;
			let reviewTarget: string | undefined;
			let reviewWorkspace: TowerReviewWorkspace | undefined;
			if (params.kind === "worker") {
				if (!params.mission_id?.trim()) throw new Error("worker spawns require mission_id");
				const added = await store.addMissionWorktree(params.mission_id);
				mission = added.mission;
				cwd = added.worktree;
				profile = mission.kind === "survey" ? "tower-surveyor" : "tower-worker";
				prompt = missionBriefing(params.name, mission, cwd, state.base, params.instructions);
			} else {
				if (!params.review_target?.trim()) throw new Error("reviewer spawns require review_target");
				reviewTarget = params.review_target.trim();
				reviewWorkspace = await store.addReviewWorktree(params.name, reviewTarget);
				mission = reviewWorkspace.mission;
				cwd = reviewWorkspace.worktree;
				profile = "tower-reviewer";
				prompt = reviewerBriefing(params.name, reviewWorkspace, mission.owner, params.instructions);
			}
			await store.registerAgent({
				name: params.name,
				agentId: "pending",
				taskId: "pending",
				kind: params.kind,
				missionId: params.kind === "worker" ? mission?.id : undefined,
				reviewTarget,
				worktree: cwd,
				branch: mission?.branch,
				spawnedAt: new Date().toISOString(),
			});
			let invocation: AgentInvocation;
			try {
				invocation = await service.invoke(
					{
						description: `tower ${params.kind} ${params.name}`,
						prompt,
						subagentType: profile,
						runInBackground: true,
						cwd,
						internalProfile: true,
						forcePrimary: params.kind === "reviewer" && service.config.secondaryModel?.force !== true,
						projectTrusted: params.kind === "reviewer" ? false : undefined,
					},
					ctx,
				);
				if (!invocation.background) throw new Error(invocation.result?.error ?? "Tower subagent failed to start");
				await store.finalizeAgent(params.name, invocation.agentId, invocation.taskId);
			} catch (error) {
				await store.unregisterAgent(params.name);
				if (reviewWorkspace) await store.removeWorktree(reviewWorkspace.worktree);
				throw error;
			}
			return result(
				[
					`name: ${params.name}`,
					`kind: ${params.kind}`,
					`agent_id: ${invocation.agentId}`,
					`task_id: ${invocation.taskId}`,
					`status: running`,
					mission ? `mission: ${mission.id}` : "",
					mission ? `branch: ${mission.branch}` : "",
					`worktree: ${cwd}`,
					"Completion will arrive automatically; do not poll.",
				]
					.filter(Boolean)
					.join("\n"),
				invocation,
			);
		},
	});

	pi.registerTool({
		name: "TowerMerge",
		label: "Tower Merge",
		description: prompts.tool("TowerMerge"),
		executionMode: "sequential",
		parameters: Type.Object({ branch: Type.String() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const { store, actor } = await storeAndActor(ctx);
			if (actor !== "tower") throw new Error("Only the tower may merge branches");
			const running = runningFleetEntries(store, service, params.branch);
			if (running.length) throw new Error(`Merge blocked: Tower agents are still running: ${running.map((entry) => entry.name).join(", ")}`);
			const merged = await store.merge(params.branch);
			return result(`${merged.noop ? "Closed survey" : "Merged"} ${params.branch} at ${merged.mergeCommit}\nchanged: ${merged.changed.join(", ") || "none"}`, merged);
		},
	});

	pi.registerTool({
		name: "TowerTeardown",
		label: "Tower Teardown",
		description: prompts.tool("TowerTeardown"),
		executionMode: "sequential",
		parameters: Type.Object({ force: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const { store, actor } = await storeAndActor(ctx);
			if (actor !== "tower") throw new Error("Only the tower may tear down worktrees");
			const running = runningFleetEntries(store, service);
			if (running.length) throw new Error(`Teardown blocked: Tower agents are still running: ${running.map((entry) => entry.name).join(", ")}`);
			const report = await store.teardown(params.force === true);
			return result(report.join("\n") || "No worktrees to remove. Audit data and branches were retained.", { report });
		},
	});

	pi.registerTool({
		name: "TowerSend",
		label: "Tower Send",
		description: prompts.tool("TowerSend"),
		parameters: Type.Object(
			{
				to: Type.String(),
				subject: Type.String(),
				body: Type.String(),
				scope: Type.Optional(Type.String()),
				action: Type.Optional(Type.String()),
				consent_ref: Type.Optional(Type.String()),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, _signal, _update, ctx) {
			const { store, actor } = await storeAndActor(ctx);
			const file = store.send(actor, { ...params, consentRef: params.consent_ref });
			return result(`Message sent: ${file}`, { file });
		},
	});

	pi.registerTool({
		name: "TowerInbox",
		label: "Tower Inbox",
		description: prompts.tool("TowerInbox"),
		parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1 })) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const { store, actor } = await storeAndActor(ctx);
			const messages = store.inbox(actor, params.limit ?? 20);
			return result(messages.length ? JSON.stringify(messages, null, 2) : "Inbox empty.", { messages });
		},
	});

	pi.registerTool({
		name: "TowerFinding",
		label: "Tower Finding",
		description: prompts.tool("TowerFinding"),
		parameters: Type.Object(
			{
				type: StringEnum(["bug", "improve", "vuln", "idea"] as const),
				title: Type.String(),
				severity: Type.Optional(StringEnum(["low", "medium", "high", "critical"] as const)),
				summary: Type.String(),
				location: Type.Optional(Type.String()),
				details: Type.String(),
				suggested_fix: Type.String(),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, _signal, _update, ctx) {
			const { store, actor } = await storeAndActor(ctx);
			const file = store.finding(actor, params);
			return result(`Finding filed: ${file}`, { file });
		},
	});

	pi.registerTool({
		name: "TowerReview",
		label: "Tower Review",
		description: prompts.tool("TowerReview"),
		executionMode: "sequential",
		parameters: Type.Object(
			{
				target: Type.String(),
				status: Type.String({ pattern: "^(clean|p[12]-\\d+items)$" }),
				merge: StringEnum(["merge", "fix-then-merge", "hold"] as const),
				findings: Type.String(),
				checks: Type.Optional(Type.Array(Type.String())),
				decision: Type.String(),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, _signal, _update, ctx) {
			const { store, actor } = await storeAndActor(ctx);
			const review = await store.review(actor, params);
			return result(`Review round ${review.round} submitted for ${review.target} at ${review.reviewedCommit}`, review);
		},
	});

	pi.registerTool({
		name: "TowerMission",
		label: "Tower Mission",
		description: prompts.tool("TowerMission"),
		executionMode: "sequential",
		parameters: Type.Object(
			{
				id: Type.String(),
				status: Type.Optional(StringEnum(["planned", "active", "completed", "blocked", "paused", "merged", "abandoned"] as const)),
				note: Type.Optional(Type.String()),
				blocker: Type.Optional(Type.String()),
				clear_blockers: Type.Optional(Type.Boolean()),
				task_done: Type.Optional(Type.String()),
				scope: Type.Optional(Type.Array(Type.String())),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, _signal, _update, ctx) {
			const { store, actor } = await storeAndActor(ctx);
			const mission = await store.updateMission(actor, params.id, {
				status: params.status,
				note: params.note,
				blocker: params.blocker,
				clearBlockers: params.clear_blockers,
				taskDone: params.task_done,
				scope: params.scope,
			});
			return result(`${mission.id}: ${mission.status}\nowner: ${mission.owner ?? "none"}\nscope: ${mission.scope.join(", ")}\nblockers: ${mission.blockers.join("; ") || "none"}`, mission);
		},
	});

	pi.registerTool({
		name: "TowerStatus",
		label: "Tower Status",
		description: prompts.tool("TowerStatus"),
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_id, _params, _signal, _update, ctx) {
			const { store } = await storeAndActor(ctx);
			return result(await towerStatus(store, service), store.status());
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		let boundProfile: string | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "kimi-like-subagent-profile-binding") {
				boundProfile = (entry.data as { profileName?: string } | undefined)?.profileName;
			}
		}
		if (boundProfile !== "tower-worker" && boundProfile !== "tower-reviewer" && boundProfile !== "tower-surveyor") return;
		try {
			const store = await TowerStore.fromCwd(ctx.cwd);
			const state = store.load();
			const actor = store.actor(ctx.cwd, state);
			if (actor === "tower") return;
			const roster = state.roster.find((entry) => entry.name === actor);
			if (roster?.kind !== "worker" || !roster.missionId || !roster.worktree) {
				return { block: true, reason: "Tower reviewers are read-only" };
			}
			const rawPath = String((event.input as Record<string, unknown>).path ?? "");
			const target = path.resolve(ctx.cwd, rawPath);
			const relative = path.relative(roster.worktree, target).replaceAll("\\", "/");
			if (!relative || relative.startsWith("../") || path.isAbsolute(relative) || relative.split("/").includes(".tower")) {
				return { block: true, reason: `Tower worker writes must stay inside ${roster.worktree}` };
			}
			if (pathContainsSymlink(roster.worktree, target)) {
				return { block: true, reason: `Tower worker writes cannot traverse symlinks: ${relative}` };
			}
			const mission = state.missions.find((candidate) => candidate.id === roster.missionId)!;
			if (mission.kind === "survey") return { block: true, reason: `Survey mission ${mission.id} is read-only` };
			if (!mission.scope.some((glob) => matchesScope(relative, glob))) {
				return { block: true, reason: `${relative} is outside mission ${mission.id} scope: ${mission.scope.join(", ")}` };
			}
		} catch (error) {
			return {
				block: true,
				reason: `Tower write guard could not verify this path: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	});

	pi.registerCommand("tower", {
		description: "Control experimental Tower mode: /tower on, off, status, teardown",
		handler: async (args, ctx) => {
			const action = args.trim() || "status";
			if (action === "on" || action === "off") {
				service.state.towerMode = action === "on";
				service.state.persist();
				ctx.ui.notify(`Tower mode ${action}`, "info");
				return;
			}
			const store = await TowerStore.fromCwd(ctx.cwd);
			await store.assertOwner(ctx.sessionManager.getSessionId());
			if (action === "teardown") {
				const running = runningFleetEntries(store, service);
				if (running.length) {
					ctx.ui.notify(`Teardown blocked: Tower agents are still running: ${running.map((entry) => entry.name).join(", ")}`, "warning");
					return;
				}
				const report = await store.teardown(false);
				ctx.ui.notify(report.join("; ") || "No worktrees to remove", "info");
				return;
			}
			if (action === "status") {
				ctx.ui.notify(await towerStatus(store, service), "info");
				return;
			}
			ctx.ui.notify("Usage: /tower on | off | status | teardown", "warning");
		},
	});
}
