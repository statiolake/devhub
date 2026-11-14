/**
 * The Neovim DevHub manages for each Workspace: where files DevHub opens go.
 *
 * A Workspace's editor area is its terminal (its `ws-` tmux session,
 * `docs/neovim-editor.md`), and `devhub <file>` and a conversation's file
 * link open in this: `nvim --headless --listen <socket>` on the Workspace's
 * machine, in the session's one `devhub-nvim` window, made when it is not
 * there. Each open selects that window and names the socket on its pane
 * (`EditorPanes.show`), and the terminal draws DevHub's GUI over the pane
 * as it does over any `nvim` (`terminalNeovims.ts`); the pane itself draws
 * nothing. tmux keeps it across a DevHub restart and an SSH connection
 * dropping, as it keeps an Agent. It is never a Neovim the person started
 * in a terminal, and never one of those is used for an open: a `git commit`
 * waiting on its editor gets no other file.
 *
 * # What is true, and how it is found out
 *
 * Every jump re-establishes the truth before acting on it, in this order:
 *
 * 1. **Alive** — the record's RPC connection is open and its pane is still a
 *    live pane of this Workspace's session: activate the pane, open the file.
 * 2. **Not known, but a server answers on the socket** — DevHub restarted
 *    while Neovim went on running in tmux, which is the normal case after a
 *    relaunch. The server is asked for its `$TMUX_PANE` and adopted. There is
 *    no state file: the socket path is deterministic, and the pane is the
 *    server's own answer.
 * 3. **Dead or stale** — the connection closed, the pane is gone or dead, or
 *    the socket file is there with nothing listening: the record is dropped,
 *    the socket unlinked, any `--wait` markers it held deleted, and a new
 *    Neovim is started in a new window.
 *
 * The connection is held open between jumps, and that is the death
 * detector: it closing is Neovim having exited, and the record is forgotten
 * then and there. A Workspace closing kills the pane (`close`); DevHub
 * quitting only lets go of the connections (`dispose`), and the next DevHub
 * adopts what is still running.
 *
 * Everything that touches tmux or the disk is a port, so the lifecycle is
 * tested with fakes and the tmux half against a real server separately.
 */

import { startupTrace } from "../diagnostics/startupTrace.js";
import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceTerminalTarget } from "../terminal/ports.js";
import {
	NeovimClient,
	NeovimRequestTimeout,
	type NeovimRpc,
} from "./neovimRpc.js";
import { NVIM_STATE_VARIABLE, followRestartSh } from "./neovimRestart.js";
import {
	themeEnvironment,
	type PublishedTheme,
} from "../../model/publishedTheme.js";

/** What a pane DevHub started is, as tmux says it. */
export type PaneState = "alive" | "dead" | "gone";

/** The tmux half: the Workspace's `ws-` session, on its machine. */
export interface EditorPanes {
	/** Run `argv` in a new window of the Workspace's session; its pane id. */
	open(
		target: WorkspaceTerminalTarget,
		argv: readonly string[],
	): Promise<string>;
	/**
	 * Make the pane's window the one the session shows, the pane active, and
	 * name its Neovim's socket (on its machine) for the overlay — only if its
	 * program is running. Answers the pane's state as read for it, which is
	 * how a jump learns its Neovim's pane went (one tmux command, over SSH
	 * one round trip, and not a `state` before it).
	 */
	show(
		target: WorkspaceTerminalTarget,
		paneId: string,
		socketPath: string,
	): Promise<PaneState>;
	/** Whether `paneId` is one of this Workspace's panes, and running. */
	state(target: WorkspaceTerminalTarget, paneId: string): Promise<PaneState>;
	kill(target: WorkspaceTerminalTarget, paneId: string): Promise<void>;
}

/** The disk half: sockets and wait markers. Defaulted to `node:fs`. */
export interface NeovimFiles {
	exists(path: string): Promise<boolean>;
	/** Remove a file; one that is already gone is not a failure. */
	remove(path: string): Promise<void>;
	/** A directory only this user can enter. */
	ensurePrivateDirectory(path: string): Promise<void>;
}

const NODE_FILES: NeovimFiles = {
	async exists(path) {
		try {
			await stat(path);
			return true;
		} catch {
			return false;
		}
	},
	async remove(path) {
		await rm(path, { force: true });
	},
	async ensurePrivateDirectory(path) {
		await mkdir(path, { recursive: true, mode: 0o700 });
	},
};

/** Where a file jump goes, in the editor's terms. */
export interface NeovimOpen {
	/** Absolute, canonical. */
	readonly path: string;
	/** 1-based. */
	readonly line?: number;
	/** 1-based, in characters. */
	readonly column?: number;
	/** `devhub --wait`'s marker: deleted when this buffer is closed. */
	readonly waitMarkerPath?: string;
}

/**
 * Where one machine's Neovim sockets are, and how to reach one from here.
 * On this Mac the socket is connected to directly; on an SSH host `reach`
 * forwards it over the host's ControlMaster first (`Runtime.forwardUnixSocket`)
 * and answers the forward's socket, here.
 */
