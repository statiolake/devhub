/**
 * The Neovim host end to end, in one process: main's `NeovimEditors`, main's
 * side of the host (`NeovimHostClient`) and the host's work (`NeovimHost`),
 * wired by fake ports and a fake utility process, on fake Neovim sockets.
 * What a page sees is what arrives on the port main handed it, or, for a UI
 * main runs itself, what main sent it.
 */

import { describe, expect, it } from "vitest";

import {
	NEOVIM_CHANNELS,
	type NeovimHostToPage,
	type NeovimPageEvent,
	type NeovimRequestResult,
	type PageToNeovimHost,
} from "../../ipc/neovim.js";
import type { ManagedNeovims } from "../editor/managedNeovim.js";
import { NeovimEditors } from "../editor/neovimEditors.js";
import type {
	NotificationListener,
	NeovimRpc,
	RequestHandler,
} from "../editor/neovimRpc.js";
import type { WorkspaceTerminalTarget } from "../terminal/ports.js";
import {
	NeovimHostClient,
	type NeovimHostPage,
	type NeovimHostProcess,
} from "./client.js";
import { NeovimHost, type HostPort } from "./host.js";
import type { FromNeovimHost, ToNeovimHost } from "./protocol.js";

/** A Neovim's end of one connection: answers the attach, records the rest. */
class FakeNeovim implements NeovimRpc {
	closed = false;
	readonly notified: [string, readonly unknown[]][] = [];
	readonly #close: (() => void)[] = [];
	#notification: NotificationListener | undefined;
	#request: RequestHandler | undefined;
	constructor(readonly socketPath: string) {}
	request(method: string, params: readonly unknown[]): Promise<unknown> {
		if (this.closed) return Promise.reject(new Error("closed"));
		if (method === "nvim_get_api_info") {
			return Promise.resolve([
				3,
				{ version: { major: 0, minor: 12, patch: 6 } },
			]);
		}
		if (method === "nvim_get_mode") return Promise.resolve({ blocking: false });
		if (method === "nvim_eval")
			return Promise.resolve(params[0] === "40+2" ? 42 : 0);
		return Promise.resolve(null);
	}
	notify(method: string, params: readonly unknown[]): void {
		this.notified.push([method, params]);
	}
	onClose(listener: () => void): void {
		if (this.closed) listener();
		else this.#close.push(listener);
	}
	onNotification(listener: NotificationListener): void {
		this.#notification = listener;
	}
	onRequest(handler: RequestHandler): void {
		this.#request = handler;
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const listener of this.#close.splice(0)) listener();
	}
	/** Neovim sends a notification, as a UI hears it. */
	send(method: string, params: readonly unknown[]): void {
		this.#notification?.(method, params);
	}
	/** Neovim `rpcrequest`s its UI. */
	ask(method: string): Promise<unknown> {
		return this.#request!(method, []);
	}
}

