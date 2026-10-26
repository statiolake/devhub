/**
 * The person's Neovim configuration on this Mac, packed for another machine.
 *
 * Terminal mode brings the editor's environment to an SSH host instead of
 * asking the host to have one (`docs/terminal-mode.md`, "Terraforming"). The
 * configuration is the half that is the person's own: `~/.config/nvim`
 * (`$XDG_CONFIG_HOME/nvim`), which for most people who keep one is a symlink
 * into a dotfiles checkout. DevHub never writes it; it reads it, hashes it,
 * and hands the host a copy when the copy there is not this one.
 *
 * What is read:
 *
 * - **Symlinks are followed**, the root's and every one inside — the
 *   dotfiles case is a link at the top, and a config that links a file from
 *   elsewhere means that file's contents. A directory reached twice (a link
 *   loop) is walked once. A link to nothing is skipped and said.
 * - **Not read**: `.git` (a checkout's history is not configuration, and is
 *   most of its bytes), editor and OS litter (`.DS_Store`), and directories
 *   that are caches or dependency trees rather than configuration
 *   (`node_modules`, `.cache`, `__pycache__`, `.venv`). Plugins are not in
 *   here at all — lazy.nvim keeps them under the data directory — so they are
 *   installed on the host by the config itself.
 * - **Bounded**: a single file over `MAX_FILE_BYTES` is skipped and said,
 *   and a whole over `MAX_TOTAL_BYTES` is refused, by size: a configuration
 *   is kilobytes, and megabytes are something that was not meant to travel.
 *
 * The digest is over what the copy *means* — each path, whether it is a
 * directory, whether it is executable, and its bytes — not over the tarball,
 * so the same configuration hashes the same whenever it is packed, and an
 * unchanged one costs the host one comparison and nothing else.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

/** Names never read, at any depth. */
export const EXCLUDED_NAMES: ReadonlySet<string> = new Set([
	".git",
	".DS_Store",
	"node_modules",
	".cache",
	"__pycache__",
	".venv",
]);

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export interface ConfigEntry {
	/** Relative to the config root, `/`-separated. */
	readonly path: string;
	readonly directory: boolean;
	readonly executable: boolean;
	readonly mtimeSeconds: number;
	/** Empty for a directory. */
	readonly bytes: Uint8Array;
}

/** A configuration, read: what it is, and what was left out of it and why. */
export interface PackedNeovimConfig {
	readonly kind: "config";
	/** Where it was read from on this Mac, symlinks resolved. */
	readonly source: string;
	readonly digest: string;
	/** A gzipped tar of the entries, paths relative to the config root. */
	readonly tarball: Uint8Array;
	readonly files: number;
	readonly bytes: number;
	/** Sentences: what was skipped. Empty when nothing was. */
	readonly skipped: readonly string[];
}

export type LocalNeovimConfig =
	| PackedNeovimConfig
	| { readonly kind: "none"; readonly digest: "none"; readonly looked: string };

/** `$XDG_CONFIG_HOME/nvim`, or `~/.config/nvim`. */
export function neovimConfigDirectory(
	environment: Readonly<Record<string, string | undefined>>,
	home: string,
): string {
	const xdg = environment["XDG_CONFIG_HOME"];
	const base =
		xdg !== undefined && xdg.startsWith("/") ? xdg : join(home, ".config");
	return join(base, "nvim");
}

/** The ports a walk needs; `node:fs` by default. */
export interface ConfigFiles {
	realpath(path: string): Promise<string>;
	/** Following symlinks. */
	stat(path: string): Promise<{
		readonly directory: boolean;
		readonly file: boolean;
		readonly size: number;
		readonly mode: number;
		readonly mtimeMs: number;
	}>;
	readdir(path: string): Promise<readonly string[]>;
	readFile(path: string): Promise<Uint8Array>;
}

const NODE_CONFIG_FILES: ConfigFiles = {
	realpath: (path) => realpath(path),
	async stat(path) {
		const found = await stat(path);
		return {
			directory: found.isDirectory(),
			file: found.isFile(),
			size: found.size,
			mode: found.mode,
			mtimeMs: found.mtimeMs,
		};
	},
	readdir: (path) => readdir(path),
	readFile: async (path) => new Uint8Array(await readFile(path)),
};

