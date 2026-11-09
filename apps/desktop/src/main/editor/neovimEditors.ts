/**
 * The Neovim GUIs: every Neovim DevHub draws, as main holds them. With
 * `general.editor = "neovim"` each is a page over a terminal pane
 * (`neovim.html#tnv:<n>`, `terminalNeovims.ts`) — a `nvim` typed in a
 * terminal, or a Workspace's `devhub-nvim` window, whose Neovim is the
 * managed one (`ManagedNeovims`) files DevHub opens go to.
 *
 * The UI itself — its own connection to the Neovim's socket, the attach,
 * every redraw decoded and sent to the page — runs in the Neovim host
 * (`main/neovimHost/`), with the page over its port; main answers the
 * attach and hands the port out, and hears only that a UI ended or its
 * buffer changed, and the clipboard requests. With no host (given up on, or
 * `DEVHUB_NEOVIM_IN_MAIN=1`) the same UI code runs here
 * (`NeovimUiSessions`) and the page's calls and events are IPC. A UI that
 * ends is its overlay's end.
 *
 * Nothing here knows Electron: the page is a `NeovimPage`, and the IPC that
 * calls in is `appController.ts`'s.
 */

import type { WorkspaceTerminalTarget } from "../terminal/ports.js";
import type { ManagedNeovims, NeovimOpen } from "./managedNeovim.js";
import type { NeovimClipboard } from "./neovimUi.js";
import {
	NEOVIM_CHANNELS,
	type NeovimAttachReply,
	type NeovimAttachRequest,
	type NeovimCall,
	type NeovimGuiMessage,
	type NeovimPageEvent,
	type NeovimRequestResult,
} from "../../ipc/neovim.js";
import { NeovimClient, type NeovimRpc } from "./neovimRpc.js";
import { isOverlayKey, type TerminalNeovims } from "./terminalNeovims.js";
import { NeovimUiSessions } from "./neovimUiSessions.js";
import {
	NeovimHostRestarted,
	type NeovimHostClient,
	type NeovimHostPage,
} from "../neovimHost/client.js";

/** The page drawing a Neovim: Electron's `WebContents` in DevHub. */
export type NeovimPage = NeovimHostPage;

export interface NeovimEditorsOptions {
	readonly neovims: ManagedNeovims;
	readonly clipboard: NeovimClipboard;
	/** Where the UIs run while it is available; absent: in main. */
	readonly host?: NeovimHostClient;
	/** How main connects to a socket when the UIs are its own. */
	readonly connect?: (socketPath: string) => Promise<NeovimRpc>;
	/** A failure to say in the log. */
	readonly log?: (line: string) => void;
	/** A UI's current buffer changed (`bufferName`). */
	readonly onBuffer?: (key: string) => void;
	/**
	 * The Neovims drawn over terminal panes (`terminalNeovims.ts`): a page
	 * attaches to its pane's Neovim by the overlay's key, and its end is the
	 * overlay's.
	 */
	readonly overlays: Pick<TerminalNeovims, "connection" | "attached" | "ended">;
}

interface Attached {
	page: NeovimPage;
	/** The host generation the UI is in; absent: main's. */
	readonly hosted: number | undefined;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A page event as the IPC main sends it, for a UI of main's own. */
function sendEvent(page: NeovimPage, event: NeovimPageEvent): void {
	if (page.isDestroyed()) return;
	switch (event.type) {
		case "redraw":
			page.send(NEOVIM_CHANNELS.redraw, event.workspaceId, event.batches);
			return;
		case "gui-window":
			page.send(NEOVIM_CHANNELS.guiWindow, event.workspaceId, event.window);
			return;
		case "gui-windows":
			page.send(NEOVIM_CHANNELS.guiWindows, event.workspaceId, event.windows);
			return;
		case "gui-send":
			page.send(NEOVIM_CHANNELS.guiSend, event.message);
			return;
		case "gui-event":
			page.send(NEOVIM_CHANNELS.guiEvent, event.event);
			return;
	}
}

export class NeovimEditors {
	private readonly attached = new Map<string, Attached>();
	private readonly buffers = new Map<string, string>();
	/** The pages whose end lets go of their UIs (`release`). */
	private readonly watched = new WeakSet<NeovimPage>();
	/** The UIs main runs itself: no host, or one given up on. */
	private readonly local: NeovimUiSessions<NeovimPage>;

	constructor(private readonly options: NeovimEditorsOptions) {
		const bufferChanged = (workspaceId: string, name: string) => {
			this.buffers.set(workspaceId, name);
			this.options.onBuffer?.(workspaceId);
		};
		this.local = new NeovimUiSessions<NeovimPage>({
			connect:
				options.connect ?? ((socketPath) => NeovimClient.connect(socketPath)),
			clipboard: options.clipboard,
			output: {
				toPage: sendEvent,
				bufferChanged,
				ended: (workspaceId) => {
					this.endedBy(workspaceId, undefined);
				},
			},
		});
		options.host?.listen({
			bufferChanged,
			ended: (workspaceId, generation) => {
				this.endedBy(workspaceId, generation);
			},
			lost: (generation) => {
				for (const [workspaceId, entry] of [...this.attached]) {
					if (entry.hosted !== generation) continue;
					this.attached.delete(workspaceId);
					if (entry.page.isDestroyed()) continue;
					entry.page.send(
						NEOVIM_CHANNELS.ended,
						workspaceId,
						"DevHub's connection to Neovim restarted. Reconnecting…",
						true,
					);
				}
			},
		});
	}

