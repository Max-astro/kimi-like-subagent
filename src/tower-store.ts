import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

export type MissionStatus = "planned" | "active" | "completed" | "blocked" | "paused" | "merged" | "abandoned";
export type MissionKind = "build" | "survey";

export interface TowerMission {
	id: string;
	title: string;
	slug: string;
	kind: MissionKind;
	scope: string[];
	branch: string;
	worktree: string;
	spawnBase?: string;
	deps: string[];
	status: MissionStatus;
	owner?: string;
	tasks: Array<{ text: string; done: boolean }>;
	notes: string[];
	blockers: string[];
}

export interface TowerRosterEntry {
	name: string;
	agentId: string;
	taskId: string;
	kind: "worker" | "reviewer";
	missionId?: string;
	reviewTarget?: string;
	worktree?: string;
	branch?: string;
	spawnedAt: string;
}

export interface TowerReview {
	reviewer: string;
	target: string;
	round: number;
	status: string;
	merge: string;
	reviewedCommit: string;
	findings: string;
	checks: string[];
	decision: string;
	createdAt: string;
}

export interface TowerState {
	version: 1;
	base: string;
	createdAt: string;
	sessionId: string;
	ownerPid?: number;
	roster: TowerRosterEntry[];
	missions: TowerMission[];
	reviews: TowerReview[];
}

export interface MissionPlanInput {
	title: string;
	scope: string[];
	tasks?: string[];
	deps?: string[];
	kind?: MissionKind;
}

export interface TowerReviewWorkspace {
	mission: TowerMission;
	worktree: string;
	base: string;
	targetCommit: string;
	diffStat: string;
	patch: string;
}

const TOWER_ROOT = ".tower";
const COMMS = path.join(TOWER_ROOT, "comms");
const STATE_FILE = path.join(COMMS, "state.json");
const ACTIVITY_LOG = path.join(COMMS, "log", "activity.log");
const locks = new Map<string, Promise<void>>();
const STORAGE_PATHS = [
	TOWER_ROOT,
	COMMS,
	path.join(COMMS, "inbox"),
	path.join(COMMS, "findings"),
	path.join(COMMS, "reviews"),
	path.join(COMMS, "missions"),
	path.join(COMMS, "log"),
	path.join(TOWER_ROOT, "worktrees"),
	STATE_FILE,
	ACTIVITY_LOG,
	path.join(COMMS, "MISSIONS.md"),
];

function isProcessAlive(pid: number | undefined): boolean {
	if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function assertNoSymlinkComponents(root: string, relative: string): void {
	let current = path.resolve(root);
	for (const segment of relative.split(path.sep)) {
		current = path.join(current, segment);
		if (!existsSync(current)) return;
		if (lstatSync(current).isSymbolicLink()) throw new Error(`Tower storage path cannot be a symlink: ${current}`);
	}
}

function assertStorageSafe(root: string): void {
	for (const relative of STORAGE_PATHS) assertNoSymlinkComponents(root, relative);
}

async function acquireFileLock(root: string): Promise<() => void> {
	const lockFile = path.join(root, ".git", "kimi-like-subagent-tower.lock");
	const token = `${process.pid}-${randomUUID()}`;
	const deadline = Date.now() + 10_000;
	while (true) {
		try {
			const handle = openSync(lockFile, "wx", 0o600);
			writeFileSync(handle, `${token}\n`, "utf8");
			closeSync(handle);
			return () => {
				try {
					if (readFileSync(lockFile, "utf8").trim() === token) unlinkSync(lockFile);
				} catch {}
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				const existing = readFileSync(lockFile, "utf8").trim();
				const pid = Number(existing.split("-", 1)[0]);
				if (!isProcessAlive(pid) && readFileSync(lockFile, "utf8").trim() === existing) unlinkSync(lockFile);
			} catch {}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for Tower state lock: ${lockFile}`);
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
		}
	}
}

function slugify(value: string, max = 40): string {
	const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");
	return slug || "item";
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd, timeout: 60_000, maxBuffer: 16 * 1024 * 1024, env: env ?? process.env }, (error, stdout, stderr) => {
			if (error) return reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim() || error.message}`));
			resolve(stdout.trimEnd());
		});
	});
}

async function tryGit(cwd: string, args: string[]): Promise<string | undefined> {
	try {
		return await git(cwd, args);
	} catch {
		return undefined;
	}
}

