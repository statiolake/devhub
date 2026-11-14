/**
 * Main's side of the pty host (`host.ts`, `entry.ts`): the utility process,
 * each page's port to it, and the ledger's view of it (`HostedPtys`).
 *
 * Main resolves which tmux session a surface attaches to and keeps who owns
 * which client (`terminal/attachments.ts`); the host runs the control client
 * and its data path with the page directly. A page gets a `MessagePort` to
 * the host the first time it attaches a client there
 * (`TERMINAL_CHANNELS.port`), one per page per host; what the client and the
 * page say to each other never passes main.
 *
 * **When the host is gone.** Its clients end with it — the kernel ends each
 * control client with the host that started it (`devhub-exec-clean
 * --die-with`, `ptyHost/entry.ts`), as its pipes closing alone did not
 * always; the sessions are the tmux server's and are not touched. A start it had not answered fails as `host_restarted`, every
 * client it held is ended in the ledger, and every page that had a port to it
 * is told (`TERMINAL_CHANNELS.restarted`), so its surfaces show that they are
 * reconnecting and attach again; the next start starts a new host. A host
 * that keeps dying is given up on: after `MAX_RESTARTS` exits within a
 * minute no new one is started (`available` is false), attaches are refused
 * as `pty_unavailable`, and that is said once. There is no other place for a
 * terminal to run, so the person is offered "Restart Terminals"
 * (`restart`), which forgets those exits and starts a new host for the
 * surfaces to attach to again.
 */

import { startupTrace } from "../diagnostics/startupTrace.js";
import { join } from "node:path";
import {
	TERMINAL_CHANNELS,
	TerminalFailure,
	type ExitReason,
} from "../../ipc/terminal.js";
import { electron } from "../electron.js";
import { APP_ROOT } from "../shell/appRoot.js";
import type { HostedOpen, HostedPtys } from "../terminal/attachments.js";
import type { FromPtyHost, ToPtyHost } from "./protocol.js";

export const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;

/** A port's end that is handed to the host or a page; Electron's `MessagePortMain`. */
export type TransferablePort = object;

/** What the client needs of a utility process; Electron's, in DevHub. */
export interface PtyHostProcess {
	postMessage(message: ToPtyHost, transfer?: TransferablePort[]): void;
	onMessage(listener: (message: FromPtyHost) => void): void;
	onExit(listener: (code: number) => void): void;
	kill(): void;
}

export type PtyHostLauncher = () => PtyHostProcess;

/** A page as the client reaches it: Electron's `WebContents` in DevHub. */
export interface HostedPage {
	readonly id: number;
	isDestroyed(): boolean;
	postMessage(
		channel: string,
		message: unknown,
		transfer: Electron.MessagePortMain[],
	): void;
	send(channel: string, ...args: unknown[]): void;
}

/** The host's entry, from the app's root, as the process host's is. */
export const PTY_HOST_ENTRY = join(
	APP_ROOT,
	"out",
	"main",
	"ptyHost",
	"entry.js",
);

/** The pty host as an Electron utility process. */
export function electronPtyHostLauncher(): PtyHostProcess {
	const child = electron.utilityProcess.fork(PTY_HOST_ENTRY, [], {
		serviceName: "DevHub Pty Host",
		env: { ...process.env },
	});
	return {
		postMessage: (message, transfer) =>
			child.postMessage(
				message,
				transfer as Electron.MessagePortMain[] | undefined,
			),
		onMessage: (listener) =>
			child.on("message", (message: unknown) =>
				listener(message as FromPtyHost),
			),
		onExit: (listener) => child.on("exit", listener),
		kill: () => {
			child.kill();
		},
	};
}

/** What `onNeovimSocket` is told. */
export type NeovimSocketListener = (said: {
	readonly surfaceKey: string;
	readonly page: HostedPage;
	readonly pane: number;
	readonly socket: string;
	readonly cols: number;
	readonly rows: number;
}) => void;

export interface PtyHostClientOptions {
	readonly launch: PtyHostLauncher;
	/** A new pair of entangled ports; Electron's `MessageChannelMain` in DevHub. */
	readonly channel?: () => {
		port1: Electron.MessagePortMain;
		port2: Electron.MessagePortMain;
	};
	readonly log?: (line: string) => void;
	readonly now?: () => number;
}

interface PagePort {
	readonly generation: number;
	readonly page: number;
}

