/**
 * The Neovim setup of this Mac, as the tree DevHub carries to an SSH host
 * (`docs/remote-neovim-config.md`).
 *
 * Three things, and none of them knows a plugin by name:
 *
 * - **What the setup is** (`resolveLocalSetup`): the local Neovim is asked
 *   where its config and its lazy.nvim root are, and which plugins the spec
 *   has, with a build step or without. DevHub knows lazy.nvim's standard spec
 *   (`build`, a `build.lua`), not the plugins in it.
 * - **The units** (`collectUnit`): the config, and one unit per installed
 *   plugin. Each is a filtered list of files with a digest, so a sync sends
 *   only what changed. The filters are generic: `.git` and secrets are never
 *   carried, and tests and source maps are trimmed. Nothing is dropped by
 *   its binary format: a plugin that bundles a binary for every platform
 *   works as it is, and one this Mac built for itself is a dead file there
 *   that the plugin's own build step replaces on the host.
 * - **The stream** (`tarUnits`): one ustar archive, gzipped, written here
 *   rather than by this Mac's `tar`, so it holds exactly the filtered list
 *   with normalised owners and no AppleDouble or extended attributes.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
	lstat,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";

const gzipAsync = promisify(gzip);

/** One plugin of the local lazy.nvim spec, as the local Neovim answered. */
export interface LocalPlugin {
	readonly name: string;
	readonly dir: string;
	readonly installed: boolean;
	/** The spec declares a build step: `build`, or a `build.lua` in the plugin. */
	readonly build: boolean;
}

/** Where this Mac's Neovim setup is, as its own Neovim says. */
export interface LocalSetup {
	/** `stdpath('config')`, symlinks resolved. */
	readonly config: string;
	/** `stdpath('data')`, symlinks resolved. */
	readonly data: string;
	/** lazy.nvim's root and lockfile; `undefined` for a config without lazy.nvim. */
	readonly root: string | undefined;
	readonly lockfile: string | undefined;
	readonly plugins: readonly LocalPlugin[];
}

/**
 * What the local Neovim is asked. Run with `--cmd` guard (`LOCAL_QUERY_GUARD`)
 * so that asking never installs or checks anything here either.
 */
export const LOCAL_QUERY_LUA = `
local out = {
  config = vim.fn.resolve(vim.fn.stdpath('config')),
  data = vim.fn.resolve(vim.fn.stdpath('data')),
  plugins = {},
}
local ok, C = pcall(require, 'lazy.core.config')
if ok and type(C.options) == 'table' and type(C.plugins) == 'table' then
  out.root = C.options.root and vim.fn.resolve(C.options.root) or nil
  out.lockfile = C.options.lockfile and vim.fn.resolve(C.options.lockfile) or nil
  for _, p in pairs(C.plugins) do
    local build = p.build ~= nil and p.build ~= false
    if not build and p.build ~= false and type(p.dir) == 'string' then
      build = vim.uv.fs_stat(p.dir .. '/build.lua') ~= nil or vim.uv.fs_stat(p.dir .. '/build/init.lua') ~= nil
    end
    table.insert(out.plugins, {
      name = p.name, dir = p.dir and vim.fn.resolve(p.dir) or '',
      installed = (p._ and p._.installed) == true, build = build,
    })
  end
end
vim.fn.writefile({ vim.json.encode(out) }, vim.env.DEVHUB_CARRY_OUT)
`;

/**
 * Loaded with `--cmd` when DevHub asks the local Neovim: lazy.nvim's setup
 * with installs and the update checker off, so a plugin missing here is not
 * cloned because DevHub asked a question.
 */
export const LOCAL_QUERY_GUARD = `
package.preload['lazy'] = function(name)
  package.preload['lazy'] = nil
  for i = 2, #package.loaders do
    local loader = package.loaders[i](name)
    if type(loader) == 'function' then
      local M = loader(name)
      local setup = M.setup
      M.setup = function(spec, opts)
        if type(spec) == 'table' and spec.spec then opts = spec else opts = opts or {}; opts.spec = spec end
        opts.install = vim.tbl_extend('force', opts.install or {}, { missing = false })
        opts.checker = vim.tbl_extend('force', opts.checker or {}, { enabled = false })
        opts.change_detection = vim.tbl_extend('force', opts.change_detection or {}, { enabled = false })
        return setup(opts)
      end
      return M
    end
  end
  error('lazy.nvim is not on the runtimepath')
end
`;

