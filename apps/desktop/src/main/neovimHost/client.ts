/**
 * Main's side of the Neovim host (`host.ts`, `entry.ts`): the utility
 * process, each page's port to it, and what main hears from it.
 *
 * Main finds or starts a Workspace's Neovim and resolves the socket the UI
 * connects to (`ManagedNeovims`); the host makes the UI's connection and
 * runs its data path with the page directly. A page gets a `MessagePort` to
 * the host the first time it attaches there (`NEOVIM_CHANNELS.port`), one per
 * page per host; its redraws, calls and requests never pass main. Main
 * answers the clipboard (`clipboard-read`/`-write`), which a utility process
 * has none of.
 *
 * **When the host is gone.** Its UIs' connections go with it — the Neovims
 * are tmux's and are not touched. An attach it had not answered fails as
 * `NeovimHostRestarted` (and `NeovimEditors` sends it to the next host), every
 * page that had a port to it is told (`NEOVIM_CHANNELS.restarted`), and the
 * listener's `lost` says which UIs were there, so their pages show that they
 * are reconnecting and attach again. A host that keeps dying is given up on,
 * as the pty host is: after `MAX_RESTARTS` exits within a minute the UIs run
 * in main from then on (`available` is false), and that is said once.
 */

import { join } from "node:path";
import { NEOVIM_CHANNELS } from "../../ipc/neovim.js";
import { electron } from "../electron.js";
import { APP_ROOT } from "../shell/appRoot.js";
import type { NeovimUiTarget } from "../editor/neovimUiSessions.js";
import type { NeovimClipboard } from "../editor/neovimUi.js";
import type { FromNeovimHost, ToNeovimHost } from "./protocol.js";

export const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;

/** An attach the host could not answer because it ended. */
export class NeovimHostRestarted extends Error {
	constructor() {
		super("DevHub's Neovim host ended");
		this.name = "NeovimHostRestarted";
	}
}

/** What the client needs of a utility process; Electron's, in DevHub. */
export interface NeovimHostProcess {
	postMessage(
		message: ToNeovimHost,
		transfer?: Electron.MessagePortMain[],
	): void;
	onMessage(listener: (message: FromNeovimHost) => void): void;
	onExit(listener: (code: number) => void): void;
	kill(): void;
}

export type NeovimHostLauncher = () => NeovimHostProcess;

/** A page as the client reaches it: Electron's `WebContents` in DevHub. */
export interface NeovimHostPage {
	readonly id: number;
	isDestroyed(): boolean;
	send(channel: string, ...args: unknown[]): void;
	postMessage(
		channel: string,
		message: unknown,
		transfer: Electron.MessagePortMain[],
	): void;
	once(event: "destroyed", listener: () => void): void;
	/** It loaded again (a reload): a new document, without the old port. */
	on(event: "did-navigate", listener: () => void): void;
}

/** What main hears of the UIs in the host. */
export interface NeovimHostListener {
	/** A UI's connection ended by itself, in the host of `generation`. */
	ended(workspaceId: string, generation: number): void;
	bufferChanged(workspaceId: string, name: string): void;
	/** The host of `generation` ended, and every UI in it. */
	lost(generation: number): void;
}

/** The host's entry, from the app's root, as the pty host's is. */
export const NEOVIM_HOST_ENTRY = join(
	APP_ROOT,
	"out",
	"main",
	"neovimHost",
	"entry.js",
);

/** The Neovim host as an Electron utility process. */
export function electronNeovimHostLauncher(): NeovimHostProcess {
	const child = electron.utilityProcess.fork(NEOVIM_HOST_ENTRY, [], {
		serviceName: "DevHub Neovim Host",
		env: { ...process.env },
	});
	return {
		postMessage: (message, transfer) => child.postMessage(message, transfer),
		onMessage: (listener) =>
			child.on("message", (message: unknown) =>
				listener(message as FromNeovimHost),
			),
		onExit: (listener) => child.on("exit", listener),
		kill: () => {
			child.kill();
		},
	};
}

export interface NeovimHostClientOptions {
	readonly launch: NeovimHostLauncher;
	readonly clipboard: NeovimClipboard;
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

export class NeovimHostClient {
	readonly #options: NeovimHostClientOptions;
	#host: NeovimHostProcess | undefined;
	#disposed = false;
	#gaveUp = false;
	readonly #exits: number[] = [];
	/** Bumped for each host started: a page's port is to one of them. */
	#generation = 0;
	readonly #ports = new Map<NeovimHostPage, PagePort>();
	readonly #pending = new Map<
		number,
		{ resolve: (version: string) => void; reject: (error: Error) => void }
	>();
	#listener: NeovimHostListener | undefined;
	#nextRequest = 1;
	#nextPage = 1;

	constructor(options: NeovimHostClientOptions) {
		this.#options = options;
	}

	get available(): boolean {
		return !this.#disposed && !this.#gaveUp;
	}

	/**
	 * A UI is about to attach (a Neovim was named in a pane): the host is
	 * started now, while the page mounts its surface, rather than by that
	 * attach — starting it was most of the first attach's wait after DevHub
	 * opened. Nothing if it runs, or was given up on.
	 */
	prepare(): void {
		if (this.available) this.#hostNow();
	}

