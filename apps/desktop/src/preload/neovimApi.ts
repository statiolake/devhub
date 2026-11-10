/**
 * The Neovim UIs' bridge, on the terminal page (`pane.html`) that draws each
 * Neovim over its pane (`shell/neovim/NeovimApp.tsx`). Every UI on the page
 * is named by its overlay's key (`tnv:<n>`, the `workspaceId` of each call
 * and event); one page may hold several.
 *
 * A Neovim's UI runs in one of two places, and this is the only code that
 * knows which. Mostly in the Neovim host (`main/neovimHost/`): main hands the
 * page a port to it (`NEOVIM_CHANNELS.port`, one per page per host) and says
 * so in the attach's answer (`hosted`), and from then on the redraws and the
 * GUI windows' events arrive on that port and the calls and requests go back
 * on it — main is not on the path. One that runs in main (the host given up
 * on, or `DEVHUB_NEOVIM_IN_MAIN=1`) has its events as IPC and its calls as
 * IPC. Attach is always main's, and so is `ended`.
 *
 * **When the host ends.** Main says so (`NEOVIM_CHANNELS.restarted`): its
 * port is closed here and a request waiting on it is answered with a
 * failure; main then tells each UI it ran that it ended, with `reconnect`,
 * and that UI attaches again.
 */

import { ipcRenderer } from "electron";
import {
	NEOVIM_CHANNELS,
	type DevhubNeovimApi,
	type NeovimAttachReply,
	type NeovimCall,
	type NeovimGuiEvent,
	type NeovimGuiMessage,
	type NeovimGuiWindowWire,
	type NeovimGuiWindowsWire,
	type NeovimHostToPage,
	type NeovimPageEvent,
	type NeovimRequestResult,
	type PageToNeovimHost,
} from "../ipc/neovim.js";

type Listeners = {
	readonly [K in NeovimPageEvent["type"]]: Set<
		(event: Extract<NeovimPageEvent, { type: K }>) => void
	>;
};

const listeners: Listeners = {
	redraw: new Set(),
	"gui-window": new Set(),
	"gui-windows": new Set(),
	"gui-send": new Set(),
	"gui-event": new Set(),
};

function emit(event: NeovimPageEvent): void {
	const set = listeners[event.type] as Set<(event: NeovimPageEvent) => void>;
	for (const listener of set) listener(event);
}

/**
 * The overlays this page has asked to attach: what the host says of any
 * other is for a surface not mounted yet — main attached it before the page
 * asked (`NeovimEditors.preattach`) — and waits here, in order, until the
 * surface asks (`attach`), as many as `EARLY_MAX` each.
 */
const asked = new Set<string>();
const early = new Map<string, NeovimPageEvent[]>();
const EARLY_MAX = 20_000;

function fromHost(event: NeovimPageEvent): void {
	const key =
		event.type === "gui-send"
			? event.message.workspaceId
			: event.type === "gui-event"
				? event.event.workspaceId
				: event.workspaceId;
	if (asked.has(key)) {
		emit(event);
		return;
	}
	const waiting = early.get(key) ?? [];
	if (waiting.length < EARLY_MAX) waiting.push(event);
	early.set(key, waiting);
}

function on<K extends NeovimPageEvent["type"]>(
	type: K,
	listener: (event: Extract<NeovimPageEvent, { type: K }>) => void,
): () => void {
	const set = listeners[type];
	set.add(listener);
	return () => {
		set.delete(listener);
	};
}

// A UI of main's own: its events as IPC, made the port's shape here.
ipcRenderer.on(
	NEOVIM_CHANNELS.redraw,
	(_event, workspaceId: string, batches: readonly unknown[]) => {
		emit({ type: "redraw", workspaceId, batches });
	},
);
ipcRenderer.on(
	NEOVIM_CHANNELS.guiWindow,
	(_event, workspaceId: string, window: NeovimGuiWindowWire) => {
		emit({ type: "gui-window", workspaceId, window });
	},
);
ipcRenderer.on(
	NEOVIM_CHANNELS.guiWindows,
	(_event, workspaceId: string, windows: NeovimGuiWindowsWire) => {
		emit({ type: "gui-windows", workspaceId, windows });
	},
);
ipcRenderer.on(NEOVIM_CHANNELS.guiSend, (_event, message: NeovimGuiMessage) => {
	emit({ type: "gui-send", message });
});
ipcRenderer.on(NEOVIM_CHANNELS.guiEvent, (_event, event: NeovimGuiEvent) => {
	emit({ type: "gui-event", event });
});

// An overlay that ended before its surface asked: nothing will.
ipcRenderer.on(NEOVIM_CHANNELS.ended, (_event, workspaceId: string) => {
	if (!asked.has(workspaceId)) early.delete(workspaceId);
});

