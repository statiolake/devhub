/**
 * What a git worktree needs from its dev container to still be a repository.
 *
 * A linked worktree is a checkout without a repository of its own: its `.git`
 * is a one-line file, `gitdir: <path>`, naming its record inside the main
 * repository's `.git/worktrees/<name>`, and every object, ref and config it
 * reads is in that main `.git` — git calls it the *common dir*. `devcontainer
 * up` mounts the worktree's folder and nothing beside it, so inside the
 * container the link points at a folder that is not there and git answers
 * "not a git repository" for every command.
 *
 * The link can be relative (`../widget/.git/worktrees/x`, what `--relative-paths`
 * writes) or absolute, and the worktree can sit anywhere in the container — a
 * definition's own `workspaceMount` puts it at `/workspace`, the CLI's default
 * at `/workspaces/<name>`. Resolving the host link from there can land on a
 * path that cannot be mounted (above `/`, or inside the worktree itself): the
 * field failure was `/workspace/../vscode-pahcer-ui/.git/...`, with nothing
 * there. So DevHub does not follow the link at all. It makes git's view in
 * the container independent of the layout, with two mounts:
 *
 * 1. the common dir, read-write (commits write objects and refs), at a fixed
 *    path, `/opt/devhub/git/<repo>-<hash of its host path>.git`;
 * 2. a one-line file, `gitdir: <that path>/worktrees/<name>`, read-only, over
 *    the worktree's `.git` inside the workspace mount — a file over a file.
 *
 * The host's own `.git` file is untouched; only the container sees the
 * replacement. The file lives on the Docker machine in the worktree's own
 * record, `<common>/worktrees/<name>/devhub-container-gitdir` (git ignores
 * files it does not know there, and removing the worktree removes it), is
 * written once before `up` and never rewritten: Docker Desktop binds a single
 * file by inode, so a file replaced by rename would leave the container on the
 * old one, and a file that is not there when the container is created becomes
 * a directory. Its content depends only on the repository's path and the
 * worktree's name, so it never needs to change.
 *
 * The CLI's `--mount-git-worktree-common-dir` is no longer used: it only acts
 * on the CLI's default workspace mount, only for relative links, and moves the
 * workspace folder; the two mounts work for every case it covers and the ones
 * it does not.
 *
 * What does not work inside: the record's back-pointer
 * (`<common>/worktrees/<name>/gitdir`) names the worktree's host path, which is
 * not there, so `git worktree prune` run in the container would delete the
 * worktree's record. DevHub locks the worktrees it creates (`git worktree lock`,
 * which prune respects) and unlocks them before removing; a worktree made by
 * hand should not be pruned from inside its container. `status`, `commit`,
 * `fetch`, `log`, `branch`, `push` only need the forward link.
 *
 * Docker Compose: `--mount` is not something DevHub can rely on reaching a
 * Compose service, so nothing is added and the person is told which volumes
 * the compose file needs.
 *
 * A mount is fixed when a container is created. A container made without
 * these mounts keeps working, without git, and `ContainerHost` says so (see
 * `missingMountAdvice`): it has to be removed and created again.
 */

import { createHash } from "node:crypto";
import { posix } from "node:path";

/** Where common dirs are mounted in a container. */
export const CONTAINER_GIT_ROOT = "/opt/devhub/git";

/** The file, in a worktree's record, that the container sees as its `.git`. */
export const CONTAINER_DOT_GIT_FILE = "devhub-container-gitdir";

/** What this folder's container needs for git to work in it. */
export type WorktreeMount =
	/** Not a linked worktree (the main checkout, or not a repository). */
	| { readonly kind: "none" }
	/** The common dir at a fixed path, and a `.git` file over the worktree's. */
	| {
			readonly kind: "overlay";
			readonly commonDir: string;
			/** Where the common dir is mounted in the container. */
			readonly containerCommonDir: string;
			/** The file on the Docker machine that becomes the container's `.git`. */
			readonly dotGitFile: string;
			/** What that file says. */
			readonly dotGitContent: string;
			/** The worktree's `.git` in the container. */
			readonly containerDotGit: string;
			/**
			 * Where the worktree goes in the container, as the main checkout
			 * would; absent when DevHub could not tell (see `planWorkspace`).
			 */
			readonly workspace?: WorkspaceOverride;
			/** Why `workspace` is absent, for the build log. */
			readonly note?: string;
	  }
	/** Nothing DevHub can add (Docker Compose, unknown layout). Said, not fixed. */
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
 * Where the definition puts the worktree in its container, from
 * `read-configuration` (see `containerLayout`).
 */
