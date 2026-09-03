import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { matchesScope, scopesOverlap, TowerStore } from "../src/tower-store.ts";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository(): string {
	const root = mkdtempSync(path.join(tmpdir(), "pi-tower-test-"));
	git(root, "init", "-b", "main");
	git(root, "config", "user.name", "Tower Test");
	git(root, "config", "user.email", "tower@test.invalid");
	writeFileSync(path.join(root, "README.md"), "base\n", "utf8");
	git(root, "add", "README.md");
	git(root, "commit", "-m", "initial");
	return root;
}

describe("Tower scope rules", () => {
	it("matches double-star paths without treating sibling prefixes as children", () => {
		expect(matchesScope("src/deep/a.ts", "src/**")).toBe(true);
		expect(matchesScope("src2/a.ts", "src/**")).toBe(false);
		expect(scopesOverlap("src/**", "src/api/**")).toBe(true);
		expect(scopesOverlap("src/**", "tests/**")).toBe(false);
		expect(scopesOverlap("src/foo*.ts", "src/foobar*.ts")).toBe(true);
	});

	it("rejects overlapping build mission scopes", async () => {
		const root = repository();
		const store = await TowerStore.fromCwd(root);
		await store.init("session-test");
		await expect(
			store.plan([
				{ title: "API", scope: ["src/**"] },
				{ title: "Nested API", scope: ["src/api/**"] },
			]),
		).rejects.toThrow(/scopes overlap/i);
	});

	it("serializes concurrent plans without losing missions", async () => {
		const root = repository();
		const store = await TowerStore.fromCwd(root);
		await store.init("session-test");
		const [left, right] = await Promise.all([
			store.plan([{ title: "API", scope: ["src/**"] }]),
			store.plan([{ title: "Tests", scope: ["tests/**"] }]),
		]);
		expect(new Set([left[0].id, right[0].id])).toEqual(new Set(["M1", "M2"]));
		expect(store.load().missions).toHaveLength(2);
	});
});

