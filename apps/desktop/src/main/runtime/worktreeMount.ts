/**
 * What a git worktree needs from its dev container to still be a repository.
 *
 * A linked worktree is a checkout without a repository of its own: its `.git`
 * is a one-line file, `gitdir: <path>`, naming its record inside the main
 * repository's `.git/worktrees/<name>`, and every object, ref and config it
 * reads is in that main `.git` — git calls it the *common dir*. `devcontainer
 * up` mounts the worktree's folder and nothing beside it, so inside the
 * container the link points at a folder that is not there and git answers
 * "not a git repository" for every command: no status, no commit, no branch
 * row, no Source Control view.
 *
 * The fix is one more mount, of the common dir, placed where the link expects
 * it — and which mount that is depends on how the link was written:
 *
 * - **Relative** (`gitdir: ../widget/.git/worktrees/x`, what `git worktree add
 *   --relative-paths` writes from git 2.48, and what DevHub asks for when the
 *   machine's git has it — `shell/git.ts`, `worktreeAddArguments`). The
 *   `@devcontainers/cli` does this itself: `--mount-git-worktree-common-dir`
 *   (default off; present in the 0.89 CLI
 *   DevHub was checked against, and probed for with `up --help` before use) mounts the worktree and the common dir
 *   under `/workspaces` with their relative layout on the host kept, so the
 *   relative link — and the record's `gitdir` back-pointer — resolve in the
 *   container exactly as they do here. The flag also moves the worktree's own
 *   folder in the container (`/workspaces/<parent>/<worktree>` rather than
 *   `/workspaces/<worktree>`), which is why `read-configuration` has to be
 *   given it too, and only for a container that was created with it.
 * - **Absolute** (`gitdir: /Users/me/src/widget/.git/worktrees/x`, every git
 *   before 2.48 and every worktree made before DevHub asked for relative
 *   ones). The CLI's flag deliberately does nothing for these, so DevHub adds
 *   a plain `--mount` of the common dir **at the same absolute path** inside
 *   the container: the absolute link then names a folder that is there. The
 *   one thing this cannot fix is the record's back-pointer, which names the
 *   worktree's *host* path; git only reads it to decide whether a worktree is
 *   prunable, so `git worktree prune` must not be run inside the container
 *   (it would forget the worktree). `git worktree repair --relative-paths` on
 *   the Mac converts such a worktree to the first case for good.
 *
 * Both are read-write, because committing writes objects and refs into the
 * common dir. Neither touches the repository's `devcontainer.json`: the mount
 * is a fact about where this checkout sits on this machine, not about the
 * project, and a teammate opening the main checkout must get the container the
 * file describes. The main checkout itself — and anything that is not a git
 * worktree — gets nothing extra.
 *
 * A mount is fixed when a container is created. A container made before this
 * existed (or by a CLI without the flag) keeps working exactly as before,
 * without git; it gets the mount only when it is removed and built again, and
 * `ContainerHost` says so when it finds one (see `missingMountAdvice`).
 */

import { posix } from "node:path";

/** The flag the `@devcontainers/cli` takes for the relative-link case. */
export const MOUNT_COMMON_DIR_FLAG = "--mount-git-worktree-common-dir";

/** What this folder's container needs for git to work in it. */
export type WorktreeMount =
	/** Not a linked worktree (the main checkout, or not a repository). */
	| { readonly kind: "none" }
	/** A relative link: the CLI's own `--mount-git-worktree-common-dir`. */
	| { readonly kind: "cli"; readonly commonDir: string }
	/** An absolute link: `--mount` of the common dir at the same path. */
	| { readonly kind: "bind"; readonly commonDir: string }
	/** A relative link and a CLI too old to mount it. Said, not fixed. */
	| {
			readonly kind: "unsupported";
			readonly commonDir: string;
			readonly reason: string;
	  };

/** What `git rev-parse --path-format=absolute` said about the folder. */
export interface WorktreeFacts {
	readonly toplevel: string;
	readonly gitDir: string;
	readonly commonDir: string;
	/** The contents of `<toplevel>/.git`, if it is a file. */
	readonly dotGit: string | undefined;
}

/**
 * The three lines of `git rev-parse --path-format=absolute --show-toplevel
 * --git-dir --git-common-dir`, or `undefined` for any other answer.
 */
