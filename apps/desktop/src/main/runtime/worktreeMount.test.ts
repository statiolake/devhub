/**
 * Which mount a dev container gets so git works in a worktree's folder.
 *
 * The decision is pure — what git said about the folder, and whether the CLI
 * has the flag — so it is tested here without a repository, a CLI or docker.
 * The cases are the ones `worktreeMount.ts` names: the main checkout gets
 * nothing, a relative link the CLI's own flag, an absolute link a mount at the
 * same path, and a relative link with an old CLI a sentence instead.
 */

import { describe, expect, it } from "vitest";
import {
	gitdirLink,
	missingMountAdvice,
	MOUNT_COMMON_DIR_FLAG,
	parseRevParse,
	planWorktreeMount,
	readConfigurationArguments,
	upArguments,
	type WorktreeFacts,
} from "./worktreeMount.js";

const COMMON = "/Users/me/src/widget/.git";

function worktree(dotGit: string | undefined): WorktreeFacts {
	return {
		toplevel: "/Users/me/src/widget-128",
		gitDir: `${COMMON}/worktrees/widget-128`,
		commonDir: COMMON,
		dotGit,
	};
}

describe("reading git's answer", () => {
	it("reads the three absolute paths rev-parse prints", () => {
		expect(
			parseRevParse(
				"/Users/me/src/widget-128\n/Users/me/src/widget/.git/worktrees/widget-128\n/Users/me/src/widget/.git/\n",
			),
		).toEqual({
			toplevel: "/Users/me/src/widget-128",
			gitDir: `${COMMON}/worktrees/widget-128`,
			// Normalised, so it compares equal to a mount's source.
			commonDir: COMMON,
		});
	});

	it("refuses anything that is not three absolute paths", () => {
		// A git too old for `--path-format` echoes the option back.
		expect(parseRevParse("--path-format=absolute\n/a\n.git\n")).toBeUndefined();
		expect(parseRevParse("")).toBeUndefined();
	});

	it("reads the link out of a worktree's .git file", () => {
		expect(gitdirLink("gitdir: ../widget/.git/worktrees/x\n")).toBe(
			"../widget/.git/worktrees/x",
		);
		expect(gitdirLink("not a link")).toBeUndefined();
	});
});

describe("choosing the mount", () => {
	it("adds nothing for the main checkout", () => {
		const main = { ...worktree(undefined), gitDir: COMMON };
		expect(planWorktreeMount(main, true)).toEqual({ kind: "none" });
		expect(planWorktreeMount(undefined, true)).toEqual({ kind: "none" });
	});

	it("uses the CLI's own flag for a relative link", () => {
		const mount = planWorktreeMount(
			worktree("gitdir: ../widget/.git/worktrees/widget-128\n"),
			true,
		);
		expect(mount).toEqual({ kind: "cli", commonDir: COMMON });
		expect(upArguments(mount)).toEqual([MOUNT_COMMON_DIR_FLAG]);
	});

	it("mounts the common dir at the same path for an absolute link", () => {
		const mount = planWorktreeMount(
			worktree(`gitdir: ${COMMON}/worktrees/widget-128\n`),
			true,
		);
		expect(mount).toEqual({ kind: "bind", commonDir: COMMON });
		expect(upArguments(mount)).toEqual([
			"--mount",
			`type=bind,source=${COMMON},target=${COMMON}`,
		]);
	});

	it("quotes a path with a comma the way the CLI does", () => {
		const commonDir = "/Users/me/a,b/.git";
		expect(upArguments({ kind: "bind", commonDir })).toEqual([
			"--mount",
			`type=bind,source="${commonDir}",target="${commonDir}"`,
		]);
	});

	it("says, rather than fixes, a relative link with a CLI too old for it", () => {
		const mount = planWorktreeMount(
			worktree("gitdir: ../widget/.git/worktrees/widget-128\n"),
			false,
		);
		expect(mount.kind).toBe("unsupported");
		expect(upArguments(mount)).toEqual([]);
		expect(missingMountAdvice("the container", "abc", mount)).toContain(
			MOUNT_COMMON_DIR_FLAG,
		);
	});

	it("leaves a worktree it cannot read alone", () => {
		expect(planWorktreeMount(worktree(undefined), true)).toEqual({
			kind: "none",
		});
	});
});

describe("asking about an existing container", () => {
	const cli = { kind: "cli", commonDir: COMMON } as const;

	it("passes the flag to read-configuration only for a container that has the mount", () => {
		// The flag moves the workspace folder, and a container created without
		// it has the folder where it always was.
		expect(readConfigurationArguments(cli, true)).toEqual([
			MOUNT_COMMON_DIR_FLAG,
		]);
		expect(readConfigurationArguments(cli, false)).toEqual([]);
		expect(
			readConfigurationArguments({ kind: "bind", commonDir: COMMON }, true),
		).toEqual([]);
	});

	it("tells the person to recreate a container made without the mount", () => {
		const advice = missingMountAdvice("the container", "abc123", cli);
		expect(advice).toContain("docker rm -f abc123");
		expect(advice).toContain(COMMON);
		expect(missingMountAdvice("x", "abc", { kind: "none" })).toBeUndefined();
	});
});
