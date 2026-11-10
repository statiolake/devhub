/**
 * This Mac's Neovim setup on an SSH host: what is written there, and the
 * sync that keeps it the same as here (`docs/remote-neovim-config.md`).
 *
 * Two halves:
 *
 * - **`NeovimConfigSource`**, one per DevHub: the setup as it is here
 *   (`carryTree.ts`), resolved once and again whenever the config, the
 *   lockfile or the plugin tree changes (watched, debounced), and told to
 *   every host that has it.
 * - **`HostCarry`**, one per host: the carried Neovim's launcher (`nvim`,
 *   `NVIM_APPNAME=devhub-nvim`, the delivered tools at the end of `PATH`,
 *   the guard with `--cmd`), and the sync — claim, compare, send the units
 *   that changed in one tar stream, swap each into place, write the manifest
 *   last, then run lazy.nvim's own build step for the plugins whose spec
 *   declares one and probe what the host lacks.
 *
 * DevHub knows lazy.nvim's standard spec and nothing about any plugin in it.
 * The host needs `sh`, `tar`, `gzip`, `mkdir`, `mv` and `rm`; no git, no
 * curl and no network. The plugins' own build steps may want more (a
 * download, a compiler); when they cannot have it, lazy's own message is
 * what the person is told, naming the plugin.
 */

import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { posix, relative, isAbsolute, sep } from "node:path";
import {
	collectUnit,
	configFiles,
	FileVerdicts,
	luaString,
	resolveLocalSetup,
	tarUnits,
	type DroppedFile,
	type LocalSetup,
	type Unit,
} from "./carryTree.js";
import {
	diffManifest,
	formatManifest,
	parseManifest,
	type Manifest,
	type ManifestUnit,
} from "./carryManifest.js";
import { shellQuote } from "./quote.js";
import type { ExecResult } from "./runtime.js";

/** The `NVIM_APPNAME` of the carried setup on a host. */
export const CARRIED_APPNAME = "devhub-nvim";

/** How long a Neovim on the host waits for a sync before starting with what is there. */
export const SYNC_WAIT_SECONDS = 120;

/**
 * `syncing` holds `<time> <pid>`: the claim's, then the unpacking `sh`'s
 * own. A marker whose process is gone and that is older than this is a sync
 * that died (DevHub quit, the connection dropped); the guard does not wait on
 * it and the next sync takes it over. Until the unpack starts nothing on the
 * host has changed, so a Neovim that starts then reads the old tree whole.
 */
export const STALE_SYNC_SECONDS = 60;

/** How long a change here waits for the next one before the hosts are told. */
const CHANGE_DEBOUNCE_MS = 2000;

/** A unit of the local setup, placed relative to the host's own XDG roots. */
export interface PlacedUnit {
	readonly unit: Unit;
	/** `config`: under `stdpath('config')`; `data`: under `stdpath('data')`. */
	readonly base: "config" | "data";
	readonly relative: string;
	/** For a plugin unit: its name, and whether its spec declares a build step. */
	readonly plugin?: { readonly name: string; readonly build: boolean };
}

export interface LocalSnapshot {
	readonly setup: LocalSetup;
	readonly units: readonly PlacedUnit[];
	/** What the units would not carry and why, by `<unit>/<path>`. */
	readonly dropped: readonly DroppedFile[];
	/** Things about the setup the host will not get, in words. */
	readonly notes: readonly string[];
}

export interface NeovimConfigSourceOptions {
	/** DevHub's own Neovim here, or `undefined` when this build has none. */
	readonly nvim: () => string | undefined;
	/** The environment DevHub's Neovims run in here. */
	readonly environment: () => Readonly<Record<string, string | undefined>>;
	/** Which DevHub on which Mac this is, for the manifest's `source`. */
	readonly source: string;
	/** Watch the setup and tell the hosts of a change. Off in tests. */
	readonly watch?: boolean;
	/** Told of every sync's outcome, to show it. */
	readonly report?: (report: CarryReport) => void;
}

/** One sync's outcome, as DevHub says it. */
export interface CarryReport {
	readonly machine: string;
	readonly level: "info" | "warning";
	readonly text: string;
	/** The gzipped bytes sent this time; 0 when nothing changed. */
	readonly bytesSent: number;
	readonly unitsSent: number;
	readonly unitsRemoved: number;
	readonly missing: readonly string[];
	readonly failedBuilds: readonly string[];
}

/**
 * The Neovim setup of this Mac, for every host: resolved when asked, again
 * after a change, and watched while any host has it.
 */
export class NeovimConfigSource {
	readonly source: string;
	readonly #options: NeovimConfigSourceOptions;
	readonly #verdicts = new FileVerdicts();
	readonly #listeners = new Set<() => void>();
	#setup: Promise<LocalSetup> | undefined;
	#watchers: FSWatcher[] = [];
	#watching = "";
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(options: NeovimConfigSourceOptions) {
		this.#options = options;
		this.source = options.source;
	}

	report(report: CarryReport): void {
		this.#options.report?.(report);
	}