/**
 * Ask the local Neovim (`nvim`, DevHub's own) where the setup is, under
 * `DEVHUB_NEOVIM_GUI=1`, so that `cond` evaluates as it does in DevHub.
 */
export async function resolveLocalSetup(
	nvim: string,
	environment: Readonly<Record<string, string | undefined>>,
	timeoutMs = 60_000,
): Promise<LocalSetup> {
	const scratch = await mkdtemp(join(tmpdir(), "devhub-carry-"));
	const out = join(scratch, "setup.json");
	const query = join(scratch, "query.lua");
	const guard = join(scratch, "guard.lua");
	try {
		const { writeFile } = await import("node:fs/promises");
		await writeFile(query, LOCAL_QUERY_LUA);
		await writeFile(guard, LOCAL_QUERY_GUARD);
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(environment)) {
			if (value !== undefined) env[key] = value;
		}
		delete env.VIMRUNTIME;
		delete env.VIM;
		env.DEVHUB_NEOVIM_GUI = "1";
		env.DEVHUB_CARRY_OUT = out;
		await promisify(execFile)(
			nvim,
			[
				"--headless",
				"-i",
				"NONE",
				"--cmd",
				`lua dofile(${luaString(guard)})`,
				"-c",
				`lua dofile(${luaString(query)})`,
				"-c",
				"qa!",
			],
			{ env, timeout: timeoutMs, cwd: scratch, maxBuffer: 4 * 1024 * 1024 },
		);
		const answer = JSON.parse(await readFile(out, "utf8")) as {
			config?: string;
			data?: string;
			root?: string;
			lockfile?: string;
			plugins?: unknown;
		};
		if (typeof answer.config !== "string" || typeof answer.data !== "string") {
			throw new Error("the local Neovim did not say where its config is");
		}
		const plugins = Array.isArray(answer.plugins)
			? (answer.plugins as LocalPlugin[]).filter(
					(p) => typeof p.name === "string" && typeof p.dir === "string",
				)
			: [];
		plugins.sort((a, b) => a.name.localeCompare(b.name));
		return {
			config: answer.config,
			data: answer.data,
			root: typeof answer.root === "string" ? answer.root : undefined,
			lockfile:
				typeof answer.lockfile === "string" ? answer.lockfile : undefined,
			plugins,
		};
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

export function luaString(text: string): string {
	return `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll("\n", "\\n")}'`;
}

/** One file of a unit, as it goes into the archive. */
export interface UnitEntry {
	/** Relative to the unit's root, `/`-separated. */
	readonly path: string;
	readonly kind: "file" | "directory" | "symlink";
	/** Unix permission bits. */
	readonly mode: number;
	readonly size: number;
	readonly mtimeSeconds: number;
	/** The absolute path here, for a file. */
	readonly source?: string;
	/** For a symlink: its target, relative, inside the unit. */
	readonly target?: string;
}

/** Why a file was left out, named in the sync's notice. */
export interface DroppedFile {
	readonly path: string;
	readonly reason: "secret" | "symlink-outside";
}

export interface Unit {
	/** `config`, or `plugin/<name>`. */
	readonly name: string;
	readonly root: string;
	readonly entries: readonly UnitEntry[];
	readonly dropped: readonly DroppedFile[];
	/** sha256 over every entry's path, kind, mode and content. */
	readonly digest: string;
	/** The bytes of the files, before compression. */
	readonly bytes: number;
}

/** Names never carried, whatever else is said: they are where secrets live. */
const SECRET_NAMES: readonly RegExp[] = [
	/^\.env/u,
	/\.pem$/u,
	/\.key$/u,
	/\.p12$/u,
	/\.pfx$/u,
	/^id_/u,
	/^\.netrc$/u,
	/^\.authinfo/u,
	/\.gpg$/u,
	/\.kdbx$/u,
	/^hosts\.yml$/u,
	/credentials/iu,
];

/** Token shapes: a text file with one of these in it stays here. */
const TOKEN_SHAPES: readonly RegExp[] = [
	/\bghp_[A-Za-z0-9]{36}\b/u,
	/\bgho_[A-Za-z0-9]{36}\b/u,
	/\bgithub_pat_[A-Za-z0-9_]{60,}\b/u,
	/\bsk-[A-Za-z0-9_-]{32,}\b/u,
	/\bxox[bp]-[0-9]{6,}-[A-Za-z0-9-]{10,}\b/u,
	/\bAKIA[0-9A-Z]{16}\b/u,
	/-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=]{16,}/u,
];

