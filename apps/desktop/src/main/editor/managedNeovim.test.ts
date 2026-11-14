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
import {
	NeovimRequestTimeout,
	type NeovimRpc,
	type RequestOptions,
} from "./neovimRpc.js";
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
	readonly calls: {
		method: string;
		params: readonly unknown[];
		timeoutMs: number | undefined;
	}[] = [];
	closed = false;
	blocking = 0;
	/**
	 * What Neovim does with a request before it answers: `exit` (`:q` was
	 * typed as it came), `hang` (its config still running, past the wait).
	 */
	before: ((method: string) => "exit" | "hang" | undefined) | undefined;
	private readonly listeners: (() => void)[] = [];

	constructor(readonly pane: string | undefined) {}

	request(
		method: string,
		params: readonly unknown[],
		options: RequestOptions = {},
	): Promise<unknown> {
		if (this.closed) return Promise.reject(new Error("closed"));
		this.calls.push({ method, params, timeoutMs: options.timeoutMs });
		const fate = this.before?.(method);
		if (fate === "exit") {
			this.exit();
			return Promise.reject(new Error("the connection to Neovim closed"));
		}
		if (fate === "hang")
			return Promise.reject(new NeovimRequestTimeout(method));
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
	/** How many times a pane's state was asked on its own (not by a show). */
	let stateAsked = 0;
	let failStart = false;
	let stateOverride:
		| ((paneId: string) => Promise<PaneState> | undefined)
		| undefined;
	let nvim: string | undefined = "/opt/homebrew/bin/nvim";

	const paneState = (paneId: string): Promise<PaneState> =>
		stateOverride?.(paneId) ?? Promise.resolve(panes.get(paneId) ?? "gone");
	const editorPanes: EditorPanes = {
		open: (target, argv) => {
			const paneId = `%${String(next++)}`;
			// The keeper: `sh -c <script> devhub-nvim <nvim and its arguments>`.
			expect(argv.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
			expect(argv[3]).toBe("devhub-nvim");
			if (!argv.includes("--listen")) {
				// A failure's window (`failureArgv`): what it says, and its stderr.
				log.push(
					`failure ${argv[4]!.split("\n")[0]!} [${argv[5]!}] -> ${paneId}`,
				);
				panes.set(paneId, "alive");
				return Promise.resolve(paneId);
			}
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
		// As tmux's: the pane read, and shown only while its program runs.
		show: async (_target, paneId, socketPath) => {
			const state = await paneState(paneId);
			if (state === "alive") shown.push(`${paneId} ${socketPath}`);
			return state;
		},
		state: (_target, paneId) => {
			stateAsked += 1;
			return paneState(paneId);
		},
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
		stateAsked: () => stateAsked,
		failNextStart: () => {
			failStart = true;
		},
		unfailStart: () => {
			failStart = false;
		},
		noNvim: () => {
			nvim = undefined;
		},
		/** tmux's answer about a pane, given by the test (`undefined`: the usual). */
		stateOf: (
			override:
				| ((paneId: string) => Promise<PaneState> | undefined)
				| undefined,
		) => {
			stateOverride = override;
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
		// No Neovim: its window says why instead, and is shown.
		expect(w.log).toEqual([
			"failure DevHub の Neovim を起動できませんでした。 [] -> %1",
		]);
		expect(w.shown).toEqual(["%1 "]);
	});

	it("says so when Neovim exits before it opens its socket, and leaves no pane", async () => {
		const w = world();
		w.failNextStart();
		await expect(
			w.make().open(WORKSPACE, { path: "/src/widget/a.ts" }),
		).rejects.toThrow("exited before it opened its socket");
		// Its pane goes, and a window in its place says why, with its stderr.
		expect(w.log).toContain(
			`failure Neovim が起動の途中で終了しました（ソケットを開く前）。 [${SOCKET}.stderr] -> %2`,
		);
		expect(w.log).toContain("kill %1");
		expect([...w.panes.keys()]).toEqual(["%2"]);
		expect(w.shown).toEqual(["%2 "]);
	});

	it("closes the window that said a start failed once the next one starts", async () => {
		const w = world();
		w.failNextStart();
		const neovims = w.make();
		await neovims
			.open(WORKSPACE, { path: "/src/widget/a.ts" })
			.catch(() => undefined);
		w.unfailStart();
		await neovims.open(WORKSPACE, { path: "/src/widget/a.ts" });
		expect(w.log).toContain("kill %2");
		expect([...w.panes.keys()]).toEqual(["%3"]);
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
		const asked = w.stateAsked();
		const result = await neovims.open(WORKSPACE, {
			path: "/src/widget/b.ts",
			line: 3,
		});
		expect(result).toEqual({ started: false });
		expect(w.log).toEqual([]);
		// Its pane is read by the show alone: one tmux command, not two.
		expect(w.stateAsked()).toBe(asked);
		expect(w.shown.at(-1)).toBe(`%1 ${SOCKET}`);
		expect(w.server()?.opens()[1]).toEqual(["/src/widget/b.ts", 3, null, null]);
	});

	it("dismisses a blocking prompt, the open waiting behind it", async () => {
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
		// Sent with the mode's question, not after its answer: a Neovim at a
		// prompt answers only fast calls, so it runs the open once the
		// `<Esc>` has let it out (one round trip fewer).
		expect(server.opens()[1]).toEqual(["/src/widget/b.ts", null, null, null]);
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

describe("a jump that meets the Neovim's end", () => {
	/** `:q` typed as the jump came: the pane and its socket go with it. */
	function quitsOnRequest(w: ReturnType<typeof world>, pane: string): void {
		const server = w.server()!;
		server.before = () => {
			w.panes.delete(pane);
			w.listening.delete(SOCKET);
			w.files.delete(SOCKET);
			return "exit";
		};
	}

	it("starts a new Neovim when the one it found ends under it, and opens the file there", async () => {
		const w = world();
		const neovims = w.make();
		await neovims.open(WORKSPACE, { path: "/src/widget/a.ts" });
		quitsOnRequest(w, "%1");
		const result = await neovims.open(WORKSPACE, { path: "/src/widget/b.ts" });
		expect(result).toEqual({ started: true });
		expect(neovims.paneOf(WORKSPACE.workspaceId)).toBe("%2");
		expect(w.server()?.opens()).toEqual([
			["/src/widget/b.ts", null, null, null],
		]);
		expect(w.shown.at(-1)).toBe(`%2 ${SOCKET}`);
	});

	it("looks again when the one it then finds on the socket is on its way out too", async () => {
		const w = world();
		const neovims = w.make();
		await neovims.open(WORKSPACE, { path: "/src/widget/a.ts" });
		// Its connection closes at the jump, while the exiting Neovim still
		// listens: the jump adopts it from its socket, and it goes then.
		const exiting = new FakeServer("%1");
		exiting.before = (method) => {
			if (method !== "nvim_get_mode") return undefined;
			w.panes.delete("%1");
			w.listening.delete(SOCKET);
			w.files.delete(SOCKET);
			return "exit";
		};
		w.server()!.before = () => {
			w.listening.set(SOCKET, exiting);
			return "exit";
		};
		const result = await neovims.open(WORKSPACE, { path: "/src/widget/b.ts" });
		expect(result).toEqual({ started: true });
		expect(neovims.paneOf(WORKSPACE.workspaceId)).toBe("%2");
		expect(w.server()?.opens()).toEqual([
			["/src/widget/b.ts", null, null, null],
		]);
	});

	it("says so, and starts no third, when the new one ends at once too", async () => {
		const w = world();
		const neovims = w.make();
		await neovims.open(WORKSPACE, { path: "/src/widget/a.ts" });
		quitsOnRequest(w, "%1");
		// Every Neovim from here on ends at its first request.
		const listening = w.listening;
		const set = listening.set.bind(listening);
		listening.set = (socket, server) => {
			server.before = () => {
				w.panes.delete(server.pane!);
				return "exit";
			};
			return set(socket, server);
		};
		await expect(
			neovims.open(WORKSPACE, { path: "/src/widget/b.ts" }),
		).rejects.toThrow(/exited as soon as it had started/);
		expect(w.log.filter((line) => line.startsWith("open"))).toHaveLength(2);
		expect(
			w.log.filter((line) => line.startsWith("failure Neovim が起動した直後")),
		).toHaveLength(1);
	});

	it("never unlinks the socket of the Neovim started after it, however late its end is heard", async () => {
		const w = world();
		const neovims = w.make();
		await neovims.open(WORKSPACE, { path: "/src/widget/a.ts" });
		// tmux is slow to say what became of the old pane.
		let answer: (state: PaneState) => void = () => undefined;
		w.stateOf((paneId) =>
			paneId === "%1"
				? new Promise<PaneState>((resolve) => {
						answer = resolve;
					})
				: undefined,
		);
		w.panes.delete("%1");
		w.listening.get(SOCKET)?.exit();
		w.listening.delete(SOCKET);
		const jump = neovims.open(WORKSPACE, { path: "/src/widget/b.ts" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		answer("gone");
		w.stateOf(undefined);
		expect(await jump).toEqual({ started: true });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(w.files.has(SOCKET)).toBe(true);
		expect(w.server()?.pane).toBe("%2");
	});

	it("kills the pane remain-on-exit kept once its Neovim's end is heard", async () => {
		const w = world();
		const neovims = w.make();
		await neovims.open(WORKSPACE, { path: "/src/widget/a.ts" });
		w.panes.set("%1", "dead");
		w.server()?.exit();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(w.log).toContain("kill %1");
		expect(w.files.has(SOCKET)).toBe(false);
	});
});

describe("a jump's window", () => {
	it("is shown before the file is asked of Neovim, so whatever holds it up is in front", async () => {
		const w = world();
		const neovims = w.make();
		const seen: string[][] = [];
		const listening = w.listening;
		const set = listening.set.bind(listening);
		listening.set = (socket, server) => {
			server.before = (method) => {
				if (method === "nvim_exec_lua") seen.push([...w.shown]);
				return undefined;
			};
			return set(socket, server);
		};
		await neovims.open(WORKSPACE, { path: "/src/widget/a.ts" });
		expect(seen.at(-1)).toEqual([`%1 ${SOCKET}`]);
	});

	it("waits on a Neovim started for it while its config runs, and on a running one only as long as any request", async () => {
		const w = world();
		const neovims = w.make({ startupWaitMs: 45_000 });
		await neovims.open(WORKSPACE, { path: "/src/widget/a.ts" });
		await neovims.open(WORKSPACE, { path: "/src/widget/b.ts" });
		const opens = w
			.server()!
			.calls.filter((call) => call.params[0] === OPEN_FILE_LUA);
		expect(opens.map((call) => call.timeoutMs)).toEqual([45_000, undefined]);
	});

	it("says, when Neovim does not answer, that its window shows why — and it is shown", async () => {
		const w = world();
		const neovims = w.make();
		const listening = w.listening;
		const set = listening.set.bind(listening);
		listening.set = (socket, server) => {
			server.before = (method) =>
				method === "nvim_get_mode" ? "hang" : undefined;
			return set(socket, server);
		};
		await expect(
			neovims.open(WORKSPACE, { path: "/src/widget/a.ts" }),
		).rejects.toThrow(/did not finish starting.*stopped/);
		// Shown at once; then, its start given up on, stopped and said.
		expect(w.shown).toEqual([`%1 ${SOCKET}`, "%2 "]);
		expect(w.log).toContain("kill %1");
	});

	it("says a running Neovim that does not answer is busy in its window, and leaves it running", async () => {
		const w = world();
		const neovims = w.make();
		await neovims.open(WORKSPACE, { path: "/src/widget/a.ts" });
		w.server()!.before = (method) =>
			method === "nvim_exec_lua" ? "hang" : undefined;
		await expect(
			neovims.open(WORKSPACE, { path: "/src/widget/b.ts" }),
		).rejects.toThrow(/busy.*waiting/);
		expect(w.log.filter((line) => line.startsWith("kill"))).toEqual([]);
		expect(w.log.filter((line) => line.startsWith("failure"))).toEqual([]);
	});

	it("lets an overlay's attach wait as long as a jump waits on a Neovim it started", async () => {
		const w = world();
		const neovims = w.make({ startupWaitMs: 45_000 });
		let during: number | undefined;
		const listening = w.listening;
		const set = listening.set.bind(listening);
		listening.set = (socket, server) => {
			server.before = (method) => {
				if (method === "nvim_get_mode")
					during = neovims.startupDeadline("local", server.pane!);
				return undefined;
			};
			return set(socket, server);
		};
		const before = Date.now();
		await neovims.open(WORKSPACE, { path: "/src/widget/a.ts" });
		expect(during).toBeGreaterThanOrEqual(before + 45_000);
		// Answered: an attach from now on waits as for any Neovim.
		expect(neovims.startupDeadline("local", "%1")).toBeUndefined();
		expect(neovims.startupDeadline("ssh:build", "%1")).toBeUndefined();
	});
});