	/** Be told when the setup here changes. */
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** The setup as it is now, in units. */
	async snapshot(): Promise<LocalSnapshot> {
		const nvim = this.#options.nvim();
		if (nvim === undefined) {
			throw new Error(
				"this build of DevHub has no Neovim to ask where your config is",
			);
		}
		this.#setup ??= resolveLocalSetup(nvim, this.#options.environment());
		const pending = this.#setup;
		pending.catch(() => {
			if (this.#setup === pending) this.#setup = undefined;
		});
		const setup = await pending;
		this.#watch(setup);
		const units: PlacedUnit[] = [];
		const notes: string[] = [];
		const configThere = await stat(setup.config).then(
			(found) => found.isDirectory(),
			() => false,
		);
		if (!configThere) return { setup, units, dropped: [], notes };
		const only = await configFiles(
			setup.config,
			setup.lockfile,
			this.#options.environment(),
		);
		units.push({
			unit: await collectUnit(
				"config",
				setup.config,
				{ trim: false, only },
				this.#verdicts,
			),
			base: "config",
			relative: "",
		});
		if (setup.lockfile !== undefined && !inside(setup.config, setup.lockfile)) {
			notes.push(
				`the lockfile ${setup.lockfile} is outside the config, so it stays here`,
			);
		}
		const rootInData =
			setup.root !== undefined && inside(setup.data, setup.root)
				? relative(setup.data, setup.root).split(sep).join("/")
				: "lazy";
		if (setup.root !== undefined && !inside(setup.data, setup.root)) {
			notes.push(
				`lazy's root ${setup.root} is outside stdpath('data'); the plugins go to stdpath('data')/lazy there`,
			);
		}
		for (const plugin of setup.plugins) {
			if (!plugin.installed) continue;
			const isDirectory = await stat(plugin.dir).then(
				(found) => found.isDirectory(),
				() => false,
			);
			if (!isDirectory) continue;
			units.push({
				unit: await collectUnit(
					`plugin/${plugin.name}`,
					plugin.dir,
					{ trim: true },
					this.#verdicts,
				),
				base: "data",
				relative: posix.join(rootInData, plugin.name),
				plugin: { name: plugin.name, build: plugin.build },
			});
		}
		const dropped = units.flatMap(({ unit }) =>
			unit.dropped.map((file) => ({
				...file,
				path: `${unit.name}/${file.path}`,
			})),
		);
		return { setup, units, dropped, notes };
	}

	#watch(setup: LocalSetup): void {
		if (this.#options.watch !== true) return;
		const roots = [setup.config, setup.root].filter(
			(root): root is string => root !== undefined,
		);
		const key = roots.join("\0");
		if (key === this.#watching) return;
		for (const watcher of this.#watchers) watcher.close();
		this.#watchers = [];
		this.#watching = key;
		for (const root of roots) {
			try {
				const watcher = watch(root, { recursive: true }, (_event, name) => {
					// A `git fetch` in a plugin is not a change to what is carried.
					if (
						typeof name === "string" &&
						/(^|[/\\])\.git([/\\]|$)/u.test(name)
					) {
						return;
					}
					this.changed();
				});
				watcher.on("error", () => undefined);
				this.#watchers.push(watcher);
			} catch (failure: unknown) {
				console.warn(
					`[devhub] cannot watch ${root} for Neovim config changes: ${String(failure)}`,
				);
			}
		}
	}

	/** Ask the local Neovim again at the next snapshot. */
	forget(): void {
		this.#setup = undefined;
	}

	/** Something here changed: ask again, and tell the hosts once it settles. */
	changed(): void {
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.forget();
			for (const listener of this.#listeners) listener();
		}, CHANGE_DEBOUNCE_MS);
		this.#timer.unref?.();
	}

	dispose(): void {
		for (const watcher of this.#watchers) watcher.close();
		this.#watchers = [];
		if (this.#timer !== undefined) clearTimeout(this.#timer);
	}
}

function inside(root: string, path: string): boolean {
	const rest = relative(root, path);
	return rest !== "" && !rest.startsWith("..") && !isAbsolute(rest);
}

/** How a host is reached: one POSIX `sh` script, with stdin. */
export interface CarryHostAccess {
	readonly machine: string;
	sh(
		script: string,
		extra?: {
			readonly stdin?: Uint8Array;
			readonly timeoutMs?: number;
			readonly stdoutBytes?: number;
		},
	): Promise<ExecResult>;
}

/** Where things are on one host. */
export interface CarryHostPaths {
	/** `~/.devhub-server/nvim-config`. */
	readonly directory: string;
	/** `${XDG_CONFIG_HOME:-~/.config}/devhub-nvim`. */
	readonly config: string;
	/** `${XDG_DATA_HOME:-~/.local/share}/devhub-nvim`. */
	readonly data: string;
	/** DevHub's Neovim on the host. */
	readonly nvim: string;
	/** Directories appended to the carried Neovim's `PATH`: the delivered tools. */
	readonly toolDirectories: readonly string[];
}

/** The host's XDG roots for `NVIM_APPNAME=devhub-nvim`, from its login environment. */
export function carriedPaths(
	home: string,
	login: Readonly<Record<string, string>>,
): { readonly config: string; readonly data: string } {
	const absolute = (value: string | undefined, fallback: string) =>
		value !== undefined && value.startsWith("/")
			? value
			: posix.join(home, fallback);
	return {
		config: posix.join(
			absolute(login.XDG_CONFIG_HOME, ".config"),
			CARRIED_APPNAME,
		),
		data: posix.join(
			absolute(login.XDG_DATA_HOME, ".local/share"),
			CARRIED_APPNAME,
		),
	};
}

/**
 * The carried Neovim's launcher on the host: what `Runtime.neovimProgram`
 * answers there, so the shim and the `devhub-nvim` keeper both run it.
 *
 * `NVIM_APPNAME=devhub-nvim` once anything has been carried (or is being),
 * and not when the person set their own; the guard with `--cmd` for an
 * editing Neovim of that name; the delivered tools appended to `PATH`, so a
 * host's own `rg` or `node` wins.
 */
export function carriedLauncherScript(paths: CarryHostPaths): string {
	const directory = shellQuote(paths.directory);
	const guard = luaString(posix.join(paths.directory, "carry.lua"));
	return `#!/bin/sh
# Generated by DevHub - do not edit. DevHub's Neovim with your Neovim setup
# from the Mac DevHub runs on (NVIM_APPNAME=${CARRIED_APPNAME}); see
# docs/remote-neovim-config.md in DevHub.
real=${shellQuote(paths.nvim)}
carry=${directory}
for dir in ${paths.toolDirectories.map(shellQuote).join(" ")}; do
	case ":\${PATH-}:" in
	*":$dir:"*) ;;
	*) PATH=\${PATH:+$PATH:}$dir ;;
	esac
done
export PATH
if [ -z "\${NVIM_APPNAME-}" ] && { [ -f "$carry/manifest" ] || [ -f "$carry/syncing" ]; }; then
	NVIM_APPNAME=${CARRIED_APPNAME}
	export NVIM_APPNAME
fi
[ "\${NVIM_APPNAME-}" = ${CARRIED_APPNAME} ] || exec "$real" "$@"
for argument in "$@"; do
	case $argument in
	--) break ;;
	-l|-v|--version|-h|--help|--api-info|-es|-Es) exec "$real" "$@" ;;
	esac
done
exec "$real" --cmd ${shellQuote(`lua dofile(${guard})`)} "$@"
`;
}

/**
 * The guard (`carry.lua`), loaded with `--cmd` before the person's
 * `init.lua`:
 *
 * - waits, up to `SYNC_WAIT_SECONDS`, while a sync is running, so a Neovim
 *   started mid-sync reads the tree before or after it and never between;
 * - sets `vim.g.devhub_carried`;
 * - wraps lazy.nvim's `setup` so that it installs nothing and checks for
 *   nothing, and refuses `install`, `update`, `sync`, `restore`, `clean` and
 *   `check` afterwards, because the tree here is a one-way mirror of the
 *   Mac's; `build` stays, it is the plugin's own step;
 * - shows the last sync's notice once (`vim.notify`).
 */
export function carryGuardLua(directory: string): string {
	return `-- Generated by DevHub - do not edit (docs/remote-neovim-config.md).
local dir = ${luaString(directory)}

local function read(path)
  local f = io.open(path, 'r')
  if not f then return nil end
  local text = f:read('*a')
  f:close()
  return text
end

local function syncing()
  local text = read(dir .. '/syncing')
  if not text then return false end
  local since, pid = text:match('^(%d+) (%d+)')
  since, pid = tonumber(since), tonumber(pid)
  if since == nil then return false end
  if pid ~= nil and vim.uv.kill(pid, 0) == 0 then return true end
  return os.time() - since < ${String(STALE_SYNC_SECONDS)}
end

if vim.env.DEVHUB_CARRY_NOWAIT == nil and syncing() then
  local message = 'DevHub is bringing your Neovim config to this host…'
  if #vim.api.nvim_list_uis() == 0 then
    io.stderr:write(message .. '\\n')
  else
    pcall(vim.api.nvim_echo, { { message } }, false, {})
    pcall(vim.cmd.redraw)
  end
  vim.wait(${String(SYNC_WAIT_SECONDS * 1000)}, function() return not syncing() end, 200)
end

local facts = {}
for key, value in (read(dir .. '/manifest') or ''):gmatch('# ([%w_-]+) ([^\\n]*)') do
  facts[key] = value
end
local source = facts.source or 'your Mac'
vim.g.devhub_carried = { source = source, digest = facts.digest }

local refused = {}
local function refuse(name)
  return function()
    vim.notify(('lazy.nvim %s: the plugins here are carried from %s. Update them there; DevHub brings the result.'):format(name, source), vim.log.levels.WARN)
    return { wait = function(_, done) if done then done() end end, is_running = function() return false end }
  end
end

local function guard_manage()
  local ok, manage = pcall(require, 'lazy.manage')
  if not ok then return false end
  local missing = {}
  for _, name in ipairs({ 'install', 'update', 'sync', 'restore', 'clean', 'check' }) do
    if type(manage[name]) == 'function' then
      manage[name] = refuse(name)
      refused[name] = true
    else
      table.insert(missing, name)
    end
  end
  if #missing > 0 then
    vim.schedule(function()
      vim.notify('DevHub could not guard lazy.nvim here (no lazy.manage.' .. table.concat(missing, ', ') .. '): do not update plugins on this host.', vim.log.levels.WARN)
    end)
  end
  return true
end

package.preload['lazy'] = function(name)
  package.preload['lazy'] = nil
  for i = 2, #package.loaders do
    local loader = package.loaders[i](name)
    if type(loader) == 'function' then
      local M = loader(name)
      if type(M) ~= 'table' or type(M.setup) ~= 'function' then return M end
      local setup = M.setup
      M.setup = function(spec, opts)
        if type(spec) == 'table' and spec.spec then opts = spec else opts = opts or {}; opts.spec = spec end
        opts.install = vim.tbl_extend('force', opts.install or {}, { missing = false })
        opts.checker = vim.tbl_extend('force', opts.checker or {}, { enabled = false })
        local result = setup(opts)
        guard_manage()
        return result
      end
      return M
    end
  end
  error('module lazy not found')
end

if vim.env.DEVHUB_CARRY_NOWAIT == nil then
  vim.api.nvim_create_autocmd('VimEnter', {
    once = true,
    callback = function()
      local text = read(dir .. '/notice')
      if not text or text == '' then return end
      local id, level, body = text:match('^([^\\n]*)\\n([^\\n]*)\\n(.*)$')
      if not id or body == '' then return end
      local seen = vim.fn.stdpath('state') .. '/devhub-carry-notice'
      if (read(seen) or '') == id then return end
      vim.fn.mkdir(vim.fn.stdpath('state'), 'p')
      pcall(vim.fn.writefile, { id }, seen)
      vim.schedule(function()
        vim.notify(vim.trim(body), level == 'warning' and vim.log.levels.WARN or vim.log.levels.INFO)
      end)
    end,
  })
end
`;
}

/**
 * Run by the sync, headless with the carried config: lazy.nvim's own build
 * step for the plugins named in `DEVHUB_CARRY_BUILD`, and each one's outcome
 * in lazy's own words, as JSON in `DEVHUB_CARRY_OUT`.
 */
export const CARRY_BUILD_LUA = `
local names = vim.split(vim.env.DEVHUB_CARRY_BUILD or '', ',', { trimempty = true })
local out = { results = {} }
local ok, err = pcall(function()
  require('lazy.manage').build({ plugins = names, wait = true, show = false })
end)
if not ok then out.error = tostring(err) end
local cok, C = pcall(require, 'lazy.core.config')
for _, name in ipairs(names) do
  local result = { name = name }
  local plugin = cok and C.plugins[name] or nil
  if not plugin then
    result.error = 'not in the lazy.nvim spec on this host'
  else
    for _, task in ipairs((plugin._ and plugin._.tasks) or {}) do
      if task.name == 'build' then
        local tok, failed = pcall(function() return task:has_errors() end)
        if tok and failed then
          result.error = task:output(vim.log.levels.ERROR)
          if result.error == '' then result.error = task:output() end
        end
      end
    end
  end
  table.insert(out.results, result)
end
vim.fn.writefile({ vim.json.encode(out) }, vim.env.DEVHUB_CARRY_OUT)
vim.cmd('qa!')
`;

/**
 * Run by the sync, headless with the carried config: each enabled language
 * server whose command is not executable there (the PATH as the carried
 * config leaves it: a plugin that installs servers puts its own there), each
 * common tool that is missing, and whether github.com answers.
 */
export const CARRY_PROBE_LUA = `
local function probe()
  local out = { lsp = {}, tools = {} }
  local function there(cmd) return vim.fn.executable(cmd) == 1 end
  local enabled = vim.lsp._enabled_configs or {}
  local names = vim.tbl_keys(enabled)
  table.sort(names)
  for _, name in ipairs(names) do
    local ok, config = pcall(function() return vim.lsp.config[name] end)
    local cmd = ok and type(config) == 'table' and config.cmd or nil
    if type(cmd) == 'table' and type(cmd[1]) == 'string' and not there(cmd[1]) then
      table.insert(out.lsp, { name = name, cmd = cmd[1] })
    end
  end
  for _, tool in ipairs({ 'rg', 'fd', 'git', 'node', 'curl' }) do
    if vim.fn.executable(tool) == 0 then table.insert(out.tools, tool) end
  end
  if vim.fn.executable('curl') == 1 then
    local ok, result = pcall(function()
      return vim.system({ 'curl', '-sS', '-m', '6', '-o', '/dev/null', 'https://github.com' }):wait()
    end)
    out.github = ok and result.code == 0 and 'reachable' or 'unreachable'
  end
  vim.fn.writefile({ vim.json.encode(out) }, vim.env.DEVHUB_CARRY_OUT)
  vim.cmd('qa!')
end
if vim.v.vim_did_enter == 1 then
  vim.defer_fn(probe, 500)
else
  vim.api.nvim_create_autocmd('VimEnter', { once = true, callback = function() vim.defer_fn(probe, 500) end })
end
`;

/** Claim `syncing` (or take over a stale one) and print the manifest. */
export function claimScript(directory: string): string {
	const d = shellQuote(directory);
	return [
		`d=${d}`,
		`mkdir -p -- "$d" || exit 1`,
		`now=$(date +%s)`,
		`if ( set -C; echo "$now $$" > "$d/syncing" ) 2>/dev/null; then`,
		`	echo claimed`,
		`else`,
		`	read since pid < "$d/syncing" 2>/dev/null`,
		`	case $since in ''|*[!0-9]*) since=0 ;; esac`,
		`	case $pid in ''|*[!0-9]*) pid=0 ;; esac`,
		`	if ! { [ "$pid" -gt 0 ] && kill -0 "$pid" 2>/dev/null; } && [ $((now - since)) -gt ${String(STALE_SYNC_SECONDS)} ]; then`,
		`		echo "$now $$" > "$d/syncing" && echo claimed || exit 1`,
		`	else`,
		`		echo busy`,
		`	fi`,
		`fi`,
		`echo ---manifest`,
		`cat "$d/manifest" 2>/dev/null`,
		`echo ---failed`,
		`cat "$d/build-failed" 2>/dev/null`,
		`exit 0`,
	].join("\n");
}

export function releaseScript(directory: string): string {
	return `exec rm -f -- ${shellQuote(posix.join(directory, "syncing"))}`;
}

/**
 * Unpack the stream into staging, swap each unit into place, remove what is
 * gone, then the manifest, then the marker: a half-written unit never sits
 * behind a name that means "done", and the old manifest stays until the end.
 */
export function installScript(
	directory: string,
	send: readonly { readonly prefix: string; readonly destination: string }[],
	remove: readonly string[],
): string {
	const d = shellQuote(directory);
	const lines = [
		`d=${d}`,
		`s="$d/staging"`,
		`echo "$(date +%s) $$" > "$d/syncing"`,
		`rm -rf -- "$s"`,
		`mkdir -p -- "$s" || exit 1`,
		`tar xzf - -C "$s" || { rm -rf -- "$s"; exit 1; }`,
		`swap() {`,
		`	parent=$(dirname -- "$2")`,
		`	mkdir -p -- "$parent" || return 1`,
		`	rm -rf -- "$2.devhub-old"`,
		`	if [ -e "$2" ] || [ -h "$2" ]; then mv -- "$2" "$2.devhub-old" || return 1; fi`,
		`	mv -- "$1" "$2" || return 1`,
		`	rm -rf -- "$2.devhub-old"`,
		`}`,
	];
	for (const unit of send) {
		lines.push(
			`swap "$s/${unit.prefix}" ${shellQuote(unit.destination)} || { echo "could not put ${unit.destination} in place" >&2; exit 1; }`,
		);
	}
	for (const destination of remove) {
		lines.push(`rm -rf -- ${shellQuote(destination)}`);
	}
	lines.push(
		`mv -- "$s/manifest" "$d/manifest.new" || exit 1`,
		`mv -- "$d/manifest.new" "$d/manifest" || exit 1`,
		`rm -rf -- "$s"`,
		`exec rm -f -- "$d/syncing"`,
	);
	return lines.join("\n");
}

interface BuildOutcome {
	readonly name: string;
	readonly error?: string;
}

interface ProbeOutcome {
	readonly lsp: readonly { readonly name: string; readonly cmd: string }[];
	readonly tools: readonly string[];
	readonly github?: "reachable" | "unreachable";
}

/** What a tool delivery beside Neovim came to, for the report. */
export interface ToolOutcome {
	readonly tool: string;
	readonly failure?: string;
}

export interface HostCarryOptions {
	readonly access: CarryHostAccess;
	readonly paths: CarryHostPaths;
	readonly source: NeovimConfigSource;
	/** Generous: a first sync sends tens of MB over somebody's link. */
	readonly installTimeoutMs: number;
}

/**
 * The carried setup on one host: its launcher, and the sync that keeps it
 * the same as this Mac's. Syncs on one host run one at a time.
 */
export class HostCarry {
	readonly #options: HostCarryOptions;
	#queue: Promise<unknown> = Promise.resolve();
	#stale = false;
	#lastProblems: string | undefined;
	#firstDone = false;
	#unsubscribe: (() => void) | undefined;
	#claimedFirst: () => void = () => undefined;
	readonly #claimed = new Promise<void>((done) => {
		this.#claimedFirst = done;
	});

	constructor(options: HostCarryOptions) {
		this.#options = options;
	}

	/** Settles once the first sync has claimed the host, or failed to. */
	claimed(): Promise<void> {
		return this.#claimed;
	}

	get launcher(): string {
		return posix.join(this.#options.paths.directory, "nvim");
	}

	/** Whether the last sync did not finish: the next Neovim asked for tries again. */
	get stale(): boolean {
		return this.#stale;
	}

	/**
	 * Write the launcher and the guard, and claim the first sync, so a Neovim
	 * started from now on waits for it. The rest of the sync goes on in the
	 * background (`firstSync`); the launcher is what `neovimProgram` answers.
	 */
	async prepare(): Promise<boolean> {
		const { access, paths } = this.#options;
		const files: Readonly<Record<string, { text: string; mode: string }>> = {
			nvim: { text: carriedLauncherScript(paths), mode: "755" },
			"carry.lua": { text: carryGuardLua(paths.directory), mode: "644" },
			"build.lua": { text: CARRY_BUILD_LUA, mode: "644" },
			"probe.lua": { text: CARRY_PROBE_LUA, mode: "644" },
		};
		const d = shellQuote(paths.directory);
		const script = [`d=${d}`, `mkdir -p -- "$d" || exit 1`];
		let index = 0;
		for (const [name, file] of Object.entries(files)) {
			const marker = `DEVHUB_CARRY_${String(index++)}`;
			script.push(
				`cat > "$d/${name}.new" <<'${marker}' || exit 1`,
				`${file.text}${file.text.endsWith("\n") ? "" : "\n"}${marker}`,
				`chmod ${file.mode} "$d/${name}.new" && mv -- "$d/${name}.new" "$d/${name}" || exit 1`,
			);
		}
		const written = await access.sh(script.join("\n"));
		if (written.code !== 0) {
			throw new Error(
				`DevHub could not write its Neovim launcher on ${access.machine}: ${lastLine(written.stderr)}`,
			);
		}
		return true;
	}

	/** Sync now (queued behind a sync already running on this host). */
	sync(
		reason: "connect" | "change",
		tools?: Promise<readonly ToolOutcome[]>,
	): Promise<void> {
		const next = this.#queue.then(() => this.#sync(reason, tools));
		this.#queue = next.catch(() => undefined);
		return next;
	}

	/** Follow changes here for as long as DevHub runs. */
	follow(): void {
		this.#unsubscribe ??= this.#options.source.subscribe(() => {
			void this.sync("change").catch(() => undefined);
		});
	}

	dispose(): void {
		this.#unsubscribe?.();
	}

	async #claim(): Promise<{ manifest: Manifest; failed: readonly string[] }> {
		const { access, paths } = this.#options;
		const deadline = Date.now() + SYNC_WAIT_SECONDS * 1000;
		for (;;) {
			const result = await access.sh(claimScript(paths.directory), {
				stdoutBytes: 4 * 1024 * 1024,
			});
			if (result.code !== 0) {
				throw new Error(`could not start a sync: ${lastLine(result.stderr)}`);
			}
			const text = result.stdout.toString("utf8");
			const [status = "", rest = ""] = splitOnce(text, "---manifest\n");
			const [manifestText = "", failedText = ""] = splitOnce(
				rest,
				"---failed\n",
			);
			if (status.trim() === "claimed") {
				return {
					manifest: parseManifest(manifestText),
					failed: failedText.split("\n").filter((name) => name.trim() !== ""),
				};
			}
			if (Date.now() > deadline) {
				throw new Error(
					"another sync to this host has been running for two minutes",
				);
			}
			await new Promise((done) => setTimeout(done, 2000));
		}
	}