	/**
	 * DevHub is idle after launch (`AppController.startNeovimHostWhenIdle`):
	 * the host is started now, so the first `nvim` does not wait on it. Only
	 * the first host: nothing if one was ever started — by a Neovim named
	 * before idle (`prepare`), or one that has since ended, which the next
	 * Neovim starts again, as it would without this. True if it started one.
	 */
	startAtIdle(): boolean {
		if (!this.available || this.#generation > 0) return false;
		this.#hostNow();
		return true;
	}

	listen(listener: NeovimHostListener): void {
		this.#listener = listener;
	}

	#log(line: string): void {
		(this.#options.log ?? ((text: string) => console.warn(text)))(line);
	}

	#hostNow(): NeovimHostProcess {
		if (this.#host !== undefined) return this.#host;
		const started = this.#options.launch();
		this.#generation += 1;
		const generation = this.#generation;
		started.onMessage((message) => {
			if (started === this.#host) this.#receive(started, generation, message);
		});
		started.onExit((code) => {
			if (started === this.#host) this.#lost(code);
		});
		this.#host = started;
		return started;
	}

	#receive(
		host: NeovimHostProcess,
		generation: number,
		message: FromNeovimHost,
	): void {
		switch (message.type) {
			case "attached": {
				const pending = this.#pending.get(message.rid);
				this.#pending.delete(message.rid);
				pending?.resolve(message.version);
				return;
			}
			case "attach-failed": {
				const pending = this.#pending.get(message.rid);
				this.#pending.delete(message.rid);
				pending?.reject(new Error(message.message));
				return;
			}
			case "ended":
				this.#listener?.ended(message.workspaceId, generation);
				return;
			case "buffer":
				this.#listener?.bufferChanged(message.workspaceId, message.name);
				return;
			case "clipboard-read": {
				const rid = message.rid;
				const answer = (text: string) => {
					if (host === this.#host) {
						host.postMessage({ type: "clipboard", rid, text });
					}
				};
				this.#options.clipboard.read().then(answer, () => {
					answer("");
				});
				return;
			}
			case "clipboard-write":
				this.#options.clipboard.write(message.text);
				return;
		}
	}

	#lost(code: number): void {
		const generation = this.#generation;
		this.#host = undefined;
		const pending = [...this.#pending.values()];
		this.#pending.clear();
		for (const request of pending) request.reject(new NeovimHostRestarted());
		const pages = [...this.#ports.entries()];
		this.#ports.clear();
		for (const [page, port] of pages) {
			if (port.generation !== generation || page.isDestroyed()) continue;
			page.send(NEOVIM_CHANNELS.restarted, { generation });
		}
		if (this.#disposed) return;
		const at = (this.#options.now ?? Date.now)();
		this.#exits.push(at);
		while (
			this.#exits.length > 0 &&
			at - (this.#exits[0] ?? at) > RESTART_WINDOW_MS
		) {
			this.#exits.shift();
		}
		this.#log(
			`[devhub] Neovim host ended with exit code ${String(code)}; its editors reconnect to a new one`,
		);
		if (this.#exits.length >= MAX_RESTARTS) {
			this.#gaveUp = true;
			this.#log(
				`[devhub] Neovim host ended ${String(this.#exits.length)} times in a minute; the Neovim editors run in main from now on`,
			);
		}
		this.#listener?.lost(generation);
	}

	/** The page's number in the host of now, its port handed out if it has none to it. */
	#pageIn(host: NeovimHostProcess, page: NeovimHostPage): number {
		const known = this.#ports.get(page);
		if (known?.generation === this.#generation) return known.page;
		if (known !== undefined) {
			host.postMessage({ type: "page-gone", page: known.page });
		} else {
			page.once("destroyed", () => {
				this.#pageGone(page);
			});
		}
		const channel =
			this.#options.channel ?? (() => new electron.MessageChannelMain());
		const { port1, port2 } = channel();
		const id = this.#nextPage++;
		host.postMessage({ type: "page", page: id }, [port1]);
		// Before the attach: the page has the port by the time redraws come.
		page.postMessage(NEOVIM_CHANNELS.port, { generation: this.#generation }, [
			port2,
		]);
		this.#ports.set(page, { generation: this.#generation, page: id });
		return id;
	}

	/**
	 * The page loaded again: its port went with its old document, so its
	 * next attach is handed a new one (and the host lets the old one go).
	 */
	pageGone(page: NeovimHostPage): void {
		this.#pageGone(page);
	}

	#pageGone(page: NeovimHostPage): void {
		const known = this.#ports.get(page);
		if (known === undefined) return;
		this.#ports.delete(page);
		if (known.generation === this.#generation) {
			this.#host?.postMessage({ type: "page-gone", page: known.page });
		}
	}

	/** Attach `page` as a Workspace's UI in the host; its generation with the version. */
	attach(
		page: NeovimHostPage,
		target: NeovimUiTarget,
	): Promise<{ readonly version: string; readonly generation: number }> {
		if (!this.available) return Promise.reject(new NeovimHostRestarted());
		if (page.isDestroyed()) {
			return Promise.reject(new Error("the Neovim page has gone"));
		}
		const host = this.#hostNow();
		const generation = this.#generation;
		const pageId = this.#pageIn(host, page);
		const rid = this.#nextRequest++;
		return new Promise((resolve, reject) => {
			this.#pending.set(rid, {
				resolve: (version) => {
					resolve({ version, generation });
				},
				reject,
			});
			host.postMessage({ type: "attach", rid, page: pageId, target });
		});
	}

	/** Let go of a Workspace's UI without hearing that it ended: it is closing. */
	detach(workspaceId: string): void {
		this.#host?.postMessage({ type: "detach", workspaceId });
	}

	/** Quit: the host goes, and the UIs' connections with it; the Neovims stay. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		const running = this.#host;
		this.#host = undefined;
		for (const request of this.#pending.values()) {
			request.reject(new NeovimHostRestarted());
		}
		this.#pending.clear();
		this.#ports.clear();
		running?.kill();
	}
}
