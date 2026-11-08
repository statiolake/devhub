/**
 * The conversation engine and main's client of it, wired back to back as
 * the utility process wires them, with every message structured-cloned as
 * it would be crossing processes. The CLI is the permission fixture's,
 * scripted; its host is main's (an Agent on another machine), so the
 * journal's lines and the writes cross too.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../model/conversation.js";
import type { AgentId } from "../../model/domain.js";
import type { ConversationHost } from "../agent/conversation/conversation.js";
import { CACHE_KEEP_OFF } from "../agent/conversation/cacheKeeper.js";
import { ConversationRefused } from "../agent/conversation/failures.js";
import {
	HostLinkFailure,
	type JournalLine,
	type SentRecord,
} from "../agent/conversation/hostLink.js";
import type { CancellationToken } from "../terminal/ports.js";
import { EngineClient, type EngineProcess } from "./client.js";
import { ConversationEngine, type EnginePort } from "./engine.js";
import {
	errorFromWire,
	errorToWire,
	type EngineToPage,
	type FromEngine,
	type PageToEngine,
	type ToEngine,
} from "./protocol.js";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1" as AgentId;

const FIXTURE = readFileSync(
	join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"agent",
		"conversation",
		"fixtures",
		"claude-permission-turn.ndjson",
	),
	"utf8",
)
	.split("\n")
	.filter((line) => line.startsWith("> ") || line.startsWith("< "))
	.map((line) => ({
		side: line.startsWith(">") ? "sent" : "received",
		line: line.slice(2),
	}));

/** The fixture's CLI behind main's host: prints its lines up to the next one DevHub is to write. */
class ScriptedHost implements ConversationHost {
	readonly journal: JournalLine[] = [];
	readonly written: SentRecord[] = [];
	#next = 0;
	#size = 0;
	#wake: (() => void) | undefined;

	constructor() {
		this.#printUntilDevHub();
	}

