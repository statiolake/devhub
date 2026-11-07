/**
 * The Neovim editors: every Workspace whose editor area is its Neovim
 * (`general.editor = "neovim"`), as main holds them.
 *
 * Per Workspace: the server (`ManagedNeovims`, which starts or adopts the
 * headless Neovim on the Workspace's machine and reaches its socket), the UI
 * attached over that connection (`NeovimUi`), and the page drawing it — the
 * one that last attached, which every `redraw` is sent to. A page that
 * attaches again (a reload, Retry) takes the UI over; a server that ends is
 * said to the page, which offers to start one again.
 *
 * Nothing here knows Electron: the page is a `NeovimPage` (its `send`), and
 * the IPC that calls in is `appController.ts`'s.
 */

import type { WorkspaceTerminalTarget } from "../terminal/ports.js";
import type { ManagedNeovims, NeovimOpen } from "./managedNeovim.js";
import { NeovimUi, type NeovimClipboard } from "./neovimUi.js";
import {
	NEOVIM_CHANNELS,
	type NeovimAttachRequest,
	type NeovimAttachResult,
	type NeovimCall,
	type NeovimGuiMessage,
	type NeovimGuiWindowWire,
	type NeovimRequestResult,
} from "../../ipc/neovim.js";
import type { NeovimRpc } from "./neovimRpc.js";

/** The page drawing a Workspace's Neovim. */
export interface NeovimPage {
	send(channel: string, ...args: unknown[]): void;
	isDestroyed(): boolean;
}

export interface NeovimEditorsOptions {
	readonly neovims: ManagedNeovims;
	/** Where a Workspace's Neovim runs; throws the sentence to show when it cannot. */
	readonly target: (workspaceId: string) => WorkspaceTerminalTarget;
	readonly clipboard: NeovimClipboard;
	/** A failure to say in the log. */
	readonly log?: (line: string) => void;
}

interface Attached {
	readonly ui: NeovimUi;
	readonly client: NeovimRpc;
	page: NeovimPage;
	readonly guiWindows: Map<number, NeovimGuiWindowWire>;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class NeovimEditors {
	private readonly attached = new Map<string, Attached>();

	constructor(private readonly options: NeovimEditorsOptions) {}

	/** The page at `page` attaches as `request.workspaceId`'s UI. */
	async attach(
		page: NeovimPage,
		request: NeovimAttachRequest,
	): Promise<NeovimAttachResult> {
		try {
			const target = this.options.target(request.workspaceId);
			const { client } = await this.options.neovims.connection(target);
			let entry = this.attached.get(request.workspaceId);
			if (entry === undefined || entry.client !== client) {
				if (typeof client.notify !== "function") {
					throw new Error("the connection to Neovim cannot carry a UI");
				}
				const ui = new NeovimUi(
					client as NeovimRpc & {
						notify(method: string, params: readonly unknown[]): void;
					},
					this.options.clipboard,
				);
				entry = { ui, client, page, guiWindows: new Map() };
				this.attached.set(request.workspaceId, entry);
				const workspaceId = request.workspaceId;
				const mine = entry;
				client.onClose(() => {
					if (this.attached.get(workspaceId) !== mine) return;
					this.attached.delete(workspaceId);
					if (!mine.page.isDestroyed()) {
						mine.page.send(
							NEOVIM_CHANNELS.ended,
							workspaceId,
							"Neovim exited. Retry starts it again.",
						);
					}
				});
			}
			entry.page = page;
			const known = entry;
			const workspaceId = request.workspaceId;
			const send = (channel: string, ...args: unknown[]) => {
				if (!known.page.isDestroyed()) known.page.send(channel, ...args);
			};
			// The GUI windows a previous page knew are told again.
			for (const window of known.guiWindows.values()) {
				send(NEOVIM_CHANNELS.guiWindow, workspaceId, window);
			}
			const { version } = await known.ui.attach(
				{
					redraw: (batches) => {
						send(NEOVIM_CHANNELS.redraw, workspaceId, batches);
					},
					guiOpen: (open) => {
						const wire: NeovimGuiWindowWire = {
							id: open.id,
							win: 0,
							title: open.title,
							content:
								open.terminal === true
									? { kind: "terminal", surfaceKey: "" }
									: open.url !== undefined
										? { kind: "url", url: open.url }
										: { kind: "html", html: open.html ?? "" },
							open: true,
						};
						known.guiWindows.set(open.id, wire);
						send(NEOVIM_CHANNELS.guiWindow, workspaceId, wire);
					},
					guiClose: (id) => {
						const wire = known.guiWindows.get(id);
						known.guiWindows.delete(id);
						if (wire) {
							send(NEOVIM_CHANNELS.guiWindow, workspaceId, {
								...wire,
								open: false,
							});
						}
					},
					guiWindows: (windows, current) => {
						send(NEOVIM_CHANNELS.guiWindows, workspaceId, {
							windows,
							current,
						});
					},
					guiSend: (id, value) => {
						const out: NeovimGuiMessage = { workspaceId, id, message: value };
						send(NEOVIM_CHANNELS.guiSend, out);
					},
				},
				request.cols,
				request.rows,
			);
			return {
				ok: true,
				version,
				where: target.machine === "local" ? "" : target.machine,
			};
		} catch (error) {
			this.options.log?.(
				`[devhub] the Neovim of ${request.workspaceId} could not be attached: ${message(error)}`,
			);
			return { ok: false, message: message(error) };
		}
	}

	call(call: NeovimCall): void {
		this.attached.get(call.workspaceId)?.ui.call(call.method, call.params);
	}

	async request(call: NeovimCall): Promise<NeovimRequestResult> {
		const entry = this.attached.get(call.workspaceId);
		if (!entry) return { ok: false, message: "Neovim is not attached" };
		try {
			return {
				ok: true,
				value: await entry.ui.request(call.method, call.params),
			};
		} catch (error) {
			return { ok: false, message: message(error) };
		}
	}

	guiMessage(value: NeovimGuiMessage): void {
		this.attached
			.get(value.workspaceId)
			?.ui.guiMessage(value.id, value.message);
	}

	/** `devhub <file>` and the rest, into the Workspace's Neovim. */
	open(target: WorkspaceTerminalTarget, file: NeovimOpen): Promise<unknown> {
		return this.options.neovims.open(target, file);
	}

	/** Whether a page is attached as this Workspace's UI. */
	isAttached(workspaceId: string): boolean {
		return this.attached.has(workspaceId);
	}

	/** The Workspace is closing: its Neovim goes with it. */
	async close(target: WorkspaceTerminalTarget): Promise<void> {
		this.attached.delete(target.workspaceId);
		await this.options.neovims.close(target);
	}
}
