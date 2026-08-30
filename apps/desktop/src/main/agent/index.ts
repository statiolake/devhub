/**
 * The Agent Surface's main-process entry point.
 *
 * This is the only file in the adapter that knows about Electron. It binds the
 * five requests on `AGENT_CHANNELS` to `AgentSurfaceManager` and pushes frames
 * back to the requesting page's `webContents`. Every failure is thrown across
 * IPC as a `TerminalError` body — nothing here turns a failure into a default.
 *
 * The `viewLabel` the manager keys attachments by is the page's `webContents`
 * id: one App Shell page owns at most one live agent attachment, exactly as
 * the Tauri webview label did.
 */

import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";

import {
	AGENT_CHANNELS,
	TerminalError,
	TerminalErrorCode,
	terminalError,
	type AckRequest,
	type AttachReceipt,
	type AttachRequest,
	type DetachRequest,
	type InputRequest,
	type ResizeRequest,
} from "../../ipc/agent.js";
import { AgentSurfaceManager, type FrameSink } from "./channel.js";
import { RuntimeLaunchContext } from "./launchContext.js";
import type { AgentId } from "./ports.js";
import { HerdrAgentRuntime } from "./runtime.js";

export interface AgentServiceOptions {
	/** Where the cleanup journal lives; the app's own user-data dir. */
	readonly journalPath: string;
	/** The configured Herdr command: a path, a `~` path, or a PATH name. */
	readonly configuredHerdr: string;
	readonly home: string;
	/** Called when a live control stream fails; health is reconciled, not the row. */
	readonly onSurfaceFailure: (agentId: AgentId) => void;
}

/**
 * The composed Agent service. `register` installs the IPC handlers; `dispose`
 * releases every view attachment and the subscription within a deadline and
 * reports whether it managed to.
 */
export class AgentService {
	readonly runtime: HerdrAgentRuntime;
	readonly surfaces = new AgentSurfaceManager();
	readonly #onSurfaceFailure: (agentId: AgentId) => void;
	#registered = false;

	constructor(options: AgentServiceOptions) {
		this.runtime = HerdrAgentRuntime.create(
			RuntimeLaunchContext.create(options.home, process.env),
			options.configuredHerdr,
			options.journalPath,
		);
		this.#onSurfaceFailure = options.onSurfaceFailure;
	}

	register(): void {
		if (this.#registered) {
			throw new Error("the agent IPC handlers are already registered");
		}
		this.#registered = true;
		ipcMain.handle(
			AGENT_CHANNELS.attach,
			async (
				event: IpcMainInvokeEvent,
				request: AttachRequest,
			): Promise<AttachReceipt> => {
				const [receipt] = await this.surfaces.attach(
					this.runtime,
					viewLabel(event.sender),
					request,
					frameSink(event.sender),
					this.#onSurfaceFailure,
				);
				return receipt;
			},
		);
		ipcMain.handle(
			AGENT_CHANNELS.input,
			(event: IpcMainInvokeEvent, request: InputRequest) =>
				this.surfaces.input(viewLabel(event.sender), request),
		);
		ipcMain.handle(
			AGENT_CHANNELS.resize,
			(event: IpcMainInvokeEvent, request: ResizeRequest) =>
				this.surfaces.resize(viewLabel(event.sender), request),
		);
		ipcMain.handle(
			AGENT_CHANNELS.acknowledge,
			(event: IpcMainInvokeEvent, request: AckRequest) =>
				this.surfaces.acknowledge(viewLabel(event.sender), request),
		);
		ipcMain.handle(
			AGENT_CHANNELS.detach,
			(event: IpcMainInvokeEvent, request: DetachRequest) =>
				this.surfaces.detach(viewLabel(event.sender), request),
		);
	}

	/** Releases every attachment and the invalidation listener, boundedly. */
	async dispose(deadline: number = Date.now() + 5_000): Promise<boolean> {
		if (this.#registered) {
			for (const channel of [
				AGENT_CHANNELS.attach,
				AGENT_CHANNELS.input,
				AGENT_CHANNELS.resize,
				AGENT_CHANNELS.acknowledge,
				AGENT_CHANNELS.detach,
			]) {
				ipcMain.removeHandler(channel);
			}
			this.#registered = false;
		}
		const surfaces = await this.surfaces.detachAllUntil(deadline);
		const runtime = await this.runtime.shutdown(deadline);
		return surfaces && runtime;
	}
}

function viewLabel(sender: WebContents): string {
	return `webcontents:${sender.id}`;
}

function frameSink(sender: WebContents): FrameSink {
	return {
		send(raw: Uint8Array): void {
			if (sender.isDestroyed()) {
				throw terminalError(TerminalErrorCode.ChannelClosed);
			}
			sender.send(AGENT_CHANNELS.frame, raw);
		},
	};
}

export {
	AgentSurfaceManager,
	HerdrAgentRuntime,
	RuntimeLaunchContext,
	TerminalError,
};
