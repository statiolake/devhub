/**
 * The carried Neovim setup, end to end against a "host" that is a second
 * home directory on this machine: the sync's own scripts run under
 * `/bin/sh` there (the same POSIX the host runs), with DevHub's real
 * Neovim and a lazy.nvim stand-in that has lazy's module names and the parts
 * of its contract the guard and the build step rely on (`lazy`,
 * `lazy.core.config`, `lazy.manage`). The real lazy.nvim is checked by
 * `DEVHUB_LAZY_NVIM=<checkout>` (below) and by the end-to-end run in
 * `docs/remote-neovim-config.md`.
 */

import { spawn } from "node:child_process";
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_NVIM } from "../editor/testNeovim.js";
import {
	carriedLauncherScript,
	carriedPaths,
	HostCarry,
	NeovimConfigSource,
	type CarryHostAccess,
	type CarryReport,
} from "./carryHost.js";
import {
	diffManifest,
	EMPTY_MANIFEST,
	formatManifest,
	parseManifest,
} from "./carryManifest.js";
import type { ExecResult } from "./runtime.js";

const D = "a".repeat(64);
const E = "b".repeat(64);

describe("the manifest", () => {
	it("reads back what it wrote", () => {
		const manifest = {
			source: "mac (DevHub)",
			units: [
				{
					name: "plugin/b",
					digest: E,
					destination: "/h/.local/share/devhub-nvim/lazy/b",
				},
				{ name: "config", digest: D, destination: "/h/.config/devhub-nvim" },
			],
			facts: { digest: D, plugins: "1" },
		};
		const parsed = parseManifest(formatManifest(manifest));
		expect(parsed.source).toBe("mac (DevHub)");
		expect(parsed.facts).toEqual({ digest: D, plugins: "1" });
		expect(parsed.units.map((unit) => unit.name)).toEqual([
			"config",
			"plugin/b",
		]);
	});

	it("sends what changed or moved, keeps what did not, removes what is gone", () => {
		const remote = parseManifest(
			formatManifest({
				source: "",
				facts: {},
				units: [
					{ name: "config", digest: D, destination: "/c" },
					{ name: "plugin/same", digest: D, destination: "/l/same" },
					{ name: "plugin/edited", digest: D, destination: "/l/edited" },
					{ name: "plugin/moved", digest: D, destination: "/old/moved" },
					{ name: "plugin/gone", digest: D, destination: "/l/gone" },
				],
			}),
		);
		const diff = diffManifest(
			[
				{ name: "config", digest: D, destination: "/c" },
				{ name: "plugin/same", digest: D, destination: "/l/same" },
				{ name: "plugin/edited", digest: E, destination: "/l/edited" },
				{ name: "plugin/moved", digest: D, destination: "/l/moved" },
				{ name: "plugin/new", digest: D, destination: "/l/new" },
			],
			remote,
		);
		expect(diff.send.map((unit) => unit.name)).toEqual([
			"plugin/edited",
			"plugin/moved",
			"plugin/new",
		]);
		expect(diff.kept.map((unit) => unit.name)).toEqual([
			"config",
			"plugin/same",
		]);
		expect([...diff.remove].sort()).toEqual(["/l/gone", "/old/moved"]);
	});

	it("treats a missing or damaged manifest as nothing there", () => {
		expect(parseManifest("garbage\nconfig\tnot-a-digest\t/c\n").units).toEqual(
			[],
		);
		expect(
			diffManifest(
				[{ name: "config", digest: D, destination: "/c" }],
				EMPTY_MANIFEST,
			).send,
		).toHaveLength(1);
	});
});