export type ContainerLayout =
	| { readonly kind: "compose" }
	| { readonly kind: "single"; readonly containerToplevel: string };

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

/** Whether `path` is `folder` or inside it. */
function within(folder: string, path: string): boolean {
	const rest = posix.relative(folder, path);
	return rest !== ".." && !rest.startsWith("../") && !posix.isAbsolute(rest);
}

/** `source` and `target` of a `--mount`-style string, unquoted. */
function mountFields(mount: string): { source?: string; target?: string } {
	const fields = new Map<string, string>();
	for (const part of mount.match(/(?:[^,"]|"[^"]*")+/gu) ?? []) {
		const at = part.indexOf("=");
		if (at < 0) continue;
		fields.set(
			part.slice(0, at).trim().toLowerCase(),
			part
				.slice(at + 1)
				.trim()
				.replace(/^"(.*)"$/u, "$1"),
		);
	}
	return {
		source: fields.get("source") ?? fields.get("src"),
		target:
			fields.get("target") ?? fields.get("destination") ?? fields.get("dst"),
	};
}

/**
 * Where the worktree lands in its container, from `read-configuration`'s
 * merged configuration and `workspace.workspaceFolder`.
 *
 * `hostFolder` is the folder `devcontainer` was given (normally the worktree's
 * top level). In order: a `workspaceMount` whose source holds the top level
 * (its target, plus the rest of the path); the CLI's resolved
 * `workspaceFolder`; the CLI's default, `/workspaces/<name>`.
 */
export function containerLayout(
	hostFolder: string,
	toplevel: string,
	configuration: Record<string, unknown>,
	workspaceFolder: string | undefined,
): ContainerLayout {
	if (configuration["dockerComposeFile"] !== undefined) {
		return { kind: "compose" };
	}
	const host = canonicalPath(hostFolder);
	const stated = configuration["workspaceMount"];
	if (typeof stated === "string" && stated.trim().length > 0) {
		const { source, target } = mountFields(
			stated
				.replaceAll("${localWorkspaceFolderBasename}", posix.basename(host))
				.replaceAll("${localWorkspaceFolder}", host),
		);
		if (source?.startsWith("/") === true && target?.startsWith("/") === true) {
			const from = canonicalPath(source);
			if (within(from, toplevel)) {
				return {
					kind: "single",
					containerToplevel: posix.resolve(
						target,
						posix.relative(from, toplevel),
					),
				};
			}
		}
	}
	if (workspaceFolder?.startsWith("/") === true) {
		return {
			kind: "single",
			containerToplevel: posix.resolve(
				workspaceFolder,
				posix.relative(host, toplevel),
			),
		};
	}
	return {
		kind: "single",
		containerToplevel: posix.join("/workspaces", posix.basename(toplevel)),
	};
}

/**
 * The fixed container path for a common dir: the repository's folder name,
 * made safe, and a hash of the host path so two repositories of one name
 * never share it.
 */
export function containerCommonDir(commonDir: string): string {
	const repository =
		posix.basename(commonDir) === ".git"
			? posix.basename(posix.dirname(commonDir))
			: posix.basename(commonDir).replace(/\.git$/u, "");
	const safe = repository.replace(/[^A-Za-z0-9._-]/gu, "_") || "repository";
	const hash = createHash("sha256")
		.update(commonDir)
		.digest("hex")
		.slice(0, 12);
	return `${CONTAINER_GIT_ROOT}/${safe}-${hash}.git`;
}

/**
 * The mount a folder needs, from what git said about it and where the
 * definition puts it (`undefined` when `read-configuration` could not say).
 *
 * Pure, so the whole decision is tested without a repository or a CLI.
 */
export function planWorktreeMount(
	facts: WorktreeFacts | undefined,
	layout: ContainerLayout | undefined,
	workspace?: WorkspaceOverride | { readonly unsupported: string },
): WorktreeMount {
	// The main checkout's git dir *is* the common dir; only a linked worktree
	// has one of its own (`.git/worktrees/<name>`) beside it.
	if (facts === undefined || facts.gitDir === facts.commonDir) {
		return { kind: "none" };
	}
	// No readable `.git` file: a worktree laid out some way DevHub does not
	// know (`--separate-git-dir`, a submodule). Leaving it alone is what
	// happened before, and is never worse.
	if (facts.dotGit === undefined || gitdirLink(facts.dotGit) === undefined) {
		return { kind: "none" };
	}
	const { commonDir, gitDir } = facts;
	// The record must be `<common>/worktrees/<name>` for the fixed path to
	// name it; anything else is a layout DevHub leaves alone.
	if (posix.dirname(gitDir) !== posix.join(commonDir, "worktrees")) {
		return { kind: "none" };
	}
	const fixed = containerCommonDir(commonDir);
	const name = posix.basename(gitDir);
	if (layout === undefined) {
		return {
			kind: "unsupported",
			commonDir,
			reason:
				`DevHub could not read where the definition puts the folder, so ` +
				`the repository's .git (${commonDir}) is not mounted and git will ` +
				`not work inside the container.`,
		};
	}
	if (layout.kind === "compose") {
		return {
			kind: "unsupported",
			commonDir,
			reason:
				`its definition uses Docker Compose, where DevHub does not add ` +
				`mounts to the service, so the repository's .git (${commonDir}) is ` +
				`not mounted and git will not work inside the container. Add two ` +
				`volumes to the service in the compose file: ${commonDir}:${fixed} ` +
				`and ${posix.join(gitDir, CONTAINER_DOT_GIT_FILE)}:<the worktree's ` +
				`folder in the container>/.git:ro, the second a file containing ` +
				`"gitdir: ${fixed}/worktrees/${name}".`,
		};
	}
	return {
		kind: "overlay",
		commonDir,
		containerCommonDir: fixed,
		dotGitFile: posix.join(gitDir, CONTAINER_DOT_GIT_FILE),
		dotGitContent: `gitdir: ${fixed}/worktrees/${name}\n`,
		containerDotGit: posix.join(layout.containerToplevel, ".git"),
		...(workspace === undefined
			? {}
			: "unsupported" in workspace
				? { note: workspace.unsupported }
				: { workspace }),
	};
}

function quoted(path: string): string {
	return path.includes(",") ? `"${path}"` : path;
}

/**
 * What `devcontainer up` is given for the mount.
 *
 * A source or target with a comma in it is quoted the way the CLI quotes its
 * own mount strings, because `--mount` is a comma-separated list and an
 * unquoted comma would be read as the start of the next field.
 */
export function upArguments(mount: WorktreeMount): readonly string[] {
	if (mount.kind !== "overlay") return [];
	return [
		...(mount.workspace?.mounts ?? []).flatMap((one) => ["--mount", one]),
		"--mount",
		`type=bind,source=${quoted(mount.commonDir)},target=${quoted(mount.containerCommonDir)}`,
		"--mount",
		`type=bind,source=${quoted(mount.dotGitFile)},target=${quoted(mount.containerDotGit)},readonly`,
	];
}

/**
 * The shell command, run on the Docker machine before `up`, that writes the
 * container's `.git` file if it is not there yet. Never a rewrite: see the
 * top of this file.
 */
export function dotGitFileCommand(
	mount: WorktreeMount,
): readonly string[] | undefined {
	if (mount.kind !== "overlay") return undefined;
	return [
		"sh",
		"-c",
		'[ -f "$1" ] || printf "%s" "$2" > "$1"',
		"sh",
		mount.dotGitFile,
		mount.dotGitContent,
	];
}

/**
 * Whether a container's mounts (`docker inspect`'s source and destination
 * pairs) already give git what `mount` asks for: both, each at exactly its
 * place. A container from before (none, or the CLI flag's, or a mount of the
 * common dir at its host path) is as good as none.
 */
export function hasMount(
	mount: WorktreeMount,
	mounts: readonly { readonly source: string; readonly destination: string }[],
): boolean {
	if (mount.kind !== "overlay") return false;
	const has = (source: string, destination: string): boolean =>
		mounts.some(
			(one) =>
				one.source.length > 0 &&
				one.destination.length > 0 &&
				canonicalPath(one.source) === source &&
				canonicalPath(one.destination) === destination,
		);
	return (
		has(mount.commonDir, mount.containerCommonDir) &&
		has(mount.dotGitFile, mount.containerDotGit)
	);
}

/**
 * The sentence for a container that should have the mounts and does not.
 *
 * A mount can only be added by creating the container again; the container
 * keeps working meanwhile, without git, so this is advice and not a refusal.
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

/*
 * Where a worktree goes in its container.
 *
 * DevHub makes worktrees as siblings of the main checkout under another name
 * (`vscode-pahcer-ui` and `vscode-pahcer-ui_5`). Left to the CLI, everything a
 * definition derives from the folder follows that name: the default
 * `/workspaces/<name>`, a `workspaceFolder` of
 * `/workspace/${localWorkspaceFolderBasename}`, a `workspaceMount` of
 * `${localWorkspaceFolder}/..` that brings the siblings in. Paths a definition,
 * its scripts or its settings hard-code then point at nothing in a worktree's
 * container. So for a linked worktree DevHub resolves `workspaceMount` and
 * `workspaceFolder` as they would be for the *main checkout*, puts the
 * worktree where the main checkout would be, and hands the CLI the result as
 * `--override-config` (the definition's own content with those two keys
 * replaced; the CLI still resolves relative paths against the original file
 * and still labels the container with the worktree's folder, so each worktree
 * keeps its own container):
 *
 * - no `workspaceMount`: the worktree at `/workspaces/<main checkout's name>`;
 * - a mount of `${localWorkspaceFolder}` (any target): the same target, the
 *   worktree as its source;
 * - a mount of a folder above the main checkout (`${localWorkspaceFolder}/..`
 *   at `/workspace`): that mount as the main checkout would get it, and the
 *   worktree bound over the main checkout's place in it, so the siblings are
 *   there and the folder is the worktree.
 *
 * Other uses of `${localWorkspaceFolder}` (mounts, `initializeCommand`) keep
 * naming the worktree's host folder. Anything else (a volume, a source that is
 * not the checkout or above it, a bare repository with no main checkout) is
 * left as the definition says, and the build log says why.
 */

/** The file, in a worktree's record, given to the CLI as `--override-config`. */
export const CONTAINER_OVERRIDE_FILE = "devhub-devcontainer.json";

/** What `planWorkspace` decided, written for `--override-config`. */
export interface WorkspaceOverride {
	/** The override file on the Docker machine. */
	readonly file: string;
	/** Its content: the definition with `workspaceMount`/`workspaceFolder` set. */
	readonly content: string;
	/** `--mount` values beside the workspace mount. */
	readonly mounts: readonly string[];
	/** The worktree's top level in the container. */
	readonly containerToplevel: string;
}

/** The main checkout of a repository whose common dir is `commonDir`. */
export function mainCheckout(commonDir: string): string | undefined {
	return posix.basename(commonDir) === ".git"
		? posix.dirname(commonDir)
		: undefined;
}

/**
 * A `devcontainer.json` (JSON with comments and trailing commas) as an
 * object, or `undefined` when it is not one.
 */
export function parseJsonc(text: string): Record<string, unknown> | undefined {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const c = text[i] ?? "";
		if (c === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
			out += text.slice(i, j + 1);
			i = j + 1;
		} else if (c === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i += 1;
		} else if (c === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end < 0 ? text.length : end + 2;
		} else {
			out += c;
			i += 1;
		}
	}
	// Trailing commas, now that comments are gone; a string is skipped whole.
	const json = out.replace(
		/("(?:[^"\\]|\\.)*")|,(\s*[}\]])/gu,
		(all, str, rest) => (typeof str === "string" ? all : (rest as string)),
	);
	try {
		const parsed: unknown = JSON.parse(json);
		return typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/** `mount` with its source field replaced. */
function withSource(mount: string, source: string): string {
	return (mount.match(/(?:[^,"]|"[^"]*")+/gu) ?? [])
		.map((part) =>
			/^\s*(source|src)\s*=/iu.test(part) ? `source=${quoted(source)}` : part,
		)
		.join(",");
}

/**
 * Where the worktree goes in its container, from the definition as written
 * (`raw`), the folder `devcontainer` is given, the worktree's top level, the
 * main checkout and the worktree's record. Pure; see the comment above.
 */
export function planWorkspace(
	raw: Record<string, unknown>,
	hostFolder: string,
	toplevel: string,
	main: string,
	gitDir: string,
): WorkspaceOverride | { readonly unsupported: string } {
	const sub = posix.relative(toplevel, canonicalPath(hostFolder));
	if (sub === ".." || sub.startsWith("../")) {
		return { unsupported: `${hostFolder} is not inside ${toplevel}.` };
	}
	const mainFolder = posix.join(main, sub);
	const asMain = (text: string): string =>
		text
			.replaceAll("${localWorkspaceFolderBasename}", posix.basename(mainFolder))
			.replaceAll("${localWorkspaceFolder}", mainFolder);
	const stated = raw["workspaceMount"];
	const folder = raw["workspaceFolder"];
	let workspaceMount: string;
	let containerToplevel: string;
	let mounts: string[] = [];
	if (stated === undefined || stated === null || stated === "") {
		// The CLI's default: the git root at /workspaces/<its name>.
		containerToplevel = posix.join("/workspaces", posix.basename(main));
		workspaceMount = `type=bind,source=${quoted(toplevel)},target=${quoted(containerToplevel)},consistency=cached`;
	} else if (typeof stated === "string") {
		const resolved = asMain(stated);
		const { source, target } = mountFields(resolved);
		if (source?.startsWith("/") !== true || target?.startsWith("/") !== true) {
			return {
				unsupported:
					`its workspaceMount (${stated}) is not a bind of a host folder, so ` +
					`DevHub leaves it as written and paths derived from the folder ` +
					`name follow the worktree's (${posix.basename(toplevel)}).`,
			};
		}
		const from = canonicalPath(source);
		if (!within(from, main)) {
			return {
				unsupported:
					`its workspaceMount source (${source}) is neither the main ` +
					`checkout (${main}) nor a folder above it, so DevHub cannot tell ` +
					`where the worktree belongs and leaves it as written. Use ` +
					"${localWorkspaceFolder} or a folder above it as the source.",
			};
		}
		containerToplevel = posix.resolve(target, posix.relative(from, main));
		if (from === main) {
			workspaceMount = withSource(resolved, toplevel);
		} else {
			workspaceMount = resolved;
			mounts = [
				`type=bind,source=${quoted(toplevel)},target=${quoted(containerToplevel)}`,
			];
		}
	} else {
		return { unsupported: "its workspaceMount is not a string." };
	}
	const workspaceFolder =
		typeof folder === "string"
			? asMain(folder)
			: posix.join(containerToplevel, sub);
	return {
		file: posix.join(gitDir, CONTAINER_OVERRIDE_FILE),
		content: `${JSON.stringify({ ...raw, workspaceMount, workspaceFolder }, null, "\t")}\n`,
		mounts,
		containerToplevel,
	};
}

/** `--override-config` for every `devcontainer` command, when there is one. */
export function configArguments(mount: WorktreeMount): readonly string[] {
	return mount.kind === "overlay" && mount.workspace !== undefined
		? ["--override-config", mount.workspace.file]
		: [];
}

/**
 * The command that writes the override file. Rewritten every time: it is read
 * by the CLI, never bound into a container.
 */
export function overrideFileCommand(
	mount: WorktreeMount,
): readonly string[] | undefined {
	if (mount.kind !== "overlay" || mount.workspace === undefined) {
		return undefined;
	}
	return [
		"sh",
		"-c",
		'printf "%s" "$2" > "$1"',
		"sh",
		mount.workspace.file,
		mount.workspace.content,
	];
}
