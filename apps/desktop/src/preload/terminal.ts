/**
 * `window.devhub.terminal`: the page's only way to reach a PTY.
 *
 * Nothing here decides anything. Each member forwards one request and returns
 * exactly what the main process answered, refusals included — turning a refusal
 * into a thrown failure is the page client's job, and doing it here as well
 * would give the same condition two shapes.
 *
 * Output frames arrive on one channel for the whole page and are handed to the
 * surface whose channel id they carry. A frame for a surface that has already
 * unbound is dropped here, which is the only place that can know it.
 */

import { ipcRenderer } from "electron";
import {
	TERMINAL_CHANNELS,
	type DevhubTerminalApi,
	type TerminalAckRequest,
	type TerminalAttachReceipt,
	type TerminalAttachRequest,
	type TerminalDetachRequest,
	type TerminalInputRequest,
	type TerminalResizeRequest,
	type TerminalResult,
} from "../ipc/terminal.js";

const listeners = new Map<string, (frame: unknown) => void>();

ipcRenderer.on(
	TERMINAL_CHANNELS.frame,
	(_event, channelId: string, frame: unknown) => {
		listeners.get(channelId)?.(frame);
	},
);

export const terminalApi: DevhubTerminalApi = {
	attach: async (channelId, request: TerminalAttachRequest, onFrame) => {
		listeners.set(channelId, onFrame);
		const result = (await ipcRenderer.invoke(
			TERMINAL_CHANNELS.attach,
			channelId,
			request,
		)) as TerminalResult<TerminalAttachReceipt>;
		if (!result.ok) listeners.delete(channelId);
		return result;
	},

	input: (channelId, request: TerminalInputRequest) =>
		ipcRenderer.invoke(TERMINAL_CHANNELS.input, channelId, request) as Promise<
			TerminalResult<void>
		>,

	resize: (channelId, request: TerminalResizeRequest) =>
		ipcRenderer.invoke(TERMINAL_CHANNELS.resize, channelId, request) as Promise<
			TerminalResult<void>
		>,

	acknowledge: (channelId, request: TerminalAckRequest) =>
		ipcRenderer.invoke(
			TERMINAL_CHANNELS.acknowledge,
			channelId,
			request,
		) as Promise<TerminalResult<void>>,

	detach: async (channelId, request: TerminalDetachRequest) => {
		const result = (await ipcRenderer.invoke(
			TERMINAL_CHANNELS.detach,
			channelId,
			request,
		)) as TerminalResult<void>;
		listeners.delete(channelId);
		return result;
	},
};