	#printUntilDevHub(): void {
		while (
			this.#next < FIXTURE.length &&
			FIXTURE[this.#next]!.side === "received"
		) {
			const { line } = FIXTURE[this.#next]!;
			this.#size += Buffer.byteLength(`${line}\n`);
			this.journal.push({ line, offset: this.#size });
			this.#next += 1;
		}
		this.#wake?.();
	}

	async *lines(
		fromOffset: number,
		cancel: CancellationToken,
	): AsyncGenerator<JournalLine> {
		let index = this.journal.findIndex((each) => each.offset > fromOffset);
		if (index < 0) index = this.journal.length;
		while (!cancel.isCancelled) {
			if (index < this.journal.length) {
				yield this.journal[index++]!;
				continue;
			}
			await new Promise<void>((resolve) => {
				this.#wake = resolve;
				cancel.onCancelled(() => resolve());
			});
		}
	}

	async write(line: string, afterOffset: number): Promise<void> {
		const expected = FIXTURE[this.#next];
		if (expected?.side !== "sent")
			throw new Error(`the CLI did not expect a line, got ${line}`);
		expect(JSON.parse(line)).toEqual(JSON.parse(expected.line));
		this.written.push({ afterOffset, line });
		this.#next += 1;
		this.#printUntilDevHub();
	}

	restart(): Promise<void> {
		return Promise.reject(new Error("not in this test"));
	}

	sleep(): Promise<void> {
		return Promise.reject(new Error("not in this test"));
	}

	async sentLog(): Promise<readonly SentRecord[]> {
		return [...this.written];
	}

	async journalSize(): Promise<number> {
		return this.#size;
	}
}

/** A page's port: what the engine sent it, and a way to say something to the engine. */
function fakePort() {
	const received: EngineToPage[] = [];
	let listener: ((event: { data: unknown }) => void) | undefined;
	const port: EnginePort & {
		received: EngineToPage[];
		say: (message: PageToEngine) => void;
	} = {
		received,
		postMessage: (message) => received.push(structuredClone(message)),
		on: (event: string, given: unknown) => {
			if (event === "message")
				listener = given as (event: { data: unknown }) => void;
			return port;
		},
		start: () => undefined,
		close: () => undefined,
		say: (message) => listener?.({ data: structuredClone(message) }),
	};
	return port;
}

/** Engines started by the client, each its own `ConversationEngine` behind a cloning wire. */
function launcher() {
	const engines: { die: (code: number) => void; seen: ToEngine[] }[] = [];
	const launch = (): EngineProcess => {
		let toMain: ((message: FromEngine) => void) | undefined;
		let exit: ((code: number) => void) | undefined;
		let alive = true;
		const seen: ToEngine[] = [];
		const engine = new ConversationEngine({
			post: (message) => {
				const copy = structuredClone(message);
				setImmediate(() => {
					if (alive) toMain?.(copy);
				});
			},
			localRuntime: () => {
				throw new Error("no Agent on this machine in this test");
			},
		});
		engines.push({
			seen,
			die: (code) => {
				alive = false;
				exit?.(code);
			},
		});
		return {
			postMessage: (message, transfer) => {
				const copy = structuredClone(message);
				seen.push(copy);
				setImmediate(() => {
					if (alive) engine.receive(copy, (transfer ?? []) as EnginePort[]);
				});
			},
			onMessage: (listener) => {
				toMain = listener;
			},
			onExit: (listener) => {
				exit = listener;
			},
			kill: () => {
				alive = false;
			},
		};
	};
	return { engines, launch };
}

async function settle(): Promise<void> {
	for (let turn = 0; turn < 100; turn += 1)
		await new Promise((resolve) => setImmediate(resolve));
}

function wired(now: () => number = Date.now) {
	const { engines, launch } = launcher();
	const logged: string[] = [];
	const client = new EngineClient({
		launch,
		settings: () => ({
			limitResume: { enabled: false, message: "" },
			cacheKeep: CACHE_KEEP_OFF,
		}),
		log: (line) => logged.push(line),
		now,
	});
	const hosts: ScriptedHost[] = [];
	const records: unknown[] = [];
	const open = () => {
		const conversation = client.open(
			AGENT,
			{
				kind: "claude",
				bootId: "boot-a",
				cwd: "/home/testuser/project",
				clientVersion: "0.0.0-test",
				resumeThreadId: undefined,
				hostHere: false,
			},
			{
				prepareHost: () => Promise.reject(new Error("not on this machine")),
				host: () => {
					const host = new ScriptedHost();
					hosts.push(host);
					return host;
				},
				record: () => undefined,
				setRecord: (record) => records.push(record),
				instructions: () => undefined,
			},
		);
		conversation.start();
		return conversation;
	};
	return { client, engines, hosts, logged, open };
}

describe("a conversation in the engine", () => {
	it("follows main's host and tells main its facts, not its transcript", async () => {
		const { open, engines } = wired();
		const conversation = open();
		expect(conversation.facts().observation.status).not.toBe("idle");
		await settle();
		expect(conversation.facts().sessionId).toBe(
			"00000000-0000-4000-8000-000000000001",
		);
		expect(conversation.facts().observation).toMatchObject({
			status: "idle",
			failure: undefined,
		});
		const { transcript } = await conversation.snapshot();
		expect(transcript.session.sessionId).toBe(
			"00000000-0000-4000-8000-000000000001",
		);
		// What reached main from the engine: no events, no entries.
		expect(engines).toHaveLength(1);
	});

	it("carries a call out and gives its failure back as the same kind of failure", async () => {
		const { open, hosts } = wired();
		const conversation = open();
		await settle();
		await conversation.submit("Run pwd with Bash", []);
		await settle();
		expect(hosts[0]!.written.map((each) => JSON.parse(each.line).type)).toEqual(
			["control_request", "control_request", "user"],
		);
		const { transcript } = await conversation.snapshot();
		expect(transcript.requests).toHaveLength(1);
		const refused = await conversation
			.startEditingPending("nope" as never)
			.catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(ConversationRefused);
	});

	it("sends a page its snapshot and then its events over the page's port, in batches", async () => {
		const { client, open } = wired();
		const conversation = open();
		const port = fakePort();
		client.attachPage(port);
		await settle();
		port.say({ type: "attach", agentId: AGENT, rid: 1 });
		await settle();
		const attached = port.received[0];
		expect(attached).toMatchObject({ type: "attached", rid: 1 });
		const from = (attached as { revision: number }).revision;
		await conversation.submit("Run pwd with Bash", []);
		await settle();
		const events = port.received
			.slice(1)
			.flatMap((message) => (message.type === "events" ? message.batch : []));
		expect(events.length).toBeGreaterThan(3);
		expect(port.received.length).toBeLessThan(events.length + 1);
		expect(events.map(([, revision]) => revision)).toEqual(
			events.map((_, index) => from + 1 + index),
		);
		const types = events.map(
			([, , event]) => (event as ConversationEvent).type,
		);
		expect(types).toContain("request-opened");
	});

	it("answers an attach that overtook main's open once the conversation is open", async () => {
		const { client, open } = wired();
		const port = fakePort();
		client.attachPage(port);
		await settle();
		port.say({ type: "attach", agentId: AGENT, rid: 7 });
		await settle();
		expect(port.received).toEqual([]);
		open();
		await settle();
		expect(port.received[0]).toMatchObject({ type: "attached", rid: 7 });
	});
});

describe("an engine that ends", () => {
	it("fails what it held, reads as nobody following, and is started again with every conversation", async () => {
		const { client, engines, open } = wired();
		let restarted = 0;
		client.onRestarted(() => {
			restarted += 1;
		});
		const conversation = open();
		await settle();
		const held = conversation.snapshot();
		engines[0]!.die(9);
		await expect(held).rejects.toThrow(/exit code 9/);
		expect(conversation.facts().observation).toMatchObject({
			status: "unknown",
			failure: { code: "conversation_host_lost" },
		});
		expect(restarted).toBe(1);
		expect(engines).toHaveLength(2);
		expect(engines[1]!.seen.map((message) => message.type)).toEqual([
			"settings",
			"open",
		]);
		await settle();
		// The new engine replayed the journal: the conversation is as it was.
		expect(conversation.facts().observation).toMatchObject({
			status: "idle",
			failure: undefined,
		});
		const { transcript } = await conversation.snapshot();
		expect(transcript.session.sessionId).toBe(
			"00000000-0000-4000-8000-000000000001",
		);
	});

	it("is given up on after ending three times in a minute", async () => {
		let at = 0;
		const { client, engines, logged, open } = wired(() => at);
		let gaveUp = 0;
		client.onGaveUp(() => {
			gaveUp += 1;
		});
		open();
		await settle();
		engines[0]!.die(1);
		at += 1000;
		engines[1]!.die(1);
		at += 1000;
		engines[2]!.die(1);
		expect(gaveUp).toBe(1);
		expect(client.available).toBe(false);
		expect(engines).toHaveLength(3);
		expect(logged.at(-1)).toMatch(/run in main from now on/);
	});

	it("is started again without limit when its ends are a minute apart", () => {
		let at = 0;
		const { client, engines, open } = wired(() => at);
		open();
		for (let n = 0; n < 5; n += 1) {
			engines.at(-1)!.die(1);
			at += 61_000;
		}
		expect(client.available).toBe(true);
		expect(engines).toHaveLength(6);
	});
});

describe("a failure crossing the wire", () => {
	it("keeps its class, its words and, for the host link, its code and offset", () => {
		const link = errorFromWire(
			structuredClone(
				errorToWire(new HostLinkFailure("stream_lost", "gone", 120)),
			),
		);
		expect(link).toBeInstanceOf(HostLinkFailure);
		expect(link).toMatchObject({ code: "stream_lost", offset: 120 });
		const refused = errorFromWire(
			structuredClone(errorToWire(new ConversationRefused("Not now."))),
		);
		expect(refused).toBeInstanceOf(ConversationRefused);
		expect(refused).toEqual(new ConversationRefused("Not now."));
		const plain = errorFromWire(
			structuredClone(errorToWire(new TypeError("odd"))),
		);
		expect(plain).toMatchObject({ name: "TypeError", message: "odd" });
	});
});