export interface NeovimSockets {
	/** A directory on that machine only this user can enter. */
	readonly directory: string;
	readonly files: NeovimFiles;
	/** A socket on this Mac that reaches the one at `socketPath` there. */
	readonly reach: (socketPath: string) => Promise<string>;
}

export interface ManagedNeovimOptions {
	readonly panes: EditorPanes;
	/** DevHub's `nvim` on the target's machine; rejects with the sentence to show. */
	readonly nvim: (target: WorkspaceTerminalTarget) => Promise<string>;
	/** This Mac's socket directory: DevHub's own, `0700`. See `socketDirectoryFor`. */
	readonly socketDirectory: string;
	readonly connect?: (socketPath: string) => Promise<NeovimRpc>;
	readonly files?: NeovimFiles;
	/** Another machine's sockets; this Mac's are the three fields above. */
	readonly remoteSockets?: (
		target: WorkspaceTerminalTarget,
	) => Promise<NeovimSockets>;
	/** How long a new Neovim has to open its socket. */
	readonly startTimeoutMs?: number;
	/**
	 * How long a Neovim started for a jump has to answer it: its config runs
	 * before it answers anything, and lazy.nvim installing or building
	 * plugins takes its time. Its window is shown meanwhile.
	 */
	readonly startupWaitMs?: number;
	/** How often the socket is tried while it starts. */
	readonly pollMs?: number;
	/** Told when a server's connection ends, for the log. */
	readonly onExit?: (workspaceId: string) => void;
	/**
	 * The colour theme DevHub publishes now, if any: told to a server as it
	 * is started or adopted, and to every live one when it changes
	 * (`publishTheme`).
	 */
	readonly theme?: () => PublishedTheme | undefined;
	/** A theme push that failed, for the log; the jump goes on regardless. */
	readonly onThemeFailure?: (workspaceId: string, error: unknown) => void;
}

interface ServerRecord {
	readonly target: WorkspaceTerminalTarget;
	/** On the server's machine. */
	readonly socketPath: string;
	/** That machine's disk, for its socket; wait markers are this Mac's. */
	readonly files: NeovimFiles;
	/** Absent for a server adopted whose pane could not be named. */
	readonly paneId: string | undefined;
	/** On this Mac: `socketPath`, or the forward of a host's. The UI connects here too. */
	readonly localPath: string;
	/** Which server this is, among every one this DevHub has known. */
	readonly serial: number;
	readonly client: NeovimRpc;
	readonly waitMarkers: Set<string>;
	/**
	 * Started for a jump and not yet answered one: until when its config may
	 * keep it from answering (`startupWaitMs`). The overlay's attach waits as
	 * long (`startupDeadline`).
	 */
	startingUntil: number | undefined;
	/** The program started, when DevHub started it: for what a failure says. */
	readonly program?: string;
}

/**
 * A Neovim that could not be started, or did not get through its start:
 * `message` for the CLI and the link, and `window` for the Workspace's
 * `devhub-nvim` window (`failureArgv`), which shows it in place of Neovim.
 */
/** A jump's show found its Neovim's pane not running. */
class PaneNotRunning extends Error {
	constructor(readonly state: Exclude<PaneState, "alive">) {
		super(`Neovim's pane is ${state}`);
	}
}

export class NeovimStartFailure extends Error {
	constructor(
		message: string,
		/** What the window says, in the person's language. */
		readonly window: string,
		/** The pane the failed Neovim was in, if one is left: replaced. */
		readonly paneId: string | undefined,
		/** Its stderr, on its machine (`neovimStderrPath`), if it ran. */
		readonly stderrPath: string | undefined,
	) {
		super(message);
		this.name = "NeovimStartFailure";
	}
}

/**
 * Where a managed Neovim's stderr goes (the keeper's `2>`), beside its
 * socket on its machine: what its config said before it died, for the
 * window that says it did.
 */
export function neovimStderrPath(socketPath: string): string {
	return `${socketPath}.stderr`;
}

const FAILURE_SH = `printf '%s\\n\\n' "$1"
if [ -n "$2" ] && [ -s "$2" ]; then
  printf '%s\\n\\n' "$3"
  tail -n 20 "$2"
  printf '\\n'
fi
printf '%s' "$4"
read -r _ || :`;

/**
 * What the `devhub-nvim` window runs when Neovim could not be started there:
 * what happened and what to do, the tail of its stderr when there is one,
 * and Enter to close it. POSIX `sh`, as on any host.
 */
export function failureArgv(
	text: string,
	stderrPath: string | undefined,
): string[] {
	return [
		"/bin/sh",
		"-c",
		FAILURE_SH,
		"devhub-nvim",
		text,
		stderrPath ?? "",
		`Neovim のエラー出力（${stderrPath ?? ""}）の最後の 20 行:`,
		"Enter でこのウィンドウを閉じます。",
	];
}

const TRY_IN_TERMINAL = (nvim: string | undefined) =>
	`確認するには: ターミナルで ${nvim ?? "DevHub の nvim"} を実行すると、設定のエラーがそのまま表示されます。\n直したら、もう一度ファイルを開いてください。`;