export function parseRevParse(
	stdout: string,
): Omit<WorktreeFacts, "dotGit"> | undefined {
	const lines = stdout.split("\n").map((line) => line.trim());
	const [toplevel = "", gitDir = "", commonDir = ""] = lines;
	if (![toplevel, gitDir, commonDir].every((line) => line.startsWith("/"))) {
		return undefined;
	}
	return {
		toplevel: canonicalPath(toplevel),
		gitDir: canonicalPath(gitDir),
		commonDir: canonicalPath(commonDir),
	};
}

/**
 * One spelling of an absolute path, so git's answer and docker's compare:
 * `rev-parse` can print the common dir with a trailing slash and `docker
 * inspect` never does.
 */
export function canonicalPath(path: string): string {
	return posix.resolve("/", path);
}

/** The path a worktree's `.git` file links to, as written. */
export function gitdirLink(dotGit: string): string | undefined {
	const found = /^gitdir:\s*(.+?)\s*$/mu.exec(dotGit);
	return found?.[1];
}

/**
 * The mount a folder needs, from what git said about it.
 *
 * Pure, so the whole decision is tested without a repository or a CLI:
 * `cliHasFlag` is whether this machine's `devcontainer up --help` lists
 * `--mount-git-worktree-common-dir`.
 */
export function planWorktreeMount(
	facts: WorktreeFacts | undefined,
	cliHasFlag: boolean,
): WorktreeMount {
	// The main checkout's git dir *is* the common dir; only a linked worktree
	// has one of its own (`.git/worktrees/<name>`) beside it.
	if (facts === undefined || facts.gitDir === facts.commonDir) {
		return { kind: "none" };
	}
	const link =
		facts.dotGit === undefined ? undefined : gitdirLink(facts.dotGit);
	// No readable `.git` file: a worktree laid out some way DevHub does not
	// know (`--separate-git-dir`, a submodule). Leaving it alone is what
	// happened before, and is never worse.
	if (link === undefined) return { kind: "none" };
	const { commonDir } = facts;
	if (link.startsWith("/")) return { kind: "bind", commonDir };
	return cliHasFlag
		? { kind: "cli", commonDir }
		: {
				kind: "unsupported",
				commonDir,
				reason:
					`this devcontainer CLI has no ${MOUNT_COMMON_DIR_FLAG}, so the ` +
					`repository's .git (${commonDir}) is not mounted and git will not ` +
					`work inside the container. Update the devcontainer CLI.`,
			};
}

/**
 * What `devcontainer up` is given for the mount.
 *
 * A source or target with a comma in it is quoted the way the CLI quotes its
 * own mount strings, because `--mount` is a comma-separated list and an
 * unquoted comma would be read as the start of the next field.
 */
export function upArguments(mount: WorktreeMount): readonly string[] {
	switch (mount.kind) {
		case "cli":
			return [MOUNT_COMMON_DIR_FLAG];
		case "bind": {
			const path = mount.commonDir.includes(",")
				? `"${mount.commonDir}"`
				: mount.commonDir;
			return ["--mount", `type=bind,source=${path},target=${path}`];
		}
		default:
			return [];
	}
}

/**
 * What `read-configuration` is given, for a container that has the mount.
 *
 * Only the CLI's flag changes the answer — it moves the workspace folder —
 * and only a container created with it is laid out that way, so the caller
 * passes `mounted` from the container's own `docker inspect`.
 */
export function readConfigurationArguments(
	mount: WorktreeMount,
	mounted: boolean,
): readonly string[] {
	return mount.kind === "cli" && mounted ? [MOUNT_COMMON_DIR_FLAG] : [];
}

/**
 * The sentence for a container that should have the mount and does not.
 *
 * It was created before DevHub added the mount (or by hand), and a mount can
 * only be added by creating the container again; the container keeps working
 * meanwhile, without git, so this is advice and not a refusal.
 */
export function missingMountAdvice(
	machineName: string,
	containerId: string,
	mount: WorktreeMount,
): string | undefined {
	if (mount.kind === "none") return undefined;
	if (mount.kind === "unsupported") {
		return `${machineName} is a git worktree, but ${mount.reason}`;
	}
	return (
		`${machineName} is a git worktree and its container was created ` +
		`without the repository's .git (${mount.commonDir}) mounted, so git ` +
		`does not work inside it. Remove the container (docker rm -f ` +
		`${containerId}) and reopen the editor in its container to recreate it ` +
		`with the mount.`
	);
}
