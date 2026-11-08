/**
 * The Neovim editors' UIs: per Workspace, a connection of its own to the
 * Neovim's socket, DevHub attached over it as the UI (`NeovimUi`), and the
 * page drawing it — the one that last attached, which every `redraw` goes to.
 *
 * This runs in the Neovim host (`main/neovimHost/`), or in main once the
 * host has been given up on; it is the same code in both. Which Neovim and
 * which socket are main's to say (`ManagedNeovims`, which keeps a connection
 * of its own to each server for its lifecycle and the file jumps): this is
 * only the UI's side, and the hot path — every redraw decoded here and sent
 * to the page.
 *
 * A page that attaches again (a reload, Retry, a reconnect) takes the UI
 * over; a connection that ends by itself is said (`ended`), and main decides
 * what the page is told. Nothing here knows Electron: a page is whatever the
 * caller says it is, and what it hears goes through `output`.
 */

import {
	NEOVIM_RESTARTED_EVENT,
	type NeovimGuiWindowWire,
	type NeovimPageEvent,
} from "../../ipc/neovim.js";
import type { NeovimRpc } from "./neovimRpc.js";
import {
	NeovimUi,
	type NeovimClipboard,
	type NeovimUiSink,
} from "./neovimUi.js";

export interface NeovimUiOutput<P> {
	/** What the page hears; a page that has gone is the output's to drop. */
	toPage(page: P, event: NeovimPageEvent): void;
	/** The current buffer's file name changed (`""` for none). */
	bufferChanged(workspaceId: string, name: string): void;
	/** The UI's connection ended by itself: Neovim exited, or the way to it went. */
	ended(workspaceId: string): void;
}

export interface NeovimUiSessionsOptions<P> {
	readonly connect: (socketPath: string) => Promise<NeovimRpc>;
	readonly clipboard: NeovimClipboard;
	readonly output: NeovimUiOutput<P>;
}

/** Which Neovim to attach to, as main resolved it. */
export interface NeovimUiTarget {
	readonly workspaceId: string;
	/** A socket on this machine: the server's, or the forward of a host's. */
	readonly socketPath: string;
	/** Which server that is (`ManagedNeovims`): a new one is a new connection. */
	readonly server: number;
	readonly cols: number;
	readonly rows: number;
}

interface Session<P> {
	readonly server: number;
	readonly socketPath: string;
	readonly client: NeovimRpc;
	readonly ui: NeovimUi;
	page: P;
	readonly guiWindows: Map<number, NeovimGuiWindowWire>;
	/** The grid's size, as attached and as the page last resized it. */
	cols: number;
	rows: number;
	/** Neovim said `restart` (`:restart`, 0.12): its close is not an end. */
	restarting: boolean;
}

/**
 * How long a `:restart`'s new server is waited for on the old one's socket,
 * and how often it is tried: it is started before the old one exits, and
 * listens once its own startup has got that far.
 */
const RESTART_WAIT_MS = 10_000;
const RESTART_POLL_MS = 100;

type Notifying = NeovimRpc & {
	notify(method: string, params: readonly unknown[]): void;
};

export class NeovimUiSessions<P> {
	private readonly sessions = new Map<string, Session<P>>();

	constructor(private readonly options: NeovimUiSessionsOptions<P>) {}

	/** The page at `page` attaches as `target.workspaceId`'s UI. */
	async attach(
		page: P,
		target: NeovimUiTarget,
	): Promise<{ readonly version: string }> {
		const workspaceId = target.workspaceId;
		let session = this.sessions.get(workspaceId);
		if (
			session !== undefined &&
			(session.client.closed ||
				session.server !== target.server ||
				session.socketPath !== target.socketPath)
		) {
			this.detach(workspaceId);
			session = undefined;
		}
		if (session === undefined) {
			const client = await this.options.connect(target.socketPath);
			session = this.open(workspaceId, client, page, target);
		}
		session.page = page;
		session.cols = target.cols;
		session.rows = target.rows;
		// The GUI windows a previous page knew are told again.
		for (const window of session.guiWindows.values()) {
			this.toPage(session, { type: "gui-window", workspaceId, window });
		}
		return session.ui.attach(
			this.sinkOf(workspaceId, session),
			target.cols,
			target.rows,
		);
	}

	/** A session on a new connection, which says when it ends. */
	private open(
		workspaceId: string,
		client: NeovimRpc,
		page: P,
		target: Pick<NeovimUiTarget, "server" | "socketPath" | "cols" | "rows">,
	): Session<P> {
		if (typeof client.notify !== "function") {
			client.close();
			throw new Error("the connection to Neovim cannot carry a UI");
		}
		const fresh: Session<P> = {
			server: target.server,
			socketPath: target.socketPath,
			client,
			ui: new NeovimUi(client as Notifying, this.options.clipboard),
			page,
			guiWindows: new Map(),
			cols: target.cols,
			rows: target.rows,
			restarting: false,
		};
		this.sessions.set(workspaceId, fresh);
		client.onClose(() => {
			if (this.sessions.get(workspaceId) !== fresh) return;
			if (fresh.restarting) {
				void this.followRestart(workspaceId, fresh);
				return;
			}
			this.sessions.delete(workspaceId);
			this.options.output.ended(workspaceId);
		});
		return fresh;
	}