	async #release(): Promise<void> {
		await this.#options.access
			.sh(releaseScript(this.#options.paths.directory))
			.catch(() => undefined);
	}

	async #sync(
		reason: "connect" | "change",
		tools: Promise<readonly ToolOutcome[]> | undefined,
	): Promise<void> {
		const { access, paths, source } = this.#options;
		const machine = access.machine;
		let claimed: { manifest: Manifest; failed: readonly string[] };
		try {
			claimed = await this.#claim();
		} catch (failure: unknown) {
			this.#claimedFirst();
			this.#stale = true;
			source.report(
				failedReport(
					machine,
					`DevHub could not bring your Neovim config to ${machine}: ${message(failure)}`,
				),
			);
			return;
		}
		this.#claimedFirst();
		let snapshot: LocalSnapshot;
		try {
			snapshot = await source.snapshot();
		} catch (failure: unknown) {
			await this.#release();
			this.#stale = true;
			source.report(
				failedReport(
					machine,
					`DevHub could not read your Neovim setup on this Mac, so ${machine} keeps what it has: ${message(failure)}`,
				),
			);
			return;
		}
		if (snapshot.units.length === 0) {
			await this.#release();
			this.#stale = false;
			console.log(
				`[devhub] no Neovim config here to bring to ${machine} (${snapshot.setup.config})`,
			);
			return;
		}
		const place = (unit: PlacedUnit) =>
			unit.base === "config"
				? posix.join(paths.config, unit.relative)
				: posix.join(paths.data, unit.relative);
		const local: ManifestUnit[] = snapshot.units.map((unit) => ({
			name: unit.unit.name,
			digest: unit.unit.digest,
			destination: place(unit),
		}));
		const diff = diffManifest(local, claimed.manifest);
		const sending = snapshot.units.filter((unit) =>
			diff.send.some((sent) => sent.name === unit.unit.name),
		);
		const plugins = snapshot.units.filter(
			(unit) => unit.plugin !== undefined,
		).length;
		const carriedBytes = snapshot.units.reduce(
			(sum, unit) => sum + unit.unit.bytes,
			0,
		);
		const manifestDigest = digestOf(local);
		let bytesSent = 0;
		const changed = diff.send.length > 0 || diff.remove.length > 0;
		if (changed) {
			const manifest: Manifest = {
				source: source.source,
				units: local,
				facts: {
					digest: manifestDigest,
					plugins: String(plugins),
					bytes: String(carriedBytes),
					synced: new Date().toISOString(),
				},
			};
			const archived = sending.map((unit, index) => ({
				prefix: `u/${String(index)}`,
				unit: unit.unit,
			}));
			try {
				const tar = await tarUnits(archived, {
					manifest: formatManifest(manifest),
				});
				bytesSent = tar.byteLength;
				const result = await access.sh(
					installScript(
						paths.directory,
						archived.map(({ prefix }, index) => ({
							prefix,
							destination: place(sending[index] as PlacedUnit),
						})),
						diff.remove,
					),
					{ stdin: tar, timeoutMs: this.#options.installTimeoutMs },
				);
				if (result.code !== 0) throw new Error(lastLine(result.stderr));
			} catch (failure: unknown) {
				await this.#release();
				this.#stale = true;
				source.report(
					failedReport(
						machine,
						`DevHub could not bring your Neovim config to ${machine}: ${message(failure)}. It tries again at the next Neovim there.`,
					),
				);
				return;
			}
		} else {
			await this.#release();
		}
		this.#stale = false;
		const first = !this.#firstDone;
		this.#firstDone = true;
		// lazy.nvim's own build step, for the plugins whose spec declares one:
		// those whose files changed, and on connect those whose last build failed.
		const sentNames = new Set(sending.map((unit) => unit.plugin?.name));
		const retry =
			first || reason === "connect"
				? new Set(claimed.failed)
				: new Set<string>();
		const toBuild = snapshot.units
			.filter(
				(unit) =>
					unit.plugin !== undefined &&
					unit.plugin.build &&
					(sentNames.has(unit.plugin.name) || retry.has(unit.plugin.name)),
			)
			.map((unit) => unit.plugin?.name as string);
		const builds = toBuild.length > 0 ? await this.#build(toBuild) : [];
		const failedBuilds = builds.filter((build) => build.error !== undefined);
		if (toBuild.length > 0 || claimed.failed.length > 0) {
			const stillFailing = new Set(
				claimed.failed.filter((name) => !toBuild.includes(name)),
			);
			for (const build of failedBuilds) stillFailing.add(build.name);
			await access
				.sh(
					`cat > ${shellQuote(posix.join(paths.directory, "build-failed"))}`,
					{
						stdin: Buffer.from(
							[...stillFailing].map((name) => `${name}\n`).join(""),
							"utf8",
						),
					},
				)
				.catch(() => undefined);
		}
		const toolOutcomes = tools === undefined ? [] : await tools.catch(() => []);
		if (!changed && failedBuilds.length === 0 && !first) return;
		const probe = await this.#probe();
		const report = composeReport({
			machine,
			plugins,
			bytesSent,
			unitsSent: diff.send.length,
			unitsRemoved: diff.remove.length,
			carriedBytes,
			previousSource: claimed.manifest.source,
			source: source.source,
			snapshot,
			builds: failedBuilds,
			probe,
			tools: toolOutcomes,
		});
		// The same problems again (a config edit on a host that still lacks a
		// server) are logged and not raised again: the notice is about what
		// changed there, and Neovim shows a notice once per set of problems.
		const problems = `${report.level}\0${report.missing.join(",")}\0${report.failedBuilds.join(",")}\0${report.text.includes("could not put") ? report.text : ""}`;
		const id = createHash("sha256").update(problems).digest("hex").slice(0, 16);
		const repeated = reason === "change" && id === this.#lastProblems;
		this.#lastProblems = id;
		await access
			.sh(`cat > ${shellQuote(posix.join(paths.directory, "notice"))}`, {
				stdin: Buffer.from(`${id}\n${report.level}\n${report.text}\n`, "utf8"),
			})
			.catch(() => undefined);
		source.report(repeated ? { ...report, level: "info" } : report);
	}

	async #headless(
		lua: string,
		env: Readonly<Record<string, string>>,
		timeoutMs: number,
	) {
		const { access, paths } = this.#options;
		const out = posix.join(paths.directory, `${lua}.json`);
		const variables = Object.entries({
			NVIM_APPNAME: CARRIED_APPNAME,
			DEVHUB_NEOVIM_GUI: "1",
			DEVHUB_CARRY_NOWAIT: "1",
			DEVHUB_CARRY_OUT: out,
			...env,
		})
			.map(([key, value]) => `${key}=${shellQuote(value)}`)
			.join(" ");
		const script = [
			`cd ${shellQuote(paths.directory)} || exit 1`,
			`rm -f -- ${shellQuote(out)}`,
			`${variables} ${shellQuote(this.launcher)} --headless -i NONE -c ${shellQuote(`lua dofile(${luaString(posix.join(paths.directory, `${lua}.lua`))})`)} </dev/null >/dev/null 2>&1`,
			`cat ${shellQuote(out)}`,
		].join("\n");
		const result = await access.sh(script, {
			timeoutMs,
			stdoutBytes: 4 * 1024 * 1024,
		});
		return JSON.parse(result.stdout.toString("utf8")) as unknown;
	}

