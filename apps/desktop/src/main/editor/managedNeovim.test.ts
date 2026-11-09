/**
 * The managed Neovim's lifecycle, with tmux, the disk and Neovim faked:
 * which jump starts a server, which reuses one, which adopts one a previous
 * DevHub left running, and what is cleaned up when one dies or its Workspace
 * closes. The tmux commands themselves run against a real server in
 * `test/terminal/editorPanes.real.test.ts`, and the RPC against a real Neovim
 * in `neovim.real.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
	ManagedNeovims,
	MAX_SOCKET_PATH_BYTES,
	neovimSocketName,
	OPEN_FILE_LUA,
	PUBLISH_THEME_LUA,
	socketDirectoryFor,
	type EditorPanes,
	type ManagedNeovimOptions,
	type NeovimFiles,
	type PaneState,
} from "./managedNeovim.js";
import type { NeovimRpc } from "./neovimRpc.js";
import {
	publishedThemeOf,
	type PublishedTheme,
} from "../../model/publishedTheme.js";
import {
	ThemeCatalog,
	terminalPaletteOfTheme,
} from "../../model/themes/theme.js";
import type { WorkspaceTerminalTarget } from "../terminal/ports.js";

const WORKSPACE: WorkspaceTerminalTarget = {
	machine: "local",
	workspaceId: "6f1c2d3e-4a5b-4c6d-8e7f-001122334455",
	root: "/src/widget",
};
const DIRECTORY = "/run/devhub/nvim";
const SOCKET = `${DIRECTORY}/${neovimSocketName(WORKSPACE.workspaceId)}`;

/** A Neovim's end of the connection, recording what it was asked. */
class FakeServer implements NeovimRpc {
	readonly calls: { method: string; params: readonly unknown[] }[] = [];
	closed = false;
	blocking = 0;
	private readonly listeners: (() => void)[] = [];

	constructor(readonly pane: string | undefined) {}

	request(method: string, params: readonly unknown[]): Promise<unknown> {
		if (this.closed) return Promise.reject(new Error("closed"));
		this.calls.push({ method, params });
		if (method === "nvim_get_mode") {
			const blocking = this.blocking > 0;
			if (blocking) this.blocking -= 1;
			return Promise.resolve({ mode: "n", blocking });
		}
		if (
			method === "nvim_exec_lua" &&
			params[0] === "return vim.env.TMUX_PANE"
		) {
			return Promise.resolve(this.pane ?? null);
		}
		return Promise.resolve(null);
	}

	onClose(listener: () => void): void {
		if (this.closed) listener();
		else this.listeners.push(listener);
	}

	/** Neovim exiting: the connection closes from its side. */
	exit(): void {
		this.closed = true;
		for (const listener of this.listeners.splice(0)) listener();
	}

	close(): void {
		this.exit();
	}

	opens(): readonly unknown[][] {
		return this.calls
			.filter(
				(call) =>
					call.method === "nvim_exec_lua" && call.params[0] === OPEN_FILE_LUA,
			)
			.map((call) => call.params[1] as unknown[]);
	}
}

/**
 * tmux, the socket directory and Neovim, together: a pane started with
 * `--listen <socket>` makes a server listening there, unless `failStart`
 * says Neovim dies first.
 */