/** Files only a text scan reads: a token is not in a 2 MB bundle. */
const TOKEN_SCAN_LIMIT = 2 * 1024 * 1024;

/** Names that are this Mac's file system and not anybody's config. */
const MAC_LITTER: readonly RegExp[] = [/^\.DS_Store$/u, /^\._/u];

export function isSecretName(name: string): boolean {
	return SECRET_NAMES.some((pattern) => pattern.test(name));
}

export function hasTokenShape(bytes: Uint8Array): boolean {
	if (bytes.byteLength > TOKEN_SCAN_LIMIT) return false;
	const head = bytes.subarray(0, Math.min(bytes.byteLength, 8192));
	if (head.includes(0)) return false;
	const text = Buffer.from(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	).toString("latin1");
	return TOKEN_SHAPES.some((pattern) => pattern.test(text));
}

export interface UnitRules {
	/**
	 * Trim what no plugin reads at run time: `tests/` and `test/` at the
	 * unit's top, and `*.map` anywhere (`docs/remote-neovim-config.md`, Sizes).
	 */
	readonly trim: boolean;
	/** For the config: only these paths (git's tracked and unignored files). */
	readonly only?: ReadonlySet<string>;
}

interface Verdict {
	readonly key: string;
	readonly sha: string;
	readonly drop: DroppedFile["reason"] | undefined;
}

/**
 * The digest and verdict of each file read, keyed by what would change them,
 * so an unchanged tree is not read again at the next sync.
 */
export class FileVerdicts {
	readonly #cache = new Map<string, Verdict>();

	async of(path: string, size: number, mtimeMs: number, ino: number) {
		const key = `${String(size)}:${String(mtimeMs)}:${String(ino)}`;
		const cached = this.#cache.get(path);
		if (cached !== undefined && cached.key === key) return cached;
		const bytes = await readFile(path);
		const verdict: Verdict = {
			key,
			sha: createHash("sha256").update(bytes).digest("hex"),
			drop: hasTokenShape(bytes) ? "secret" : undefined,
		};
		this.#cache.set(path, verdict);
		return verdict;
	}
}

