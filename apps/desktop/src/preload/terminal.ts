/**
 * `window.devhub.terminal`: the page's only way to reach a PTY.
 *
 * Nothing here decides anything. Each member forwards one request and returns
 * exactly what was answered, refusals included — turning a refusal into a
 * thrown failure is the page client's job, and doing it here as well would
 * give the same condition two shapes.
 *
 * A client runs in one of two places, and this is the only code that knows
 * which. Most run in the pty host (`main/ptyHost/`): main hands the page a
 * port to it (`TERMINAL_CHANNELS.port`) and says so in the attach's answer,
 * and from then on the client's frames arrive on that port and its input,
 * resizes and acks go back on it — main is not on the path. One that runs in
 * main (a host given up on, a machine that cannot say what it would open) has
 * its frames on `TERMINAL_CHANNELS.frame` and its requests as `invoke`s, as
 * before. Attach and detach are always main's.
 *
 * A frame for a surface that has already unbound is dropped here, which is
 * the only place that can know it.
 *
 * **When the host ends.** Main says so (`TERMINAL_CHANNELS.restarted`). Each
 * surface whose client was there is handed one last frame, an error of
 * `host_restarted` in the client's own sequence, so it shows that it is
 * reconnecting and attaches again; an attach main had not answered yet is
 * answered with the same refusal; and a request waiting on the host is
 * answered with it too.
 */

import { ipcRenderer } from "electron";
import {
	TERMINAL_CHANNELS,
	TERMINAL_PROTOCOL_VERSION,
	TerminalFailure,
	encodeTerminalFrame,
	type DevhubTerminalApi,
	type TerminalAckRequest,
	type TerminalAttachReply,
	type TerminalAttachRequest,
	type TerminalDetachRequest,
	type TerminalInputRequest,
	type TerminalResizeRequest,
	type TerminalResult,
} from "../ipc/terminal.js";
import type { ControlRequest } from "../ipc/terminalControl.js";
import type { PageToPtyHost, PtyHostToPage } from "../main/ptyHost/protocol.js";

interface Channel {
	readonly listener: (frame: unknown) => void;
	/** The host generation whose port carries this client, once main has said so. */
	hosted: number | undefined;
	attachmentId: string | undefined;
	/** The last frame's sequence from the host, and whether it was the last there will be. */
	sequence: number;
	ended: boolean;
	/** A host that ended while this channel's attach was unanswered. */
	restartedDuringAttach: number | undefined;
}

const channels = new Map<string, Channel>();
/**
 * Per channel, the attachments its surface let go of whose last frame has not
 * come. A surface attaches again on the same channel id (a retry, a reveal
 * after more than it kept), and the client it replaced may still have frames
 * on the way, its end among them: they are not the new attachment's, and its
 * end must not end the new one's channel.
 */
const retired = new Map<string, string[]>();
/** More than a surface ever has in flight; a client lost with its host never sends its end. */
const MAX_RETIRED = 8;

function isRetired(channelId: string, attachmentId: string): boolean {
	return retired.get(channelId)?.includes(attachmentId) === true;
}

function retire(channelId: string, attachmentId: string): void {
	const ids = retired.get(channelId) ?? [];
	if (!ids.includes(attachmentId)) ids.push(attachmentId);
	if (ids.length > MAX_RETIRED) ids.shift();
	retired.set(channelId, ids);
}

function forget(channelId: string, attachmentId: string): void {
	const ids = retired.get(channelId)?.filter((id) => id !== attachmentId);
	if (ids === undefined || ids.length === 0) retired.delete(channelId);
	else retired.set(channelId, ids);
}

ipcRenderer.on(
	TERMINAL_CHANNELS.frame,
	(_event, channelId: string, frame: unknown) => {
		channels.get(channelId)?.listener(frame);
	},
);

let host: { port: MessagePort; generation: number } | undefined;
const replies = new Map<number, (result: TerminalResult<void>) => void>();
let nextRequest = 1;

const restarted = (): TerminalResult<never> => ({
	ok: false,
	error: new TerminalFailure("host_restarted").toWire(),
});

ipcRenderer.on(
	TERMINAL_CHANNELS.port,
	(event, { generation }: { generation: number }) => {
		const port = event.ports[0];
		if (port === undefined) return;
		host?.port.close();
		host = { port, generation };
		port.onmessage = ({ data }: MessageEvent<PtyHostToPage>) => {
			if (host?.port !== port) return;
			if (data.type === "reply") {
				const reply = replies.get(data.rid);
				replies.delete(data.rid);
				reply?.(data.result);
				return;
			}
			if (isRetired(data.channelId, data.attachmentId)) {
				if (data.last) forget(data.channelId, data.attachmentId);
				return;
			}
			const channel = channels.get(data.channelId);
			// A channel main has said runs here, on this host, or one whose
			// attach is still unanswered: its `started` comes before the answer.
			if (
				channel === undefined ||
				channel.ended ||
				(channel.hosted !== undefined && channel.hosted !== generation)
			) {
				return;
			}
			if (data.last) channel.ended = true;
			if (data.type === "control") {
				// A control client's news is a message, not frame bytes: its surface
				// reads it as such (`shell/terminal/control/`).
				channel.listener(data.message);
				return;
			}
			channel.sequence = data.sequence;
			channel.listener(data.frame);
		};
		port.start();
	},
);

