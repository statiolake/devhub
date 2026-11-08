/**
 * The Neovim editors: every Workspace whose editor area is its Neovim
 * (`general.editor = "neovim"`), as main holds them.
 *
 * Per Workspace: the server (`ManagedNeovims`, which starts or adopts the
 * headless Neovim on the Workspace's machine and reaches its socket), and
 * the page drawing it. The UI itself — its own connection to that socket,
 * the attach, every redraw decoded and sent to the page — runs in the Neovim
 * host (`main/neovimHost/`), with the page over its port; main answers the
 * attach and hands the port out, and hears only that a UI ended or its
 * buffer changed, and the clipboard requests. With no host (given up on, or
 * `DEVHUB_NEOVIM_IN_MAIN=1`) the same UI code runs here
 * (`NeovimUiSessions`) and the page's calls and events are IPC.
 *
 * A server that ends is said to the page, which offers to start one again; a
 * connection to an SSH host that drops, or a host that ends, is said with
 * `reconnect`, and the page attaches again by itself.
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
import { NeovimUiSessions } from "./neovimUiSessions.js";
import {
	NeovimHostRestarted,
	type NeovimHostClient,
	type NeovimHostPage,
} from "../neovimHost/client.js";

/** The page drawing a Workspace's Neovim: Electron's `WebContents` in DevHub. */
export type NeovimPage = NeovimHostPage;

export interface NeovimEditorsOptions {
	readonly neovims: ManagedNeovims;
	/** Where a Workspace's Neovim runs; throws the sentence to show when it cannot. */
	readonly target: (workspaceId: string) => WorkspaceTerminalTarget;
	readonly clipboard: NeovimClipboard;
	/** Where the UIs run while it is available; absent: in main. */
	readonly host?: NeovimHostClient;
	/** How main connects to a socket when the UIs are its own. */
	readonly connect?: (socketPath: string) => Promise<NeovimRpc>;
	/** A failure to say in the log. */
	readonly log?: (line: string) => void;
	/** A Workspace's current buffer changed (`bufferName`). */
	readonly onBuffer?: (workspaceId: string) => void;
}

interface Attached {
	page: NeovimPage;
	readonly target: WorkspaceTerminalTarget;
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

	/** A UI's connection ended by itself, where it ran. */
	private endedBy(workspaceId: string, hosted: number | undefined): void {
		const entry = this.attached.get(workspaceId);
		if (entry === undefined || entry.hosted !== hosted) return;
		this.attached.delete(workspaceId);
		void this.ended(entry.target, entry);
	}

	/**
	 * Tell the page its connection ended: Neovim exited, or — on an SSH host
	 * whose connection dropped — only the way to it went, and the page
	 * attaches again by itself to the Neovim that went on running.
	 */
	private async ended(
		target: WorkspaceTerminalTarget,
		entry: { readonly page: NeovimPage },
	): Promise<void> {
		const remote = target.machine !== "local";
		// A `:qa` closes the connection a moment before its pane goes.
		if (remote) await new Promise((resolve) => setTimeout(resolve, 500));
		const reconnect =
			remote &&
			(await this.options.neovims.stillRunning(target).catch(() => true));
		if (entry.page.isDestroyed()) return;
		const host = target.machine.replace(/^ssh:/, "");
		entry.page.send(
			NEOVIM_CHANNELS.ended,
			target.workspaceId,
			reconnect
				? `The connection to ${host} dropped. Reconnecting to the Neovim that is still running there…`
				: "Neovim exited. Retry starts it again.",
			reconnect,
		);
	}

	/** The page at `page` attaches as `request.workspaceId`'s UI. */
	async attach(
		page: NeovimPage,
		request: NeovimAttachRequest,
	): Promise<NeovimAttachReply> {
		try {
			const target = this.options.target(request.workspaceId);
			const workspaceId = request.workspaceId;
			const { socketPath, server } =
				await this.options.neovims.connection(target);
			const ui = {
				workspaceId,
				socketPath,
				server,
				cols: request.cols,
				rows: request.rows,
			};
			const where = target.machine === "local" ? "" : target.machine;
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
					this.attached.set(workspaceId, {
						page,
						target,
						hosted: generation,
					});
					return { ok: true, version, where, hosted: generation };
				} catch (error) {
					if (!(error instanceof NeovimHostRestarted)) throw error;
				}
			}
			const previous = this.attached.get(workspaceId);
			if (previous?.hosted !== undefined) host?.detach(workspaceId);
			// Known before the attach: a connection can end while it runs.
			this.attached.set(workspaceId, { page, target, hosted: undefined });
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

	/** The file the Workspace's Neovim is in, for the window title. */
	bufferName(workspaceId: string): string | undefined {
		const name = this.buffers.get(workspaceId);
		return name === undefined || name === "" ? undefined : name;
	}

	/** The Workspace is closing: its Neovim goes with it. */
	async close(target: WorkspaceTerminalTarget): Promise<void> {
		const entry = this.attached.get(target.workspaceId);
		this.attached.delete(target.workspaceId);
		if (entry?.hosted !== undefined) {
			this.options.host?.detach(target.workspaceId);
		} else {
			this.local.detach(target.workspaceId);
		}
		await this.options.neovims.close(target);
	}

	/** Quit: every UI's connection let go; the Neovims run on in tmux. */
	dispose(): void {
		this.attached.clear();
		this.local.dispose();
	}
}