/** One unit: the files under `root` that are carried, with their digest. */
export async function collectUnit(
	name: string,
	root: string,
	rules: UnitRules,
	verdicts: FileVerdicts,
): Promise<Unit> {
	const entries: UnitEntry[] = [];
	const dropped: DroppedFile[] = [];
	const hash = createHash("sha256");
	let bytes = 0;
	const walk = async (directory: string, prefix: string): Promise<void> => {
		const names = (await readdir(directory)).sort();
		for (const child of names) {
			const path = prefix === "" ? child : `${prefix}/${child}`;
			if (child === ".git") continue;
			if (MAC_LITTER.some((pattern) => pattern.test(child))) continue;
			const absolute = join(directory, child);
			const stat = await lstat(absolute).catch(() => undefined);
			if (stat === undefined) continue;
			if (stat.isDirectory()) {
				if (
					rules.trim &&
					prefix === "" &&
					(child === "tests" || child === "test")
				) {
					continue;
				}
				if (rules.only !== undefined && !hasUnder(rules.only, path)) continue;
				entries.push({
					path,
					kind: "directory",
					mode: 0o755,
					size: 0,
					mtimeSeconds: Math.floor(stat.mtimeMs / 1000),
				});
				hash.update(`d\0${path}\0`);
				await walk(absolute, path);
				continue;
			}
			if (rules.only !== undefined && !rules.only.has(path)) continue;
			if (isSecretName(child)) {
				dropped.push({ path, reason: "secret" });
				continue;
			}
			if (rules.trim && child.endsWith(".map")) continue;
			if (stat.isSymbolicLink()) {
				const target = await readlink(absolute);
				const landing = resolve(directory, target);
				const inside = relative(root, landing);
				if (inside.startsWith("..") || isAbsolute(inside) || inside === "") {
					dropped.push({ path, reason: "symlink-outside" });
					continue;
				}
				const relativeTarget = relative(directory, landing)
					.split(sep)
					.join("/");
				entries.push({
					path,
					kind: "symlink",
					mode: 0o777,
					size: 0,
					mtimeSeconds: Math.floor(stat.mtimeMs / 1000),
					target: relativeTarget,
				});
				hash.update(`l\0${path}\0${relativeTarget}\0`);
				continue;
			}
			if (!stat.isFile()) continue;
			const verdict = await verdicts.of(
				absolute,
				stat.size,
				stat.mtimeMs,
				stat.ino,
			);
			if (verdict.drop !== undefined) {
				dropped.push({ path, reason: verdict.drop });
				continue;
			}
			const mode = stat.mode & 0o111 ? 0o755 : 0o644;
			entries.push({
				path,
				kind: "file",
				mode,
				size: stat.size,
				mtimeSeconds: Math.floor(stat.mtimeMs / 1000),
				source: absolute,
			});
			bytes += stat.size;
			hash.update(`f\0${path}\0${mode.toString(8)}\0${verdict.sha}\0`);
		}
	};
	await walk(root, "");
	return {
		name,
		root,
		entries,
		dropped,
		digest: hash.digest("hex"),
		bytes,
	};
}

function hasUnder(only: ReadonlySet<string>, directory: string): boolean {
	const prefix = `${directory}/`;
	for (const path of only) if (path.startsWith(prefix)) return true;
	return false;
}

/**
 * The config's own files: what git takes (tracked, plus untracked files git
 * does not ignore) when the config is in a git work tree, so the person's
 * ignore rules are honoured; everything otherwise (`undefined`). The
 * lockfile is added by name, since dotfiles usually ignore it.
 */
export async function configFiles(
	config: string,
	lockfile: string | undefined,
	environment: Readonly<Record<string, string | undefined>>,
): Promise<ReadonlySet<string> | undefined> {
	let listed: string;
	try {
		listed = (
			await promisify(execFile)(
				"git",
				["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
				{ cwd: config, env: { ...environment }, maxBuffer: 16 * 1024 * 1024 },
			)
		).stdout;
	} catch {
		return undefined;
	}
	const files = new Set(listed.split("\0").filter((path) => path !== ""));
	if (lockfile !== undefined) {
		const inside = relative(config, lockfile);
		if (!inside.startsWith("..") && !isAbsolute(inside)) {
			files.add(inside.split(sep).join("/"));
		}
	}
	return files;
}

/** A unit as it goes into the archive: under `<prefix>/` of the stream. */
export interface ArchivedUnit {
	readonly prefix: string;
	readonly unit: Unit;
}

/**
 * One gzipped ustar stream: each unit under its prefix, then `extra` files
 * at the top (the new manifest). Long names take ustar's prefix field, and a
 * pax header past that, which GNU tar, bsdtar and busybox all read.
 */
export async function tarUnits(
	units: readonly ArchivedUnit[],
	extra: Readonly<Record<string, string>>,
): Promise<Uint8Array> {
	const chunks: Buffer[] = [];
	const now = Math.floor(Date.now() / 1000);
	for (const { prefix, unit } of units) {
		chunks.push(...tarEntry(prefix, "directory", 0o755, 0, now));
		for (const entry of unit.entries) {
			const path = `${prefix}/${entry.path}`;
			if (entry.kind === "directory") {
				chunks.push(
					...tarEntry(path, "directory", 0o755, 0, entry.mtimeSeconds),
				);
			} else if (entry.kind === "symlink") {
				chunks.push(
					...tarEntry(
						path,
						"symlink",
						0o777,
						0,
						entry.mtimeSeconds,
						entry.target,
					),
				);
			} else if (entry.source !== undefined) {
				const content = await readFile(entry.source);
				chunks.push(
					...tarEntry(
						path,
						"file",
						entry.mode,
						content.byteLength,
						entry.mtimeSeconds,
					),
				);
				chunks.push(content, padding(content.byteLength));
			}
		}
	}
	for (const [path, text] of Object.entries(extra)) {
		const content = Buffer.from(text, "utf8");
		chunks.push(...tarEntry(path, "file", 0o644, content.byteLength, now));
		chunks.push(content, padding(content.byteLength));
	}
	chunks.push(Buffer.alloc(1024));
	return new Uint8Array(await gzipAsync(Buffer.concat(chunks), { level: 6 }));
}

function padding(size: number): Buffer {
	const rest = size % 512;
	return Buffer.alloc(rest === 0 ? 0 : 512 - rest);
}

/** Split a path into ustar's `prefix` and `name`, or `undefined` when it does not fit. */
export function ustarSplit(
	path: string,
): { readonly prefix: string; readonly name: string } | undefined {
	if (Buffer.byteLength(path) <= 100) return { prefix: "", name: path };
	for (
		let index = path.indexOf("/");
		index !== -1;
		index = path.indexOf("/", index + 1)
	) {
		const prefix = path.slice(0, index);
		const name = path.slice(index + 1);
		if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
			if (name !== "") return { prefix, name };
		}
	}
	return undefined;
}

