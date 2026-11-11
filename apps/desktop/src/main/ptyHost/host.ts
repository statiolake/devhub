/**
 * The pty host's work, apart from the process it runs in (`entry.ts`), so it
 * can be driven by tests with fake children and fake ports.
 *
 * Every terminal client DevHub shows — a tmux control client on pipes, its
 * panes' engines, its popups' PTYs — runs here once main has resolved which
 * session it attaches to: its news goes to the page over the page's own port,
 * and the page's requests come back the same way. Main is on none of it: it
 * keeps the ledger of who owns which client (`terminal/attachments.ts`) and
 * hears only that a client has started or ended.
 *
 * What a page may touch is decided as main decided it: a request names the
 * surface, the attachment and its generation, and the page is the one whose
 * port it came in on, so a page can only reach the clients it was given.
 */

import { TerminalFailure, type TerminalResult } from "../../ipc/terminal.js";
import type { PtyFactory, PtyLaunch } from "../terminal/pty.js";
import {
	validateControlRequest,
	type ControlRequest,
} from "../../ipc/terminalControl.js";
import { ControlClient, type ControlProcess } from "./control/controlClient.js";
import type { LibGhosttyVt } from "./vt/libghosttyVt.js";
import type {
	FromPtyHost,
	OpenSpec,
	PageToPtyHost,
	PtyHostToPage,
	ToPtyHost,
} from "./protocol.js";

/** A page's end of its port, as this process holds it (`MessagePortMain`). */
export interface HostPort {
	postMessage(message: PtyHostToPage): void;
	on(event: "message", listener: (event: { data: unknown }) => void): void;
	on(event: "close", listener: () => void): void;
	start(): void;
	close(): void;
}

interface Page {
	readonly port: HostPort;
	readonly viewLabel: string;
	closed: boolean;
}

export interface PtyHostOptions {
	readonly post: (message: FromPtyHost) => void;
	/** A popup's PTY (`control/popup.ts`). */
	readonly spawn: PtyFactory;
	/** A tmux control client's child, on pipes. */
	readonly spawnPipes: (launch: PtyLaunch) => ControlProcess;
	/** The pane engine, loaded once, at the first control client. */
	readonly loadVt: () => Promise<LibGhosttyVt>;
}

interface Control {
	readonly client: ControlClient;
	readonly page: number;
	readonly surfaceKey: string;
	readonly viewLabel: string;
	readonly targetGeneration: number;
}

function failureOf(failure: unknown): TerminalResult<void> {
	const wire =
		failure instanceof TerminalFailure
			? failure.toWire()
			: new TerminalFailure("internal").toWire();
	return { ok: false, error: wire };
}

export class PtyHost {
	readonly #options: PtyHostOptions;
	readonly #pages = new Map<number, Page>();
	readonly #controls = new Map<string, Control>();
	#vt: Promise<LibGhosttyVt> | undefined;

	constructor(options: PtyHostOptions) {
		this.#options = options;
	}

	get clientCount(): number {
		return this.#controls.size;
	}

	receive(message: ToPtyHost, ports: readonly HostPort[] = []): void {
		switch (message.type) {
			case "page": {
				const port = ports[0];
				if (port === undefined) return;
				this.#addPage(message.page, message.viewLabel, port);
				return;
			}
			case "page-gone":
				this.#pageGone(message.page);
				return;
			case "open":
				void this.#openControl(message.rid, message.spec);
				return;
			case "stop":
				this.#controls.get(message.id)?.client.stop();
				return;
		}
	}

