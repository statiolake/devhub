/**
 * `window.devhub.terminal`: the page's only way to reach a terminal client.
 *
 * Nothing here decides anything. Each member forwards one request and returns
 * exactly what was answered, refusals included — turning a refusal into a
 * thrown failure is the page client's job, and doing it here as well would
 * give the same condition two shapes.
 *
 * Every client runs in the pty host (`main/ptyHost/`): main hands the page a
 * port to it (`TERMINAL_CHANNELS.port`) and says so in the attach's answer,
 * and from then on the client's news arrives on that port and the page's
 * requests go back on it — main is not on the path. Attach and detach are
 * main's.
 *
 * A message for a surface that has already unbound is dropped here, which is
 * the only place that can know it.
 *
 * **When the host ends.** Main says so (`TERMINAL_CHANNELS.restarted`). Each
 * surface whose client was there is handed one last message, `ended` with the
 * reason `host_restarted`, so it shows that it is reconnecting and attaches
 * again; an attach main had not answered yet is answered with that refusal;
 * and a request waiting on the host is answered with it too.
 */

import { ipcRenderer } from "electron";
import {
	TERMINAL_CHANNELS,
	TerminalFailure,
	type DevhubTerminalApi,
	type TerminalAttachReply,
	type TerminalAttachRequest,
	type TerminalDetachRequest,
	type TerminalResult,
} from "../ipc/terminal.js";
import type { ControlRequest, ControlToPage } from "../ipc/terminalControl.js";
import type { PageToPtyHost, PtyHostToPage } from "../main/ptyHost/protocol.js";

interface Channel {
	readonly listener: (message: unknown) => void;
	/** The host generation whose port carries this client, once main has said so. */
	hosted: number | undefined;
	attachmentId: string | undefined;
	/** Its last message has come: nothing more will. */
	ended: boolean;
	/** A host that ended while this channel's attach was unanswered. */
	restartedDuringAttach: number | undefined;
}

const channels = new Map<string, Channel>();
/**
 * Per channel, the attachments its surface let go of whose last message has
 * not come. A surface attaches again on the same channel id (a retry, a
 * reattach), and the client it replaced may still have messages on the way,
 * its end among them: they are not the new attachment's, and its
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

const revived = new Set<() => void>();
ipcRenderer.on(TERMINAL_CHANNELS.revived, () => {
	for (const listener of [...revived]) listener();
});

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
			// attach is still unanswered: its first news can come before the answer.
			if (
				channel === undefined ||
				channel.ended ||
				(channel.hosted !== undefined && channel.hosted !== generation)
			) {
				return;
			}
			if (data.last) channel.ended = true;
			channel.listener(data.message);
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
			channel.listener({
				kind: "ended",
				reason: "host_restarted",
			} satisfies ControlToPage);
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
	attach: async (channelId, request: TerminalAttachRequest, onMessage) => {
		const channel: Channel = {
			listener: onMessage,
			hosted: undefined,
			attachmentId: undefined,
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

	control: (channelId, request: ControlRequest) => {
		const channel = hostedChannel(channelId);
		if (channel === undefined) return Promise.resolve(restarted());
		return toHost(channel, "control", request);
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

	restart: async () => {
		await ipcRenderer.invoke(TERMINAL_CHANNELS.restart);
	},

	onRevived: (listener) => {
		revived.add(listener);
		return () => {
			revived.delete(listener);
		};
	},
};