/** `sun_path` is 104 bytes on macOS, NUL included; Linux allows 108. */
export const MAX_SOCKET_PATH_BYTES = 103;

/**
 * The socket a Workspace's managed Neovim listens on: one per Workspace,
 * stable across DevHub restarts (which is what lets a relaunched DevHub adopt
 * it), and short — twelve hex digits of the Workspace id's SHA-256.
 */
export function neovimSocketName(workspaceId: string): string {
	return `${createHash("sha256").update(workspaceId).digest("hex").slice(0, 12)}.sock`;
}

/**
 * The first of `candidates` a socket path fits under, or a failure that says
 * why none did. A socket that silently fails to bind would be a Neovim that
 * starts and is never reachable.
 */
export function socketDirectoryFor(candidates: readonly string[]): string {
	for (const directory of candidates) {
		const path = join(directory, neovimSocketName("x"));
		if (Buffer.byteLength(path) <= MAX_SOCKET_PATH_BYTES) return directory;
	}
	throw new Error(
		`No directory for Neovim's socket is short enough for a socket path (${String(MAX_SOCKET_PATH_BYTES)} bytes): ${candidates.join(", ")}.`,
	);
}

/**
 * The one RPC call a jump makes, after the mode check: `:drop` the file (it
 * focuses a window already showing it), falling back to `:edit`; the cursor
 * where it was asked, clamped to the buffer; folds opened, the line centred;
 * and for `--wait`, autocommands that delete the marker when the buffer goes
 * or Neovim leaves. Arguments arrive as values (`...`), so nothing is
 * escaped by hand except through `fnameescape`.
 */
export const OPEN_FILE_LUA = `
local path, line, column, marker = ...
local function given(value) return value ~= nil and value ~= vim.NIL end
local escaped = vim.fn.fnameescape(path)
if vim.fn.mode() ~= "n" then vim.cmd("stopinsert") end
if not pcall(vim.cmd, "drop " .. escaped) then vim.cmd("edit " .. escaped) end
if given(line) then
  local last = vim.api.nvim_buf_line_count(0)
  local row = math.max(1, math.min(line, last))
  local text = vim.api.nvim_buf_get_lines(0, row - 1, row, false)[1] or ""
  local byte = 0
  if given(column) and column > 1 then
    byte = vim.fn.byteidx(text, column - 1)
    if byte < 0 then byte = #text end
  end
  vim.api.nvim_win_set_cursor(0, { row, byte })
  vim.cmd("normal! zvzz")
end
if given(marker) then
  local buffer = vim.api.nvim_get_current_buf()
  local group = vim.api.nvim_create_augroup("devhub_wait_" .. tostring((vim.uv or vim.loop).hrtime()), { clear = true })
  local function done()
    os.remove(marker)
    pcall(vim.api.nvim_del_augroup_by_id, group)
  end
  vim.api.nvim_create_autocmd({ "BufDelete", "BufWipeout", "BufUnload" }, { group = group, buffer = buffer, once = true, callback = done })
  vim.api.nvim_create_autocmd("VimLeavePre", { group = group, once = true, callback = done })
end
`;

const PANE_LUA = "return vim.env.TMUX_PANE";

/** How many Neovims a jump finds ending under it before it says so. */
const MAX_ENDED_PER_JUMP = 3;

/**
 * What the keeper pane runs: DevHub's Neovim (`Runtime.neovimProgram`),
 * headless on the socket, with the person's own config. `DEVHUB_NEOVIM_GUI=1` is there from the first line of
 * their config, so it can tell DevHub's GUI from a terminal before any UI has
 * attached (`g:devhub_gui` is set on attach, `neovimUi.ts`). A `sh` keeps the
 * pane while it runs and, after a `:restart`, while the server that
 * took over runs (`neovimRestart.ts`): the pane is the Neovim's until the
 * last of them ends.
 */
export function neovimArgv(nvim: string, socketPath: string): string[] {
	return [
		"/bin/sh",
		"-c",
		KEEPER_SH,
		"devhub-nvim",
		nvim,
		"--headless",
		"--listen",
		socketPath,
	];
}

const KEEPER_SH = `unset VIMRUNTIME VIM
state=$(mktemp -d "\${TMPDIR:-/tmp}/devhub-nvim.XXXXXX") || state=/nonexistent
for err; do :; done
err=$err.stderr
: 2>/dev/null >"$err" || err=/dev/null
DEVHUB_NEOVIM_GUI=1 ${NVIM_STATE_VARIABLE}=$state "$@" 2>"$err" &
pid=$!
wait "$pid"
status=$?
${followRestartSh()}
rm -rf "$state"
exit "$status"`;

