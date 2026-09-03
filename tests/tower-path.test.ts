import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { pathContainsSymlink } from "../src/tower.ts";

describe("Tower write paths", () => {
	it("detects a symlink component that escapes the worktree", () => {
		const root = mkdtempSync(path.join(tmpdir(), "pi-tower-path-"));
		const worktree = path.join(root, "worktree");
		const outside = path.join(root, "outside");
		mkdirSync(worktree);
		mkdirSync(outside);
		writeFileSync(path.join(outside, "secret.txt"), "outside\n", "utf8");
		symlinkSync(outside, path.join(worktree, "linked"));

		expect(pathContainsSymlink(worktree, path.join(worktree, "linked", "secret.txt"))).toBe(true);
		expect(pathContainsSymlink(worktree, path.join(worktree, "ordinary", "new.txt"))).toBe(false);
	});
});
