/**
 * The terminal surface's main-process service.
 *
 * It is the only place terminal IPC is registered. Attaches and detaches
 * arrive as `ipcMain.handle` calls and are answered with a result value; the
 * control client itself runs in the pty host (`main/ptyHost/`), and what it
 * and the page say to each other passes over the page's own port to it, not
 * through here.
 *
 * Ported from the Tauri app's `terminal/mod.rs` command surface. What it does
 * *not* do is decide what a surface means: the surface key names a place in
 * DevHub's model, and the model owns the answer. This service asks for the
 * terminal target and refuses the request when there is none.
 */

import { terminalAttached } from "../shell/launchMilestones.js";
import { randomBytes } from "node:crypto";
import {
	app,
	ipcMain,
	webContents,
	type IpcMainInvokeEvent,
	type WebContents,
} from "electron";
import {
	TERMINAL_CHANNELS,
	TerminalFailure,
	validateAttachRequest,
	validateDetachRequest,
	type TerminalAttachReply,
	type TerminalResult,
} from "../../ipc/terminal.js";
import {
	AttachmentManager,
	type AttachmentManagerOptions,
} from "./attachments.js";
import type { PtyHostClient } from "../ptyHost/client.js";
import type { TerminalTarget } from "./ports.js";
import { TerminalSurfaces, terminalFailureFromPort } from "./surfaces.js";
import type { TmuxTerminalRuntime } from "./tmux.js";
import type { RuntimeId } from "../runtime/runtime.js";
import { noteMainActivity } from "../diagnostics/eventLoopLag.js";

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
	/** One tmux adapter per machine; a target says which. */
	readonly runtimeFor: (machine: RuntimeId) => Promise<TmuxTerminalRuntime>;
	readonly resolveSurface: SurfaceResolver;
	/** A client ended on its own (`AttachmentManagerOptions.onEndedByItself`). */
	readonly onEndedByItself?: AttachmentManagerOptions["onEndedByItself"];
	/** Where every client runs (`main/ptyHost/`). */
	readonly ptyHost: PtyHostClient;
}

export interface TerminalService {
	/** Detaches every client and unregisters the IPC handlers. */
	dispose(): void;
	/**
	 * "Restart Terminals" (`restart_terminals`, and the action on a terminal
	 * that could not attach): the pty host is started afresh
	 * (`PtyHostClient.restart`) and every page is told, so each surface
	 * attaches its control client again. tmux keeps the sessions.
	 */
	restart(): void;
	readonly attachmentCount: number;
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
		// The wire carries the code and summary only; why is said here.
		if (failure.cause !== undefined) {
			console.error(
				`[devhub] terminal ${failure.code}:`,
				failure.cause instanceof Error
					? (failure.cause.stack ?? failure.cause.message)
					: String(failure.cause),
			);
		}
		return { ok: false, error: failure.toWire() };
	}
	throw failure;
}

export function registerTerminalService(
	options: TerminalServiceOptions,
): TerminalService {
	const ptyHost = options.ptyHost;
	const attachments = new AttachmentManager({
		onEndedByItself: options.onEndedByItself,
		randomBytes: (count) => new Uint8Array(randomBytes(count)),
		hosted: ptyHost,
	});
	const stopHearing = ptyHost.onEnded((id, reason) =>
		attachments.hostedEnded(id, reason),
	);
	const surfaces = new TerminalSurfaces({
		runtimeFor: options.runtimeFor,
		attachments,
	});
	const watched = new Set<WebContents>();

	/**
	 * The page a request came from, and only the page.
	 *
	 * Which surface it is about is the surface key, which every request already
	 * carries: the two together are what the attachment ledger owns by. The
	 * channel id is not part of it — it addresses the client's messages to one
	 * mounted surface, and a surface that remounts gets a new one while
	 * remaining the same surface of the same page.
	 */
	const viewLabel = (event: IpcMainInvokeEvent) => String(event.sender.id);

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
		// One call: the page is the label, and every surface it held is
		// released by it. Nothing here keeps a list of mounted surfaces to
		// fall out of step with the ledger.
		const gone = () => {
			surfaces.detachView(String(sender.id));
			ptyHost.pageGone(sender);
		};
		// A page that loads again (a reload, in development) is a new page in
		// the same web contents: its old document's clients go with it, and
		// its next attach is handed a new port to the pty host.
		sender.on("did-navigate", gone);
		sender.once("destroyed", () => {
			watched.delete(sender);
			sender.off("did-navigate", gone);
			gone();
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
		): Promise<TerminalAttachReply> => {
			try {
				const id = channel(channelId);
				const request = validateAttachRequest(payload);
				const target = targetFor(request.surfaceKey);
				noteMainActivity(`terminal attach ${request.surfaceKey}`);
				const label = viewLabel(event);
				watch(event.sender);
				const receipt = await surfaces.attach({
					target,
					surfaceKey: request.surfaceKey,
					viewLabel: label,
					size: {
						cols: request.cols,
						rows: request.rows,
						pixelWidth: request.pixelWidth,
						pixelHeight: request.pixelHeight,
					},
					route: { page: event.sender, channelId: id },
				});
				terminalAttached();
				const hosted = attachments.hostedGeneration(receipt.attachmentId);
				return {
					result: ok(receipt),
					...(hosted === undefined ? {} : { hosted }),
				};
			} catch (failure: unknown) {
				return { result: refuse(terminalFailureFromPort(failure)) };
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

	const restart = () => {
		noteMainActivity("terminal restart");
		ptyHost.restart();
		for (const page of webContents.getAllWebContents()) {
			if (!page.isDestroyed()) page.send(TERMINAL_CHANNELS.revived);
		}
	};
	ipcMain.handle(TERMINAL_CHANNELS.restart, () => {
		restart();
	});

	// Quit detaches every client. The tmux sessions stay: that is the whole
	// point of the runtime, and they are what the next launch attaches to.
	const onQuit = () => surfaces.detachAll();
	app.on("will-quit", onQuit);

	return {
		surfaces,
		restart,
		get attachmentCount() {
			return surfaces.attachmentCount;
		},
		dispose() {
			surfaces.detachAll();
			stopHearing();
			app.removeListener("will-quit", onQuit);
			for (const name of [
				TERMINAL_CHANNELS.attach,
				TERMINAL_CHANNELS.detach,
				TERMINAL_CHANNELS.restart,
			]) {
				ipcMain.removeHandler(name);
			}
		},
	};
}