	/**
	 * `:restart` (Neovim 0.12): the server started a new one with the same
	 * arguments — the same `--listen` socket — told its UIs `restart`, and
	 * exited. The UI attaches to the new one on the same socket (which an
	 * SSH host's forward reaches as it reached the old), with the same page
	 * and at the page's size: the page forgets the old screen where the new
	 * one starts (`NEOVIM_RESTARTED_EVENT`), so it goes from the old frame
	 * to the new without a blank one, and nothing else hears of it — the
	 * overlay stays over its pane, with the keys. Only when nothing answers
	 * there in `RESTART_WAIT_MS` is it an end.
	 */
	private async followRestart(
		workspaceId: string,
		old: Session<P>,
	): Promise<void> {
		const deadline = Date.now() + RESTART_WAIT_MS;
		let client: NeovimRpc | undefined;
		while (client === undefined && Date.now() < deadline) {
			client = await this.options
				.connect(old.socketPath)
				.catch(() => undefined);
			if (client === undefined) await delay(RESTART_POLL_MS);
			if (this.sessions.get(workspaceId) !== old) {
				client?.close();
				return;
			}
		}
		if (client === undefined) {
			this.sessions.delete(workspaceId);
			this.options.output.ended(workspaceId);
			return;
		}
		const session = this.open(workspaceId, client, old.page, old);
		// The old server's GUI windows went with it.
		for (const window of old.guiWindows.values()) {
			this.toPage(session, {
				type: "gui-window",
				workspaceId,
				window: { ...window, open: false },
			});
		}
		this.toPage(session, {
			type: "redraw",
			workspaceId,
			batches: [[NEOVIM_RESTARTED_EVENT, []]],
		});
		await session.ui
			.attach(this.sinkOf(workspaceId, session), old.cols, old.rows)
			.catch(() => {
				// It went again before the attach finished: its close says so.
				session.client.close();
			});
	}

	private toPage(session: Session<P>, event: NeovimPageEvent): void {
		this.options.output.toPage(session.page, event);
	}

	/** What a session's Neovim draws and says, to its page. */
	private sinkOf(workspaceId: string, known: Session<P>): NeovimUiSink {
		const send = (event: NeovimPageEvent) => {
			this.toPage(known, event);
		};
		return {
			bufferChanged: (name) => {
				this.options.output.bufferChanged(workspaceId, name);
			},
			redraw: (batches) => {
				if (batches.some(isRestart)) known.restarting = true;
				send({ type: "redraw", workspaceId, batches });
			},
			guiOpen: (open) => {
				const window: NeovimGuiWindowWire = {
					id: open.id,
					win: 0,
					title: open.title,
					content:
						open.url !== undefined
							? { kind: "url", url: open.url }
							: { kind: "html", html: open.html ?? "" },
					open: true,
				};
				known.guiWindows.set(open.id, window);
				send({ type: "gui-window", workspaceId, window });
			},
			guiClose: (id) => {
				const window = known.guiWindows.get(id);
				known.guiWindows.delete(id);
				if (window) {
					send({
						type: "gui-window",
						workspaceId,
						window: { ...window, open: false },
					});
				}
			},
			guiWindows: (windows, current, layout) => {
				send({
					type: "gui-windows",
					workspaceId,
					windows: { windows, current, layout },
				});
			},
			guiEvent: (kind, payload) => {
				send({ type: "gui-event", event: { workspaceId, kind, payload } });
			},
			guiSend: (id, message) => {
				send({ type: "gui-send", message: { workspaceId, id, message } });
			},
		};
	}

	/** The page a Workspace's UI draws on, while it has one. */
	pageOf(workspaceId: string): P | undefined {
		return this.sessions.get(workspaceId)?.page;
	}

	/** A call from the page, in order and unanswered. */
	call(workspaceId: string, method: string, params: readonly unknown[]): void {
		const session = this.sessions.get(workspaceId);
		if (session === undefined) return;
		if (
			method === "nvim_ui_try_resize" &&
			typeof params[0] === "number" &&
			typeof params[1] === "number"
		) {
			session.cols = params[0];
			session.rows = params[1];
		}
		session.ui.call(method, params);
	}

	request(
		workspaceId: string,
		method: string,
		params: readonly unknown[],
	): Promise<unknown> {
		const session = this.sessions.get(workspaceId);
		if (!session) return Promise.reject(new Error("Neovim is not attached"));
		return session.ui.request(method, params);
	}

	guiMessage(workspaceId: string, id: number, message: unknown): void {
		this.sessions.get(workspaceId)?.ui.guiMessage(id, message);
	}

	/** Let go of a Workspace's UI without saying so: it is closing. */
	detach(workspaceId: string): void {
		const session = this.sessions.get(workspaceId);
		if (session === undefined) return;
		this.sessions.delete(workspaceId);
		session.client.close();
	}

	/** Every UI's connection closed, nothing said: quit, or the host going. */
	dispose(): void {
		for (const workspaceId of [...this.sessions.keys()]) {
			this.detach(workspaceId);
		}
	}
}

/** Neovim's `restart` UI event (`:restart`, 0.12) in a redraw's batches. */
function isRestart(batch: unknown): boolean {
	return Array.isArray(batch) && batch[0] === "restart";
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
