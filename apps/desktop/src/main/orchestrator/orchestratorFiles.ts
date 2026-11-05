/**
 * The orchestrator's folder, read-only, for the Orchestrator screen's Files
 * tab: list a folder, read a file, and say when something in it changed.
 *
 * The page names paths from the root (`decisions.md`, `.claude/skills/x`),
 * never absolute ones, and every one is confined here: an absolute path, a
 * `..` segment, or a symlink whose target lies outside the root is refused
 * before anything is read. What a listing leaves out is noise (`.git`,
 * `node_modules`, `.DS_Store`, …) and, when the root is in a git checkout,
 * what its `.gitignore` ignores; dot-folders such as `.claude` stay, since
 * the orchestrator's skills live there. See `docs/orchestrator.md`.
 */

import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import type {
	OrchestratorFileEntryWire,
	OrchestratorFileWire,
	OrchestratorFolderWire,
} from "../../ipc/contract.js";

/** Names that are never worth listing, wherever they are. */
const NOISE = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	".DS_Store",
	"Thumbs.db",
	"__pycache__",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	".venv",
	".Trashes",
	".Spotlight-V100",
	".fseventsd",
]);

/** Whether a name is noise: one of `NOISE`, or an editor's leftovers. */
export function isNoise(name: string): boolean {
	return (
		NOISE.has(name) ||
		name.endsWith(".swp") ||
		name.endsWith(".swo") ||
		name.endsWith("~")
	);
}

/** Whether a path from the root runs through noise (`.git/index`). */
function inNoise(path: string): boolean {
	return path.split("/").some(isNoise);
}

const MARKDOWN = new Set([".md", ".markdown", ".mdx"]);
const IMAGES: Readonly<Record<string, string>> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".bmp": "image/bmp",
	".ico": "image/x-icon",
	".svg": "image/svg+xml",
};
/** The highlighter's name for an extension, where it is not the extension. */
const LANGUAGES: Readonly<Record<string, string>> = {
	".ts": "typescript",
	".tsx": "tsx",
	".js": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".jsx": "jsx",
	".py": "python",
	".rb": "ruby",
	".rs": "rust",
	".sh": "bash",
	".zsh": "bash",
	".bash": "bash",
	".yml": "yaml",
	".yaml": "yaml",
	".toml": "toml",
	".json": "json",
	".jsonl": "json",
	".go": "go",
	".swift": "swift",
	".sql": "sql",
	".css": "css",
	".html": "html",
	".xml": "xml",
	".diff": "diff",
	".patch": "diff",
};

/** Text larger than this is not drawn; an image, `MAX_IMAGE`. */
export const MAX_TEXT = 1024 * 1024;
export const MAX_IMAGE = 8 * 1024 * 1024;

/** A refusal the page shows as words. */
export class OrchestratorFileError extends Error {
	override readonly name = "OrchestratorFileError";
}

/**
 * The absolute path of `path` (from the root), once it is known to be
 * inside: no absolute path, no `..`, and — where it exists — its real
 * location, symlinks followed, under the root's real location.
 */
export async function insideRoot(root: string, path: unknown): Promise<string> {
	if (typeof path !== "string" || path.includes("\0"))
		throw new OrchestratorFileError(`${JSON.stringify(path)} is not a path`);
	if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/u.test(path))
		throw new OrchestratorFileError(
			`${path} is not in the orchestrator's folder: paths are from its root`,
		);
	const segments = path
		.split(/[/\\]/u)
		.filter((one) => one !== "" && one !== ".");
	if (segments.includes(".."))
		throw new OrchestratorFileError(
			`${path} leads out of the orchestrator's folder`,
		);
	const absolute = segments.length === 0 ? root : join(root, ...segments);
	const realRoot = await realpath(root);
	let real: string;
	try {
		real = await realpath(absolute);
	} catch {
		throw new OrchestratorFileError(`${path} is not there`);
	}
	if (real !== realRoot && !real.startsWith(realRoot + sep))
		throw new OrchestratorFileError(
			`${path} leads out of the orchestrator's folder`,
		);
	return absolute;
}

/**
 * Which of `paths` (from the root) git ignores, or none when the root is not
 * in a checkout or git is not there. One `git check-ignore` for a listing.
 */
export function gitIgnored(
	root: string,
	paths: readonly string[],
): Promise<ReadonlySet<string>> {
	if (paths.length === 0) return Promise.resolve(new Set());
	return new Promise((resolve) => {
		const child = execFile(
			"git",
			["-C", root, "check-ignore", "-z", "--stdin"],
			{ timeout: 3000, maxBuffer: 1024 * 1024 },
			(error, stdout) => {
				// 1 is "nothing ignored"; 128 "not a repository": both are none.
				if (error !== null && stdout === "") {
					resolve(new Set());
					return;
				}
				resolve(new Set(stdout.split("\0").filter((one) => one !== "")));
			},
		);
		child.stdin?.end(paths.join("\0") + "\0");
		child.stdin?.on("error", () => undefined);
	});
}