/** One end of an entangled pair; delivery is a task later, as a real port's is. */
class FakePort implements HostPort {
	peer: FakePort | undefined;
	closed = false;
	readonly #message: ((event: { data: unknown }) => void)[] = [];
	readonly #close: (() => void)[] = [];
	postMessage(message: unknown): void {
		const peer = this.peer;
		if (this.closed || peer === undefined || peer.closed) return;
		setTimeout(() => {
			if (peer.closed) return;
			for (const listener of peer.#message) listener({ data: message });
		}, 0);
	}
	on(event: "message" | "close", listener: never): void {
		if (event === "message") this.#message.push(listener);
		else this.#close.push(listener);
	}
	start(): void {}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		const peer = this.peer;
		if (peer !== undefined && !peer.closed) {
			peer.closed = true;
			for (const listener of peer.#close) listener();
		}
	}
}

function channel(): { port1: FakePort; port2: FakePort } {
	const port1 = new FakePort();
	const port2 = new FakePort();
	port1.peer = port2;
	port2.peer = port1;
	return { port1, port2 };
}

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** A page as main and the test see it: what it was sent, and what came on its port. */
class FakePage implements NeovimHostPage {
	destroyed = false;
	readonly sent: [string, unknown[]][] = [];
	ports: { generation: number; port: FakePort }[] = [];
	readonly events: NeovimPageEvent[] = [];
	readonly #replies = new Map<number, (result: NeovimRequestResult) => void>();
	readonly #destroyed: (() => void)[] = [];
	#nextRid = 1;
	constructor(readonly id: number) {}
	isDestroyed() {
		return this.destroyed;
	}
	postMessage(channelName: string, message: unknown, transfer: never[]) {
		expect(channelName).toBe(NEOVIM_CHANNELS.port);
		const port = transfer[0] as unknown as FakePort;
		const { generation } = message as { generation: number };
		this.ports.push({ generation, port });
		port.on("message", (({ data }: { data: NeovimHostToPage }) => {
			if (data.type === "reply") {
				this.#replies.get(data.rid)?.(data.result);
				return;
			}
			this.events.push(data);
		}) as never);
	}
	send(channelName: string, ...args: unknown[]) {
		this.sent.push([channelName, args]);
	}
	once(_event: "destroyed", listener: () => void) {
		this.#destroyed.push(listener);
	}
	destroy() {
		this.destroyed = true;
		for (const listener of this.#destroyed.splice(0)) listener();
	}
	toHost(message: PageToNeovimHost) {
		this.ports.at(-1)!.port.postMessage(message);
	}
	request(workspaceId: string, method: string, params: unknown[]) {
		const rid = this.#nextRid++;
		return new Promise<NeovimRequestResult>((resolve) => {
			this.#replies.set(rid, resolve);
			this.toHost({
				type: "request",
				rid,
				call: { workspaceId, method, params },
			});
		});
	}
	ended() {
		return this.sent.filter(([name]) => name === NEOVIM_CHANNELS.ended);
	}
}

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TARGET: WorkspaceTerminalTarget = {
	machine: "local",
	workspaceId: WS,
	root: "/ws",
};
const REQUEST = { workspaceId: WS, cols: 80, rows: 24 };

function world() {
	/** Every connection made, by whom: the host's or main's own. */
	const connections: { by: "host" | "main"; nvim: FakeNeovim }[] = [];
	const connect = (by: "host" | "main") => (socketPath: string) => {
		const nvim = new FakeNeovim(socketPath);
		connections.push({ by, nvim });
		return Promise.resolve(nvim);
	};
	const hosts: { crash: (code?: number) => void }[] = [];
	const launch = (): NeovimHostProcess => {
		const toMain: ((message: FromNeovimHost) => void)[] = [];
		const exits: ((code: number) => void)[] = [];
		let dead = false;
		const host = new NeovimHost({
			post: (message) =>
				setTimeout(() => {
					if (!dead) for (const listener of toMain) listener(message);
				}, 0),
			connect: connect("host"),
		});
		hosts.push({
			crash: (code = 70) => {
				dead = true;
				host.dispose();
				for (const listener of exits) listener(code);
			},
		});
		return {
			postMessage: (message: ToNeovimHost, transfer?: object[]) => {
				if (dead) return;
				host.receive(message, (transfer ?? []) as unknown as HostPort[]);
			},
			onMessage: (listener) => toMain.push(listener),
			onExit: (listener) => exits.push(listener),
			kill: () => {
				dead = true;
			},
		};
	};
	const clipboard = { text: "from the Mac" };
	const clip = {
		read: () => Promise.resolve(clipboard.text),
		write: (text: string) => {
			clipboard.text = text;
		},
	};
	let now = 0;
	const logs: string[] = [];
	const client = new NeovimHostClient({
		launch,
		clipboard: clip,
		channel: channel as never,
		log: (line) => logs.push(line),
		now: () => now,
	});
	let server = 1;
	const neovims = {
		connection: () =>
			Promise.resolve({ socketPath: "/sock", server, started: false }),
		stillRunning: () => Promise.resolve(false),
		close: () => Promise.resolve(),
	} as unknown as ManagedNeovims;
	const buffers: string[] = [];
	const editors = new NeovimEditors({
		neovims,
		target: () => TARGET,
		clipboard: clip,
		host: client,
		connect: connect("main"),
		onBuffer: (workspaceId) =>
			buffers.push(editors.bufferName(workspaceId) ?? ""),
	});
	return {
		connections,
		hosts,
		client,
		editors,
		clipboard,
		logs,
		buffers,
		newServer: () => {
			server += 1;
		},
		advance: (ms: number) => {
			now += ms;
		},
		last: () => connections.at(-1)!,
	};
}

describe("a Neovim editor's UI in the Neovim host", () => {
	it("is attached there, and its redraws and calls pass between the page and the host only", async () => {
		const w = world();
		const page = new FakePage(1);
		const reply = await w.editors.attach(page, REQUEST);
		expect(reply).toEqual({
			ok: true,
			version: "0.12.6",
			where: "",
			hosted: 1,
		});
		expect(w.connections.map((c) => c.by)).toEqual(["host"]);
		expect(page.ports).toHaveLength(1);
		const nvim = w.last().nvim;
		nvim.send("redraw", [
			["grid_line", [1, 0, 0, [["a"]]]],
			["flush", []],
		]);
		page.toHost({
			type: "call",
			call: { workspaceId: WS, method: "nvim_input", params: ["x"] },
		});
		await settle();
		expect(page.events).toContainEqual({
			type: "redraw",
			workspaceId: WS,
			batches: [
				["grid_line", [1, 0, 0, [["a"]]]],
				["flush", []],
			],
		});
		expect(nvim.notified).toContainEqual(["nvim_input", ["x"]]);
		expect(await page.request(WS, "nvim_eval", ["40+2"])).toEqual({
			ok: true,
			value: 42,
		});
		expect(
			page.sent.filter(([name]) => name === NEOVIM_CHANNELS.redraw),
		).toEqual([]);
	});

	it("refuses a call from a page that did not attach the Workspace", async () => {
		const w = world();
		const page = new FakePage(1);
		await w.editors.attach(page, REQUEST);
		const other = new FakePage(2);
		await w.editors.attach(other, { ...REQUEST, workspaceId: "other" });
		other.toHost({
			type: "call",
			call: { workspaceId: WS, method: "nvim_input", params: ["x"] },
		});
		await settle();
		expect(w.connections[0]!.nvim.notified).toEqual([]);
		expect(await other.request(WS, "nvim_eval", ["40+2"])).toEqual({
			ok: false,
			message: "Neovim is not attached",
		});
	});

	it("answers Neovim's clipboard from main's, both ways, and says the buffer", async () => {
		const w = world();
		await w.editors.attach(new FakePage(1), REQUEST);
		const nvim = w.last().nvim;
		expect(await nvim.ask("devhub_clipboard_get")).toEqual([
			["from the Mac"],
			"v",
		]);
		nvim.send("devhub_clipboard_set", [["yanked", ""], "V"]);
		nvim.send("devhub_buffer", ["/ws/a.ts", ""]);
		await settle();
		expect(w.clipboard.text).toBe("yanked\n");
		expect(w.buffers).toEqual(["a.ts"]);
	});

	it("says when its connection ended, and a new server is a new connection", async () => {
		const w = world();
		const page = new FakePage(1);
		await w.editors.attach(page, REQUEST);
		w.last().nvim.close();
		await settle();
		expect(page.ended()).toEqual([
			[
				NEOVIM_CHANNELS.ended,
				[WS, "Neovim exited. Retry starts it again.", false],
			],
		]);
		w.newServer();
		await w.editors.attach(page, REQUEST);
		expect(w.connections).toHaveLength(2);
		// A reload of the same page on the same server keeps the connection.
		await w.editors.attach(page, REQUEST);
		expect(w.connections).toHaveLength(2);
	});

	it("is let go without a word when its Workspace closes", async () => {
		const w = world();
		const page = new FakePage(1);
		await w.editors.attach(page, REQUEST);
		await w.editors.close(TARGET);
		await settle();
		expect(w.last().nvim.closed).toBe(true);
		expect(page.ended()).toEqual([]);
	});
});

describe("when the Neovim host ends", () => {
	it("its pages are told, attach again, and get a new host", async () => {
		const w = world();
		const page = new FakePage(1);
		await w.editors.attach(page, REQUEST);
		w.hosts[0]!.crash();
		await settle();
		expect(page.sent).toContainEqual([
			NEOVIM_CHANNELS.restarted,
			[{ generation: 1 }],
		]);
		expect(page.ended()).toEqual([
			[
				NEOVIM_CHANNELS.ended,
				[WS, "DevHub's connection to Neovim restarted. Reconnecting…", true],
			],
		]);
		const reply = await w.editors.attach(page, REQUEST);
		expect(reply).toMatchObject({ ok: true, hosted: 2 });
		expect(page.ports.map((p) => p.generation)).toEqual([1, 2]);
	});

	it("three times in a minute, the UIs run in main from then on", async () => {
		const w = world();
		const page = new FakePage(1);
		for (let i = 0; i < 3; i += 1) {
			await w.editors.attach(page, REQUEST);
			w.hosts.at(-1)!.crash();
			await settle();
			w.advance(1_000);
		}
		expect(w.client.available).toBe(false);
		expect(w.logs.at(-1)).toMatch(/run in main from now on/);
		const reply = await w.editors.attach(page, REQUEST);
		expect(reply).toEqual({ ok: true, version: "0.12.6", where: "" });
		expect(w.last().by).toBe("main");
		w.last().nvim.send("redraw", [["flush", []]]);
		w.editors.call({ workspaceId: WS, method: "nvim_input", params: ["y"] });
		expect(page.sent).toContainEqual([
			NEOVIM_CHANNELS.redraw,
			[WS, [["flush", []]]],
		]);
		expect(w.last().nvim.notified).toContainEqual(["nvim_input", ["y"]]);
	});

	it("now and then is restarted every time", async () => {
		const w = world();
		const page = new FakePage(1);
		for (let i = 0; i < 4; i += 1) {
			await w.editors.attach(page, REQUEST);
			w.hosts.at(-1)!.crash();
			await settle();
			w.advance(61_000);
		}
		expect(w.client.available).toBe(true);
		expect(await w.editors.attach(page, REQUEST)).toMatchObject({ hosted: 5 });
	});
});