async function locked<T>(root: string, action: () => Promise<T>): Promise<T> {
	const prior = locks.get(root) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const chain = prior.then(() => current);
	locks.set(root, chain);
	await prior;
	let releaseFileLock: (() => void) | undefined;
	try {
		assertStorageSafe(root);
		releaseFileLock = await acquireFileLock(root);
		return await action();
	} finally {
		releaseFileLock?.();
		release();
		if (locks.get(root) === chain) locks.delete(root);
	}
}

function atomicJson(file: string, value: unknown): void {
	const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(temporary, file);
}

function scopeStem(glob: string): string {
	return glob.replace(/\/\*\*?$/, "").replace(/\*.*$/, "").replace(/\/+$/, "");
}

function literalGlobPrefix(glob: string): { prefix: string; hasMagic: boolean } {
	const index = glob.search(/[?*[]/);
	return index < 0 ? { prefix: glob.replace(/\/+$/, ""), hasMagic: false } : { prefix: glob.slice(0, index), hasMagic: true };
}

export function scopesOverlap(a: string, b: string): boolean {
	const leftPrefix = literalGlobPrefix(a);
	const rightPrefix = literalGlobPrefix(b);
	if (leftPrefix.hasMagic || rightPrefix.hasMagic) {
		if (!leftPrefix.prefix || !rightPrefix.prefix) return true;
		if (leftPrefix.prefix.startsWith(rightPrefix.prefix) || rightPrefix.prefix.startsWith(leftPrefix.prefix)) return true;
	}
	const left = scopeStem(a);
	const right = scopeStem(b);
	if (!left || !right) return true;
	return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function matchesScope(file: string, glob: string): boolean {
	let expression = "^";
	for (let index = 0; index < glob.length; index++) {
		const char = glob[index];
		if (char === "*" && glob[index + 1] === "*") {
			if (glob[index + 2] === "/") {
				expression += "(?:.*/)?";
				index += 2;
			} else {
				expression += ".*";
				index++;
			}
		} else if (char === "*") expression += "[^/]*";
		else if (char === "?") expression += "[^/]";
		else expression += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
	}
	return new RegExp(`${expression}$`).test(file.replaceAll(path.sep, "/"));
}

async function repoRoot(cwd: string): Promise<string> {
	const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	return path.dirname(common);
}

async function dirtyPaths(root: string): Promise<Array<{ path: string; unmerged: boolean }>> {
	const output = await git(root, ["status", "--porcelain", "-z", "--no-renames", "--untracked-files=normal"]);
	const unmerged = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
	return output
		.split("\0")
		.filter((entry) => entry.length >= 4)
		.map((entry) => ({ path: entry.slice(3).replace(/\/+$/, ""), unmerged: unmerged.has(entry.slice(0, 2)) }))
		.filter((entry) => entry.path && !entry.path.split("/").includes(TOWER_ROOT));
}

async function snapshotWip(root: string, base: string, files: string[], label: string): Promise<string | undefined> {
	if (files.length === 0) return undefined;
	const temp = mkdtempSync(path.join(tmpdir(), "pi-tower-index-"));
	const env = {
		...process.env,
		GIT_INDEX_FILE: path.join(temp, "index"),
		GIT_LITERAL_PATHSPECS: "1",
		GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "Pi Tower",
		GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "pi-tower@localhost",
		GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "Pi Tower",
		GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "pi-tower@localhost",
	};
	try {
		const baseTip = await git(root, ["rev-parse", base]);
		await git(root, ["read-tree", baseTip], env);
		for (let index = 0; index < files.length; index += 100) {
			await git(root, ["add", "-A", "--", ...files.slice(index, index + 100)], env);
		}
		const tree = await git(root, ["write-tree"], env);
		const baseTree = await git(root, ["rev-parse", `${baseTip}^{tree}`]);
		if (tree === baseTree) return undefined;
		return await git(root, ["commit-tree", tree, "-p", baseTip, "-m", label], env);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

export class TowerStore {
	private ownerSessionId?: string;
	private participantPid?: number;

	private constructor(readonly root: string) {}

	static async fromCwd(cwd: string): Promise<TowerStore> {
		const root = await repoRoot(cwd);
		assertStorageSafe(root);
		return new TowerStore(root);
	}

	private abs(relative: string): string {
		return path.join(this.root, relative);
	}

	private save(state: TowerState): void {
		atomicJson(this.abs(STATE_FILE), state);
		this.renderMissions(state);
	}

	private log(actor: string, action: string, details = ""): void {
		mkdirSync(path.dirname(this.abs(ACTIVITY_LOG)), { recursive: true });
		appendFileSync(this.abs(ACTIVITY_LOG), `${new Date().toISOString()} ${actor} ${action}${details ? ` ${details}` : ""}\n`, "utf8");
	}

	private renderMissions(state: TowerState): void {
		const rows = state.missions.map(
			(mission) => `| ${mission.id} | ${mission.kind} | ${mission.title} | ${mission.branch} | ${mission.status} | ${mission.owner ?? "—"} | ${mission.scope.join(", ")} |`,
		);
		writeFileSync(
			this.abs(path.join(COMMS, "MISSIONS.md")),
			[
				"# Tower missions",
				"",
				"Generated by Tower tools; do not edit manually.",
				"",
				`Base: ${state.base}`,
				"",
				"| ID | Kind | Mission | Branch | Status | Owner | Scope |",
				"| -- | -- | -- | -- | -- | -- | -- |",
				...rows,
				"",
			].join("\n"),
			"utf8",
		);
	}

	private claim(state: TowerState, sessionId: string): string[] {
		if (state.sessionId === sessionId && state.ownerPid === process.pid) return [];
		if (isProcessAlive(state.ownerPid)) {
			throw new Error(`Tower is owned by live session ${state.sessionId} (pid ${state.ownerPid})`);
		}
		const retiredAgents = state.roster.map((entry) => entry.name);
		const retired = new Set(retiredAgents);
		state.roster = [];
		for (const mission of state.missions) {
			if (!mission.owner || !retired.has(mission.owner)) continue;
			mission.owner = undefined;
			if (mission.status === "active") mission.status = "paused";
		}
		const previousSession = state.sessionId;
		state.sessionId = sessionId;
		state.ownerPid = process.pid;
		this.save(state);
		this.log("tower", "session.claim", `session=${sessionId} previous=${previousSession} retired=${retiredAgents.join(",") || "none"}`);
		return retiredAgents;
	}

	async init(sessionId: string, requestedBase?: string): Promise<{ created: boolean; state: TowerState; checkout: string; retiredAgents: string[] }> {
		return locked(this.root, async () => {
			if ((await tryGit(this.root, ["rev-parse", "--is-inside-work-tree"])) !== "true") throw new Error("Tower requires a git worktree");
			if (!(await tryGit(this.root, ["rev-list", "-n", "1", "--all"]))) throw new Error("Tower requires at least one commit");
			const statePath = this.abs(STATE_FILE);
			if (existsSync(statePath)) {
				const state = this.readState();
				const retiredAgents = this.claim(state, sessionId);
				this.ownerSessionId = sessionId;
				return { created: false, state, checkout: await git(this.root, ["branch", "--show-current"]), retiredAgents };
			}
			const checkout = await git(this.root, ["branch", "--show-current"]);
			const base = requestedBase?.trim() || checkout;
			if (!base) throw new Error("Detached HEAD requires an explicit local base branch");
			if ((await tryGit(this.root, ["show-ref", "--verify", `refs/heads/${base}`])) === undefined) {
				throw new Error(`Base branch does not exist locally: ${base}`);
			}
			for (const dir of ["inbox", "findings", "reviews", "missions", "log"]) mkdirSync(this.abs(path.join(COMMS, dir)), { recursive: true });
			mkdirSync(this.abs(path.join(TOWER_ROOT, "worktrees")), { recursive: true });
			const exclude = this.abs(path.join(".git", "info", "exclude"));
			if (existsSync(path.dirname(exclude))) {
				const existing = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
				if (!existing.split(/\r?\n/).some((line) => line.trim() === ".tower/")) {
					appendFileSync(exclude, `${existing && !existing.endsWith("\n") ? "\n" : ""}.tower/\n`, "utf8");
				}
			}
			const state: TowerState = { version: 1, base, createdAt: new Date().toISOString(), sessionId, ownerPid: process.pid, roster: [], missions: [], reviews: [] };
			this.save(state);
			this.log("tower", "init", `base=${base}`);
			this.ownerSessionId = sessionId;
			return { created: true, state, checkout, retiredAgents: [] };
		});
	}

	async assertOwner(sessionId: string): Promise<string[]> {
		return locked(this.root, async () => {
			const state = this.readState();
			const retired = this.claim(state, sessionId);
			this.ownerSessionId = sessionId;
			return retired;
		});
	}

	async assertParticipant(): Promise<void> {
		await locked(this.root, async () => {
			const state = this.readState();
			if (state.ownerPid !== process.pid) {
				throw new Error(`Tower session ${state.sessionId} is not active in this process`);
			}
			this.participantPid = process.pid;
		});
	}

	async release(sessionId: string): Promise<void> {
		await locked(this.root, async () => {
			const state = this.readState();
			if (state.sessionId !== sessionId) throw new Error(`Tower is owned by ${state.sessionId}, not ${sessionId}`);
			if (state.ownerPid !== process.pid) throw new Error(`Tower session ${sessionId} is not owned by this process`);
			state.ownerPid = undefined;
			this.save(state);
			this.log("tower", "session.release", `session=${sessionId}`);
		});
	}

	private readState(): TowerState {
		assertStorageSafe(this.root);
		if (!existsSync(this.abs(STATE_FILE))) throw new Error("Tower is not initialized; run TowerInit first");
		const raw = JSON.parse(readFileSync(this.abs(STATE_FILE), "utf8")) as unknown;
		if (!raw || typeof raw !== "object" || !("version" in raw) || raw.version !== 1) {
			const version = raw && typeof raw === "object" && "version" in raw ? raw.version : undefined;
			throw new Error(`Unsupported Tower state version: ${String(version)}`);
		}
		return raw as TowerState;
	}

	load(): TowerState {
		const state = this.readState();
		if (this.ownerSessionId && (state.sessionId !== this.ownerSessionId || state.ownerPid !== process.pid)) {
			throw new Error(`Tower ownership changed from session ${this.ownerSessionId} to ${state.sessionId}`);
		}
		if (this.participantPid && state.ownerPid !== this.participantPid) {
			throw new Error(`Tower session ${state.sessionId} is no longer active in this process`);
		}
		return state;
	}

	actor(cwd: string, state = this.load()): string {
		const normalized = path.resolve(cwd);
		if (normalized === path.resolve(this.root)) return "tower";
		const entry = state.roster.find((candidate) => candidate.worktree && path.resolve(candidate.worktree) === normalized);
		if (!entry) throw new Error(`This working directory is not a registered Tower participant: ${cwd}`);
		return entry.name;
	}

	async plan(inputs: MissionPlanInput[]): Promise<TowerMission[]> {
		return locked(this.root, async () => {
			const state = this.load();
			const start = state.missions.length;
			const missions = inputs.map((input, index): TowerMission => {
				if (!input.title.trim() || input.scope.length === 0 || input.scope.some((scope) => !scope.trim())) throw new Error("Every mission needs a title and non-empty scope globs");
				if (input.kind !== "survey" && input.scope.some((scope) => !scopeStem(scope))) throw new Error("Build mission scope cannot cover the whole repository");
				const number = start + index + 1;
				const slug = slugify(input.title);
				return {
					id: `M${number}`,
					title: input.title.trim(),
					slug,
					kind: input.kind ?? "build",
					scope: input.scope.map((scope) => scope.trim()),
					branch: `feat/${slug}`,
					worktree: `wt-${number}`,
					deps: input.deps ?? [],
					status: "planned",
					tasks: (input.tasks ?? []).map((text) => ({ text, done: false })),
					notes: [],
					blockers: [],
				};
			});
			const branches = [...state.missions.map((mission) => mission.branch), ...missions.map((mission) => mission.branch)];
			if (new Set(branches).size !== branches.length) throw new Error("Mission titles must produce unique branch slugs");
			const ids = new Set([...state.missions, ...missions].map((mission) => mission.id));
			for (const mission of missions) {
				for (const dep of mission.deps) if (!ids.has(dep)) throw new Error(`${mission.id} depends on unknown mission ${dep}`);
			}
			const builds = [...state.missions.filter((mission) => !["merged", "abandoned"].includes(mission.status)), ...missions].filter((mission) => mission.kind === "build");
			for (let i = 0; i < builds.length; i++) {
				for (let j = i + 1; j < builds.length; j++) {
					for (const a of builds[i].scope) for (const b of builds[j].scope) if (scopesOverlap(a, b)) throw new Error(`Mission scopes overlap: ${builds[i].id} (${a}) vs ${builds[j].id} (${b})`);
				}
			}
			state.missions.push(...missions);
			this.save(state);
			this.log("tower", "plan", `missions=${missions.map((mission) => mission.id).join(",")}`);
			return missions;
		});
	}

	async addMissionWorktree(missionId: string): Promise<{ mission: TowerMission; worktree: string }> {
		return locked(this.root, async () => {
			const state = this.load();
			const mission = state.missions.find((candidate) => candidate.id === missionId);
			if (!mission) throw new Error(`Unknown mission: ${missionId}`);
			const worktree = this.abs(path.join(TOWER_ROOT, "worktrees", mission.worktree));
			assertNoSymlinkComponents(this.root, path.relative(this.root, worktree));
			if (state.roster.some((entry) => entry.missionId === missionId)) throw new Error(`Mission ${missionId} already has a registered worker`);
			if (!existsSync(worktree)) {
				const branchExists = (await tryGit(this.root, ["show-ref", "--verify", `refs/heads/${mission.branch}`])) !== undefined;
				if (branchExists && mission.status === "planned" && !mission.owner) {
					throw new Error(`Branch ${mission.branch} already exists and is not owned by Tower mission ${mission.id}`);
				}
				let spawnBase: string | undefined;
				if (!branchExists) {
					const dirty = await dirtyPaths(this.root);
					if (dirty.some((entry) => entry.unmerged)) throw new Error("The base checkout has unmerged paths; finish or abort that operation first");
					if (dirty.length > 0) {
						const current = await git(this.root, ["branch", "--show-current"]);
						if (current !== state.base) throw new Error(`Dirty checkout is on ${current || "detached HEAD"}, not Tower base ${state.base}`);
						spawnBase = await snapshotWip(this.root, state.base, dirty.map((entry) => entry.path), `tower: snapshot base WIP for ${mission.id}`);
					}
					await git(this.root, ["worktree", "add", worktree, "-b", mission.branch, spawnBase ?? state.base]);
					mission.spawnBase = spawnBase;
				} else {
					await git(this.root, ["worktree", "add", worktree, mission.branch]);
				}
			} else {
				const actualRoot = await tryGit(worktree, ["rev-parse", "--show-toplevel"]);
				const actualBranch = await tryGit(worktree, ["branch", "--show-current"]);
				if (!actualRoot || path.resolve(actualRoot) !== path.resolve(worktree) || actualBranch !== mission.branch) {
					throw new Error(`Existing Tower worktree is not the registered ${mission.branch} checkout: ${worktree}`);
				}
			}
			this.save(state);
			this.log("tower", "worktree.add", `mission=${mission.id} branch=${mission.branch} path=${worktree}`);
			return { mission, worktree };
		});
	}

	async addReviewWorktree(name: string, target: string): Promise<TowerReviewWorkspace> {
		return locked(this.root, async () => {
			const state = this.load();
			if (state.roster.some((entry) => entry.name === name)) throw new Error(`Tower agent name already exists: ${name}`);
			const mission = state.missions.find((candidate) => candidate.branch === target);
			if (!mission) throw new Error(`No Tower mission owns review target: ${target}`);
			const base = await this.diffBase(state, mission);
			const targetCommit = await git(this.root, ["rev-parse", target]);
			const diffStat = await git(this.root, ["diff", "--stat", `${base}...${targetCommit}`]);
			const rawPatch = await git(this.root, ["diff", "--no-ext-diff", "--unified=40", `${base}...${targetCommit}`]);
			const maxPatchChars = 120_000;
			const patch = rawPatch.length <= maxPatchChars
				? rawPatch
				: `${rawPatch.slice(0, maxPatchChars)}\n\n[patch truncated; inspect named files with read]`;
			const worktree = this.abs(path.join(TOWER_ROOT, "worktrees", `review-${slugify(name)}`));
			if (existsSync(worktree)) throw new Error(`Reviewer worktree already exists: ${worktree}`);
			await git(this.root, ["worktree", "add", "--detach", worktree, targetCommit]);
			this.log("tower", "worktree.review.add", `name=${name} target=${target} commit=${targetCommit.slice(0, 7)} path=${worktree}`);
			return { mission, worktree, base, targetCommit, diffStat, patch };
		});
	}

	async removeWorktree(worktree: string): Promise<void> {
		const worktreeRoot = this.abs(path.join(TOWER_ROOT, "worktrees"));
		const resolved = path.resolve(worktree);
		const relative = path.relative(worktreeRoot, resolved);
		if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
			throw new Error(`Refusing to remove a non-Tower worktree: ${worktree}`);
		}
		if (existsSync(resolved)) await git(this.root, ["worktree", "remove", "--force", resolved]);
	}

	async registerAgent(entry: TowerRosterEntry): Promise<void> {
		await locked(this.root, async () => {
			const state = this.load();
			if (state.roster.some((candidate) => candidate.name === entry.name)) throw new Error(`Tower agent name is already registered: ${entry.name}`);
			state.roster.push(entry);
			if (entry.missionId) {
				const mission = state.missions.find((candidate) => candidate.id === entry.missionId);
				if (!mission) throw new Error(`Unknown mission: ${entry.missionId}`);
				mission.owner = entry.name;
				mission.status = "active";
			}
			this.save(state);
			this.log("tower", "spawn", `name=${entry.name} kind=${entry.kind} agent=${entry.agentId}`);
		});
	}

	async finalizeAgent(name: string, agentId: string, taskId: string): Promise<void> {
		await locked(this.root, async () => {
			const state = this.load();
			const entry = state.roster.find((candidate) => candidate.name === name);
			if (!entry) throw new Error(`Tower agent is not reserved: ${name}`);
			entry.agentId = agentId;
			entry.taskId = taskId;
			this.save(state);
			this.log("tower", "spawn.ready", `name=${name} agent=${agentId}`);
		});
	}

	async unregisterAgent(name: string): Promise<void> {
		await locked(this.root, async () => {
			const state = this.load();
			const index = state.roster.findIndex((candidate) => candidate.name === name);
			if (index < 0) return;
			const [entry] = state.roster.splice(index, 1);
			if (entry.missionId) {
				const mission = state.missions.find((candidate) => candidate.id === entry.missionId);
				if (mission?.owner === name && mission.status === "active") {
					mission.owner = undefined;
					mission.status = "paused";
				}
			}
			this.save(state);
			this.log("tower", "spawn.rollback", `name=${name}`);
		});
	}

	async updateMission(actor: string, id: string, patch: { status?: MissionStatus; note?: string; blocker?: string; clearBlockers?: boolean; taskDone?: string; scope?: string[] }): Promise<TowerMission> {
		return locked(this.root, async () => {
		const state = this.load();
		const mission = state.missions.find((candidate) => candidate.id === id);
		if (!mission) throw new Error(`Unknown mission: ${id}`);
		if (actor !== "tower") {
			const owner = state.roster.find((candidate) => candidate.name === actor);
			if (owner?.kind !== "worker" || owner.missionId !== id) throw new Error(`${actor} does not own mission ${id}`);
		}
		if (patch.status === "abandoned" && actor !== "tower") throw new Error("Only the tower can abandon a mission");
		if (patch.scope && actor !== "tower") throw new Error("Only the tower can change mission scope");
		if (patch.scope) {
			if (patch.scope.length === 0 || patch.scope.some((scope) => !scope.trim())) throw new Error("Mission scope cannot be empty");
			const candidate = { ...mission, scope: patch.scope };
			if (candidate.kind !== "survey" && candidate.scope.some((scope) => !scopeStem(scope))) throw new Error("Build mission scope cannot cover the whole repository");
			for (const other of state.missions) {
				if (other.id === id || other.kind === "survey" || ["merged", "abandoned"].includes(other.status) || candidate.kind === "survey") continue;
				for (const a of candidate.scope) for (const b of other.scope) if (scopesOverlap(a, b)) throw new Error(`Mission scopes overlap: ${candidate.id} (${a}) vs ${other.id} (${b})`);
			}
			mission.scope = patch.scope.map((scope) => scope.trim());
		}
		if (patch.status) mission.status = patch.status;
		if (patch.note) mission.notes.push(patch.note);
		if (patch.blocker) {
			mission.blockers.push(patch.blocker);
			mission.status = "blocked";
		}
		if (patch.clearBlockers) mission.blockers = [];
		if (patch.taskDone) {
			const task = mission.tasks.find((candidate) => !candidate.done && candidate.text.includes(patch.taskDone!));
			if (!task) throw new Error(`No open task in ${id} matches: ${patch.taskDone}`);
			task.done = true;
		}
		this.save(state);
		this.log(actor, "mission.update", `id=${id} status=${mission.status}`);
		return mission;
		});
	}

	send(actor: string, input: { to: string; subject: string; body: string; scope?: string; action?: string; consentRef?: string }): string {
		const state = this.load();
		const recipients = new Set(["tower", "all", ...state.roster.map((entry) => entry.name)]);
		if (!recipients.has(input.to)) throw new Error(`Unknown recipient ${input.to}. Known: ${[...recipients].join(", ")}`);
		if (input.to === actor) throw new Error("Cannot send a Tower message to yourself");
		const file = `${Date.now()}-${slugify(actor, 20)}-${slugify(input.to, 20)}-${slugify(input.subject)}-${randomUUID().slice(0, 6)}.json`;
		const relative = path.join(COMMS, "inbox", file);
		atomicJson(this.abs(relative), { ...input, from: actor, sentAt: new Date().toISOString() });
		this.log(actor, "inbox.send", `to=${input.to} subject=${slugify(input.subject)}`);
		return relative;
	}

	inbox(actor: string, limit = 20): unknown[] {
		const dir = this.abs(path.join(COMMS, "inbox"));
		return readdirSync(dir)
			.filter((file) => file.endsWith(".json"))
			.map((file) => JSON.parse(readFileSync(path.join(dir, file), "utf8")))
			.filter((message) => actor === "tower" || message.to === actor || message.to === "all")
			.sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt)))
			.slice(0, Math.max(1, limit));
	}

	finding(actor: string, value: Record<string, unknown>): string {
		this.load();
		const relative = path.join(COMMS, "findings", `${Date.now()}-${slugify(actor)}-${slugify(String(value.title))}.json`);
		atomicJson(this.abs(relative), { ...value, actor, createdAt: new Date().toISOString() });
		this.log(actor, "finding.file", `type=${String(value.type)} ref=${relative}`);
		return relative;
	}

	async review(actor: string, value: { target: string; status: string; merge: string; findings: string; checks?: string[]; decision: string }): Promise<TowerReview> {
		return locked(this.root, async () => {
			const state = this.load();
			const reviewer = state.roster.find((entry) => entry.name === actor);
			if (reviewer?.kind !== "reviewer" || reviewer.reviewTarget !== value.target) throw new Error(`${actor} is not assigned to review ${value.target}`);
			if (!/^(clean|p[12]-\d+items)$/.test(value.status)) throw new Error("Review status must be clean, p1-Nitems, or p2-Nitems");
			const reviewedCommit = await git(this.root, ["rev-parse", value.target]);
			if (!reviewer.worktree) throw new Error(`${actor} has no isolated review worktree`);
			const workspaceCommit = await git(reviewer.worktree, ["rev-parse", "HEAD"]);
			if (workspaceCommit !== reviewedCommit) {
				throw new Error(`Review target moved while ${actor} was reviewing (${workspaceCommit.slice(0, 7)} -> ${reviewedCommit.slice(0, 7)})`);
			}
			const review: TowerReview = {
				...value,
				reviewer: actor,
				round: state.reviews.filter((item) => item.target === value.target && item.reviewer === actor).length + 1,
				reviewedCommit,
				checks: value.checks ?? [],
				createdAt: new Date().toISOString(),
			};
			state.reviews.push(review);
			this.save(state);
			const relative = path.join(COMMS, "reviews", `review-${slugify(value.target)}-${slugify(actor)}-r${review.round}.json`);
			atomicJson(this.abs(relative), review);
			this.log(actor, "review.write", `target=${value.target} status=${value.status} commit=${reviewedCommit.slice(0, 7)}`);
			return review;
		});
	}

	private async diffBase(state: TowerState, mission: TowerMission): Promise<string> {
		if (mission.spawnBase && (await tryGit(this.root, ["merge-base", "--is-ancestor", mission.spawnBase, mission.branch])) !== undefined) return mission.spawnBase;
		return state.base;
	}

	async merge(branch: string): Promise<{ mergeCommit: string; changed: string[]; noop?: boolean }> {
		return locked(this.root, async () => {
			const state = this.load();
			const mission = state.missions.find((candidate) => candidate.branch === branch);
			if (!mission) throw new Error(`No Tower mission owns branch: ${branch}`);
			if (mission.status !== "completed") throw new Error(`Merge blocked: mission ${mission.id} is ${mission.status}, not completed`);
			const openDeps = mission.deps.filter((id) => {
				const dep = state.missions.find((candidate) => candidate.id === id);
				return dep && !["merged", "abandoned"].includes(dep.status);
			});
			if (openDeps.length) throw new Error(`Merge blocked: dependencies are not merged or abandoned: ${openDeps.join(", ")}`);
			const base = await this.diffBase(state, mission);
			const changedText = await git(this.root, ["diff", "--name-only", `${base}...${branch}`]);
			const changed = changedText ? changedText.split("\n").filter(Boolean) : [];
			if (mission.kind === "survey") {
				if (changed.length) throw new Error(`Merge blocked: read-only survey changed files: ${changed.join(", ")}`);
				mission.status = "merged";
				this.save(state);
				return { mergeCommit: await git(this.root, ["rev-parse", state.base]), changed, noop: true };
			}
			const outOfScope = changed.filter((file) => !mission.scope.some((glob) => matchesScope(file, glob)));
			if (outOfScope.length) throw new Error(`Merge blocked: files outside ${mission.id} scope: ${outOfScope.join(", ")}`);
			const tip = await git(this.root, ["rev-parse", branch]);
			const review = [...state.reviews].reverse().find((item) => item.target === branch);
			if (!review) throw new Error(`Merge blocked: ${branch} has no review`);
			if (review.status !== "clean") throw new Error(`Merge blocked: latest review is ${review.status}, not clean`);
			if (review.merge !== "merge") throw new Error(`Merge blocked: latest review recommendation is ${review.merge}, not merge`);
			if (review.reviewedCommit !== tip) throw new Error(`Merge blocked: branch moved after review (${review.reviewedCommit.slice(0, 7)} -> ${tip.slice(0, 7)})`);
			const checkout = await git(this.root, ["branch", "--show-current"]);
			if (checkout !== state.base) throw new Error(`Merge blocked: main checkout is on ${checkout || "detached HEAD"}, expected ${state.base}`);
			if (mission.spawnBase) {
				const snapshotText = await git(this.root, ["diff", "--name-only", `${mission.spawnBase}^`, mission.spawnBase]);
				const snapshotPaths = snapshotText ? snapshotText.split("\n").filter(Boolean) : [];
				if (snapshotPaths.length) {
					const missingText = await git(this.root, ["diff", "--name-only", mission.spawnBase, "HEAD", "--", ...snapshotPaths]);
					const missing = missingText ? missingText.split("\n").filter(Boolean) : [];
					if (missing.length) {
						throw new Error(`Merge blocked: snapshot WIP is not incorporated into the current base: ${missing.join(", ")}. Commit or restore it on ${state.base}, or abandon and replan the mission.`);
					}
				}
			}
			const touchedText = await git(this.root, ["diff", "--name-only", `HEAD...${branch}`]);
			const touched = touchedText ? touchedText.split("\n").filter(Boolean) : [];
			const dirty = new Set((await dirtyPaths(this.root)).map((entry) => entry.path));
			const collision = touched.filter((file) => dirty.has(file));
			if (collision.length) throw new Error(`Merge blocked: main checkout has uncommitted changes in touched files: ${collision.join(", ")}`);
			if ((await tryGit(this.root, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])) !== undefined) {
				throw new Error("Merge blocked: the main checkout already has an in-progress merge");
			}
			try {
				await git(this.root, ["merge", "--no-ff", "--no-edit", branch]);
			} catch (error) {
				await tryGit(this.root, ["merge", "--abort"]);
				throw error;
			}
			const mergeCommit = await git(this.root, ["rev-parse", "HEAD"]);
			mission.status = "merged";
			this.save(state);
			this.log("tower", "merge", `branch=${branch} commit=${mergeCommit.slice(0, 7)}`);
			return { mergeCommit, changed };
		});
	}

	async teardown(force = false): Promise<string[]> {
		return locked(this.root, async () => {
			const state = this.load();
			const report: string[] = [];
			const worktrees = new Set([
				...state.missions.map((mission) => this.abs(path.join(TOWER_ROOT, "worktrees", mission.worktree))),
				...state.roster.map((entry) => entry.worktree).filter((worktree): worktree is string => Boolean(worktree)),
			]);
			worktrees.delete(this.root);
			for (const worktree of worktrees) {
				if (!existsSync(worktree)) continue;
				const status = await tryGit(worktree, ["status", "--porcelain"]);
				if (!force && status === undefined) {
					report.push(`kept ${worktree} (could not verify worktree status)`);
					continue;
				}
				if (!force && status?.trim()) {
					report.push(`kept ${worktree} (uncommitted changes)`);
					continue;
				}
				try {
					await git(this.root, ["worktree", "remove", "--force", worktree]);
					report.push(`removed ${worktree}`);
				} catch (error) {
					report.push(`failed ${worktree}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			this.log("tower", "teardown", `force=${String(force)}`);
			return report;
		});
	}

	status(): { state: TowerState; recentActivity: string[] } {
		const state = this.load();
		const log = existsSync(this.abs(ACTIVITY_LOG)) ? readFileSync(this.abs(ACTIVITY_LOG), "utf8").trim().split("\n").filter(Boolean).slice(-20) : [];
		return { state, recentActivity: log };
	}
}
