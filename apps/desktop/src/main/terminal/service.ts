/**
 * The terminal surface's main-process service.
 *
 * It is the only place terminal IPC is registered. Requests arrive as
 * `ipcMain.handle` calls and are answered with a result value; output frames go
 * back the one way frames go, `webContents.send` on a single channel carrying
 * the page's channel id, so a page with several mounted surfaces routes each
 * frame to the surface that asked for it.
 *
 * Ported from the Tauri app's `terminal/mod.rs` command surface. What it does
 * *not* do is decide what a surface means: the surface key names a place in
 * DevHub's model, and the model owns the answer. This service asks for the
 * terminal target and refuses the request when there is none.
 */

import { randomBytes } from "node:crypto";
import {
	app,
	ipcMain,
	type IpcMainInvokeEvent,
	type WebContents,
} from "electron";
import {
	TERMINAL_CHANNELS,
	TerminalFailure,
	encodeTerminalFrame,
	validateAckRequest,
	validateAttachRequest,
	validateDetachRequest,
	validateInputRequest,
	validateResizeRequest,
	type TerminalAttachReceipt,
	type TerminalResult,
} from "../../ipc/terminal.js";
import { AttachmentManager, type RequestIdentity } from "./attachments.js";
import { terminalEnvironment, type PtyFactory } from "./pty.js";
import type { TerminalTarget } from "./ports.js";
import { TerminalSurfaces, terminalFailureFromPort } from "./surfaces.js";
import type { TmuxTerminalRuntime } from "./tmux.js";

/**
 * What a surface key means.
 *
 * `undefined` means the key names no terminal DevHub currently has — a
 * workspace that was removed, or a stale key from a page that has not caught up.
 */
export type SurfaceResolver = (
	surfaceKey: string,
) => TerminalTarget | undefined;

export interface TerminalServiceOptions {
	readonly runtime: TmuxTerminalRuntime;
	readonly resolveSurface: SurfaceResolver;
	/** Overridden only by tests; production always opens a real PTY. */
	readonly spawn?: PtyFactory;
}

export interface TerminalService {
	/** Detaches every client and unregisters the IPC handlers. */
	dispose(): void;
	readonly attachmentCount: number;
	/** The session owner, for the app's lifecycle and settings flows. */
	readonly runtime: TmuxTerminalRuntime;
	readonly surfaces: TerminalSurfaces;
}

function ok<T>(value: T): TerminalResult<T> {
	return { ok: true, value };
}

/**
 * A refusal the contract has a code for becomes a value; anything else is a
 * defect in this process and is left to the root handler.
 */
function refuse<T>(failure: unknown): TerminalResult<T> {
	if (failure instanceof TerminalFailure) {
		return { ok: false, error: failure.toWire() };
	}
	throw failure;
}

