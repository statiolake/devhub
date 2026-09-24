/**
 * One conversation, followed live and attached again after a restart.
 *
 * The host here is a fake with the real contract's shape — a journal that
 * grows, an `in.log` that records the offset each write followed — and a
 * scripted CLI behind it that prints the permission fixture's lines one
 * exchange at a time, checking each line DevHub writes against the one the
 * fixture recorded. The adapter is the real Claude adapter.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	EMPTY_TRANSCRIPT,
	applyEvent,
	requestId,
	type ConversationEvent,
	type Transcript,
} from "../../../model/conversation.js";
import { CancellationToken } from "../../terminal/ports.js";
import { ClaudeAdapter } from "./claude/adapter.js";
import { AgentConversation, type ConversationHost } from "./conversation.js";
import {
	HostLinkFailure,
	type JournalLine,
	type SentRecord,
} from "./hostLink.js";

const FIXTURE = readFileSync(
	join(
		dirname(fileURLToPath(import.meta.url)),
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

/** A journal and an `in.log`, with the host's contract and none of its processes. */
class FakeHost implements ConversationHost {
	readonly journal: JournalLine[] = [];
	readonly inLog: SentRecord[] = [];
	#size = 0;
	#wake: (() => void) | undefined;
	/** Called with each written line; a scripted CLI answers through `print`. */
	onWrite: (line: string) => void = () => undefined;
	/** The next `lines` stream fails after this many lines, once. */
	failAfter: number | undefined;
	/** The next write fails. */
	refuseWrite = false;

