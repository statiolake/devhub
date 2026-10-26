/**
 * The Neovim DevHub manages for each Workspace, in terminal mode.
 *
 * A file jump — a conversation's file link, `devhub <file>`, Finder's Open
 * With — needs an editor DevHub can address. In terminal mode there is no
 * workbench, so DevHub keeps one Neovim server per Workspace of its own: a
 * new tmux window in the Workspace's `ws-` session running `nvim --listen
 * <socket>`, opened on the first jump and reused while it lives. It is
 * separate from any Neovim the person runs in the same session; two of them is
 * fine. See `docs/terminal-mode.md`.
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

import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceTerminalTarget } from "../terminal/ports.js";
import { NeovimClient, type NeovimRpc } from "./neovimRpc.js";

/** What a pane DevHub started is, as tmux says it. */
export type PaneState = "alive" | "dead" | "gone";

/** The tmux half: the Workspace's `ws-` session, on its machine. */
export interface EditorPanes {
	/** Run `argv` in a new window of the Workspace's session; its pane id. */
	open(
		target: WorkspaceTerminalTarget,
		argv: readonly string[],
	): Promise<string>;
	/** Whether `paneId` is one of this Workspace's panes, and running. */
	state(target: WorkspaceTerminalTarget, paneId: string): Promise<PaneState>;
	/** Bring the pane's window and the pane to the front of its session. */
	activate(target: WorkspaceTerminalTarget, paneId: string): Promise<void>;
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

export interface ManagedNeovimOptions {
	readonly panes: EditorPanes;
	/** The `nvim` to start, resolved; rejects with the sentence to show. */
	readonly nvim: () => Promise<string>;
	/** Where the sockets go: DevHub's own, `0700`. See `socketDirectoryFor`. */
	readonly socketDirectory: string;
	readonly connect?: (socketPath: string) => Promise<NeovimRpc>;
	readonly files?: NeovimFiles;
	/** How long a new Neovim has to open its socket. */
	readonly startTimeoutMs?: number;
	/** How often the socket is tried while it starts. */
	readonly pollMs?: number;
	/** Told when a server's connection ends, for the log. */
	readonly onExit?: (workspaceId: string) => void;
}

interface ServerRecord {
	readonly socketPath: string;
	/** Absent for a server adopted whose pane could not be named. */
	readonly paneId: string | undefined;
	readonly client: NeovimRpc;
	readonly waitMarkers: Set<string>;
}

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
  local group = vim.api.nvim_create_augroup("devhub_wait_" .. tostring(vim.uv.hrtime()), { clear = true })
  local function done()
    os.remove(marker)
    pcall(vim.api.nvim_del_augroup_by_id, group)
  end
  vim.api.nvim_create_autocmd({ "BufDelete", "BufWipeout", "BufUnload" }, { group = group, buffer = buffer, once = true, callback = done })
  vim.api.nvim_create_autocmd("VimLeavePre", { group = group, once = true, callback = done })
end
`;

const PANE_LUA = "return vim.env.TMUX_PANE";

function isRefused(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "ECONNREFUSED" || code === "ENOENT" || code === "ENOTSOCK";
}

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
	private readonly pollMs: number;

	constructor(private readonly options: ManagedNeovimOptions) {
		this.panes = options.panes;
		this.files = options.files ?? NODE_FILES;
		this.connect =
			options.connect ?? ((socketPath) => NeovimClient.connect(socketPath));
		this.startTimeoutMs = options.startTimeoutMs ?? 5_000;
		this.pollMs = options.pollMs ?? 50;
	}

	socketPath(workspaceId: string): string {
		return join(this.options.socketDirectory, neovimSocketName(workspaceId));
	}

	/** The pane a Workspace's managed Neovim is in, while one is known. */
	paneOf(workspaceId: string): string | undefined {
		return this.records.get(workspaceId)?.paneId;
	}

	/**
	 * Open a file in the Workspace's managed Neovim, starting one in a new
	 * window of its session if there is none alive, and bring its pane to the
	 * front. Answers whether a new Neovim was started.
	 */
	open(
		target: WorkspaceTerminalTarget,
		file: NeovimOpen,
	): Promise<{ readonly started: boolean }> {
		return this.serially(target.workspaceId, async () => {
			const { record, started } = await this.server(target);
			if (record.paneId !== undefined) {
				await this.panes.activate(target, record.paneId);
			}
			if (file.waitMarkerPath !== undefined) {
				record.waitMarkers.add(file.waitMarkerPath);
			}
			await this.leaveBlockingPrompt(record.client);
			await record.client.request("nvim_exec_lua", [
				OPEN_FILE_LUA,
				[
					file.path,
					file.line ?? null,
					file.column ?? null,
					file.waitMarkerPath ?? null,
				],
			]);
			return { started };
		});
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
			await this.files.remove(this.socketPath(target.workspaceId));
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
			if (await this.isAlive(target, known)) {
				return { record: known, started: false };
			}
			if (known.paneId !== undefined) {
				// A pane left dead by `remain-on-exit` would sit in the
				// person's window list for ever.
				await this.panes.kill(target, known.paneId).catch(() => undefined);
			}
			await this.forget(target.workspaceId, known);
		}
		const adopted = await this.adopt(target);
		if (adopted !== undefined) return { record: adopted, started: false };
		return { record: await this.start(target), started: true };
	}

	private async isAlive(
		target: WorkspaceTerminalTarget,
		record: ServerRecord,
	): Promise<boolean> {
		if (record.client.closed) return false;
		if (record.paneId === undefined) return true;
		return (await this.panes.state(target, record.paneId)) === "alive";
	}

	/**
	 * A server already listening on the Workspace's socket — DevHub restarted
	 * under it — taken back, or nothing. A socket file with nobody behind it
	 * is unlinked here, so `start` can bind the path.
	 */
	private async adopt(
		target: WorkspaceTerminalTarget,
	): Promise<ServerRecord | undefined> {
		const socketPath = this.socketPath(target.workspaceId);
		if (!(await this.files.exists(socketPath))) return undefined;
		let client: NeovimRpc;
		try {
			client = await this.connect(socketPath);
		} catch (error) {
			if (!isRefused(error)) throw error;
			await this.files.remove(socketPath);
			return undefined;
		}
		let paneId: string | undefined;
		try {
			const answer = await client.request("nvim_exec_lua", [PANE_LUA, []]);
			paneId =
				typeof answer === "string" && answer.length > 0 ? answer : undefined;
		} catch {
			client.close();
			await this.files.remove(socketPath);
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
			socketPath,
			paneId,
			client,
			waitMarkers: new Set(),
		});
	}

	private async start(target: WorkspaceTerminalTarget): Promise<ServerRecord> {
		const socketPath = this.socketPath(target.workspaceId);
		await this.files.ensurePrivateDirectory(this.options.socketDirectory);
		await this.files.remove(socketPath);
		const nvim = await this.options.nvim();
		const paneId = await this.panes.open(target, [
			nvim,
			"--listen",
			socketPath,
		]);
		const deadline = Date.now() + this.startTimeoutMs;
		for (;;) {
			if (await this.files.exists(socketPath)) {
				try {
					const client = await this.connect(socketPath);
					return this.remember(target.workspaceId, {
						socketPath,
						paneId,
						client,
						waitMarkers: new Set(),
					});
				} catch (error) {
					if (!isRefused(error)) throw error;
				}
			}
			if ((await this.panes.state(target, paneId)) !== "alive") {
				await this.panes.kill(target, paneId).catch(() => undefined);
				throw new Error(
					`Neovim (${nvim}) exited before it opened its socket. Run it in a terminal to see why — a configuration error is the usual reason.`,
				);
			}
			if (Date.now() >= deadline) {
				throw new Error(
					`Neovim (${nvim}) did not open its socket within ${String(this.startTimeoutMs / 1_000)} seconds; it is still running in its tmux window.`,
				);
			}
			await delay(this.pollMs);
		}
	}

	private remember(workspaceId: string, record: ServerRecord): ServerRecord {
		this.records.set(workspaceId, record);
		record.client.onClose(() => {
			// The server ended — `:q`, its pane killed, a crash. Forgotten now,
			// so the next jump starts one rather than asking a dead socket.
			if (this.records.get(workspaceId) !== record) return;
			this.records.delete(workspaceId);
			void this.cleanUp(record);
			this.options.onExit?.(workspaceId);
		});
		return record;
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

	/** Its socket and every wait marker it held: nothing waits on a dead editor. */
	private async cleanUp(record: ServerRecord): Promise<void> {
		await Promise.all([
			this.files.remove(record.socketPath).catch(() => undefined),
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
	private async leaveBlockingPrompt(client: NeovimRpc): Promise<void> {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const mode = (await client.request("nvim_get_mode", [])) as
				| { readonly blocking?: boolean }
				| undefined;
			if (mode?.blocking !== true) return;
			await client.request("nvim_input", ["<Esc>"]);
			await delay(this.pollMs);
		}
	}
}