/**
 * Tell a Neovim the theme DevHub wears, and dress it in DevHub's colorscheme.
 *
 * `g:devhub_theme` is the theme's name — what `[appearance] theme` selects —
 * with `g:devhub_theme_kind` (`dark`, `light`), `g:devhub_theme_background`
 * and the whole published value in `g:devhub_theme_info`; the `DEVHUB_*`
 * variables a new pane would get are updated in its environment, so a
 * `:terminal` or a job started from it sees them too. Then `User DevhubTheme`
 * fires with the value as its `data`.
 *
 * Then the theme is worn — **unless the person's config chose another
 * colorscheme**: with `g:colors_name` set to anything but `devhub` or the
 * colorscheme DevHub itself put on (`g:devhub_colorscheme`), nothing more is
 * done, so a `:colorscheme` of their own always wins.
 *
 * - A theme with a Neovim colorscheme of its own (`theme.neovim.colorscheme`,
 *   `model/themes/neovimPlugins.ts` or a custom theme's `neovim_colorscheme`)
 *   is worn as that: `background` from the theme, then `:colorscheme <name>`
 *   — which lazy.nvim answers by loading a `lazy = true` plugin that has it.
 *   Nothing is redone when it is already worn.
 * - Otherwise, or when `:colorscheme` cannot find it, the colorscheme
 *   generated from the theme (`theme.neovim.highlights`,
 *   `model/themes/neovimColorscheme.ts`) is applied as `devhub`, the way a
 *   colorscheme file applies itself (`highlight clear`, `background`, every
 *   group, `g:terminal_color_*`, `g:colors_name`). A colorscheme that was not
 *   found is said once per Neovim, quietly, with the plugin to install.
 *
 * Either way it ends with the `ColorScheme` event, so the person's
 * `ColorScheme` autocommands adjust it as they would any other. After `User
 * DevhubTheme`, so a plugin that recolours on that event (devhub.nvim) is
 * drawn over rather than drawing over DevHub's.
 */
export const PUBLISH_THEME_LUA = `
local theme, env = ...
vim.g.devhub_theme = theme.name
vim.g.devhub_theme_kind = theme.kind
vim.g.devhub_theme_background = theme.background
vim.g.devhub_theme_info = theme
for name, value in pairs(env) do vim.env[name] = value end
vim.api.nvim_exec_autocmds("User", { pattern = "DevhubTheme", modeline = false, data = theme })
local scheme = theme.neovim
local chosen = vim.g.colors_name
if type(scheme) ~= "table" then return end
if chosen ~= nil and chosen ~= "devhub" and chosen ~= vim.g.devhub_colorscheme then return end
local own = scheme.colorscheme
if type(own) == "string" and own ~= "" then
  if chosen == own and vim.o.background == scheme.background then return end
  -- Before it, so a colorscheme that sets its own terminal colours wins.
  for index, color in ipairs(scheme.terminal) do vim.g["terminal_color_" .. (index - 1)] = color end
  -- Unset first: setting 'background' while a colorscheme is named reloads it.
  vim.g.colors_name = nil
  vim.o.background = scheme.background
  if pcall(vim.cmd.colorscheme, own) then
    vim.g.devhub_colorscheme = own
    return
  end
  local said = vim.g.devhub_colorscheme_missing or ""
  if not said:find("|" .. own .. "|", 1, true) then
    vim.g.devhub_colorscheme_missing = said .. "|" .. own .. "|"
    local plugin = type(scheme.plugin) == "string" and scheme.plugin or "a plugin that has it"
    vim.schedule(function()
      vim.notify(string.format("DevHub: %s is meant to be worn as the colorscheme %s (%s). Install it to wear it; until then DevHub's generated colours are worn.", theme.name, own, plugin), vim.log.levels.INFO)
    end)
  end
end
vim.g.devhub_colorscheme = nil
-- Unset first: setting 'background' while a colorscheme is named reloads it.
vim.g.colors_name = nil
vim.cmd("highlight clear")
if vim.fn.exists("syntax_on") == 1 then vim.cmd("syntax reset") end
vim.o.background = scheme.background
for name, spec in pairs(scheme.highlights) do vim.api.nvim_set_hl(0, name, spec) end
for index, color in ipairs(scheme.terminal) do vim.g["terminal_color_" .. (index - 1)] = color end
vim.g.colors_name = "devhub"
vim.api.nvim_exec_autocmds("ColorScheme", { pattern = "devhub", modeline = false })
`;

function isRefused(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "ECONNREFUSED" || code === "ENOENT" || code === "ENOTSOCK";
}