export type IgnoredBy = (
	root: string,
	paths: readonly string[],
) => Promise<ReadonlySet<string>>;

/** One folder, from the root: noise, ignored and escaping symlinks left out. */
export async function listFolder(
	root: string,
	path: string,
	ignored: IgnoredBy = gitIgnored,
): Promise<OrchestratorFolderWire> {
	const folder = await insideRoot(root, path);
	const prefix = normalise(path);
	const realRoot = await realpath(root);
	const dirents = await readdir(folder, { withFileTypes: true });
	const candidates: OrchestratorFileEntryWire[] = [];
	for (const dirent of dirents) {
		if (isNoise(dirent.name)) continue;
		const from = prefix === "" ? dirent.name : `${prefix}/${dirent.name}`;
		let kind: OrchestratorFileEntryWire["kind"];
		if (dirent.isSymbolicLink()) {
			// Listed as what it leads to, and only when that is inside.
			try {
				const real = await realpath(join(folder, dirent.name));
				if (real !== realRoot && !real.startsWith(realRoot + sep)) continue;
				kind = (await stat(real)).isDirectory() ? "directory" : "file";
			} catch {
				continue;
			}
		} else if (dirent.isDirectory()) kind = "directory";
		else if (dirent.isFile()) kind = "file";
		else continue;
		candidates.push({ name: dirent.name, path: from, kind });
	}
	const gone = await ignored(
		root,
		candidates.map((entry) =>
			entry.kind === "directory" ? `${entry.path}/` : entry.path,
		),
	);
	const entries = candidates
		.filter((entry) => !gone.has(entry.path) && !gone.has(`${entry.path}/`))
		.sort((a, b) =>
			a.kind === b.kind
				? a.name.localeCompare(b.name, undefined, { numeric: true })
				: a.kind === "directory"
					? -1
					: 1,
		);
	return { root, path: prefix, entries };
}

/** One file, from the root, as the Files tab draws it. */
export async function readRootFile(
	root: string,
	path: string,
): Promise<OrchestratorFileWire> {
	const absolute = await insideRoot(root, path);
	const info = await stat(absolute);
	if (info.isDirectory())
		throw new OrchestratorFileError(`${path} is a folder`);
	const from = normalise(path);
	const base = {
		path: from,
		size: info.size,
		modifiedAt: Math.round(info.mtimeMs),
	};
	const extension = extname(from).toLowerCase();
	const image = IMAGES[extension];
	if (image !== undefined) {
		if (info.size > MAX_IMAGE) return { ...base, kind: "too_large" };
		const bytes = await readFile(absolute);
		return {
			...base,
			kind: "image",
			dataUrl: `data:${image};base64,${bytes.toString("base64")}`,
		};
	}
	if (info.size > MAX_TEXT) return { ...base, kind: "too_large" };
	const bytes = await readFile(absolute);
	if (bytes.subarray(0, 8000).includes(0)) return { ...base, kind: "binary" };
	const text = bytes.toString("utf8");
	if (MARKDOWN.has(extension)) return { ...base, kind: "markdown", text };
	const language = LANGUAGES[extension] ?? extension.slice(1);
	return {
		...base,
		kind: "text",
		text,
		...(language === "" ? {} : { language }),
	};
}

/** `a//b/./c/` → `a/b/c`; the root is `""`. */
function normalise(path: string): string {
	return path
		.split(/[/\\]/u)
		.filter((one) => one !== "" && one !== ".")
		.join("/");
}

/**
 * Watch the root, recursively, and say which paths changed — at most once
 * per `debounceMs`, all of them together. Noise (`.git/…`) is not news.
 * Returns the stop.
 */
export function watchRoot(
	root: string,
	changed: (paths: readonly string[]) => void,
	options: {
		readonly debounceMs?: number;
		readonly watchImpl?: typeof watch;
	} = {},
): () => void {
	const debounceMs = options.debounceMs ?? 250;
	const watchImpl = options.watchImpl ?? watch;
	const pending = new Set<string>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const flush = () => {
		timer = undefined;
		if (pending.size === 0) return;
		const paths = [...pending];
		pending.clear();
		changed(paths);
	};
	let watcher: FSWatcher | undefined;
	try {
		watcher = watchImpl(root, { recursive: true }, (_event, name) => {
			const path =
				name === null
					? ""
					: normalise(typeof name === "string" ? name : String(name));
			if (path !== "" && inNoise(path)) return;
			pending.add(path);
			if (timer === undefined) timer = setTimeout(flush, debounceMs);
		});
		watcher.on("error", () => undefined);
	} catch {
		watcher = undefined;
	}
	return () => {
		watcher?.close();
		if (timer !== undefined) clearTimeout(timer);
	};
}

/** Whether `root` is a folder that can be listed. */
export async function rootProblem(
	root: string | undefined,
): Promise<string | undefined> {
	if (root === undefined) return "No orchestrator folder is set.";
	try {
		if (!(await stat(root)).isDirectory()) return `${root} is not a folder.`;
	} catch {
		return `${root} is not there yet. Starting the orchestrator makes it.`;
	}
	return undefined;
}