describe("Tower merge gate", () => {
	it("requires a clean review of the current branch tip", async () => {
		const root = repository();
		const store = await TowerStore.fromCwd(root);
		await store.init("session-test");
		const [mission] = await store.plan([{ title: "Feature", scope: ["src/**"], tasks: ["implement"] }]);
		const added = await store.addMissionWorktree(mission.id);
		mkdirSync(path.join(added.worktree, "src"), { recursive: true });
		writeFileSync(path.join(added.worktree, "src", "feature.ts"), "export const value = 1;\n", "utf8");
		git(added.worktree, "add", "src/feature.ts");
		git(added.worktree, "commit", "-m", "feature");

		await expect(store.merge(mission.branch)).rejects.toThrow(/completed/i);
		await store.updateMission("tower", mission.id, { status: "completed" });
		const reviewWorkspace = await store.addReviewWorktree("reviewer", mission.branch);
		await store.registerAgent({
			name: "reviewer",
			agentId: "agent-reviewer",
			taskId: "task-reviewer",
			kind: "reviewer",
			reviewTarget: mission.branch,
			worktree: reviewWorkspace.worktree,
			spawnedAt: new Date().toISOString(),
		});
		await expect(store.review("tower", {
			target: mission.branch,
			status: "clean",
			merge: "merge",
			findings: "none",
			decision: "clean",
		})).rejects.toThrow(/not assigned/i);
		await store.review("reviewer", {
			target: mission.branch,
			status: "clean",
			merge: "merge",
			findings: "none",
			checks: ["tests"],
			decision: "clean",
		});
		writeFileSync(path.join(added.worktree, "src", "feature.ts"), "export const value = 2;\n", "utf8");
		git(added.worktree, "add", "src/feature.ts");
		git(added.worktree, "commit", "-m", "move tip");

		await expect(store.merge(mission.branch)).rejects.toThrow(/moved after review/i);
	});

	it("honors a clean review's explicit merge recommendation", async () => {
		const root = repository();
		const store = await TowerStore.fromCwd(root);
		await store.init("session-test");
		const [mission] = await store.plan([{ title: "Hold Feature", scope: ["src/**"] }]);
		const added = await store.addMissionWorktree(mission.id);
		mkdirSync(path.join(added.worktree, "src"), { recursive: true });
		writeFileSync(path.join(added.worktree, "src", "feature.ts"), "export const value = 1;\n", "utf8");
		git(added.worktree, "add", "src/feature.ts");
		git(added.worktree, "commit", "-m", "feature");
		await store.updateMission("tower", mission.id, { status: "completed" });
		const reviewWorkspace = await store.addReviewWorktree("reviewer", mission.branch);
		await store.registerAgent({
			name: "reviewer",
			agentId: "agent-reviewer",
			taskId: "task-reviewer",
			kind: "reviewer",
			reviewTarget: mission.branch,
			worktree: reviewWorkspace.worktree,
			spawnedAt: new Date().toISOString(),
		});
		await store.review("reviewer", {
			target: mission.branch,
			status: "clean",
			merge: "hold",
			findings: "needs product decision",
			decision: "hold",
		});
		await expect(store.merge(mission.branch)).rejects.toThrow(/recommendation.*hold/i);
	});

	it("does not claim an unrelated pre-existing feature branch", async () => {
		const root = repository();
		git(root, "branch", "feat/existing-feature");
		const store = await TowerStore.fromCwd(root);
		await store.init("session-test");
		const [mission] = await store.plan([{ title: "Existing Feature", scope: ["src/**"] }]);
		await expect(store.addMissionWorktree(mission.id)).rejects.toThrow(/already exists/i);
	});

	it("does not merge a dirty-base snapshot that was later discarded", async () => {
		const root = repository();
		writeFileSync(path.join(root, "README.md"), "uncommitted user work\n", "utf8");
		const store = await TowerStore.fromCwd(root);
		await store.init("session-test");
		const [mission] = await store.plan([{ title: "Snapshot Feature", scope: ["src/**"] }]);
		const added = await store.addMissionWorktree(mission.id);
		mkdirSync(path.join(added.worktree, "src"), { recursive: true });
		writeFileSync(path.join(added.worktree, "src", "feature.ts"), "export const value = 1;\n", "utf8");
		git(added.worktree, "add", "src/feature.ts");
		git(added.worktree, "commit", "-m", "feature");
		git(root, "restore", "README.md");
		await store.updateMission("tower", mission.id, { status: "completed" });
		const reviewWorkspace = await store.addReviewWorktree("snapshot-reviewer", mission.branch);
		await store.registerAgent({
			name: "snapshot-reviewer",
			agentId: "agent-snapshot-reviewer",
			taskId: "task-snapshot-reviewer",
			kind: "reviewer",
			reviewTarget: mission.branch,
			worktree: reviewWorkspace.worktree,
			spawnedAt: new Date().toISOString(),
		});
		await store.review("snapshot-reviewer", {
			target: mission.branch,
			status: "clean",
			merge: "merge",
			findings: "none",
			decision: "clean",
		});
		await expect(store.merge(mission.branch)).rejects.toThrow(/snapshot WIP.*not incorporated/i);
		expect(readFileSync(path.join(root, "README.md"), "utf8")).toBe("base\n");
	});
});

describe("Tower session ownership", () => {
	it("rejects a second live owner and adopts after the previous session releases", async () => {
		const root = repository();
		const store = await TowerStore.fromCwd(root);
		await store.init("session-a");
		await store.registerAgent({
			name: "stale-reviewer",
			agentId: "agent-old",
			taskId: "task-old",
			kind: "reviewer",
			reviewTarget: "feat/old",
			spawnedAt: new Date().toISOString(),
		});
		await expect(store.init("session-b")).rejects.toThrow(/live session/i);
		await expect(store.assertOwner("session-b")).rejects.toThrow(/owned by live session session-a/i);

		await store.release("session-a");
		const adoptingStore = await TowerStore.fromCwd(root);
		const adopted = await adoptingStore.init("session-b");
		expect(adopted.retiredAgents).toEqual(["stale-reviewer"]);
		expect(adopted.state.sessionId).toBe("session-b");
		expect(adopted.state.roster).toEqual([]);
	});
});

describe("Tower storage boundaries", () => {
	it("rejects a repository-controlled .tower symlink", async () => {
		const root = repository();
		const outside = mkdtempSync(path.join(tmpdir(), "pi-tower-outside-"));
		symlinkSync(outside, path.join(root, ".tower"));
		await expect(TowerStore.fromCwd(root)).rejects.toThrow(/storage path.*symlink/i);
	});

	it("does not reuse an arbitrary existing worktree directory", async () => {
		const root = repository();
		const store = await TowerStore.fromCwd(root);
		await store.init("session-test");
		const [mission] = await store.plan([{ title: "Feature", scope: ["src/**"] }]);
		mkdirSync(path.join(root, ".tower", "worktrees", mission.worktree));
		await expect(store.addMissionWorktree(mission.id)).rejects.toThrow(/not the registered.*checkout/i);
	});
});