export class PtyHostClient implements HostedPtys {
	readonly #options: PtyHostClientOptions;
	#host: PtyHostProcess | undefined;
	#disposed = false;
	#gaveUp = false;
	readonly #exits: number[] = [];
	/** Bumped for each host started: a page's port is to one of them. */
	#generation = 0;
	readonly #ports = new Map<HostedPage, PagePort>();
	readonly #pending = new Map<
		number,
		{ resolve: () => void; reject: (failure: TerminalFailure) => void }
	>();
	/** Every client the host of this generation was asked to start and has not ended. */
	readonly #clients = new Set<string>();
	readonly #ended = new Set<(id: string, reason: ExitReason) => void>();
	readonly #sockets = new Set<NeovimSocketListener>();
	#nextRequest = 1;
	#nextPage = 1;

	constructor(options: PtyHostClientOptions) {
		this.#options = options;
	}

	get available(): boolean {
		return !this.#disposed && !this.#gaveUp;
	}

	get generation(): number {
		return this.#generation;
	}

	/**
	 * A control client in the host read a pane's `@devhub-nvim` from tmux:
	 * the surface and the page it draws (`FromPtyHost` `nvim-socket`).
	 */
	onNeovimSocket(listener: NeovimSocketListener): () => void {
		this.#sockets.add(listener);
		return () => this.#sockets.delete(listener);
	}

	/** A client the host held has ended, as the host said or because it did. */
	onEnded(listener: (id: string, reason: ExitReason) => void): () => void {
		this.#ended.add(listener);
		return () => this.#ended.delete(listener);
	}

	#log(line: string): void {
		(this.#options.log ?? ((text: string) => console.warn(text)))(line);
	}