ipcRenderer.on(
	TERMINAL_CHANNELS.restarted,
	(_event, { generation }: { generation: number }) => {
		if (host?.generation === generation) {
			host.port.close();
			host = undefined;
			for (const reply of [...replies.values()]) reply(restarted());
			replies.clear();
		}
		for (const channel of channels.values()) {
			if (channel.hosted === undefined) {
				channel.restartedDuringAttach = generation;
				continue;
			}
			if (
				channel.hosted !== generation ||
				channel.ended ||
				channel.attachmentId === undefined
			) {
				continue;
			}
			channel.ended = true;
			channel.listener(
				encodeTerminalFrame({
					type: "error",
					schemaVersion: TERMINAL_PROTOCOL_VERSION,
					attachmentId: channel.attachmentId,
					sequence: channel.sequence + 1,
					error: new TerminalFailure("host_restarted").toWire(),
				}),
			);
		}
	},
);

/** A request to the host for a client it runs, answered on the same port. */
function toHost(
	channel: Channel,
	type: PageToPtyHost["type"],
	request: unknown,
): Promise<TerminalResult<void>> {
	if (host === undefined || host.generation !== channel.hosted) {
		return Promise.resolve(restarted());
	}
	const port = host.port;
	const rid = nextRequest++;
	return new Promise((resolve) => {
		replies.set(rid, resolve);
		port.postMessage({ type, rid, request } satisfies PageToPtyHost);
	});
}

function hostedChannel(channelId: string): Channel | undefined {
	const channel = channels.get(channelId);
	return channel?.hosted === undefined ? undefined : channel;
}

export const terminalApi: DevhubTerminalApi = {
	attach: async (channelId, request: TerminalAttachRequest, onFrame) => {
		const channel: Channel = {
			listener: onFrame,
			hosted: undefined,
			attachmentId: undefined,
			sequence: 0,
			ended: false,
			restartedDuringAttach: undefined,
		};
		channels.set(channelId, channel);
		const reply = (await ipcRenderer.invoke(
			TERMINAL_CHANNELS.attach,
			channelId,
			request,
		)) as TerminalAttachReply;
		const result = reply.result;
		if (!result.ok) {
			if (channels.get(channelId) === channel) channels.delete(channelId);
			return result;
		}
		channel.attachmentId = result.value.attachmentId;
		if (reply.hosted !== undefined) {
			channel.hosted = reply.hosted;
			// Its host ended before the answer came: the client is gone, and
			// the surface attaches again.
			if (
				channel.restartedDuringAttach !== undefined &&
				channel.restartedDuringAttach >= reply.hosted
			) {
				if (channels.get(channelId) === channel) channels.delete(channelId);
				return restarted();
			}
		}
		return result;
	},

	input: (channelId, request: TerminalInputRequest) => {
		const channel = hostedChannel(channelId);
		if (channel !== undefined) return toHost(channel, "input", request);
		return ipcRenderer.invoke(
			TERMINAL_CHANNELS.input,
			channelId,
			request,
		) as Promise<TerminalResult<void>>;
	},

	resize: (channelId, request: TerminalResizeRequest) => {
		const channel = hostedChannel(channelId);
		if (channel !== undefined) return toHost(channel, "resize", request);
		return ipcRenderer.invoke(
			TERMINAL_CHANNELS.resize,
			channelId,
			request,
		) as Promise<TerminalResult<void>>;
	},

	control: (channelId, request: ControlRequest) => {
		const channel = hostedChannel(channelId);
		if (channel === undefined) return Promise.resolve(restarted());
		return toHost(channel, "control", request);
	},

	acknowledge: (channelId, request: TerminalAckRequest) => {
		const channel = hostedChannel(channelId);
		if (channel !== undefined) return toHost(channel, "ack", request);
		return ipcRenderer.invoke(
			TERMINAL_CHANNELS.acknowledge,
			channelId,
			request,
		) as Promise<TerminalResult<void>>;
	},

	detach: async (channelId, request: TerminalDetachRequest) => {
		const channel = channels.get(channelId);
		if (channel?.hosted !== undefined && channel.ended === false) {
			retire(channelId, request.attachmentId);
		}
		const result = (await ipcRenderer.invoke(
			TERMINAL_CHANNELS.detach,
			channelId,
			request,
		)) as TerminalResult<void>;
		// Only the channel this detach was for: the surface may have started
		// its next attach, on the same channel id, while this was answered.
		if (
			channel !== undefined &&
			channels.get(channelId) === channel &&
			(channel.attachmentId === undefined ||
				channel.attachmentId === request.attachmentId)
		) {
			channels.delete(channelId);
		}
		return result;
	},
};
