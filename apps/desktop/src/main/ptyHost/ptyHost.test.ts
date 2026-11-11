/**
 * The pty host end to end, in one process: main's ledger
 * (`AttachmentManager`), main's side of the host (`PtyHostClient`) and the
 * host's work (`PtyHost`), wired by fake ports and a fake utility process, on
 * fake control clients' children. What a page sees is what arrives on the
 * port main handed it.
 */

import { describe, expect, it } from "vitest";

import {
	TERMINAL_CHANNELS,
	TERMINAL_PROTOCOL_VERSION,
	TerminalFailure,
	type TerminalResult,
} from "../../ipc/terminal.js";
import type { ControlToPage } from "../../ipc/terminalControl.js";
import { AttachmentManager } from "../terminal/attachments.js";
import { CancellationToken, workspaceTarget } from "../terminal/ports.js";
import type { PtyLaunch } from "../terminal/pty.js";
import {
	PtyHostClient,
	type HostedPage,
	type PtyHostProcess,
} from "./client.js";
import type { ControlProcess } from "./control/controlClient.js";
import { PtyHost, type HostPort } from "./host.js";
import type { FromPtyHost, PtyHostToPage, ToPtyHost } from "./protocol.js";
import type { LibGhosttyVt } from "./vt/libghosttyVt.js";

