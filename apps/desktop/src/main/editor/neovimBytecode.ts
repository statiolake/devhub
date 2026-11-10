/**
 * DevHub's own setup Lua (`SETUP_CHUNKS`, `neovimUi.ts`), compiled ahead of
 * time: every attach runs about 100 KB of it, and Neovim would otherwise
 * compile it each time (a few milliseconds; more on a loaded machine).
 *
 * `build:nvim-lua` (`scripts/build-nvim-lua.mjs`, after `build:main` and
 * `build:nvim`) has DevHub's Neovim compile each chunk with its LuaJIT
 * (`string.dump`, debug info kept, so an error still names its chunk and
 * line) into `out/nvim-lua/setup.json`: the bytecode by the sha256 of the
 * source it came from, and the Neovim version that made it. An attach sends a
 * chunk's bytecode instead of its source when the file has it for exactly
 * that source and the Neovim answers that version; `nvim_exec_lua` loads
 * either (LuaJIT's loader takes bytecode as it takes text). Anything else —
 * no file (vitest runs the sources, a checkout that did not build it), a
 * source edited since, another Neovim version — is the source, as before.
 *
 * The bytecode is LuaJIT's, at the version the pinned Neovim's three builds
 * share (darwin-arm64, linux-x64, linux-arm64: all little-endian GC64), so
 * the Mac's serves an SSH host's Neovim too. Should a Neovim refuse it
 * anyway, the attach sends the sources again and this DevHub sends that
 * Neovim version none from then on (`bytecodeRefused`).
 *
 * Nothing is written on the Neovim's machine and the person's config does
 * nothing: only what DevHub sends changes.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_ROOT } from "../shell/appRoot.js";

/** One of DevHub's setup chunks: its name (in errors) and source. */
export interface LuaChunk {
	readonly name: string;
	readonly lua: string;
}

/** `out/nvim-lua/setup.json`. */
export interface CompiledLua {
	/** The Neovim that compiled it, as `nvim_get_api_info` says it. */
	readonly nvimVersion: string;
	/** The bytecode, base64, by the sha256 (hex) of its source. */
	readonly bytecode: Readonly<Record<string, string>>;
}

/** Where `build:nvim-lua` writes it. */
export function compiledLuaPath(appRoot = APP_ROOT): string {
	return join(appRoot, "out", "nvim-lua", "setup.json");
}

/** What an error in a chunk is attributed to: `devhub:<name>:<line>:`. */
export function chunkName(name: string): string {
	return `=devhub:${name}`;
}

/** The key a chunk's bytecode is found by. */
export function luaDigest(lua: string): string {
	return createHash("sha256").update(lua).digest("hex");
}

/**
 * Compile `chunks` with the Neovim at `nvim` — the build's step and the
 * tests' — into what `setup.json` holds.
 */
export function compileLua(
	nvim: string,
	chunks: readonly LuaChunk[],
): CompiledLua {
	const directory = mkdtempSync(join(tmpdir(), "devhub-nvim-lua-"));
	try {
		const input = join(directory, "chunks.json");
		const script = join(directory, "compile.lua");
		writeFileSync(
			input,
			JSON.stringify(
				chunks.map((chunk) => ({
					name: chunkName(chunk.name),
					lua: chunk.lua,
				})),
			),
		);
		writeFileSync(script, COMPILE_LUA);
		// Its own runtime, beside it, never an inherited one (`--clean`: no
		// config either).
		const env = { ...process.env };
		delete env.VIMRUNTIME;
		delete env.VIM;
		const output = execFileSync(nvim, ["--clean", "-l", script, input], {
			encoding: "utf8",
			env,
			maxBuffer: 64 * 1024 * 1024,
		});
		const answer = JSON.parse(output) as {
			version: string;
			bytecode: string[];
		};
		const bytecode: Record<string, string> = {};
		chunks.forEach((chunk, index) => {
			const compiled = answer.bytecode[index];
			if (compiled === undefined) {
				throw new Error(`${nvim} compiled no ${chunk.name}`);
			}
			bytecode[luaDigest(chunk.lua)] = compiled;
		});
		return { nvimVersion: answer.version, bytecode };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

/** `nvim -l` with `chunks.json`: their bytecode (base64) on stdout. */
const COMPILE_LUA = String.raw`
local file = assert(io.open(arg[1], "rb"))
local chunks = vim.json.decode(file:read("*a"))
file:close()
local bytecode = {}
for index, chunk in ipairs(chunks) do
  local fn = assert(loadstring(chunk.lua, chunk.name))
  bytecode[index] = vim.base64.encode(string.dump(fn, false))
end
local v = vim.version()
io.stdout:write(vim.json.encode({
  version = ("%d.%d.%d"):format(v.major, v.minor, v.patch),
  bytecode = bytecode,
}))
`;

/** What an attach sends for DevHub's chunks: bytecode where it has it. */
export class SetupLua {
	private compiled: CompiledLua | undefined | null = null;
	private readonly digests = new Map<string, string>();
	private readonly decoded = new Map<string, Uint8Array>();
	/** Neovim versions that refused the bytecode: sent sources from then on. */
	private readonly refused = new Set<string>();

	constructor(
		private readonly load: () => CompiledLua | undefined = () =>
			readCompiledLua(compiledLuaPath()),
	) {}

	/** The code for `lua` in an `nvim_exec_lua` to Neovim `nvimVersion`. */
	code(lua: string, nvimVersion: string): string | Uint8Array {
		if (this.refused.has(nvimVersion)) return lua;
		if (this.compiled === null) this.compiled = this.load();
		const compiled = this.compiled;
		if (compiled?.nvimVersion !== nvimVersion) return lua;
		let digest = this.digests.get(lua);
		if (digest === undefined) {
			digest = luaDigest(lua);
			this.digests.set(lua, digest);
		}
		let bytes = this.decoded.get(digest);
		if (bytes === undefined) {
			const base64 = compiled.bytecode[digest];
			if (base64 === undefined) return lua;
			bytes = new Uint8Array(Buffer.from(base64, "base64"));
			this.decoded.set(digest, bytes);
		}
		return bytes;
	}

	/** A Neovim of `nvimVersion` failed a chunk sent as bytecode. */
	bytecodeRefused(nvimVersion: string): void {
		this.refused.add(nvimVersion);
	}
}

/** `setup.json`, or `undefined` when it is missing or not one. */
export function readCompiledLua(path: string): CompiledLua | undefined {
	try {
		const value = JSON.parse(
			readFileSync(path, "utf8"),
		) as Partial<CompiledLua>;
		if (
			typeof value.nvimVersion !== "string" ||
			typeof value.bytecode !== "object" ||
			value.bytecode === null
		)
			return undefined;
		return { nvimVersion: value.nvimVersion, bytecode: value.bytecode };
	} catch {
		return undefined;
	}
}

/** The one this DevHub's attaches share. */
export const SETUP_LUA_CODE = new SetupLua();