function world() {
	const panes = new Map<string, PaneState>();
	const files = new Set<string>();
	/** Who is listening on each socket path. */
	const listening = new Map<string, FakeServer>();
	const log: string[] = [];
	/** Each window shown, as `<pane> <socket>`. */
	const shown: string[] = [];
	let next = 1;
	let failStart = false;
	let nvim: string | undefined = "/opt/homebrew/bin/nvim";

	const editorPanes: EditorPanes = {
		open: (target, argv) => {
			const paneId = `%${String(next++)}`;
			// The keeper: `sh -c <script> devhub-nvim <nvim and its arguments>`.
			expect(argv.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
			expect(argv[3]).toBe("devhub-nvim");
			log.push(
				`open ${target.workspaceId} ${argv.slice(4).join(" ")} -> ${paneId}`,
			);
			if (failStart) {
				panes.set(paneId, "dead");
				return Promise.resolve(paneId);
			}
			panes.set(paneId, "alive");
			const socket = argv[argv.indexOf("--listen") + 1]!;
			files.add(socket);
			listening.set(socket, new FakeServer(paneId));
			return Promise.resolve(paneId);
		},
		show: (_target, paneId, socketPath) => {
			shown.push(`${paneId} ${socketPath}`);
			return Promise.resolve();
		},
		state: (_target, paneId) => Promise.resolve(panes.get(paneId) ?? "gone"),
		kill: (_target, paneId) => {
			log.push(`kill ${paneId}`);
			panes.delete(paneId);
			for (const [socket, server] of listening) {
				if (server.pane === paneId) {
					listening.delete(socket);
					server.exit();
				}
			}
			return Promise.resolve();
		},
	};
	const fakeFiles: NeovimFiles = {
		exists: (path) => Promise.resolve(files.has(path)),
		remove: (path) => {
			if (files.delete(path)) log.push(`rm ${path}`);
			return Promise.resolve();
		},
		ensurePrivateDirectory: () => Promise.resolve(),
	};
	const connect = (path: string): Promise<NeovimRpc> => {
		const server = listening.get(path);
		if (server === undefined || server.closed) {
			const error = new Error("refused") as NodeJS.ErrnoException;
			error.code = files.has(path) ? "ECONNREFUSED" : "ENOENT";
			return Promise.reject(error);
		}
		return Promise.resolve(server);
	};
	const make = (extra: Partial<ManagedNeovimOptions> = {}) =>
		new ManagedNeovims({
			...extra,
			panes: editorPanes,
			nvim: () =>
				nvim === undefined
					? Promise.reject(new Error("nvim was not found in /usr/bin, /bin."))
					: Promise.resolve(nvim),
			socketDirectory: DIRECTORY,
			connect,
			files: fakeFiles,
			startTimeoutMs: 200,
			pollMs: 1,
		});
	return {
		panes,
		files,
		listening,
		log,
		shown,
		make,
		server: () => listening.get(SOCKET),
		failNextStart: () => {
			failStart = true;
		},
		noNvim: () => {
			nvim = undefined;
		},
	};
}

describe("the first jump into a Workspace", () => {
	it("starts a headless Neovim in its session's devhub-nvim window, opens the file and shows the window", async () => {
		const w = world();
		const neovims = w.make();
		const result = await neovims.open(WORKSPACE, {
			path: "/src/widget/a b.ts",
			line: 12,
			column: 4,
		});
		expect(result).toEqual({ started: true });
		expect(w.log).toEqual([
			`open ${WORKSPACE.workspaceId} /opt/homebrew/bin/nvim --headless --listen ${SOCKET} -> %1`,
		]);
		expect(w.server()?.opens()).toEqual([["/src/widget/a b.ts", 12, 4, null]]);
		expect(neovims.paneOf(WORKSPACE.workspaceId)).toBe("%1");
		// After the file is in it: the overlay over that pane draws it.
		expect(w.shown).toEqual([`%1 ${SOCKET}`]);
		await neovims.open(WORKSPACE, { path: "/src/widget/b.ts" });
		expect(w.shown).toEqual([`%1 ${SOCKET}`, `%1 ${SOCKET}`]);
	});

	it("says which nvim is missing, and starts nothing", async () => {
		const w = world();
		w.noNvim();
		await expect(
			w.make().open(WORKSPACE, { path: "/src/widget/a.ts" }),
		).rejects.toThrow("nvim was not found");
		expect(w.log).toEqual([]);
	});

	it("says so when Neovim exits before it opens its socket, and leaves no pane", async () => {
		const w = world();
		w.failNextStart();
		await expect(
			w.make().open(WORKSPACE, { path: "/src/widget/a.ts" }),
		).rejects.toThrow("exited before it opened its socket");
		expect(w.log).toContain("kill %1");
		expect(w.panes.size).toBe(0);
	});

	it("starts one Neovim for two jumps that arrive together", async () => {
		const w = world();
		const neovims = w.make();
		const results = await Promise.all([
			neovims.open(WORKSPACE, { path: "/src/widget/a.ts" }),
			neovims.open(WORKSPACE, { path: "/src/widget/b.ts" }),
		]);
		expect(results).toEqual([{ started: true }, { started: false }]);
		expect(w.log.filter((line) => line.startsWith("open"))).toHaveLength(1);
		expect(
			w
				.server()
				?.opens()
				.map((open) => open[0]),
		).toEqual(["/src/widget/a.ts", "/src/widget/b.ts"]);
	});
});

describe("a jump while that Neovim is alive", () => {
	it("goes to it, and starts nothing", async () => {
		const w = world();
		const neovims = w.make();
		await neovims.open(WORKSPACE, { path: "/src/widget/a.ts" });
		w.log.length = 0;
		const result = await neovims.open(WORKSPACE, {
			path: "/src/widget/b.ts",
			line: 3,
		});
		expect(result).toEqual({ started: false });
		expect(w.log).toEqual([]);
		expect(w.server()?.opens()[1]).toEqual(["/src/widget/b.ts", 3, null, null]);
	});

	it("dismisses a blocking prompt before asking it to open anything", async () => {
		const w = world();
		const neovims = w.make();
		await neovims.open(WORKSPACE, { path: "/src/widget/a.ts" });
		const server = w.server()!;
		server.blocking = 1;
		await neovims.open(WORKSPACE, { path: "/src/widget/b.ts" });
		const methods = server.calls.map((call) => call.method);
		const input = methods.lastIndexOf("nvim_input");
		expect(input).toBeGreaterThan(-1);
		expect(server.calls[input]?.params).toEqual(["<Esc>"]);
		expect(methods.lastIndexOf("nvim_exec_lua")).toBeGreaterThan(input);
	});
});

describe("a jump after that Neovim has gone", () => {
	it("starts a new one in a new window once it exited (:q)", async () => {
		const w = world();
		const neovims = w.make();
		await neovims.open(WORKSPACE, {
			path: "/src/widget/a.ts",
			waitMarkerPath: "/tmp/wait-1",
		});
		w.files.add("/tmp/wait-1");
		w.log.length = 0;
		// `:q`: the pane closes and the connection with it.
		w.panes.delete("%1");
		w.listening.get(SOCKET)?.exit();
		w.listening.delete(SOCKET);
		await new Promise((resolve) => setTimeout(resolve, 0));
		// Heard at once: the socket and the wait marker it held are cleaned up
		// without waiting for the next jump.
		expect(neovims.paneOf(WORKSPACE.workspaceId)).toBeUndefined();
		expect(w.files.has("/tmp/wait-1")).toBe(false);
		const result = await neovims.open(WORKSPACE, { path: "/src/widget/b.ts" });
		expect(result).toEqual({ started: true });
		expect(w.log.filter((line) => line.startsWith("open"))).toEqual([
			`open ${WORKSPACE.workspaceId} /opt/homebrew/bin/nvim --headless --listen ${SOCKET} -> %2`,
		]);
	});

	it("keeps a running one whose connection only dropped, and adopts it again", async () => {
		const w = world();
		const neovims = w.make();
		await neovims.open(WORKSPACE, { path: "/src/widget/a.ts" });
		w.log.length = 0;
		// An SSH host's master went away: this connection closed, while the
		// Neovim goes on listening in its pane.
		w.server()?.exit();
		w.listening.set(SOCKET, new FakeServer("%1"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(w.files.has(SOCKET)).toBe(true);
		const result = await neovims.open(WORKSPACE, { path: "/src/widget/b.ts" });
		expect(result).toEqual({ started: false });
		expect(w.log).toEqual([]);
		expect(neovims.paneOf(WORKSPACE.workspaceId)).toBe("%1");
	});

	it("does not trust a connection whose pane has gone", async () => {
		const w = world();
		const neovims = w.make();
		await neovims.open(WORKSPACE, { path: "/src/widget/a.ts" });
		w.panes.delete("%1");
		const result = await neovims.open(WORKSPACE, { path: "/src/widget/b.ts" });
		expect(result).toEqual({ started: true });
		expect(neovims.paneOf(WORKSPACE.workspaceId)).toBe("%2");
	});

	it("kills a pane remain-on-exit kept, instead of leaving it in the window list", async () => {
		const w = world();
		const neovims = w.make();
		await neovims.open(WORKSPACE, { path: "/src/widget/a.ts" });
		w.panes.set("%1", "dead");
		await neovims.open(WORKSPACE, { path: "/src/widget/b.ts" });
		expect(w.log).toContain("kill %1");
		expect(neovims.paneOf(WORKSPACE.workspaceId)).toBe("%2");
	});

	it("unlinks a stale socket with nothing listening, and starts on its path", async () => {
		const w = world();
		w.files.add(SOCKET);
		const result = await w.make().open(WORKSPACE, { path: "/src/widget/a.ts" });
		expect(result).toEqual({ started: true });
		expect(w.log[0]).toBe(`rm ${SOCKET}`);
		expect(w.server()?.opens()).toHaveLength(1);
	});
});

describe("a DevHub that restarted under a running Neovim", () => {
	it("adopts it by its socket and its own $TMUX_PANE, and starts nothing", async () => {
		const w = world();
		w.files.add(SOCKET);
		w.panes.set("%7", "alive");
		w.listening.set(SOCKET, new FakeServer("%7"));
		const neovims = w.make();
		const result = await neovims.open(WORKSPACE, { path: "/src/widget/a.ts" });
		expect(result).toEqual({ started: false });
		expect(w.log).toEqual([]);
		expect(neovims.paneOf(WORKSPACE.workspaceId)).toBe("%7");
	});

	it("still uses one whose pane is not this Workspace's, without bringing anything forward", async () => {
		const w = world();
		w.files.add(SOCKET);
		w.listening.set(SOCKET, new FakeServer("%99"));
		const neovims = w.make();
		const result = await neovims.open(WORKSPACE, { path: "/src/widget/a.ts" });
		expect(result).toEqual({ started: false });
		expect(w.log).toEqual([]);
		expect(w.server()?.opens()).toHaveLength(1);
	});
});

describe("the end of a managed Neovim", () => {
	it("goes with its Workspace: the pane killed, the socket unlinked, its markers deleted", async () => {
		const w = world();
		const neovims = w.make();
		await neovims.open(WORKSPACE, {
			path: "/src/widget/a.ts",
			waitMarkerPath: "/tmp/wait-2",
		});
		w.files.add("/tmp/wait-2");
		await neovims.close(WORKSPACE);
		expect(w.log).toContain("kill %1");
		expect(w.files.has(SOCKET)).toBe(false);
		expect(w.files.has("/tmp/wait-2")).toBe(false);
		expect(neovims.paneOf(WORKSPACE.workspaceId)).toBeUndefined();
	});

	it("closes one a previous DevHub left running, found by its socket", async () => {
		const w = world();
		w.files.add(SOCKET);
		w.panes.set("%7", "alive");
		w.listening.set(SOCKET, new FakeServer("%7"));
		await w.make().close(WORKSPACE);
		expect(w.log).toContain("kill %7");
		expect(w.files.has(SOCKET)).toBe(false);
	});

	it("is not killed by DevHub quitting: the connection is let go and the pane left running", async () => {
		const w = world();
		const neovims = w.make();
		await neovims.open(WORKSPACE, { path: "/src/widget/a.ts" });
		neovims.dispose();
		expect(w.log).not.toContain("kill %1");
		expect(w.panes.get("%1")).toBe("alive");
	});
});

describe("where the sockets go", () => {
	it("is one short, stable name per Workspace", () => {
		expect(neovimSocketName(WORKSPACE.workspaceId)).toMatch(
			/^[0-9a-f]{12}\.sock$/u,
		);
		expect(neovimSocketName(WORKSPACE.workspaceId)).toBe(
			neovimSocketName(WORKSPACE.workspaceId),
		);
		expect(neovimSocketName("another")).not.toBe(
			neovimSocketName(WORKSPACE.workspaceId),
		);
	});

	it("falls back to a shorter directory when a socket path would not fit", () => {
		const long = `/Users/${"x".repeat(80)}/Library/Application Support/DevHub/devhub/nvim`;
		expect(socketDirectoryFor([long, "/var/folders/T/devhub-nvim-501"])).toBe(
			"/var/folders/T/devhub-nvim-501",
		);
		expect(socketDirectoryFor(["/short"])).toBe("/short");
		expect(() => socketDirectoryFor([long])).toThrow(
			String(MAX_SOCKET_PATH_BYTES),
		);
	});
});

describe("the theme", () => {
	const theme = (name: string): PublishedTheme => {
		const base = new ThemeCatalog().find("DevHub Dark");
		if (!base) throw new Error("no DevHub Dark");
		const resolved = { ...base, name };
		return publishedThemeOf({
			theme: resolved,
			terminal: terminalPaletteOfTheme(resolved),
			temporary: false,
		});
	};
	const told = (server: FakeServer | undefined) =>
		(server?.calls ?? [])
			.filter((call) => call.params[0] === PUBLISH_THEME_LUA)
			.map((call) => {
				const [value, env] = call.params[1] as [
					PublishedTheme,
					Record<string, string>,
				];
				return `${value.name} ${env["DEVHUB_THEME"] ?? ""}`;
			});

	it("is told to a Neovim as it starts, and to every live one when it changes", async () => {
		const w = world();
		let current = theme("Nord");
		const failures: string[] = [];
		const neovims = w.make({
			theme: () => current,
			onThemeFailure: (id) => failures.push(id),
		});
		await neovims.open(WORKSPACE, { path: "/src/widget/a.ts" });
		expect(told(w.server())).toEqual(["Nord Nord"]);
		current = theme("Light 2026");
		await neovims.publishTheme(current);
		expect(told(w.server())).toEqual(["Nord Nord", "Light 2026 Light 2026"]);
		expect(failures).toEqual([]);
	});

	it("is not told to a Neovim that has gone, and a refusal is only reported", async () => {
		const w = world();
		const failures: string[] = [];
		const neovims = w.make({
			theme: () => theme("Nord"),
			onThemeFailure: (id) => failures.push(id),
		});
		await neovims.open(WORKSPACE, { path: "/src/widget/a.ts" });
		const server = w.server();
		if (!server) throw new Error("no server");
		server.request = () => Promise.reject(new Error("E5108: your config"));
		await neovims.publishTheme(theme("X"));
		expect(failures).toEqual([WORKSPACE.workspaceId]);
		server.exit();
		await neovims.publishTheme(theme("Y"));
		expect(failures).toEqual([WORKSPACE.workspaceId]);
	});
});