	print(line: string): void {
		this.#size += Buffer.byteLength(`${line}\n`);
		this.journal.push({ line, offset: this.#size });
		this.#wake?.();
	}

	async *lines(
		fromOffset: number,
		cancel: CancellationToken,
	): AsyncGenerator<JournalLine> {
		let index = this.journal.findIndex((each) => each.offset > fromOffset);
		if (index < 0) index = this.journal.length;
		let delivered = 0;
		while (!cancel.isCancelled) {
			if (index < this.journal.length) {
				if (this.failAfter !== undefined && delivered === this.failAfter) {
					this.failAfter = undefined;
					throw new HostLinkFailure(
						"stream_lost",
						"the fake stream dropped",
						fromOffset,
					);
				}
				delivered += 1;
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
		await Promise.resolve();
		if (this.refuseWrite) {
			this.refuseWrite = false;
			throw new HostLinkFailure(
				"host_gone",
				"the fake host has ended",
				undefined,
			);
		}
		this.inLog.push({ afterOffset, line });
		this.onWrite(line);
	}

	async sentLog(): Promise<readonly SentRecord[]> {
		return [...this.inLog];
	}
}

/** Prints the fixture's CLI lines up to the next line DevHub is to write, and checks that line when it comes. */
function scriptedCli(host: FakeHost): { readonly remaining: () => number } {
	let next = 0;
	const printUntilDevHub = () => {
		while (next < FIXTURE.length && FIXTURE[next]!.side === "received") {
			host.print(FIXTURE[next]!.line);
			next += 1;
		}
	};
	host.onWrite = (line) => {
		const expected = FIXTURE[next];
		if (expected?.side !== "sent")
			throw new Error(`the CLI did not expect a line, got ${line}`);
		expect(JSON.parse(line)).toEqual(JSON.parse(expected.line));
		next += 1;
		printUntilDevHub();
	};
	return { remaining: () => FIXTURE.length - next };
}

async function settle(): Promise<void> {
	for (let turn = 0; turn < 50; turn += 1)
		await new Promise((resolve) => setImmediate(resolve));
}

function recording(): {
	readonly events: { revision: number; event: ConversationEvent }[];
	readonly publish: (revision: number, event: ConversationEvent) => void;
} {
	const events: { revision: number; event: ConversationEvent }[] = [];
	return {
		events,
		publish: (revision, event) => events.push({ revision, event }),
	};
}

/** The permission fixture, lived through: greeted, asked, allowed. */
async function liveTurn(): Promise<{
	host: FakeHost;
	conversation: AgentConversation;
	events: ReturnType<typeof recording>["events"];
}> {
	const host = new FakeHost();
	const cli = scriptedCli(host);
	const { events, publish } = recording();
	const conversation = new AgentConversation(
		host,
		new ClaudeAdapter("boot-a"),
		publish,
	);
	conversation.start();
	await settle();
	await conversation.command({
		kind: "send",
		text: "Run pwd with Bash",
		origin: "person",
	});
	await settle();
	expect(
		conversation.reading().transcript.requests.map((each) => each.id),
	).toEqual(["perm-1"]);
	await conversation.command({
		kind: "answer",
		request: requestId("perm-1"),
		answer: { kind: "choice", choiceId: "allow", text: undefined },
	});
	await settle();
	expect(cli.remaining()).toBe(0);
	return { host, conversation, events };
}

describe("a conversation followed live", () => {
	it("greets the CLI, takes its lines and DevHub's in their order, and ends idle", async () => {
		const { host, conversation } = await liveTurn();
		const { transcript, lost } = conversation.reading();
		expect(lost).toBeUndefined();
		expect(transcript.state).toEqual({ phase: "ready", turn: "none" });
		expect(transcript.requests).toEqual([]);
		expect(transcript.entries.map((each) => each.id)).toEqual([
			"user:00000000-0000-4000-8000-0000000000a1",
			"assistant:msg_01:0",
			"tool:toolu_01",
			"assistant:msg_02:0",
			"turn:1",
		]);
		// Each write names how far into the journal the conversation was.
		expect(host.inLog.map((each) => each.afterOffset)).toEqual([
			0,
			host.journal[1]!.offset,
			host.journal.find((each) => each.line.includes("can_use_tool"))!.offset,
		]);
		await conversation.stop();
	});

	it("publishes every event numbered, and they fold to the transcript it holds", async () => {
		const { conversation, events } = await liveTurn();
		expect(events.map((each) => each.revision)).toEqual(
			events.map((_, index) => index + 1),
		);
		const folded = events.reduce<Transcript>(
			(transcript, { event }) => applyEvent(transcript, event),
			EMPTY_TRANSCRIPT,
		);
		expect(folded).toEqual(conversation.snapshot().transcript);
		expect(conversation.snapshot().revision).toBe(events.length);
		await conversation.stop();
	});
});

describe("a conversation attached again after DevHub restarts", () => {
	it("replays to the transcript the live conversation had, without greeting the CLI again", async () => {
		const { host, conversation } = await liveTurn();
		const live = conversation.reading().transcript;
		await conversation.stop();
		const writes = host.inLog.length;

		const again = new AgentConversation(
			host,
			new ClaudeAdapter("boot-b"),
			() => undefined,
		);
		again.start();
		await settle();
		expect(again.reading().transcript).toEqual(live);
		expect(host.inLog).toHaveLength(writes);
		await again.stop();
	});

	it("replays a request as still open when DevHub had not answered it", async () => {
		const host = new FakeHost();
		scriptedCli(host);
		const conversation = new AgentConversation(
			host,
			new ClaudeAdapter("boot-a"),
			() => undefined,
		);
		conversation.start();
		await settle();
		await conversation.command({
			kind: "send",
			text: "Run pwd with Bash",
			origin: "person",
		});
		await settle();
		await conversation.stop();

		const again = new AgentConversation(
			host,
			new ClaudeAdapter("boot-b"),
			() => undefined,
		);
		again.start();
		await settle();
		expect(again.reading().transcript.requests.map((each) => each.id)).toEqual([
			"perm-1",
		]);
		await again.stop();
	});
});

describe("a command", () => {
	it("that could not be written is refused and leaves no trace", async () => {
		const host = new FakeHost();
		scriptedCli(host);
		const conversation = new AgentConversation(
			host,
			new ClaudeAdapter("boot-a"),
			() => undefined,
		);
		conversation.start();
		await settle();
		const before = conversation.snapshot();
		host.refuseWrite = true;
		await expect(
			conversation.command({
				kind: "send",
				text: "Run pwd with Bash",
				origin: "person",
			}),
		).rejects.toThrow(HostLinkFailure);
		expect(conversation.snapshot()).toEqual(before);
		await conversation.stop();
	});
});

describe("a line the adapter cannot read", () => {
	it("breaks the conversation where it lands: shown, and no further input taken", async () => {
		const host = new FakeHost();
		const { events, publish } = recording();
		const conversation = new AgentConversation(
			host,
			new ClaudeAdapter("boot-a"),
			publish,
		);
		conversation.start();
		await settle();
		host.print(
			'{"type":"assistant","message":{"id":"m","content":"not an array"}}',
		);
		await settle();
		const { state } = conversation.reading().transcript;
		expect(state).toEqual({
			phase: "broken",
			failure: {
				code: "protocol_mismatch",
				detail: "assistant.message.content: expected an array",
			},
		});
		expect(events.at(-1)?.event).toEqual({ type: "state", state });
		await expect(conversation.command({ kind: "interrupt" })).rejects.toThrow(
			/stopped taking input: assistant.message.content/,
		);
		await conversation.stop();
	});
});

describe("a journal stream that is lost", () => {
	it("is read as lost, and attaching again continues from where it stopped", async () => {
		const host = new FakeHost();
		const conversation = new AgentConversation(
			host,
			new ClaudeAdapter("boot-a"),
			() => undefined,
		);
		host.failAfter = 1;
		host.print(
			JSON.stringify({
				type: "system",
				subtype: "init",
				session_id: "s",
				cwd: "/w",
				model: "m",
			}),
		);
		host.print(JSON.stringify({ type: "hologram" }));
		conversation.start();
		await settle();
		expect(conversation.reading().lost?.code).toBe("stream_lost");
		expect(conversation.reading().transcript.session.sessionId).toBe("s");
		expect(conversation.reading().transcript.entries).toEqual([]);

		conversation.reattach();
		await settle();
		expect(conversation.reading().lost).toBeUndefined();
		// The second line, once — neither lost nor repeated.
		expect(
			conversation.reading().transcript.entries.map((each) => each.kind),
		).toEqual(["notice"]);
		await conversation.stop();
	});
});

describe("a failure that is neither the host's nor the protocol's", () => {
	it("is thrown by the reading, so the round that asks fails with it", async () => {
		const host = new FakeHost();
		host.sentLog = () => Promise.reject(new TypeError("a bug of DevHub's own"));
		const conversation = new AgentConversation(
			host,
			new ClaudeAdapter("boot-a"),
			() => undefined,
		);
		conversation.start();
		await settle();
		expect(() => conversation.reading()).toThrow(/a bug of DevHub's own/);
		await conversation.stop();
	});
});

describe("a reply the protocol demands", () => {
	it("is not written again when the line that demanded it is replayed", async () => {
		const host = new FakeHost();
		const hook = JSON.stringify({
			type: "control_request",
			request_id: "c1",
			request: { subtype: "hook_callback" },
		});
		const live = new AgentConversation(
			host,
			new ClaudeAdapter("boot-a"),
			() => undefined,
		);
		live.start();
		await settle();
		host.print(hook);
		await settle();
		await live.stop();
		const written = host.inLog.length;

		const again = new AgentConversation(
			host,
			new ClaudeAdapter("boot-b"),
			() => undefined,
		);
		again.start();
		await settle();
		expect(host.inLog).toHaveLength(written);
		await again.stop();
	});

	it("is written when DevHub stopped before it answered", async () => {
		const host = new FakeHost();
		const live = new AgentConversation(
			host,
			new ClaudeAdapter("boot-a"),
			() => undefined,
		);
		live.start();
		await settle();
		await live.stop();
		// Printed while no DevHub was following: nobody has answered it yet.
		host.print(
			JSON.stringify({
				type: "control_request",
				request_id: "c2",
				request: { subtype: "hook_callback" },
			}),
		);

		const again = new AgentConversation(
			host,
			new ClaudeAdapter("boot-b"),
			() => undefined,
		);
		again.start();
		await settle();
		expect(JSON.parse(host.inLog.at(-1)!.line)).toMatchObject({
			response: { subtype: "error", request_id: "c2" },
		});
		await again.stop();
	});

	it("is written at once", async () => {
		const host = new FakeHost();
		const conversation = new AgentConversation(
			host,
			new ClaudeAdapter("boot-a"),
			() => undefined,
		);
		conversation.start();
		await settle();
		host.print(
			JSON.stringify({
				type: "control_request",
				request_id: "c1",
				request: { subtype: "hook_callback" },
			}),
		);
		await settle();
		expect(JSON.parse(host.inLog.at(-1)!.line)).toMatchObject({
			type: "control_response",
			response: { subtype: "error", request_id: "c1" },
		});
		await conversation.stop();
	});
});
