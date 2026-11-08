/**
 * The pty host's work, apart from the process it runs in (`entry.ts`), so it
 * can be driven by tests with a fake PTY and fake ports.
 *
 * Every terminal client DevHub shows — a tmux client on a PTY — runs here
 * once main has resolved which session it attaches to: its output is read,
 * coalesced and framed here and sent to the page over the page's own port,
 * and the page's input, resizes and acks come back the same way. Main is on
 * none of it: it keeps the ledger of who owns which client
 * (`terminal/attachments.ts`) and hears only that a client has started or
 * ended. The data path itself is `PtyAttachment`, the code that ran in main.
 *
 * What a page may touch is decided as main decided it: a request names the
 * surface, the attachment and its generation, and the page is the one whose
 * port it came in on, so a page can only reach the clients it was given.
 */

import {
	TerminalFailure,
	encodeTerminalFrame,
	validateAckRequest,
	validateInputRequest,
	validateResizeRequest,
	type ExitReason,
	type TerminalFrame,
	type TerminalResult,
} from "../../ipc/terminal.js";
import {
	reportSpawnFailure,
	startPtyAttachment,
	type FrameSink,
	type PtyAttachment,
} from "../terminal/attachments.js";
import type { Pty, PtyFactory, PtyLaunch } from "../terminal/pty.js";
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

interface Client {
	readonly attachment: PtyAttachment;
	readonly page: number;
}

export interface PtyHostOptions {
	readonly post: (message: FromPtyHost) => void;
	readonly spawn: PtyFactory;
	/** A tmux control client's child, on pipes (`OpenSpec.control`). */
	readonly spawnPipes?: (launch: PtyLaunch) => ControlProcess;
	/** The pane engine, loaded once, at the first control client. */
	readonly loadVt?: () => Promise<LibGhosttyVt>;
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
	readonly #clients = new Map<string, Client>();
	readonly #controls = new Map<string, Control>();
	#vt: Promise<LibGhosttyVt> | undefined;

	constructor(options: PtyHostOptions) {
		this.#options = options;
	}

	get clientCount(): number {
		return this.#clients.size + this.#controls.size;
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
				if (message.spec.control === true)
					void this.#openControl(message.rid, message.spec);
				else this.#open(message.rid, message.spec);
				return;
			case "stop":
				this.#clients.get(message.id)?.attachment.stop(message.reason);
				this.#controls.get(message.id)?.client.stop();
				return;
		}
	}

	/** Every client ends; used when the process is told to go. */
	stopAll(reason: ExitReason = "detached"): void {
		for (const client of [...this.#clients.values()]) {
			client.attachment.stop(reason);
		}
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
		for (const client of [...this.#clients.values()]) {
			if (client.page === page) client.attachment.stop("detached");
		}
		for (const control of [...this.#controls.values()]) {
			if (control.page === page) control.client.stop();
		}
		entry.port.close();
	}

	#sinkFor(page: Page, channelId: string): FrameSink {
		return (frame: TerminalFrame) => {
			if (page.closed) return false;
			page.port.postMessage({
				type: "frame",
				channelId,
				attachmentId: frame.attachmentId,
				sequence: frame.sequence,
				last: frame.type === "exited" || frame.type === "error",
				frame: encodeTerminalFrame(frame),
			});
			return true;
		};
	}

	#open(rid: number, spec: OpenSpec): void {
		const page = this.#pages.get(spec.page);
		if (page === undefined || page.closed) {
			this.#options.post({
				type: "open-failed",
				rid,
				message: "the page is gone",
			});
			return;
		}
		const sink = this.#sinkFor(page, spec.channelId);
		let pty: Pty;
		try {
			pty = this.#options.spawn(spec.launch);
		} catch (failure: unknown) {
			reportSpawnFailure(sink, spec.id);
			this.#options.post({
				type: "open-failed",
				rid,
				message: failure instanceof Error ? failure.message : String(failure),
			});
			return;
		}
		let attachment: PtyAttachment;
		try {
			attachment = startPtyAttachment(
				{
					id: spec.id,
					surfaceKey: spec.surfaceKey,
					viewLabel: page.viewLabel,
					targetGeneration: spec.targetGeneration,
					size: spec.size,
				},
				pty,
				sink,
				(finished, reason) => {
					if (this.#clients.get(finished.id)?.attachment === finished) {
						this.#clients.delete(finished.id);
					}
					this.#options.post({ type: "ended", id: finished.id, reason });
				},
			);
		} catch (failure: unknown) {
			this.#options.post({
				type: "open-failed",
				rid,
				message: failure instanceof Error ? failure.message : String(failure),
			});
			return;
		}
		if (!attachment.isStopped) {
			this.#clients.set(spec.id, { attachment, page: spec.page });
		}
		this.#options.post({ type: "opened", rid });
	}

	/**
	 * A tmux control client: its child on pipes, its panes' engines, its news
	 * to the page's port. Its end is said to main as a PTY client's is.
	 */
	async #openControl(rid: number, spec: OpenSpec): Promise<void> {
		const page = this.#pages.get(spec.page);
		const fail = (message: string) =>
			this.#options.post({ type: "open-failed", rid, message });
		if (page === undefined || page.closed) return fail("the page is gone");
		const { spawnPipes, loadVt } = this.#options;
		if (spawnPipes === undefined || loadVt === undefined)
			return fail("this host runs no control clients");
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

	#owned(
		page: Page,
		request: {
			surfaceKey: string;
			attachmentId: string;
			targetGeneration: number;
		},
	): PtyAttachment {
		const client = this.#clients.get(request.attachmentId);
		const attachment = client?.attachment;
		if (
			client === undefined ||
			attachment === undefined ||
			this.#pages.get(client.page) !== page ||
			attachment.surfaceKey !== request.surfaceKey ||
			attachment.viewLabel !== page.viewLabel ||
			attachment.targetGeneration !== request.targetGeneration
		) {
			throw new TerminalFailure("wrong_attachment");
		}
		return attachment;
	}

	#fromPage(page: Page, message: PageToPtyHost): void {
		if (page.closed) return;
		let result: TerminalResult<void>;
		try {
			switch (message.type) {
				case "input": {
					const request = validateInputRequest(message.request);
					this.#owned(page, request).acceptInput(
						request.inputSequence,
						request.bytes,
					);
					break;
				}
				case "resize": {
					const request = validateResizeRequest(message.request);
					this.#owned(page, request).requestResize(request.size);
					break;
				}
				case "ack": {
					const request = validateAckRequest(message.request);
					this.#owned(page, request).acknowledge(request.sequence);
					break;
				}
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