function tarEntry(
	path: string,
	kind: UnitEntry["kind"],
	mode: number,
	size: number,
	mtime: number,
	target?: string,
): Buffer[] {
	const out: Buffer[] = [];
	const named = kind === "directory" ? `${path}/` : path;
	const split = ustarSplit(named);
	const longLink = target !== undefined && Buffer.byteLength(target) > 100;
	if (split === undefined || longLink) {
		const records: string[] = [];
		if (split === undefined) records.push(paxRecord("path", named));
		if (longLink && target !== undefined)
			records.push(paxRecord("linkpath", target));
		const body = Buffer.from(records.join(""), "utf8");
		out.push(
			header(
				{ prefix: "", name: "././@PaxHeader" },
				"x",
				0o644,
				body.byteLength,
				mtime,
				"",
			),
			body,
			padding(body.byteLength),
		);
	}
	const fallbackName = posix.basename(named).slice(0, 99);
	out.push(
		header(
			split ?? { prefix: "", name: fallbackName },
			kind === "directory" ? "5" : kind === "symlink" ? "2" : "0",
			mode,
			size,
			mtime,
			longLink ? "" : (target ?? ""),
		),
	);
	return out;
}

function paxRecord(key: string, value: string): string {
	const body = ` ${key}=${value}\n`;
	let length = Buffer.byteLength(body);
	length += String(length).length;
	if (String(length).length !== String(length - String(length).length).length) {
		length += 1;
	}
	return `${String(length)}${body}`;
}

function header(
	split: { readonly prefix: string; readonly name: string },
	type: string,
	mode: number,
	size: number,
	mtime: number,
	linkname: string,
): Buffer {
	const block = Buffer.alloc(512);
	block.write(split.name, 0, 100, "utf8");
	block.write(octal(mode, 8), 100, 8, "ascii");
	block.write(octal(0, 8), 108, 8, "ascii");
	block.write(octal(0, 8), 116, 8, "ascii");
	block.write(octal(size, 12), 124, 12, "ascii");
	block.write(octal(mtime, 12), 136, 12, "ascii");
	block.fill(0x20, 148, 156);
	block.write(type, 156, 1, "ascii");
	block.write(linkname, 157, 100, "utf8");
	block.write("ustar\0", 257, 6, "ascii");
	block.write("00", 263, 2, "ascii");
	block.write(split.prefix, 345, 155, "utf8");
	let sum = 0;
	for (const byte of block) sum += byte;
	block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
	return block;
}

function octal(value: number, width: number): string {
	return `${value.toString(8).padStart(width - 1, "0")}\0`;
}