/** A control client's child on pipes: what it was told, and its end. */
class FakeChild implements ControlProcess {
	readonly written: string[] = [];
	killed = false;
	#exit: ((code?: number) => void) | undefined;
	constructor(readonly launch: PtyLaunch) {}
	write(text: string) {
		this.written.push(text);
	}
	onData() {}
	onExit(listener: (code?: number) => void) {
		this.#exit = listener;
	}
	kill() {
		this.killed = true;
	}
	end() {
		this.#exit?.(0);
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

/** A page as main and the test see it: what it was sent, and its port. */
class FakePage implements HostedPage {
	destroyed = false;
	readonly sent: [string, unknown][] = [];
	ports: { generation: number; port: FakePort }[] = [];
	readonly news = new Map<string, ControlToPage[]>();
	readonly #replies = new Map<number, (result: TerminalResult<void>) => void>();
	#nextRid = 1;
	constructor(readonly id: number) {}
	isDestroyed() {
		return this.destroyed;
	}
	postMessage(channelName: string, message: unknown, transfer: never[]) {
		expect(channelName).toBe(TERMINAL_CHANNELS.port);
		const port = transfer[0] as unknown as FakePort;
		const { generation } = message as { generation: number };
		this.ports.push({ generation, port });
		port.on("message", (({ data }: { data: PtyHostToPage }) => {
			if (data.type === "reply") {
				this.#replies.get(data.rid)?.(data.result);
				return;
			}
			const list = this.news.get(data.channelId) ?? [];
			list.push(data.message);
			this.news.set(data.channelId, list);
		}) as never);
	}
	send(channelName: string, ...args: unknown[]) {
		this.sent.push([channelName, args[0]]);
	}
	control(request: unknown): Promise<TerminalResult<void>> {
		const port = this.ports.at(-1)!.port;
		const rid = this.#nextRid++;
		return new Promise((resolve) => {
			this.#replies.set(rid, resolve);
			port.postMessage({ type: "control", rid, request });
		});
	}
}

const SURFACE = "workspace-terminal:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TARGET = workspaceTarget(
	"local",
	"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	"/ws",
);

function world() {
	const children: FakeChild[] = [];
	const hosts: { host: PtyHost; crash: (code?: number) => void }[] = [];
	const killed: number[] = [];
	const launch = (): PtyHostProcess => {
		const toMain: ((message: FromPtyHost) => void)[] = [];
		const exits: ((code: number) => void)[] = [];
		let dead = false;
		const host = new PtyHost({
			post: (message) =>
				setTimeout(() => {
					if (!dead) for (const listener of toMain) listener(message);
				}, 0),
			spawn: () => {
				throw new Error("no popup is opened in these cases");
			},
			spawnPipes: (childLaunch) => {
				if (childLaunch.file === "/missing") throw new Error("no such file");
				const child = new FakeChild(childLaunch);
				children.push(child);
				return child;
			},
			// No pane is made in these cases: the engine is never asked.
			loadVt: () => Promise.resolve({} as LibGhosttyVt),
		});
		const index = hosts.length;
		hosts.push({
			host,
			crash: (code = 70) => {
				dead = true;
				for (const listener of exits) listener(code);
			},
		});
		return {
			postMessage: (message: ToPtyHost, transfer?: object[]) => {
				if (dead) return;
				host.receive(message, (transfer ?? []) as HostPort[]);
			},
			onMessage: (listener) => toMain.push(listener),
			onExit: (listener) => exits.push(listener),
			kill: () => {
				dead = true;
				killed.push(index);
				// A killed utility process exits, as Electron's does.
				setTimeout(() => {
					for (const listener of exits) listener(15);
				}, 0);
			},
		};
	};
	let now = 0;
	const logs: string[] = [];
	const client = new PtyHostClient({
		launch,
		channel: channel as never,
		log: (line) => logs.push(line),
		now: () => now,
	});
	const endedByItself: string[] = [];
	const plansEnded: string[] = [];
	let counter = 0;
	const manager = new AttachmentManager({
		randomBytes: (count) =>
			Uint8Array.from({ length: count }, () => (counter += 13) & 0xff),
		onEndedByItself: ({ surfaceKey }) => endedByItself.push(surfaceKey),
		hosted: client,
	});
	client.onEnded((id, reason) => manager.hostedEnded(id, reason));
	const attach = async (page: FakePage, channelId = "c1", file = "/tmux") => {
		const permit = manager.beginAttach(
			TARGET,
			SURFACE,
			String(page.id),
			new CancellationToken(),
		);
		try {
			return await manager.attach(permit, {
				surfaceKey: SURFACE,
				viewLabel: String(page.id),
				target: TARGET,
				plan: (planned) => ({
					launch: { ...planned, file: planned.pipes ? file : planned.file },
					ended: () => {
						if (planned.pipes) plansEnded.push(file);
					},
				}),
				file,
				args: ["attach-session", "-t", "ws"],
				cwd: "/",
				environment: {},
				size: { cols: 80, rows: 24, pixelWidth: 0, pixelHeight: 0 },
				route: { page, channelId },
			});
		} finally {
			permit.release();
		}
	};
	return {
		children,
		hosts,
		killed,
		client,
		manager,
		attach,
		logs,
		endedByItself,
		plansEnded,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

const identity = (receipt: {
	attachmentId: string;
	targetGeneration: number;
}) => ({
	surfaceKey: SURFACE,
	attachmentId: receipt.attachmentId,
	targetGeneration: receipt.targetGeneration,
});

describe("a terminal client in the pty host", () => {
	it("is started there, on pipes, and its page's requests pass between the page and the host only", async () => {
		const w = world();
		const page = new FakePage(3);
		const receipt = await w.attach(page);
		expect(w.manager.hostedGeneration(receipt.attachmentId)).toBe(1);
		expect(receipt.schemaVersion).toBe(TERMINAL_PROTOCOL_VERSION);
		// The port came before the answer, and the client is the host's.
		expect(page.ports.map((p) => p.generation)).toEqual([1]);
		expect(w.children).toHaveLength(1);
		expect(w.children[0]!.launch.args).toEqual([
			"-C",
			"attach-session",
			"-t",
			"ws",
		]);
		await settle();
		const reply = await page.control({
			...identity(receipt),
			message: { kind: "resize", cols: 100, rows: 40 },
		});
		expect(reply).toEqual({ ok: true, value: undefined });
	});

	it("refuses a request for a client the page was not given", async () => {
		const w = world();
		const page = new FakePage(3);
		const receipt = await w.attach(page);
		await settle();
		const wrong = await page.control({
			...identity(receipt),
			targetGeneration: receipt.targetGeneration + 1,
			message: { kind: "visible", visible: false },
		});
		expect(wrong).toMatchObject({
			ok: false,
			error: { code: "wrong_attachment" },
		});
		const other = new FakePage(4);
		await w.attach(other, "c9");
		await settle();
		// The other page's port, with the first page's handle.
		const stolen = await other.control({
			...identity(receipt),
			message: { kind: "visible", visible: false },
		});
		expect(stolen.ok).toBe(false);
	});

	it("is ended in the host when main's ledger detaches it, and gives back what its machine held", async () => {
		const w = world();
		const page = new FakePage(3);
		const receipt = await w.attach(page);
		await settle();
		w.manager.detach({ ...identity(receipt), viewLabel: "3" });
		expect(w.manager.count).toBe(0);
		await settle();
		expect(w.children[0]!.killed).toBe(true);
		expect(w.children[0]!.written).toContain("detach-client\n");
		expect(page.news.get("c1")!.at(-1)).toEqual({
			kind: "ended",
			reason: "detached",
		});
		expect(w.plansEnded).toEqual(["/tmux"]);
		expect(w.endedByItself).toEqual([]);
	});

	it("says when it ended on its own", async () => {
		const w = world();
		const page = new FakePage(3);
		await w.attach(page);
		w.children[0]!.end();
		await settle();
		expect(w.manager.count).toBe(0);
		expect(w.endedByItself).toEqual([SURFACE]);
		expect(w.plansEnded).toEqual(["/tmux"]);
	});

	it("goes with its page", async () => {
		const w = world();
		const page = new FakePage(3);
		await w.attach(page);
		w.client.pageGone(page);
		await settle();
		expect(w.children[0]!.killed).toBe(true);
		expect(w.manager.count).toBe(0);
	});

	it("that could not be started is refused, and gives back what its machine held", async () => {
		const w = world();
		const page = new FakePage(3);
		await expect(w.attach(page, "c1", "/missing")).rejects.toMatchObject({
			code: "pty_unavailable",
		});
		await settle();
		expect(w.manager.count).toBe(0);
		expect(w.plansEnded).toEqual(["/missing"]);
	});
});

describe("when the pty host ends", () => {
	it("its clients leave the ledger, the page is told, and the next attach starts a new host", async () => {
		const w = world();
		const page = new FakePage(3);
		await w.attach(page);
		w.hosts[0]!.crash();
		expect(w.manager.count).toBe(0);
		expect(w.plansEnded).toEqual(["/tmux"]);
		expect(w.endedByItself).toEqual([]);
		expect(page.sent).toEqual([
			[TERMINAL_CHANNELS.restarted, { generation: 1 }],
		]);
		const again = await w.attach(page);
		expect(w.hosts).toHaveLength(2);
		expect(w.manager.hostedGeneration(again.attachmentId)).toBe(2);
		expect(page.ports.map((p) => p.generation)).toEqual([1, 2]);
	});

	it("an attach it had not answered is refused as host_restarted", async () => {
		const w = world();
		const page = new FakePage(3);
		const pending = w.attach(page);
		w.hosts[0]!.crash();
		await expect(pending).rejects.toBeInstanceOf(TerminalFailure);
		await expect(pending).rejects.toMatchObject({ code: "host_restarted" });
		expect(w.manager.count).toBe(0);
	});

	it("three times in a minute, it is not started again until the terminals are restarted", async () => {
		const w = world();
		const page = new FakePage(3);
		for (let i = 0; i < 3; i++) {
			await w.attach(page);
			w.hosts.at(-1)!.crash();
			w.advance(1_000);
		}
		expect(w.client.available).toBe(false);
		expect(w.logs.join("\n")).toMatch(/3 times in a minute/u);
		// There is nowhere else for a client to run: the attach is refused.
		await expect(w.attach(page)).rejects.toMatchObject({
			code: "pty_unavailable",
		});
		expect(w.hosts).toHaveLength(3);
		// "Restart Terminals": the count is forgotten and a new host is
		// started for the next attach.
		w.client.restart();
		expect(w.client.available).toBe(true);
		const receipt = await w.attach(page);
		expect(w.hosts).toHaveLength(4);
		expect(w.manager.hostedGeneration(receipt.attachmentId)).toBe(4);
	});

	it("restarted on request, it ends with its clients, its pages are told, and that is no crash", async () => {
		const w = world();
		const page = new FakePage(3);
		await w.attach(page);
		await w.attach(new FakePage(4), "c2");
		w.client.restart();
		expect(w.killed).toEqual([0]);
		expect(w.manager.count).toBe(0);
		expect(page.sent).toEqual([
			[TERMINAL_CHANNELS.restarted, { generation: 1 }],
		]);
		await settle();
		// The killed host's own exit is not counted, and is not news.
		for (let i = 0; i < 2; i++) {
			await w.attach(page);
			w.client.restart();
			await settle();
		}
		expect(w.client.available).toBe(true);
		expect(w.logs.join("\n")).not.toMatch(/ended with exit code/u);
		const again = await w.attach(page);
		expect(w.manager.hostedGeneration(again.attachmentId)).toBe(4);
	});

	it("now and then is restarted every time", async () => {
		const w = world();
		const page = new FakePage(3);
		for (let i = 0; i < 4; i++) {
			await w.attach(page);
			w.hosts.at(-1)!.crash();
			w.advance(40_000);
		}
		expect(w.client.available).toBe(true);
	});
});
