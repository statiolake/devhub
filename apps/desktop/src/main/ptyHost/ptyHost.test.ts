/**
 * The pty host end to end, in one process: main's ledger
 * (`AttachmentManager`), main's side of the host (`PtyHostClient`) and the
 * host's work (`PtyHost`), wired by fake ports and a fake utility process, on
 * fake PTYs. What a page sees is what arrives on the port main handed it.
 */

import { describe, expect, it } from "vitest";

import {
	TERMINAL_CHANNELS,
	TERMINAL_PROTOCOL_VERSION,
	TerminalFailure,
	decodeTerminalFrame,
	type TerminalFrame,
	type TerminalResult,
} from "../../ipc/terminal.js";
import { AttachmentManager } from "../terminal/attachments.js";
import { CancellationToken, workspaceTarget } from "../terminal/ports.js";
import type { Pty, PtyLaunch } from "../terminal/pty.js";
import {
	PtyHostClient,
	type HostedPage,
	type PtyHostProcess,
} from "./client.js";
import { PtyHost, type HostPort } from "./host.js";
import type { FromPtyHost, PtyHostToPage, ToPtyHost } from "./protocol.js";

class FakePty implements Pty {
	readonly pid = 7;
	readonly written: string[] = [];
	readonly resizes: number[][] = [];
	killed = false;
	#data: ((bytes: Uint8Array) => void) | undefined;
	#exit: (() => void) | undefined;
	constructor(readonly launch: PtyLaunch) {}
	onData(listener: (bytes: Uint8Array) => void) {
		this.#data = listener;
	}
	onExit(listener: () => void) {
		this.#exit = listener;
	}
	write(bytes: Uint8Array) {
		this.written.push(new TextDecoder().decode(bytes));
	}
	resize(size: { cols: number; rows: number }) {
		this.resizes.push([size.cols, size.rows]);
	}
	kill() {
		this.killed = true;
	}
	pause() {}
	resume() {}
	emit(text: string) {
		this.#data?.(new TextEncoder().encode(text));
	}
	end() {
		this.#exit?.();
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
	readonly frames = new Map<string, TerminalFrame[]>();
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
			if (data.type === "control") return;
			const list = this.frames.get(data.channelId) ?? [];
			list.push(decodeTerminalFrame(data.frame));
			this.frames.set(data.channelId, list);
		}) as never);
	}
	send(channelName: string, ...args: unknown[]) {
		this.sent.push([channelName, args[0]]);
	}
	request(
		type: "input" | "resize" | "ack",
		request: unknown,
	): Promise<TerminalResult<void>> {
		const port = this.ports.at(-1)!.port;
		const rid = this.#nextRid++;
		return new Promise((resolve) => {
			this.#replies.set(rid, resolve);
			port.postMessage({ type, rid, request });
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
	const ptys: FakePty[] = [];
	const hosts: { host: PtyHost; crash: (code?: number) => void }[] = [];
	const launch = (): PtyHostProcess => {
		const toMain: ((message: FromPtyHost) => void)[] = [];
		const exits: ((code: number) => void)[] = [];
		let dead = false;
		const host = new PtyHost({
			post: (message) =>
				setTimeout(() => {
					if (!dead) for (const listener of toMain) listener(message);
				}, 0),
			spawn: (ptyLaunch) => {
				if (ptyLaunch.file === "/missing") throw new Error("no such file");
				const pty = new FakePty(ptyLaunch);
				ptys.push(pty);
				return pty;
			},
		});
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
	const mainFrames: TerminalFrame[] = [];
	let counter = 0;
	const localPtys: FakePty[] = [];
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
			return await manager.attachVia(permit, {
				surfaceKey: SURFACE,
				viewLabel: String(page.id),
				target: TARGET,
				spawn: (ptyLaunch) => {
					const pty = new FakePty(ptyLaunch);
					localPtys.push(pty);
					return pty;
				},
				plan: (ptyLaunch) => ({
					launch: { ...ptyLaunch, file },
					ended: () => plansEnded.push(file),
				}),
				file,
				args: ["attach-session", "-t", "ws"],
				cwd: "/",
				environment: {},
				size: { cols: 80, rows: 24, pixelWidth: 0, pixelHeight: 0 },
				sink: (frame) => {
					mainFrames.push(frame);
					return true;
				},
				route: { page, channelId },
			});
		} finally {
			permit.release();
		}
	};
	return {
		ptys,
		localPtys,
		hosts,
		client,
		manager,
		attach,
		logs,
		endedByItself,
		plansEnded,
		mainFrames,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

const identity = (receipt: {
	attachmentId: string;
	targetGeneration: number;
}) => ({
	schemaVersion: TERMINAL_PROTOCOL_VERSION,
	surfaceKey: SURFACE,
	attachmentId: receipt.attachmentId,
	targetGeneration: receipt.targetGeneration,
});

describe("a terminal client in the pty host", () => {
	it("is started there, and its frames and input pass between the page and the host only", async () => {
		const w = world();
		const page = new FakePage(3);
		const receipt = await w.attach(page);
		expect(w.manager.hostedGeneration(receipt.attachmentId)).toBe(1);
		// The port came before the answer, and the client is the host's.
		expect(page.ports.map((p) => p.generation)).toEqual([1]);
		expect(w.ptys).toHaveLength(1);
		expect(w.localPtys).toHaveLength(0);
		await settle();
		w.ptys[0]!.emit("hello");
		await settle();
		const frames = page.frames.get("c1")!;
		expect(frames.map((frame) => frame.type)).toEqual(["started", "output"]);
		expect(frames[0]).toMatchObject({
			attachmentId: receipt.attachmentId,
			surfaceKey: SURFACE,
		});
		const input = await page.request("input", {
			...identity(receipt),
			inputSequence: 1,
			bytes: [...new TextEncoder().encode("ls\r")],
		});
		expect(input).toEqual({ ok: true, value: undefined });
		expect(w.ptys[0]!.written).toEqual(["ls\r"]);
		const ack = await page.request("ack", {
			...identity(receipt),
			sequence: 1,
		});
		expect(ack.ok).toBe(true);
		// Nothing of it went through main's frame path.
		expect(w.mainFrames).toEqual([]);
	});

	it("refuses a request for a client the page was not given", async () => {
		const w = world();
		const page = new FakePage(3);
		const receipt = await w.attach(page);
		await settle();
		const wrong = await page.request("input", {
			...identity(receipt),
			targetGeneration: receipt.targetGeneration + 1,
			inputSequence: 1,
			bytes: [65],
		});
		expect(wrong).toMatchObject({
			ok: false,
			error: { code: "wrong_attachment" },
		});
		const other = new FakePage(4);
		await w.attach(other, "c9");
		await settle();
		// The other page's port, with the first page's handle.
		const stolen = await other.request("input", {
			...identity(receipt),
			inputSequence: 1,
			bytes: [65],
		});
		expect(stolen.ok).toBe(false);
		expect(w.ptys[0]!.written).toEqual([]);
	});

	it("is ended in the host when main's ledger detaches it, and gives back what its machine held", async () => {
		const w = world();
		const page = new FakePage(3);
		const receipt = await w.attach(page);
		w.manager.detach({ ...identity(receipt), viewLabel: "3" });
		expect(w.manager.count).toBe(0);
		await settle();
		expect(w.ptys[0]!.killed).toBe(true);
		expect(page.frames.get("c1")!.at(-1)).toMatchObject({
			type: "exited",
			reason: "detached",
		});
		expect(w.plansEnded).toEqual(["/tmux"]);
		expect(w.endedByItself).toEqual([]);
	});

	it("says when it ended on its own, as a client in main did", async () => {
		const w = world();
		const page = new FakePage(3);
		await w.attach(page);
		w.ptys[0]!.end();
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
		expect(w.ptys[0]!.killed).toBe(true);
		expect(w.manager.count).toBe(0);
	});

	it("that could not be opened is refused as main refused it, with the frames that say so", async () => {
		const w = world();
		const page = new FakePage(3);
		await expect(w.attach(page, "c1", "/missing")).rejects.toMatchObject({
			code: "pty_unavailable",
		});
		await settle();
		expect(page.frames.get("c1")!.map((frame) => frame.type)).toEqual([
			"error",
			"exited",
		]);
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

	it("three times in a minute, clients start in main from then on", async () => {
		const w = world();
		const page = new FakePage(3);
		for (let i = 0; i < 3; i++) {
			await w.attach(page);
			w.hosts.at(-1)!.crash();
			w.advance(1_000);
		}
		expect(w.client.available).toBe(false);
		expect(w.logs.join("\n")).toMatch(/3 times in a minute/u);
		const receipt = await w.attach(page);
		expect(w.manager.hostedGeneration(receipt.attachmentId)).toBeUndefined();
		expect(w.localPtys).toHaveLength(1);
		expect(w.mainFrames[0]).toMatchObject({ type: "started" });
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