	async #build(names: readonly string[]): Promise<readonly BuildOutcome[]> {
		try {
			const answer = (await this.#headless(
				"build",
				{ DEVHUB_CARRY_BUILD: names.join(",") },
				15 * 60_000,
			)) as {
				results?: BuildOutcome[];
				error?: string;
			};
			if (answer.error !== undefined && (answer.results ?? []).length === 0) {
				return names.map((name) => ({ name, error: answer.error }));
			}
			return answer.results ?? [];
		} catch (failure: unknown) {
			return names.map((name) => ({
				name,
				error: `lazy.nvim's build did not answer: ${message(failure)}`,
			}));
		}
	}

	async #probe(): Promise<ProbeOutcome | undefined> {
		try {
			return (await this.#headless("probe", {}, 60_000)) as ProbeOutcome;
		} catch {
			return undefined;
		}
	}
}

/** The sentence DevHub says after a sync, and its level. */
export function composeReport(facts: {
	readonly machine: string;
	readonly plugins: number;
	readonly bytesSent: number;
	readonly unitsSent: number;
	readonly unitsRemoved: number;
	readonly carriedBytes: number;
	readonly previousSource: string;
	readonly source: string;
	readonly snapshot: Pick<LocalSnapshot, "dropped" | "notes">;
	readonly builds: readonly BuildOutcome[];
	readonly probe: ProbeOutcome | undefined;
	readonly tools: readonly ToolOutcome[];
}): CarryReport {
	const sentences: string[] = [];
	const sent =
		facts.bytesSent === 0
			? "nothing changed"
			: `${megabytes(facts.bytesSent)} sent, ${String(facts.unitsSent)} part${facts.unitsSent === 1 ? "" : "s"}`;
	sentences.push(
		`Your Neovim config is on ${facts.machine} (${String(facts.plugins)} plugins, ${megabytes(facts.carriedBytes)}; ${sent}).`,
	);
	if (facts.previousSource !== "" && facts.previousSource !== facts.source) {
		sentences.push(`It replaces the one synced from ${facts.previousSource}.`);
	}
	const missing: string[] = [];
	if (facts.probe !== undefined) {
		const servers = facts.probe.lsp.map(
			(server) => `${server.name} (${server.cmd})`,
		);
		missing.push(...facts.probe.lsp.map((server) => server.name));
		const tools = facts.probe.tools.filter((tool) => tool !== "curl");
		missing.push(...tools);
		const parts: string[] = [];
		if (servers.length > 0)
			parts.push(`language servers ${servers.join(", ")}`);
		if (tools.length > 0) parts.push(tools.join(", "));
		if (parts.length > 0) {
			sentences.push(`Not available there: ${parts.join("; ")}.`);
			if (servers.length > 0) {
				sentences.push(
					facts.probe.github === "unreachable"
						? `Nothing can download them there: ${facts.machine} has no route to github.com.`
						: facts.probe.github === undefined
							? `Nothing can download them there: ${facts.machine} has no curl.`
							: "Install them on that host.",
				);
			}
		}
	}
	for (const build of facts.builds) {
		sentences.push(
			`lazy.nvim's build of ${build.name} failed there: ${firstLines(build.error ?? "")}.`,
		);
	}
	for (const tool of facts.tools) {
		if (tool.failure !== undefined) {
			sentences.push(
				`DevHub could not put ${tool.tool} there: ${tool.failure}.`,
			);
		}
	}
	if (facts.snapshot.dropped.length > 0) {
		const names = facts.snapshot.dropped.map((file) => file.path);
		sentences.push(
			`Left on this Mac: ${names.slice(0, 8).join(", ")}${names.length > 8 ? ` and ${String(names.length - 8)} more` : ""} (secrets, or links out of the tree).`,
		);
	}
	for (const note of facts.snapshot.notes) sentences.push(`Note: ${note}.`);
	const warning =
		missing.length > 0 ||
		facts.builds.length > 0 ||
		facts.tools.some((tool) => tool.failure !== undefined) ||
		facts.snapshot.dropped.length > 0;
	return {
		machine: facts.machine,
		level: warning ? "warning" : "info",
		text: sentences.join(" "),
		bytesSent: facts.bytesSent,
		unitsSent: facts.unitsSent,
		unitsRemoved: facts.unitsRemoved,
		missing,
		failedBuilds: facts.builds.map((build) => build.name),
	};
}

