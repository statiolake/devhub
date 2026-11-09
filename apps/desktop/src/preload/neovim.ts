/**
 * The Neovim editor's bridge — `neovim.html`.
 *
 * One view per Neovim drawn over a terminal pane. See `NeovimBridge` in
 * `ipc/contract.ts`, and `shell/neovim/NeovimApp.tsx`.
 *
 * A Neovim's UI runs in one of two places, and this is the only code that
 * knows which. Mostly in the Neovim host (`main/neovimHost/`): main hands the
 * page a port to it (`NEOVIM_CHANNELS.port`) and says so in the attach's
 * answer (`hosted`), and from then on the redraws and the GUI windows'
 * events arrive on that port and the calls and requests go back on it —
 * main is not on the path. One that runs in main (the host given up on, or
 * `DEVHUB_NEOVIM_IN_MAIN=1`) has its events as IPC and its calls as IPC,
 * as before. Attach is always main's, and so is `ended`.
 *
 * **When the host ends.** Main says so (`NEOVIM_CHANNELS.restarted`): its
 * port is closed here and a request waiting on it is answered with a
 * failure; main then tells each page whose UI it ran that it ended, with
 * `reconnect`, and the page attaches again.
 */

import { contextBridge, ipcRenderer } from "electron";
import type { NeovimBridge } from "../ipc/contract.js";
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
	type NeovimPlacement,
	type NeovimPageEvent,
	type NeovimRequestResult,
	type PageToNeovimHost,
} from "../ipc/neovim.js";
import {
	appearanceBridge,
	openExternalUrl,
	pageBridge,
	projectionBridge,
} from "./bridge.js";

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

// Kept from before the page listens: main says it as the view is placed.
let placement: NeovimPlacement | undefined;
const placedListeners = new Set<(placement: NeovimPlacement) => void>();
ipcRenderer.on(NEOVIM_CHANNELS.placed, (_event, said: NeovimPlacement) => {
	placement = said;
	for (const listener of placedListeners) listener(said);
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
			emit(data);
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

const neovim: DevhubNeovimApi = {
	attach: async (request) => {
		hosted.delete(request.workspaceId);
		const reply = (await ipcRenderer.invoke(
			NEOVIM_CHANNELS.attach,
			request,
		)) as NeovimAttachReply;
		if (!reply.ok) return reply;
		if (reply.hosted !== undefined) {
			hosted.set(request.workspaceId, reply.hosted);
		}
		return { ok: true, version: reply.version, where: reply.where };
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
	onPlaced: (listener) => {
		placedListeners.add(listener);
		if (placement !== undefined) listener(placement);
		return () => {
			placedListeners.delete(listener);
		};
	},
	guiMessage: (message) => {
		const port = portFor(message.workspaceId);
		if (port === undefined)
			ipcRenderer.send(NEOVIM_CHANNELS.guiMessage, message);
		else toHost(port, { type: "gui-message", message });
	},
};

const api: NeovimBridge = {
	...pageBridge(),
	...projectionBridge(),
	...appearanceBridge(),

	openExternalUrl,
	neovim,
};

contextBridge.exposeInMainWorld("devhub", api);