	/** Every client ends; used when the process is told to go. */
	stopAll(): void {
		for (const control of [...this.#controls.values()]) control.client.stop();
	}

	#addPage(page: number, viewLabel: string, port: HostPort): void {
		this.#pageGone(page);
		const entry: Page = { port, viewLabel, closed: false };
		this.#pages.set(page, entry);
		port.on("message", ({ data }) => {
			this.#fromPage(entry, data as PageToPtyHost);
		});
		port.on("close", () => {
			if (this.#pages.get(page) === entry) this.#pageGone(page);
		});
		port.start();
	}

	/** A page that is gone takes its clients with it, as a closed view did in main. */
	#pageGone(page: number): void {
		const entry = this.#pages.get(page);
		if (entry === undefined) return;
		this.#pages.delete(page);
		entry.closed = true;
		for (const control of [...this.#controls.values()]) {
			if (control.page === page) control.client.stop();
		}
		entry.port.close();
	}

	/**
	 * A tmux control client: its child on pipes, its panes' engines, its news
	 * to the page's port. Its end is said to main.
	 */
	async #openControl(rid: number, spec: OpenSpec): Promise<void> {
		const page = this.#pages.get(spec.page);
		const fail = (message: string) =>
			this.#options.post({ type: "open-failed", rid, message });
		if (page === undefined || page.closed) return fail("the page is gone");
		const { spawnPipes, loadVt } = this.#options;
		let vt: LibGhosttyVt;
		try {
			this.#vt ??= loadVt();
			vt = await this.#vt;
		} catch (failure: unknown) {
			this.#vt = undefined;
			return fail(failure instanceof Error ? failure.message : String(failure));
		}
		if (page.closed) return fail("the page is gone");
		let child: ControlProcess;
		try {
			child = spawnPipes(spec.launch);
		} catch (failure: unknown) {
			return fail(failure instanceof Error ? failure.message : String(failure));
		}
		const popupLaunch = spec.popupLaunch;
		const client = new ControlClient({
			process: child,
			vt,
			...(popupLaunch === undefined
				? {}
				: {
						popup: (cols: number, rows: number) =>
							this.#options.spawn({
								...popupLaunch,
								cols,
								rows,
								pixelWidth: 0,
								pixelHeight: 0,
							}),
					}),
			cols: spec.size.cols,
			rows: spec.size.rows,
			socket: (pane, socket, cols, rows) => {
				this.#options.post({
					type: "nvim-socket",
					surfaceKey: spec.surfaceKey,
					page: spec.page,
					pane,
					socket,
					cols,
					rows,
				});
			},
			post: (message) => {
				if (page.closed) return;
				page.port.postMessage({
					type: "control",
					channelId: spec.channelId,
					attachmentId: spec.id,
					last: message.kind === "ended",
					message,
				});
			},
			ended: (reason) => {
				if (this.#controls.get(spec.id)?.client !== client) return;
				this.#controls.delete(spec.id);
				this.#options.post({
					type: "ended",
					id: spec.id,
					reason: reason === "detached" ? "detached" : "eof",
				});
			},
		});
		this.#controls.set(spec.id, {
			client,
			page: spec.page,
			surfaceKey: spec.surfaceKey,
			viewLabel: page.viewLabel,
			targetGeneration: spec.targetGeneration,
		});
		this.#options.post({ type: "opened", rid });
	}

	#ownedControl(page: Page, request: ControlRequest): ControlClient {
		const control = this.#controls.get(request.attachmentId);
		if (
			control === undefined ||
			this.#pages.get(control.page) !== page ||
			control.surfaceKey !== request.surfaceKey ||
			control.viewLabel !== page.viewLabel ||
			control.targetGeneration !== request.targetGeneration
		) {
			throw new TerminalFailure("wrong_attachment");
		}
		return control.client;
	}

	#fromPage(page: Page, message: PageToPtyHost): void {
		if (page.closed) return;
		let result: TerminalResult<void>;
		try {
			switch (message.type) {
				case "control": {
					const request = validateControlRequest(message.request);
					this.#ownedControl(page, request).receive(request.message);
					break;
				}
				default:
					throw new TerminalFailure("invalid_request");
			}
			result = { ok: true, value: undefined };
		} catch (failure: unknown) {
			result = failureOf(failure);
		}
		page.port.postMessage({ type: "reply", rid: message.rid, result });
	}
}