describe("the launcher", () => {
	const paths = {
		directory: "/h/.devhub-server/nvim-config",
		config: "/h/.config/devhub-nvim",
		data: "/h/.local/share/devhub-nvim",
		nvim: "/h/.devhub-server/nvim/0.12.6/bin/nvim",
		toolDirectories: ["/h/.devhub-server/rg/15.1.0/ripgrep-x"],
	};

	it("puts the host's XDG roots under the carried app name", () => {
		expect(carriedPaths("/h", {})).toEqual({
			config: "/h/.config/devhub-nvim",
			data: "/h/.local/share/devhub-nvim",
		});
		expect(
			carriedPaths("/h", {
				XDG_CONFIG_HOME: "/x/c",
				XDG_DATA_HOME: "relative",
			}),
		).toEqual({
			config: "/x/c/devhub-nvim",
			data: "/h/.local/share/devhub-nvim",
		});
	});

	it("appends the tools to PATH, never prepends, and names the real Neovim by path", () => {
		const script = carriedLauncherScript(paths);
		expect(script).toMatch(/^#!\/bin\/sh\n/u);
		expect(script).toContain("PATH=${PATH:+$PATH:}$dir");
		expect(script).toContain("real='/h/.devhub-server/nvim/0.12.6/bin/nvim'");
		expect(script).not.toMatch(/blink|review-relay|incremental/u);
	});
});

/** A host that is a directory here: each script runs under /bin/sh with its own HOME. */
function localHost(
	home: string,
): CarryHostAccess & { readonly scripts: string[] } {
	const scripts: string[] = [];
	return {
		machine: "test-host",
		scripts,
		sh: (script, extra) =>
			new Promise<ExecResult>((done, fail) => {
				scripts.push(script);
				const child = spawn("/bin/sh", ["-c", script], {
					cwd: home,
					env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
					stdio: ["pipe", "pipe", "pipe"],
				});
				const out: Buffer[] = [];
				const err: Buffer[] = [];
				child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
				child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
				child.on("error", fail);
				const timer = setTimeout(
					() => child.kill("SIGKILL"),
					extra?.timeoutMs ?? 60_000,
				);
				child.on("close", (code, signal) => {
					clearTimeout(timer);
					done({
						code,
						signal,
						stdout: Buffer.concat(out),
						stderr: Buffer.concat(err),
					});
				});
				child.stdin.end(
					extra?.stdin === undefined ? undefined : Buffer.from(extra.stdin),
				);
			}),
	};
}

/** lazy.nvim's module names and the parts of its contract the carry relies on. */
const FAKE_LAZY: Readonly<Record<string, string>> = {
	"lua/lazy/init.lua": `
local M = {}
function M.setup(spec, opts)
  if type(spec) == 'table' and spec.spec then opts = spec else opts = opts or {}; opts.spec = spec end
  local C = require('lazy.core.config')
  C.options = { root = vim.fn.stdpath('data') .. '/lazy', lockfile = vim.fn.stdpath('config') .. '/lazy-lock.json' }
  vim.g.fake_lazy = { missing = opts.install and opts.install.missing, checker = opts.checker and opts.checker.enabled }
  for _, p in ipairs(opts.spec) do
    local dir = C.options.root .. '/' .. p.name
    C.plugins[p.name] = { name = p.name, dir = dir, build = p.build, _ = { installed = vim.uv.fs_stat(dir) ~= nil, tasks = {} } }
    vim.opt.rtp:append(dir)
  end
end
return M
`,
	"lua/lazy/core/config.lua": "return { plugins = {}, options = nil }\n",
	"lua/lazy/manage.lua": `
local M = {}
local function mark(name) vim.fn.writefile({ name }, vim.fn.stdpath('data') .. '/manage-' .. name) end
for _, name in ipairs({ 'install', 'update', 'sync', 'restore', 'clean', 'check' }) do
  M[name] = function() mark(name) end
end
function M.build(opts)
  local C = require('lazy.core.config')
  for _, name in ipairs(opts.plugins) do
    local p = C.plugins[name]
    local log, level = {}, 0
    local build = p.build
    if build == nil and vim.uv.fs_stat(p.dir .. '/build.lua') then build = 'build.lua' end
    local ok, err = pcall(function()
      if type(build) == 'function' then build(p) elseif build == 'build.lua' then dofile(p.dir .. '/build.lua') end
    end)
    if not ok then table.insert(log, tostring(err)); level = vim.log.levels.ERROR end
    p._.tasks = { {
      name = 'build',
      has_errors = function() return level >= vim.log.levels.ERROR end,
      output = function() return table.concat(log, '\\n') end,
    } }
  end
end
return M
`,
};

const INIT_LUA = `
vim.opt.rtp:prepend(vim.fn.stdpath('data') .. '/lazy/lazy.nvim')
vim.lsp.config('fake_ls', { cmd = { 'devhub-fake-language-server' }, filetypes = { 'fake' } })
vim.lsp.enable('fake_ls')
require('lazy').setup({
  spec = {
    { name = 'lazy.nvim' },
    { name = 'plain' },
    { name = 'builds', build = function(p) vim.fn.writefile({ 'built on the host' }, p.dir .. '/built.txt') end },
    { name = 'offline' },
  },
})
`;

describe.skipIf(TEST_NVIM === undefined)("a sync to a host", () => {
	let root: string;
	let mac: Record<string, string>;
	let host: string;
	let source: NeovimConfigSource;
	let carry: HostCarry;
	let reach: ReturnType<typeof localHost>;
	const reports: CarryReport[] = [];

	const local = (...parts: string[]) => join(root, "mac", ...parts);
	const lazy = (...parts: string[]) => local("data", "nvim", "lazy", ...parts);
	const there = (...parts: string[]) => join(host, ...parts);

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "devhub-carry-host-"));
		host = join(root, "host");
		await mkdir(there(".config", "nvim"), { recursive: true });
		await writeFile(
			there(".config", "nvim", "init.lua"),
			"-- the host's own\n",
		);
		mac = {
			HOME: local(),
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			XDG_CONFIG_HOME: local("config"),
			XDG_DATA_HOME: local("data"),
			XDG_STATE_HOME: local("state"),
			XDG_CACHE_HOME: local("cache"),
		};
		await mkdir(local("config", "nvim"), { recursive: true });
		await writeFile(local("config", "nvim", "init.lua"), INIT_LUA);
		await writeFile(local("config", "nvim", ".env"), "TOKEN=never-carried\n");
		for (const [path, text] of Object.entries(FAKE_LAZY)) {
			await mkdir(join(lazy("lazy.nvim"), path, ".."), { recursive: true });
			await writeFile(join(lazy("lazy.nvim"), path), text);
		}
		await mkdir(lazy("plain", "lua", "plain"), { recursive: true });
		await writeFile(
			lazy("plain", "lua", "plain", "init.lua"),
			"return 'plain'\n",
		);
		await mkdir(lazy("plain", "tests"), { recursive: true });
		await writeFile(lazy("plain", "tests", "big_spec.lua"), "x".repeat(10_000));
		await mkdir(lazy("builds"), { recursive: true });
		await writeFile(lazy("builds", "README"), "built by its spec's build\n");
		await mkdir(lazy("offline"), { recursive: true });
		await writeFile(
			lazy("offline", "build.lua"),
			"error('could not download the release: no route to host', 0)\n",
		);
		source = new NeovimConfigSource({
			nvim: () => TEST_NVIM,
			environment: () => mac,
			source: "this-mac (DevHub)",
			report: (report) => reports.push(report),
		});
		reach = localHost(host);
		carry = new HostCarry({
			access: reach,
			paths: {
				directory: there(".devhub-server", "nvim-config"),
				...carriedPaths(host, {}),
				nvim: TEST_NVIM ?? "",
				toolDirectories: [there(".devhub-server", "rg", "1", "rg-dir")],
			},
			source,
			installTimeoutMs: 120_000,
		});
		await carry.prepare();
	}, 60_000);

	afterAll(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("carries the config and the plugin tree, builds by the spec, and says what is missing", async () => {
		await carry.sync("connect");
		expect(
			await readFile(there(".config", "devhub-nvim", "init.lua"), "utf8"),
		).toBe(INIT_LUA);
		expect(
			await readFile(
				there(".local/share/devhub-nvim/lazy/plain/lua/plain/init.lua"),
				"utf8",
			),
		).toBe("return 'plain'\n");
		await expect(
			access(there(".config", "devhub-nvim", ".env")),
		).rejects.toThrow();
		await expect(
			access(there(".local/share/devhub-nvim/lazy/plain/tests")),
		).rejects.toThrow();
		// lazy.nvim's own build step ran on the host, for the specs that declare one.
		expect(
			await readFile(
				there(".local/share/devhub-nvim/lazy/builds/built.txt"),
				"utf8",
			),
		).toBe("built on the host\n");
		await expect(
			access(there(".devhub-server", "nvim-config", "syncing")),
		).rejects.toThrow();
		const manifest = parseManifest(
			await readFile(
				there(".devhub-server", "nvim-config", "manifest"),
				"utf8",
			),
		);
		expect(manifest.source).toBe("this-mac (DevHub)");
		expect(manifest.units.map((unit) => unit.name)).toEqual([
			"config",
			"plugin/builds",
			"plugin/lazy.nvim",
			"plugin/offline",
			"plugin/plain",
		]);
		const report = reports.at(-1);
		expect(report?.level).toBe("warning");
		expect(report?.unitsSent).toBe(5);
		expect(report?.failedBuilds).toEqual(["offline"]);
		expect(report?.text).toContain(
			"lazy.nvim's build of offline failed there: could not download the release: no route to host",
		);
		expect(report?.text).toContain("fake_ls (devhub-fake-language-server)");
		expect(report?.text).toContain("config/.env");
		expect(report?.missing).toContain("fake_ls");
		// The host's own config is never read or written.
		expect(await readFile(there(".config", "nvim", "init.lua"), "utf8")).toBe(
			"-- the host's own\n",
		);
		expect(
			await readFile(
				there(".devhub-server", "nvim-config", "build-failed"),
				"utf8",
			),
		).toBe("offline\n");
	}, 120_000);

	it("sends only the unit that changed, and nothing when nothing did", async () => {
		reports.length = 0;
		await carry.sync("change");
		expect(reports).toEqual([]);
		await writeFile(
			local("config", "nvim", "init.lua"),
			`${INIT_LUA}-- edited\n`,
		);
		source.forget();
		const before = (
			await stat(
				there(".local/share/devhub-nvim/lazy/plain/lua/plain/init.lua"),
			)
		).ino;
		await carry.sync("change");
		expect(reports.at(-1)?.unitsSent).toBe(1);
		expect(reports.at(-1)?.bytesSent).toBeLessThan(4096);
		expect(
			await readFile(there(".config", "devhub-nvim", "init.lua"), "utf8"),
		).toContain("-- edited");
		expect(
			(
				await stat(
					there(".local/share/devhub-nvim/lazy/plain/lua/plain/init.lua"),
				)
			).ino,
		).toBe(before);
	}, 120_000);

	it("removes a plugin the spec no longer has", async () => {
		await writeFile(
			local("config", "nvim", "init.lua"),
			INIT_LUA.replace("    { name = 'plain' },\n", ""),
		);
		source.forget();
		await carry.sync("change");
		await expect(
			access(there(".local/share/devhub-nvim/lazy/plain")),
		).rejects.toThrow();
		expect(reports.at(-1)?.unitsRemoved).toBe(1);
	}, 120_000);

	async function runCarried(
		lua: string,
		env: Readonly<Record<string, string>> = {},
	) {
		const out = join(host, "out.json");
		await rm(out, { force: true });
		const result = await reach.sh(
			`${Object.entries({ DEVHUB_TEST_OUT: out, ...env })
				.map(([k, v]) => `${k}='${v}'`)
				.join(
					" ",
				)} '${carry.launcher}' --headless -i NONE -c 'lua ${lua.replaceAll("'", "'\\''")}' -c 'qa!' </dev/null`,
			{ timeoutMs: 60_000 },
		);
		expect(result.stderr.toString()).not.toMatch(/E5113|Error/u);
		return JSON.parse(await readFile(out, "utf8")) as Record<string, unknown>;
	}

	it("guards the carried tree: no installs, no checker, no updates; build stays", async () => {
		const answer = await runCarried(
			"require('lazy.manage').update(); require('lazy.manage').sync(); vim.fn.writefile({ vim.json.encode({ appname = vim.env.NVIM_APPNAME, config = vim.fn.stdpath('config'), lazy = vim.g.fake_lazy, carried = vim.g.devhub_carried, path = vim.env.PATH }) }, vim.env.DEVHUB_TEST_OUT)",
		);
		expect(answer.appname).toBe("devhub-nvim");
		expect(answer.config).toBe(there(".config", "devhub-nvim"));
		expect(answer.lazy).toEqual({ missing: false, checker: false });
		expect(answer.carried).toMatchObject({ source: "this-mac (DevHub)" });
		expect(
			String(answer.path).endsWith(
				`:${there(".devhub-server", "rg", "1", "rg-dir")}`,
			),
		).toBe(true);
		await expect(
			access(there(".local/share/devhub-nvim/manage-update")),
		).rejects.toThrow();
		await expect(
			access(there(".local/share/devhub-nvim/manage-sync")),
		).rejects.toThrow();
	}, 60_000);

	it("leaves a NVIM_APPNAME the person set alone", async () => {
		const answer = await runCarried(
			"vim.fn.writefile({ vim.json.encode({ appname = vim.env.NVIM_APPNAME, carried = vim.g.devhub_carried == nil }) }, vim.env.DEVHUB_TEST_OUT)",
			{ NVIM_APPNAME: "mine" },
		);
		expect(answer).toEqual({ appname: "mine", carried: true });
	}, 60_000);

	it("makes a Neovim started mid-sync wait for the tree", async () => {
		const marker = there(".devhub-server", "nvim-config", "syncing");
		await writeFile(marker, `${String(Math.floor(Date.now() / 1000))} 1\n`);
		const started = Date.now();
		setTimeout(() => void rm(marker, { force: true }), 1500);
		await runCarried(
			"vim.fn.writefile({ vim.json.encode({ ok = true }) }, vim.env.DEVHUB_TEST_OUT)",
		);
		expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
	}, 60_000);

	it("does not wait on a marker a dead sync left behind", async () => {
		const marker = there(".devhub-server", "nvim-config", "syncing");
		await writeFile(
			marker,
			`${String(Math.floor(Date.now() / 1000) - 3600)} 999999999\n`,
		);
		const started = Date.now();
		await runCarried(
			"vim.fn.writefile({ vim.json.encode({ ok = true }) }, vim.env.DEVHUB_TEST_OUT)",
		);
		expect(Date.now() - started).toBeLessThan(10_000);
		// …and the next sync takes it over.
		await carry.sync("change");
		await expect(access(marker)).rejects.toThrow();
	}, 60_000);

	it("names no plugin anywhere it writes on the host", () => {
		for (const script of reach.scripts) {
			expect(script).not.toMatch(
				/blink|review-relay|incremental-diff|copilot/u,
			);
		}
	});
});