/** Read the configuration at `directory`, or say there is none. */
export async function readNeovimConfig(
	directory: string,
	files: ConfigFiles = NODE_CONFIG_FILES,
): Promise<LocalNeovimConfig> {
	let root: string;
	try {
		root = await files.realpath(directory);
		if (!(await files.stat(root)).directory) {
			return { kind: "none", digest: "none", looked: directory };
		}
	} catch {
		return { kind: "none", digest: "none", looked: directory };
	}
	const entries: ConfigEntry[] = [];
	const skipped: string[] = [];
	const visited = new Set<string>([root]);
	let total = 0;
	const walk = async (absolute: string, relative: string): Promise<void> => {
		const names = [...(await files.readdir(absolute))].sort();
		for (const name of names) {
			if (EXCLUDED_NAMES.has(name)) continue;
			const path = join(absolute, name);
			const inside = relative === "" ? name : `${relative}/${name}`;
			let found;
			try {
				found = await files.stat(path);
			} catch {
				skipped.push(`${inside} (a link to nothing)`);
				continue;
			}
			if (found.directory) {
				const real = await files.realpath(path);
				if (visited.has(real)) continue;
				visited.add(real);
				entries.push({
					path: inside,
					directory: true,
					executable: true,
					mtimeSeconds: Math.floor(found.mtimeMs / 1_000),
					bytes: new Uint8Array(0),
				});
				await walk(path, inside);
				continue;
			}
			if (!found.file) continue;
			if (found.size > MAX_FILE_BYTES) {
				skipped.push(
					`${inside} (${String(Math.round(found.size / 1024 / 1024))} MB)`,
				);
				continue;
			}
			total += found.size;
			if (total > MAX_TOTAL_BYTES) {
				throw new Error(
					`${directory} is over ${String(MAX_TOTAL_BYTES / 1024 / 1024)} MB without .git, which is not a Neovim configuration DevHub will copy to another machine; look for something large in it that is not configuration.`,
				);
			}
			entries.push({
				path: inside,
				directory: false,
				executable: (found.mode & 0o111) !== 0,
				mtimeSeconds: Math.floor(found.mtimeMs / 1_000),
				bytes: await files.readFile(path),
			});
		}
	};
	await walk(root, "");
	return {
		kind: "config",
		source: root,
		digest: configDigest(entries),
		tarball: gzipSync(tarOf(entries)),
		files: entries.filter((entry) => !entry.directory).length,
		bytes: total,
		skipped,
	};
}

/** The identity of a configuration: paths, kinds, exec bits, contents. */
export function configDigest(entries: readonly ConfigEntry[]): string {
	const hash = createHash("sha256");
	for (const entry of [...entries].sort((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
	)) {
		const kind = entry.directory ? "d" : entry.executable ? "x" : "f";
		hash.update(`${kind}\0${entry.path}\0${String(entry.bytes.byteLength)}\0`);
		hash.update(entry.bytes);
	}
	return hash.digest("hex").slice(0, 32);
}

// --- tar --------------------------------------------------------------------
//
// ustar, with a pax `path` record for the rare name that does not fit — the
// two forms every `tar` a host has reads (GNU, bsdtar, busybox). Written here
// rather than by spawning this Mac's `tar` because the bytes must not depend
// on which `tar` that is, and the walk above already decided what goes in.

const BLOCK = 512;

function octal(value: number, width: number): string {
	return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function header(
	name: string,
	options: {
		readonly mode: number;
		readonly size: number;
		readonly mtime: number;
		readonly type: string;
	},
): Uint8Array {
	const block = Buffer.alloc(BLOCK, 0);
	const put = (text: string, offset: number, width: number): void => {
		block.write(text.slice(0, width), offset, width, "utf8");
	};
	put(name, 0, 100);
	put(octal(options.mode, 8), 100, 8);
	put(octal(0, 8), 108, 8);
	put(octal(0, 8), 116, 8);
	put(octal(options.size, 12), 124, 12);
	put(octal(options.mtime, 12), 136, 12);
	put("        ", 148, 8);
	put(options.type, 156, 1);
	put("ustar\0", 257, 6);
	put("00", 263, 2);
	let sum = 0;
	for (const byte of block) sum += byte;
	put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
	return block;
}

function padded(bytes: Uint8Array): Uint8Array[] {
	const rest = bytes.byteLength % BLOCK;
	return rest === 0 ? [bytes] : [bytes, Buffer.alloc(BLOCK - rest, 0)];
}

/** One pax record, whose length counts its own digits. */
function paxRecord(key: string, value: string): string {
	const body = ` ${key}=${value}\n`;
	let length = Buffer.byteLength(body) + 1;
	while (String(length).length + Buffer.byteLength(body) !== length) {
		length = String(length).length + Buffer.byteLength(body);
	}
	return `${String(length)}${body}`;
}

export function tarOf(entries: readonly ConfigEntry[]): Uint8Array {
	const blocks: Uint8Array[] = [];
	for (const entry of entries) {
		const name = entry.directory ? `${entry.path}/` : entry.path;
		const mode = entry.directory ? 0o755 : entry.executable ? 0o755 : 0o644;
		if (Buffer.byteLength(name) > 99) {
			const record = Buffer.from(paxRecord("path", name), "utf8");
			blocks.push(
				header("././@PaxHeader", {
					mode: 0o644,
					size: record.byteLength,
					mtime: entry.mtimeSeconds,
					type: "x",
				}),
				...padded(record),
			);
		}
		blocks.push(
			header(name, {
				mode,
				size: entry.directory ? 0 : entry.bytes.byteLength,
				mtime: entry.mtimeSeconds,
				type: entry.directory ? "5" : "0",
			}),
		);
		if (!entry.directory) blocks.push(...padded(entry.bytes));
	}
	blocks.push(Buffer.alloc(BLOCK * 2, 0));
	return Buffer.concat(blocks);
}