/** How often a local Neovim's socket is looked for while it starts. */
const LOCAL_SOCKET_POLL_MS = 5;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ManagedNeovims {
	private readonly records = new Map<string, ServerRecord>();
	/** One jump at a time per Workspace: two must not start two Neovims. */
	private readonly queues = new Map<string, Promise<unknown>>();
	private readonly panes: EditorPanes;
	private readonly files: NeovimFiles;
	private readonly connect: (socketPath: string) => Promise<NeovimRpc>;
	private readonly startTimeoutMs: number;
	private readonly startupWaitMs: number;
	private readonly pollMs: number;
	private nextSerial = 1;
	/** The window that says a Workspace's last start failed, until the next start. */
	private readonly failurePanes = new Map<string, string>();

	constructor(private readonly options: ManagedNeovimOptions) {
		this.panes = options.panes;
		this.files = options.files ?? NODE_FILES;
		this.connect =
			options.connect ?? ((socketPath) => NeovimClient.connect(socketPath));
		this.startTimeoutMs = options.startTimeoutMs ?? 5_000;
		this.startupWaitMs = options.startupWaitMs ?? 60_000;
		this.pollMs = options.pollMs ?? 50;
	}

	socketPath(workspaceId: string): string {
		return join(this.options.socketDirectory, neovimSocketName(workspaceId));
	}

	private async sockets(
		target: WorkspaceTerminalTarget,
	): Promise<NeovimSockets> {
		if (target.machine !== "local" && this.options.remoteSockets) {
			return this.options.remoteSockets(target);
		}
		return {
			directory: this.options.socketDirectory,
			files: this.files,
			reach: (socketPath) => Promise.resolve(socketPath),
		};
	}

	/** The pane a Workspace's managed Neovim is in, while one is known. */
	paneOf(workspaceId: string): string | undefined {
		return this.records.get(workspaceId)?.paneId;
	}

	/**
	 * Until when the managed Neovim in `paneId` may still be running its
	 * config — started for a jump that it has not answered yet — or
	 * `undefined`. An overlay's attach to it waits as long as the jump does,
	 * so its "Starting Neovim…" stays until Neovim draws, with no gap.
	 */
	startupDeadline(machine: string, paneId: string): number | undefined {
		for (const record of this.records.values()) {
			if (
				record.target.machine === machine &&
				record.paneId === paneId &&
				!record.client.closed
			)
				return record.startingUntil;
		}
		return undefined;
	}

	/**
	 * A start that failed, said where Neovim would have been: a window of its
	 * own in the Workspace's session (`failureArgv`), shown, in place of the
	 * pane the failed Neovim was in. It goes with the next start.
	 */
	private async showFailure(
		target: WorkspaceTerminalTarget,
		failure: NeovimStartFailure,
	): Promise<void> {
		// Made before the old pane goes: the last window of the session
		// killed first would end the session.
		const paneId = await this.panes.open(
			target,
			failureArgv(failure.window, failure.stderrPath),
		);
		await this.panes.show(target, paneId, "");
		if (failure.paneId !== undefined)
			await this.panes.kill(target, failure.paneId).catch(() => undefined);
		const before = this.failurePanes.get(target.workspaceId);
		this.failurePanes.set(target.workspaceId, paneId);
		if (before !== undefined)
			await this.panes.kill(target, before).catch(() => undefined);
	}

	/**
	 * Tell every managed Neovim DevHub is connected to about this theme. One
	 * that refuses (an error in the person's `User DevhubTheme` handler, say)
	 * is reported and the rest are still told.
	 */
	async publishTheme(theme: PublishedTheme): Promise<void> {
		await Promise.all(
			[...this.records.entries()].map(([workspaceId, record]) =>
				this.tellTheme(workspaceId, record, theme),
			),
		);
	}

	/**
	 * Open a file in the Workspace's managed Neovim, starting one if there is
	 * none alive, and show its window. Answers whether a new Neovim was
	 * started.
	 *
	 * Its window is shown first, then the file is opened in it: whatever
	 * keeps Neovim from answering — its config still running, a prompt (a
	 * swap file's) — is in front of the person, never behind a jump that
	 * seems to have done nothing. A server that ends while the jump is at it
	 * (`:q` typed as the jump came, a crash) says so by its connection
	 * closing, and the jump starts again from what is true then: a new
	 * Neovim.
	 */
	open(
		target: WorkspaceTerminalTarget,
		file: NeovimOpen,
	): Promise<{ readonly started: boolean }> {
		return this.serially(target.workspaceId, () =>
			this.jump(target, file).catch(async (error: unknown) => {
				// Said in its window too, not only to whoever asked.
				if (error instanceof NeovimStartFailure)
					await this.showFailure(target, error).catch(() => undefined);
				throw error;
			}),
		);
	}

	private async jump(
		target: WorkspaceTerminalTarget,
		file: NeovimOpen,
	): Promise<{ readonly started: boolean }> {
		{
			for (let ended = 0; ; ended += 1) {
				const { record, started } = await this.server(target);
				try {
					await this.openIn(target, record, file, started);
					return { started };
				} catch (error) {
					if (error instanceof PaneNotRunning && !started) {
						// Found ended at the show: put away as `server` would
						// have, and the jump goes on to the next one.
						await this.retire(target, record, error.state);
						if (ended >= MAX_ENDED_PER_JUMP) throw error;
						continue;
					}
					// Only its end. A Neovim started for this jump that ends
					// is said, not started for ever; one found running may be
					// on its way out (`:q` typed as the jump came: adopted
					// from its socket while it still listens), and the next
					// one is looked for — a few times at most.
					const alive = await this.isAlive(target, record).catch(() => true);
					if (started && !alive) {
						throw new NeovimStartFailure(
							"Neovim exited as soon as it had started. Run DevHub's nvim in a terminal to see why — a configuration error is the usual reason.",
							`Neovim が起動した直後に終了しました。\n設定（init.lua など）のエラーがよくある原因です。\n\n${TRY_IN_TERMINAL(record.program)}`,
							record.paneId,
							neovimStderrPath(record.socketPath),
						);
					}
					if (started || ended >= MAX_ENDED_PER_JUMP || alive) throw error;
					// It ended under the jump: its close is handled as any is
					// (`connectionClosed`), and the jump starts again.
					record.client.close();
				}
			}
		}
	}

	private async openIn(
		target: WorkspaceTerminalTarget,
		record: ServerRecord,
		file: NeovimOpen,
		started: boolean,
	): Promise<void> {
		// One adopted whose pane could not be named is still opened in, and
		// only not brought to the front.
		if (record.paneId !== undefined) {
			const pane = await this.panes.show(
				target,
				record.paneId,
				record.socketPath,
			);
			// Its pane's state is read here, not before (`server`): one that
			// is not running is a Neovim that ended.
			if (pane !== "alive") throw new PaneNotRunning(pane);
		}
		if (file.waitMarkerPath !== undefined) {
			record.waitMarkers.add(file.waitMarkerPath);
		}
		// A Neovim started now answers once its config has run.
		const timeoutMs =
			started && record.startingUntil !== undefined
				? Math.max(1, record.startingUntil - Date.now())
				: undefined;
		try {
			// The open is sent with the mode's question, not after its answer:
			// `nvim_get_mode` is answered at once even at a prompt, and the open
			// is queued behind the prompt until the `<Esc>` that leaves it. One
			// round trip, which over SSH is one to the host.
			const opened = record.client.request(
				"nvim_exec_lua",
				[
					OPEN_FILE_LUA,
					[
						file.path,
						file.line ?? null,
						file.column ?? null,
						file.waitMarkerPath ?? null,
					],
				],
				{ timeoutMs },
			);
			// Its failure is the open's to say, below, after the prompt's.
			opened.catch(() => undefined);
			await this.leaveBlockingPrompt(record.client, timeoutMs);
			await opened;
		} catch (error) {
			if (!(error instanceof NeovimRequestTimeout) || record.client.closed)
				throw error;
			if (started) {
				// Its config never finished: it is stopped, and its window
				// says so (`showFailure`), so the next jump starts afresh.
				const seconds = String(this.startupWaitMs / 1_000);
				throw new NeovimStartFailure(
					`Neovim did not finish starting within ${seconds} seconds, and was stopped. Run DevHub's nvim in a terminal to see why.`,
					`Neovim が ${seconds} 秒たっても起動を終えなかったため、止めました。\n設定（init.lua など）が何かを待っているか、プラグインのインストールに時間がかかっている可能性があります。\n\n${TRY_IN_TERMINAL(record.program)}`,
					record.paneId,
					neovimStderrPath(record.socketPath),
				);
			}
			throw new Error(
				`Neovim is busy and did not open ${file.path}: something in its window is waiting (a prompt, say). The file opens once it is answered.`,
				{ cause: error },
			);
		} finally {
			record.startingUntil = undefined;
		}
	}

	/**
	 * The Workspace is closing: its managed Neovim goes with it — the pane
	 * killed, the socket unlinked, its wait markers deleted. Unsaved buffers
	 * were the close confirmation's to ask about (a pane running something
	 * other than the shell counts as busy work).
	 */
	close(target: WorkspaceTerminalTarget): Promise<void> {
		return this.serially(target.workspaceId, async () => {
			let record = this.records.get(target.workspaceId);
			// One DevHub has not touched since it started is still this
			// Workspace's: found the way a jump would find it.
			record ??= await this.adopt(target).catch(() => undefined);
			if (record?.paneId !== undefined) {
				await this.panes.kill(target, record.paneId).catch(() => undefined);
			}
			await this.forget(target.workspaceId, record);
			const sockets = await this.sockets(target);
			await sockets.files.remove(
				join(sockets.directory, neovimSocketName(target.workspaceId)),
			);
		});
	}

	/**
	 * DevHub is quitting: let go of every connection and kill nothing. The
	 * servers go on running in tmux, and the next DevHub adopts them.
	 */
	dispose(): void {
		const records = [...this.records.values()];
		this.records.clear();
		for (const record of records) record.client.close();
	}

	private serially<T>(workspaceId: string, work: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(workspaceId) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(work);
		const settled = next.catch(() => undefined);
		this.queues.set(workspaceId, settled);
		void settled.then(() => {
			if (this.queues.get(workspaceId) === settled) {
				this.queues.delete(workspaceId);
			}
		});
		return next;
	}

	/** The live server for a Workspace: known, adopted, or started now. */
	private async server(
		target: WorkspaceTerminalTarget,
	): Promise<{ readonly record: ServerRecord; readonly started: boolean }> {
		const known = this.records.get(target.workspaceId);
		if (known !== undefined) {
			// Its pane is not asked after here: the show that follows reads it
			// (`openIn`), and a pane that went is put away then.
			if (!known.client.closed) return { record: known, started: false };
			await this.retire(
				target,
				known,
				known.paneId === undefined ? "gone" : "dead",
			);
		}
		const adopted = await this.adopt(target);
		if (adopted !== undefined) return { record: adopted, started: false };
		return { record: await this.start(target), started: true };
	}

	/** A Neovim found ended: its pane, if one is left, and its record go. */
	private async retire(
		target: WorkspaceTerminalTarget,
		record: ServerRecord,
		pane: PaneState,
	): Promise<void> {
		if (record.paneId !== undefined && pane !== "gone") {
			// A pane left dead by `remain-on-exit` would sit in the
			// person's window list for ever.
			await this.panes.kill(target, record.paneId).catch(() => undefined);
		}
		await this.forget(target.workspaceId, record);
	}

	private async isAlive(
		target: WorkspaceTerminalTarget,
		record: ServerRecord,
	): Promise<boolean> {
		if (record.client.closed) return false;
		if (record.paneId === undefined) return true;
		const state = await this.panes.state(target, record.paneId);
		// The connection is asked again: it may have closed meanwhile.
		return state === "alive" && !record.client.closed;
	}

	/**
	 * A server already listening on the Workspace's socket — DevHub restarted
	 * under it — taken back, or nothing. A socket file with nobody behind it
	 * is unlinked here, so `start` can bind the path.
	 */
	private async adopt(
		target: WorkspaceTerminalTarget,
	): Promise<ServerRecord | undefined> {
		const sockets = await this.sockets(target);
		const socketPath = join(
			sockets.directory,
			neovimSocketName(target.workspaceId),
		);
		if (!(await sockets.files.exists(socketPath))) return undefined;
		let client: NeovimRpc;
		let localPath: string;
		try {
			localPath = await sockets.reach(socketPath);
			client = await this.connect(localPath);
		} catch (error) {
			if (!isRefused(error)) throw error;
			await sockets.files.remove(socketPath);
			return undefined;
		}
		let paneId: string | undefined;
		try {
			const answer = await client.request("nvim_exec_lua", [PANE_LUA, []]);
			paneId =
				typeof answer === "string" && answer.length > 0 ? answer : undefined;
		} catch {
			client.close();
			await sockets.files.remove(socketPath);
			return undefined;
		}
		// A server on DevHub's socket is DevHub's by construction; one whose
		// pane is not this Workspace's (its window moved to another session)
		// is still used, and only not brought to the front.
		if (
			paneId !== undefined &&
			(await this.panes.state(target, paneId)) !== "alive"
		) {
			paneId = undefined;
		}
		return this.remember(target.workspaceId, {
			target,
			socketPath,
			files: sockets.files,
			paneId,
			localPath,
			serial: this.nextSerial++,
			client,
			waitMarkers: new Set(),
			startingUntil: undefined,
		});
	}

	private async start(target: WorkspaceTerminalTarget): Promise<ServerRecord> {
		const sockets = await this.sockets(target);
		const socketPath = join(
			sockets.directory,
			neovimSocketName(target.workspaceId),
		);
		const nvim = await this.options.nvim(target).catch((error: unknown) => {
			const reason = error instanceof Error ? error.message : String(error);
			throw new NeovimStartFailure(
				reason,
				`DevHub の Neovim を起動できませんでした。\n\n${reason}\n\n上の理由を解消してから、もう一度ファイルを開いてください。`,
				undefined,
				undefined,
			);
		});
		await sockets.files.ensurePrivateDirectory(sockets.directory);
		await sockets.files.remove(socketPath);
		const stderrPath = neovimStderrPath(socketPath);
		startupTrace("managed-nvim:spawn");
		const paneId = await this.panes.open(target, neovimArgv(nvim, socketPath));
		startupTrace("managed-nvim:window-opened");
		// A window that said the last start failed goes once this one is up.
		const failed = this.failurePanes.get(target.workspaceId);
		if (failed !== undefined) {
			this.failurePanes.delete(target.workspaceId);
			await this.panes.kill(target, failed).catch(() => undefined);
		}
		const deadline = Date.now() + this.startTimeoutMs;
		// Neovim listens within a few ms of starting, before its config: a
		// local socket is looked for every `LOCAL_SOCKET_POLL_MS`, and the
		// pane (a tmux command) asked after only every `pollMs`. A host's is
		// a command on the host each time, so it waits `pollMs` between.
		const socketPollMs =
			target.machine === "local"
				? Math.min(this.pollMs, LOCAL_SOCKET_POLL_MS)
				: this.pollMs;
		let paneCheckAt = Date.now() + this.pollMs;
		for (;;) {
			if (await sockets.files.exists(socketPath)) {
				try {
					const localPath = await sockets.reach(socketPath);
					const client = await this.connect(localPath);
					startupTrace("managed-nvim:connected");
					return this.remember(target.workspaceId, {
						target,
						socketPath,
						files: sockets.files,
						paneId,
						localPath,
						serial: this.nextSerial++,
						client,
						waitMarkers: new Set(),
						startingUntil: Date.now() + this.startupWaitMs,
						program: nvim,
					});
				} catch (error) {
					if (!isRefused(error)) throw error;
				}
			}
			if (Date.now() < paneCheckAt && Date.now() < deadline) {
				await delay(socketPollMs);
				continue;
			}
			paneCheckAt = Date.now() + this.pollMs;
			if ((await this.panes.state(target, paneId)) !== "alive") {
				throw new NeovimStartFailure(
					`Neovim (${nvim}) exited before it opened its socket. Run it in a terminal to see why — a configuration error is the usual reason.`,
					`Neovim が起動の途中で終了しました（ソケットを開く前）。\n設定（init.lua など）のエラーがよくある原因です。\n\n${TRY_IN_TERMINAL(nvim)}`,
					paneId,
					stderrPath,
				);
			}
			if (Date.now() >= deadline) {
				throw new NeovimStartFailure(
					`Neovim (${nvim}) did not open its socket within ${String(this.startTimeoutMs / 1_000)} seconds, and was stopped. Run it in a terminal to see why.`,
					`Neovim が ${String(this.startTimeoutMs / 1_000)} 秒たってもソケットを開かなかったため、止めました。\n\n${TRY_IN_TERMINAL(nvim)}`,
					paneId,
					stderrPath,
				);
			}
			await delay(socketPollMs);
		}
	}

	private async tellTheme(
		workspaceId: string,
		record: ServerRecord,
		theme: PublishedTheme | undefined = this.options.theme?.(),
	): Promise<void> {
		if (theme === undefined || record.client.closed) return;
		try {
			await record.client.request("nvim_exec_lua", [
				PUBLISH_THEME_LUA,
				// The file is this Mac's; a managed Neovim is always on it.
				[theme, themeEnvironment(theme, undefined)],
			]);
		} catch (error) {
			this.options.onThemeFailure?.(workspaceId, error);
		}
	}

	private remember(workspaceId: string, record: ServerRecord): ServerRecord {
		this.records.set(workspaceId, record);
		// A Neovim started now has the theme in its environment already; one
		// adopted may have been started under another. Either is told, so
		// `g:devhub_theme` is there from the first jump.
		void this.tellTheme(workspaceId, record);
		record.client.onClose(() => {
			// The connection ended. Forgotten now, so the next jump connects
			// again rather than asking a closed one.
			if (this.records.get(workspaceId) !== record) return;
			this.records.delete(workspaceId);
			// In the jumps' queue: a jump asked meanwhile finds it gone, and
			// what it cleans up is never a newer server's.
			void this.serially(workspaceId, () =>
				this.connectionClosed(workspaceId, record),
			).catch(() => undefined);
		});
		return record;
	}

	/**
	 * A closed connection is the server ending — `:q`, its pane killed, a
	 * crash — or only the way to it: an SSH host's master went away and
	 * took the forward with it, while the Neovim went on running in the
	 * host's tmux. Only an ended server's socket is removed; a live one is
	 * left for the next attach to adopt, as it is after a DevHub restart.
	 * A pane that cannot be asked about (the host unreachable) counts as
	 * alive: removing the socket of a running Neovim orphans it.
	 */
	private async connectionClosed(
		workspaceId: string,
		record: ServerRecord,
	): Promise<void> {
		if (record.paneId !== undefined) {
			const state = await this.panes
				.state(record.target, record.paneId)
				.catch(() => "alive" as const);
			if (state === "alive") return;
			// Kept by `remain-on-exit`: a dead `devhub-nvim` window would sit
			// in the person's window list for ever, beside the next one.
			if (state === "dead") {
				await this.panes
					.kill(record.target, record.paneId)
					.catch(() => undefined);
			}
		}
		await this.cleanUp(record);
		this.options.onExit?.(workspaceId);
	}

	private async forget(
		workspaceId: string,
		record: ServerRecord | undefined,
	): Promise<void> {
		if (record === undefined) return;
		if (this.records.get(workspaceId) === record) {
			this.records.delete(workspaceId);
		}
		record.client.close();
		await this.cleanUp(record);
	}

	/**
	 * Its socket and every wait marker it held: nothing waits on a dead
	 * editor. The socket's path is the Workspace's, not the server's: once a
	 * newer server is known it is that one's, and it is left to it.
	 */
	private async cleanUp(record: ServerRecord): Promise<void> {
		const workspaceId = record.target.workspaceId;
		const newer = this.records.get(workspaceId);
		const socketIsItsOwn = newer === undefined || newer === record;
		await Promise.all([
			socketIsItsOwn
				? record.files.remove(record.socketPath).catch(() => undefined)
				: undefined,
			...[...record.waitMarkers].map((marker) =>
				this.files.remove(marker).catch(() => undefined),
			),
		]);
		record.waitMarkers.clear();
	}

	/**
	 * Neovim queues RPC requests behind a blocking prompt (hit-enter,
	 * `confirm()`); one `<Esc>` dismisses it so the open is not stuck behind
	 * it. Checked a few times, because `nvim_input` is only queued.
	 */
	private async leaveBlockingPrompt(
		client: NeovimRpc,
		timeoutMs: number | undefined,
	): Promise<void> {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const mode = (await client.request("nvim_get_mode", [], {
				timeoutMs,
			})) as { readonly blocking?: boolean } | undefined;
			if (mode?.blocking !== true) return;
			await client.request("nvim_input", ["<Esc>"]);
			await delay(this.pollMs);
		}
	}
}