export function registerTerminalService(
	options: TerminalServiceOptions,
): TerminalService {
	const attachments = new AttachmentManager({
		spawn: options.spawn,
		randomBytes: (count) => new Uint8Array(randomBytes(count)),
		// The client inherits the app's frozen launch environment, with the
		// terminal's own TERM and without the parent's tmux hints.
		environment: () => terminalEnvironment(options.runtime.environment),
	});
	const surfaces = new TerminalSurfaces({
		runtime: options.runtime,
		attachments,
	});
	const watched = new Set<WebContents>();

	/**
	 * The page a request came from, and only the page.
	 *
	 * Which surface it is about is the surface key, which every request already
	 * carries: the two together are what the attachment ledger owns by. The
	 * channel id is not part of it — it addresses frames back to one mounted
	 * client, and a surface that remounts gets a new one while remaining the
	 * same surface of the same page.
	 */
	const viewLabel = (event: IpcMainInvokeEvent) => String(event.sender.id);

	const identityOf = (
		event: IpcMainInvokeEvent,
		request: {
			surfaceKey: string;
			attachmentId: string;
			targetGeneration: number;
		},
	): RequestIdentity => ({
		surfaceKey: request.surfaceKey,
		attachmentId: request.attachmentId,
		targetGeneration: request.targetGeneration,
		viewLabel: viewLabel(event),
	});

	const targetFor = (surfaceKey: string): TerminalTarget => {
		const target = options.resolveSurface(surfaceKey);
		if (target === undefined) throw new TerminalFailure("surface_unavailable");
		return target;
	};

	/**
	 * A page that goes away takes its clients with it. Without this the tmux
	 * client of a closed window would keep running with nobody reading it — the
	 * session is unaffected either way.
	 */
	const watch = (sender: WebContents) => {
		if (watched.has(sender)) return;
		watched.add(sender);
		sender.once("destroyed", () => {
			watched.delete(sender);
			// One call: the page is the label, and every surface it held is
			// released by it. Nothing here keeps a list of mounted surfaces to
			// fall out of step with the ledger.
			surfaces.detachView(String(sender.id));
		});
	};

	const channel = (value: unknown): string => {
		if (typeof value !== "string" || value.length === 0) {
			throw new TerminalFailure("invalid_request");
		}
		return value;
	};

	ipcMain.handle(
		TERMINAL_CHANNELS.attach,
		async (
			event,
			channelId: unknown,
			payload: unknown,
		): Promise<TerminalResult<TerminalAttachReceipt>> => {
			try {
				const id = channel(channelId);
				const request = validateAttachRequest(payload);
				const target = targetFor(request.surfaceKey);
				const label = viewLabel(event);
				watch(event.sender);
				const sender = event.sender;
				return ok(
					await surfaces.attach({
						target,
						surfaceKey: request.surfaceKey,
						viewLabel: label,
						size: {
							cols: request.cols,
							rows: request.rows,
							pixelWidth: request.pixelWidth,
							pixelHeight: request.pixelHeight,
						},
						sink: (frame) => {
							if (sender.isDestroyed()) return false;
							sender.send(
								TERMINAL_CHANNELS.frame,
								id,
								encodeTerminalFrame(frame),
							);
							return true;
						},
					}),
				);
			} catch (failure: unknown) {
				return refuse(terminalFailureFromPort(failure));
			}
		},
	);

	ipcMain.handle(
		TERMINAL_CHANNELS.input,
		(event, channelId: unknown, payload: unknown): TerminalResult<void> => {
			try {
				channel(channelId);
				const request = validateInputRequest(payload);
				surfaces.input(
					identityOf(event, request),
					request.inputSequence,
					request.bytes,
				);
				return ok(undefined);
			} catch (failure: unknown) {
				return refuse(failure);
			}
		},
	);

	ipcMain.handle(
		TERMINAL_CHANNELS.resize,
		async (
			event,
			channelId: unknown,
			payload: unknown,
		): Promise<TerminalResult<void>> => {
			try {
				channel(channelId);
				const request = validateResizeRequest(payload);
				await surfaces.resize(
					identityOf(event, request),
					targetFor(request.surfaceKey),
					request.size,
				);
				return ok(undefined);
			} catch (failure: unknown) {
				return refuse(terminalFailureFromPort(failure));
			}
		},
	);

	ipcMain.handle(
		TERMINAL_CHANNELS.acknowledge,
		(event, channelId: unknown, payload: unknown): TerminalResult<void> => {
			try {
				channel(channelId);
				const request = validateAckRequest(payload);
				surfaces.acknowledge(identityOf(event, request), request.sequence);
				return ok(undefined);
			} catch (failure: unknown) {
				return refuse(failure);
			}
		},
	);

	ipcMain.handle(
		TERMINAL_CHANNELS.detach,
		(event, channelId: unknown, payload: unknown): TerminalResult<void> => {
			try {
				channel(channelId);
				const request = validateDetachRequest(payload);
				surfaces.detach({ ...request, viewLabel: viewLabel(event) });
				return ok(undefined);
			} catch (failure: unknown) {
				return refuse(failure);
			}
		},
	);

	// Quit detaches every client. The tmux sessions stay: that is the whole
	// point of the runtime, and they are what the next launch attaches to.
	const onQuit = () => surfaces.detachAll();
	app.on("will-quit", onQuit);

	return {
		runtime: options.runtime,
		surfaces,
		get attachmentCount() {
			return surfaces.attachmentCount;
		},
		dispose() {
			surfaces.detachAll();
			app.removeListener("will-quit", onQuit);
			for (const name of [
				TERMINAL_CHANNELS.attach,
				TERMINAL_CHANNELS.input,
				TERMINAL_CHANNELS.resize,
				TERMINAL_CHANNELS.acknowledge,
				TERMINAL_CHANNELS.detach,
			]) {
				ipcMain.removeHandler(name);
			}
		},
	};
}