	#hostNow(): PtyHostProcess {
		if (this.#host !== undefined) return this.#host;
		startupTrace("pty-host:launch");
		const started = this.#options.launch();
		this.#generation += 1;
		started.onMessage((message) => {
			if (started === this.#host) this.#receive(message);
		});
		started.onExit((code) => {
			if (started === this.#host) this.#lost(code);
		});
		this.#host = started;
		return started;
	}

	#receive(message: FromPtyHost): void {
		switch (message.type) {
			case "opened": {
				const pending = this.#pending.get(message.rid);
				this.#pending.delete(message.rid);
				pending?.resolve();
				return;
			}
			case "open-failed": {
				const pending = this.#pending.get(message.rid);
				this.#pending.delete(message.rid);
				// Said in the log and on the surface: the host's own words are
				// the only thing that names why (a module it could not load, a
				// program that would not start, a page it did not know).
				this.#log(
					`[devhub] pty host could not open a terminal client: ${message.message}`,
				);
				pending?.reject(
					new TerminalFailure("pty_unavailable", {
						summary: `The terminal client could not be attached: ${message.message}`,
						cause: new Error(message.message),
					}),
				);
				return;
			}
			case "nvim-socket": {
				const generation = this.#generation;
				const page = [...this.#ports.entries()].find(
					([, port]) =>
						port.generation === generation && port.page === message.page,
				)?.[0];
				if (page === undefined || page.isDestroyed()) return;
				for (const listener of this.#sockets)
					listener({
						surfaceKey: message.surfaceKey,
						page,
						pane: message.pane,
						socket: message.socket,
						cols: message.cols,
						rows: message.rows,
					});
				return;
			}
			case "ended":
				if (!this.#clients.delete(message.id)) return;
				for (const listener of this.#ended)
					listener(message.id, message.reason);
				return;
		}
	}

	/**
	 * A host's end: its requests and clients fail, its pages are told.
	 * `counted`: an end of its own, towards giving up; a restart the person
	 * asked for is not one.
	 */
	#lost(code: number | "restart", counted = true): void {
		const generation = this.#generation;
		this.#host = undefined;
		const pending = [...this.#pending.values()];
		this.#pending.clear();
		for (const request of pending) {
			request.reject(new TerminalFailure("host_restarted"));
		}
		const clients = [...this.#clients];
		this.#clients.clear();
		for (const id of clients) {
			for (const listener of this.#ended) listener(id, "detached");
		}
		const pages = [...this.#ports.entries()];
		this.#ports.clear();
		for (const [page, port] of pages) {
			if (port.generation !== generation || page.isDestroyed()) continue;
			page.send(TERMINAL_CHANNELS.restarted, { generation });
		}
		if (this.#disposed || !counted) return;
		const at = (this.#options.now ?? Date.now)();
		this.#exits.push(at);
		while (
			this.#exits.length > 0 &&
			at - (this.#exits[0] ?? at) > RESTART_WINDOW_MS
		) {
			this.#exits.shift();
		}
		this.#log(
			`[devhub] pty host ended with exit code ${String(code)}; ${String(clients.length)} terminal client(s) reconnect to a new one`,
		);
		if (this.#exits.length >= MAX_RESTARTS) {
			this.#gaveUp = true;
			this.#log(
				`[devhub] pty host ended ${String(this.#exits.length)} times in a minute; no new one is started until the terminals are restarted`,
			);
		}
	}

	/** The page's number in the host of now, its port handed out if it has none to it. */
	#pageIn(host: PtyHostProcess, page: HostedPage): number {
		const known = this.#ports.get(page);
		if (known?.generation === this.#generation) return known.page;
		if (known !== undefined)
			host.postMessage({ type: "page-gone", page: known.page });
		const channel =
			this.#options.channel ?? (() => new electron.MessageChannelMain());
		const { port1, port2 } = channel();
		const id = this.#nextPage++;
		host.postMessage({ type: "page", page: id, viewLabel: String(page.id) }, [
			port1,
		]);
		// Before the attach's answer: the page has the port by the time it
		// learns that a client is on it.
		page.postMessage(TERMINAL_CHANNELS.port, { generation: this.#generation }, [
			port2,
		]);
		this.#ports.set(page, { generation: this.#generation, page: id });
		return id;
	}

	open(spec: HostedOpen): Promise<number> {
		if (!this.available) {
			return Promise.reject(new TerminalFailure("host_restarted"));
		}
		const page = spec.route.page as HostedPage;
		if (page.isDestroyed()) {
			return Promise.reject(new TerminalFailure("channel_closed"));
		}
		const host = this.#hostNow();
		const generation = this.#generation;
		const pageId = this.#pageIn(host, page);
		const rid = this.#nextRequest++;
		this.#clients.add(spec.id);
		return new Promise<number>((resolve, reject) => {
			this.#pending.set(rid, {
				resolve: () => resolve(generation),
				reject: (failure) => {
					this.#clients.delete(spec.id);
					reject(failure);
				},
			});
			host.postMessage({
				type: "open",
				rid,
				spec: {
					id: spec.id,
					surfaceKey: spec.surfaceKey,
					viewLabel: spec.viewLabel,
					targetGeneration: spec.targetGeneration,
					size: spec.size,
					page: pageId,
					channelId: spec.route.channelId,
					launch: spec.launch,
					...(spec.popupLaunch === undefined
						? {}
						: { popupLaunch: spec.popupLaunch }),
				},
			});
		});
	}

	stop(id: string, reason: ExitReason): void {
		if (!this.#clients.has(id)) return;
		this.#host?.postMessage({ type: "stop", id, reason });
	}

	/** The page went away: its port, and with it its clients in the host. */
	pageGone(page: HostedPage): void {
		const known = this.#ports.get(page);
		if (known === undefined) return;
		this.#ports.delete(page);
		if (known.generation === this.#generation) {
			this.#host?.postMessage({ type: "page-gone", page: known.page });
		}
	}

	/**
	 * "Restart Terminals": whatever host there is ends (its clients with it,
	 * each page told as for any end), its past ends are forgotten, and the
	 * next attach starts a new one. The tmux sessions are untouched: the
	 * surfaces attach to them again, as after a host that ended by itself.
	 */
	restart(): void {
		if (this.#disposed) return;
		this.#exits.length = 0;
		this.#gaveUp = false;
		const running = this.#host;
		if (running === undefined) return;
		this.#log("[devhub] pty host restarted on request");
		// Its own exit, after this, is not news: `#host` is not it any more.
		this.#lost("restart", false);
		running.kill();
	}

	/** Quit: the host goes, and its clients with it; the sessions stay. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		const running = this.#host;
		this.#host = undefined;
		for (const request of this.#pending.values()) {
			request.reject(new TerminalFailure("host_restarted"));
		}
		this.#pending.clear();
		this.#clients.clear();
		this.#ports.clear();
		running?.kill();
	}
}
