/**
 * The Neovim host's work, apart from the process it runs in (`entry.ts`), so
 * it can be driven by tests with fake sockets and fake ports.
 *
 * Every Neovim editor's UI runs here once main has said which Neovim it is
 * (`ManagedNeovims`): its own connection to the socket, the msgpack decoding,
 * the attach and every redraw, sent to the page over the page's own port; the
 * page's calls and requests come back the same way. It is
 * `NeovimUiSessions`, the code main runs when there is no host. Main hears
 * that a UI ended or its buffer changed, and is asked for the clipboard.
 *
 * A page may reach only the Workspaces it attached: a call names the
 * Workspace, and the page is the one whose port it came in on.
 */

import type {
	NeovimHostToPage,
	NeovimRequestResult,
	PageToNeovimHost,
} from "../../ipc/neovim.js";
import type { NeovimRpc } from "../editor/neovimRpc.js";
import { NeovimUiSessions } from "../editor/neovimUiSessions.js";
import type { FromNeovimHost, ToNeovimHost } from "./protocol.js";

/** A page's end of its port, as this process holds it (`MessagePortMain`). */
export interface HostPort {
	postMessage(message: NeovimHostToPage): void;
	on(event: "message", listener: (event: { data: unknown }) => void): void;
	on(event: "close", listener: () => void): void;
	start(): void;
	close(): void;
}

export interface NeovimHostOptions {
	readonly post: (message: FromNeovimHost) => void;
	readonly connect: (socketPath: string) => Promise<NeovimRpc>;
}

function failureText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class NeovimHost {
	readonly #options: NeovimHostOptions;
	readonly #pages = new Map<number, HostPort>();
	readonly #clipboardReads = new Map<number, (text: string) => void>();
	#nextClipboardRead = 1;
	readonly #sessions: NeovimUiSessions<number>;

	constructor(options: NeovimHostOptions) {
		this.#options = options;
		this.#sessions = new NeovimUiSessions<number>({
			connect: options.connect,
			clipboard: {
				read: () =>
					new Promise((resolve) => {
						const rid = this.#nextClipboardRead++;
						this.#clipboardReads.set(rid, resolve);
						options.post({ type: "clipboard-read", rid });
					}),
				write: (text) => {
					options.post({ type: "clipboard-write", text });
				},
			},
			output: {
				toPage: (page, event) => {
					this.#pages.get(page)?.postMessage(event);
				},
				bufferChanged: (workspaceId, name) => {
					options.post({ type: "buffer", workspaceId, name });
				},
				ended: (workspaceId) => {
					options.post({ type: "ended", workspaceId });
				},
			},
		});
	}

	receive(message: ToNeovimHost, ports: readonly HostPort[] = []): void {
		switch (message.type) {
			case "page": {
				const port = ports[0];
				if (port === undefined) return;
				this.#addPage(message.page, port);
				return;
			}
			case "page-gone":
				this.#pageGone(message.page);
				return;
			case "attach":
				this.#sessions.attach(message.page, message.target).then(
					({ version }) => {
						this.#options.post({ type: "attached", rid: message.rid, version });
					},
					(error: unknown) => {
						this.#options.post({
							type: "attach-failed",
							rid: message.rid,
							message: failureText(error),
						});
					},
				);
				return;
			case "detach":
				this.#sessions.detach(message.workspaceId);
				return;
			case "clipboard": {
				const read = this.#clipboardReads.get(message.rid);
				this.#clipboardReads.delete(message.rid);
				read?.(message.text);
				return;
			}
		}
	}

	/** Every UI's connection let go; the process is told to go. */
	dispose(): void {
		this.#sessions.dispose();
	}

	#addPage(page: number, port: HostPort): void {
		this.#pageGone(page);
		this.#pages.set(page, port);
		port.on("message", ({ data }) => {
			if (this.#pages.get(page) === port) {
				this.#fromPage(page, port, data as PageToNeovimHost);
			}
		});
		port.on("close", () => {
			if (this.#pages.get(page) === port) this.#pages.delete(page);
		});
		port.start();
	}

	#pageGone(page: number): void {
		const port = this.#pages.get(page);
		if (port === undefined) return;
		this.#pages.delete(page);
		port.close();
	}

	#fromPage(page: number, port: HostPort, message: PageToNeovimHost): void {
		switch (message.type) {
			case "call": {
				const { workspaceId, method, params } = message.call;
				if (this.#sessions.pageOf(workspaceId) !== page) return;
				this.#sessions.call(workspaceId, method, params);
				return;
			}
			case "gui-message": {
				const { workspaceId, id, message: value } = message.message;
				if (this.#sessions.pageOf(workspaceId) !== page) return;
				this.#sessions.guiMessage(workspaceId, id, value);
				return;
			}
			case "request": {
				const { workspaceId, method, params } = message.call;
				const answer = (result: NeovimRequestResult) => {
					port.postMessage({ type: "reply", rid: message.rid, result });
				};
				if (this.#sessions.pageOf(workspaceId) !== page) {
					answer({ ok: false, message: "Neovim is not attached" });
					return;
				}
				this.#sessions.request(workspaceId, method, params).then(
					(value) => {
						answer({ ok: true, value });
					},
					(error: unknown) => {
						answer({ ok: false, message: failureText(error) });
					},
				);
				return;
			}
		}
	}
}