function failedReport(machine: string, text: string): CarryReport {
	return {
		machine,
		level: "warning",
		text,
		bytesSent: 0,
		unitsSent: 0,
		unitsRemoved: 0,
		missing: [],
		failedBuilds: [],
	};
}

function megabytes(bytes: number): string {
	if (bytes < 1024 * 1024)
		return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** lazy's message for a build, once per distinct line and short enough to read. */
function firstLines(text: string): string {
	const lines: string[] = [];
	for (const line of text.split("\n").map((each) => each.trim())) {
		// A tool that says the same thing on every retry says it once here.
		const key = line.replace(/[),.;\s]+$/u, "");
		if (key === "" || lines.some((seen) => seen.includes(key))) continue;
		lines.push(line);
	}
	const joined = lines.join(" ").replace(/\s+/gu, " ");
	return joined.length > 240 ? `${joined.slice(0, 240)}…` : joined;
}

function digestOf(units: readonly ManifestUnit[]): string {
	const hash = createHash("sha256");
	for (const unit of [...units].sort((a, b) => a.name.localeCompare(b.name))) {
		hash.update(`${unit.name}\0${unit.digest}\0`);
	}
	return hash.digest("hex");
}

function splitOnce(text: string, separator: string): [string, string] {
	const index = text.indexOf(separator);
	return index === -1
		? [text, ""]
		: [text.slice(0, index), text.slice(index + separator.length)];
}

function lastLine(bytes: Buffer): string {
	const lines = bytes.toString("utf8").trim().split("\n");
	return lines[lines.length - 1] ?? "";
}

function message(failure: unknown): string {
	return failure instanceof Error ? failure.message : String(failure);
}