/**
 * The guard against the real lazy.nvim, when a checkout is named: the commit
 * in the person's lock is the one that matters (`DEVHUB_LAZY_NVIM=<dir>`).
 */
describe.skipIf(
	TEST_NVIM === undefined || process.env.DEVHUB_LAZY_NVIM === undefined,
)("the guard against lazy.nvim itself", () => {
	it("refuses update and sync and keeps build", async () => {
		const root = await mkdtemp(join(tmpdir(), "devhub-carry-lazy-"));
		try {
			const guard = join(root, "carry.lua");
			const { carryGuardLua } = await import("./carryHost.js");
			await writeFile(guard, carryGuardLua(root));
			const init = join(root, "init.lua");
			await writeFile(
				init,
				`vim.opt.rtp:prepend(${JSON.stringify(process.env.DEVHUB_LAZY_NVIM)})
require('lazy').setup({ spec = {}, install = { missing = true }, checker = { enabled = true } })
local C = require('lazy.core.config')
local M = require('lazy.manage')
vim.fn.writefile({ vim.json.encode({ missing = C.options.install.missing, checker = C.options.checker.enabled, build = type(M.build), update = debug.getinfo(M.update).source }) }, ${JSON.stringify(join(root, "out.json"))})
vim.cmd('qa!')`,
			);
			await new Promise<void>((done, fail) => {
				const child = spawn(
					TEST_NVIM ?? "",
					["--headless", "-u", init, "--cmd", `lua dofile('${guard}')`],
					{
						env: {
							...process.env,
							DEVHUB_CARRY_NOWAIT: "1",
							XDG_DATA_HOME: root,
							XDG_STATE_HOME: root,
						},
						stdio: "ignore",
					},
				);
				child.on("error", fail);
				child.on("close", () => done());
			});
			const answer = JSON.parse(
				await readFile(join(root, "out.json"), "utf8"),
			) as Record<string, unknown>;
			expect(answer.missing).toBe(false);
			expect(answer.checker).toBe(false);
			expect(answer.build).toBe("function");
			expect(String(answer.update)).toContain("carry.lua");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 60_000);
});
