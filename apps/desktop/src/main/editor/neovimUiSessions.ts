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

import type { NeovimGuiWindowWire, NeovimPageEvent } from "../../ipc/neovim.js";
import type { NeovimRpc } from "./neovimRpc.js";
import { NeovimUi, type NeovimClipboard } from "./neovimUi.js";

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
}

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
			};
			session = fresh;
			this.sessions.set(workspaceId, fresh);
			client.onClose(() => {
				if (this.sessions.get(workspaceId) !== fresh) return;
				this.sessions.delete(workspaceId);
				this.options.output.ended(workspaceId);
			});
		}
		session.page = page;
		const known = session;
		const send = (event: NeovimPageEvent) => {
			this.options.output.toPage(known.page, event);
		};
		// The GUI windows a previous page knew are told again.
		for (const window of known.guiWindows.values()) {
			send({ type: "gui-window", workspaceId, window });
		}
		return known.ui.attach(
			{
				bufferChanged: (name) => {
					this.options.output.bufferChanged(workspaceId, name);
				},
				redraw: (batches) => {
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
			},
			target.cols,
			target.rows,
		);
	}

	/** The page a Workspace's UI draws on, while it has one. */
	pageOf(workspaceId: string): P | undefined {
		return this.sessions.get(workspaceId)?.page;
	}

	/** A call from the page, in order and unanswered. */
	call(workspaceId: string, method: string, params: readonly unknown[]): void {
		this.sessions.get(workspaceId)?.ui.call(method, params);
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