/** The port to the Neovim host, and which host it is. */
let host:
	| { readonly port: MessagePort; readonly generation: number }
	| undefined;
/** Each overlay whose UI is in a host: that host's generation. */
const hosted = new Map<string, number>();
const replies = new Map<number, (result: NeovimRequestResult) => void>();
let nextRequest = 1;

const HOST_ENDED: NeovimRequestResult = {
	ok: false,
	message: "DevHub's Neovim host ended",
};

ipcRenderer.on(
	NEOVIM_CHANNELS.port,
	(event, { generation }: { generation: number }) => {
		const port = event.ports[0];
		if (port === undefined) return;
		host?.port.close();
		host = { port, generation };
		port.onmessage = ({ data }: MessageEvent<NeovimHostToPage>) => {
			if (host?.port !== port) return;
			if (data.type === "reply") {
				const reply = replies.get(data.rid);
				replies.delete(data.rid);
				reply?.(data.result);
				return;
			}
			fromHost(data);
		};
		port.start();
	},
);

ipcRenderer.on(
	NEOVIM_CHANNELS.restarted,
	(_event, { generation }: { generation: number }) => {
		if (host?.generation !== generation) return;
		host.port.close();
		host = undefined;
		for (const reply of [...replies.values()]) reply(HOST_ENDED);
		replies.clear();
	},
);

/** The port an overlay's UI is on, or nothing: main's. */
function portFor(workspaceId: string): MessagePort | undefined {
	const generation = hosted.get(workspaceId);
	if (generation === undefined) return undefined;
	return host?.generation === generation ? host.port : undefined;
}

function toHost(port: MessagePort, message: PageToNeovimHost): void {
	port.postMessage(message);
}

export const neovimApi: DevhubNeovimApi = {
	attach: async (request) => {
		hosted.delete(request.workspaceId);
		// The surface listens now: what came before it, then the rest.
		asked.add(request.workspaceId);
		const waiting = early.get(request.workspaceId);
		early.delete(request.workspaceId);
		for (const event of waiting ?? []) emit(event);
		const reply = (await ipcRenderer.invoke(
			NEOVIM_CHANNELS.attach,
			request,
		)) as NeovimAttachReply;
		if (!reply.ok) return reply;
		if (reply.hosted !== undefined) {
			hosted.set(request.workspaceId, reply.hosted);
		}
		return {
			ok: true,
			version: reply.version,
			where: reply.where,
			...(reply.cols === undefined || reply.rows === undefined
				? {}
				: { cols: reply.cols, rows: reply.rows }),
		};
	},
	call: (call: NeovimCall) => {
		const port = portFor(call.workspaceId);
		if (port === undefined) ipcRenderer.send(NEOVIM_CHANNELS.call, call);
		else toHost(port, { type: "call", call });
	},
	request: (call) => {
		if (hosted.has(call.workspaceId)) {
			const port = portFor(call.workspaceId);
			if (port === undefined) return Promise.resolve(HOST_ENDED);
			const rid = nextRequest++;
			return new Promise<NeovimRequestResult>((resolve) => {
				replies.set(rid, resolve);
				toHost(port, { type: "request", rid, call });
			});
		}
		return ipcRenderer.invoke(
			NEOVIM_CHANNELS.request,
			call,
		) as Promise<NeovimRequestResult>;
	},
	onRedraw: (listener) =>
		on("redraw", (event) => {
			listener(event.workspaceId, event.batches);
		}),
	onEnded: (listener) => {
		const handler = (
			_event: Electron.IpcRendererEvent,
			workspaceId: string,
			reason: string,
			reconnect: boolean,
		) => {
			listener(workspaceId, reason, reconnect);
		};
		ipcRenderer.on(NEOVIM_CHANNELS.ended, handler);
		return () => {
			ipcRenderer.removeListener(NEOVIM_CHANNELS.ended, handler);
		};
	},
	onGuiWindow: (listener) =>
		on("gui-window", (event) => {
			listener(event.workspaceId, event.window);
		}),
	onGuiWindows: (listener) =>
		on("gui-windows", (event) => {
			listener(event.workspaceId, event.windows);
		}),
	onGuiSend: (listener) =>
		on("gui-send", (event) => {
			listener(event.message);
		}),
	onGuiEvent: (listener) =>
		on("gui-event", (event) => {
			listener(event.event);
		}),
	guiMessage: (message) => {
		const port = portFor(message.workspaceId);
		if (port === undefined)
			ipcRenderer.send(NEOVIM_CHANNELS.guiMessage, message);
		else toHost(port, { type: "gui-message", message });
	},
	quickPick: (request) =>
		ipcRenderer.invoke(NEOVIM_CHANNELS.quickPick, request) as Promise<
			number | string
		>,
};