	/** A UI's connection ended by itself, where it ran: its overlay goes. */
	private endedBy(key: string, hosted: number | undefined): void {
		const entry = this.attached.get(key);
		if (entry === undefined || entry.hosted !== hosted) return;
		this.attached.delete(key);
		this.buffers.delete(key);
		this.options.overlays.ended(key);
	}

	/**
	 * The page at `page` attaches as the UI of the overlay its id names
	 * (`request.workspaceId`, `tnv:<n>`). Any other id is refused: there is
	 * no Neovim page but an overlay's.
	 */
	async attach(
		page: NeovimPage,
		request: NeovimAttachRequest,
	): Promise<NeovimAttachReply> {
		const overlays = this.options.overlays;
		if (!isOverlayKey(request.workspaceId)) {
			return { ok: false, message: "That Neovim is not DevHub's to draw." };
		}
		if (!this.watched.has(page)) {
			this.watched.add(page);
			page.once("destroyed", () => {
				this.release(page);
			});
			// A page that loads again (a reload) is a new document in the same
			// web contents, which attaches again: its old UI goes, and so does
			// its port to the host, which died with the old document — kept,
			// the host's redraws would go to nobody and the page stay blank.
			page.on("did-navigate", () => {
				this.release(page);
				this.options.host?.pageGone(page);
			});
		}
		const reply = await this.attachTo(page, request);
		// The page went while it attached: what attached is nobody's.
		if (reply.ok && page.isDestroyed()) {
			const key = request.workspaceId;
			if (this.attached.get(key)?.page === page) this.attached.delete(key);
			this.letGo(key, reply.hosted);
			return { ok: false, message: "The Neovim page has gone." };
		}
		if (reply.ok) overlays.attached(request.workspaceId);
		else overlays.ended(request.workspaceId);
		return reply;
	}

	/**
	 * A page has gone (its overlay ended, its terminal closed): its UI is let
	 * go of with it. Neovim draws every UI at the smallest one's size, so a
	 * UI left attached without a page would hold the Neovim at whatever size
	 * that page last had — the next page over the pane could never grow it.
	 * The Neovim itself runs on; its end is said by its pane, not here.
	 */
	private release(page: NeovimPage): void {
		for (const [key, entry] of [...this.attached]) {
			if (entry.page !== page) continue;
			this.attached.delete(key);
			this.letGo(key, entry.hosted);
		}
	}

	private letGo(key: string, hosted: number | undefined): void {
		this.buffers.delete(key);
		if (hosted === undefined) this.local.detach(key);
		else this.options.host?.detach(key);
	}

	private async attachTo(
		page: NeovimPage,
		request: NeovimAttachRequest,
	): Promise<NeovimAttachReply> {
		try {
			const workspaceId = request.workspaceId;
			const { socketPath, server, machine } =
				await this.options.overlays.connection(workspaceId);
			const ui = {
				workspaceId,
				socketPath,
				server,
				cols: request.cols,
				rows: request.rows,
			};
			const where = machine === "local" ? "" : machine;
			const host = this.options.host;
			// A host that ends during the attach is replaced, and the attach
			// goes to the next one; a host given up on leaves it to main.
			while (host?.available === true) {
				const previous = this.attached.get(workspaceId);
				if (previous !== undefined && previous.hosted === undefined) {
					this.local.detach(workspaceId);
				}
				try {
					const { version, generation } = await host.attach(page, ui);
					this.attached.set(workspaceId, { page, hosted: generation });
					return { ok: true, version, where, hosted: generation };
				} catch (error) {
					if (!(error instanceof NeovimHostRestarted)) throw error;
				}
			}
			const previous = this.attached.get(workspaceId);
			if (previous?.hosted !== undefined) host?.detach(workspaceId);
			// Known before the attach: a connection can end while it runs.
			this.attached.set(workspaceId, { page, hosted: undefined });
			const { version } = await this.local.attach(page, ui);
			return { ok: true, version, where };
		} catch (error) {
			this.options.log?.(
				`[devhub] the Neovim of ${request.workspaceId} could not be attached: ${message(error)}`,
			);
			return { ok: false, message: message(error) };
		}
	}

	/** A call from a page whose UI is main's (a hosted one's go on its port). */
	call(call: NeovimCall): void {
		this.local.call(call.workspaceId, call.method, call.params);
	}

	async request(call: NeovimCall): Promise<NeovimRequestResult> {
		try {
			return {
				ok: true,
				value: await this.local.request(
					call.workspaceId,
					call.method,
					call.params,
				),
			};
		} catch (error) {
			return { ok: false, message: message(error) };
		}
	}

	guiMessage(value: NeovimGuiMessage): void {
		this.local.guiMessage(value.workspaceId, value.id, value.message);
	}

	/** `devhub <file>` and the rest, into the Workspace's Neovim. */
	open(target: WorkspaceTerminalTarget, file: NeovimOpen): Promise<unknown> {
		return this.options.neovims.open(target, file);
	}

	/** The file a UI's Neovim is in (by its overlay's key), for the window title. */
	bufferName(key: string): string | undefined {
		const name = this.buffers.get(key);
		return name === undefined || name === "" ? undefined : name;
	}

	/**
	 * The Workspace is closing: its managed Neovim goes with it (its
	 * overlay's UI ends with the connection).
	 */
	async close(target: WorkspaceTerminalTarget): Promise<void> {
		await this.options.neovims.close(target);
	}

	/** Quit: every UI's connection let go; the Neovims run on in tmux. */
	dispose(): void {
		this.attached.clear();
		this.local.dispose();
	}
}
