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
	entryId,
	rewindTargets,
	requestId,
	type ConversationEvent,
	type Transcript,
} from "../../../model/conversation.js";
import { errorWire } from "../../../model/wire.js";
import { CancellationToken } from "../../terminal/ports.js";
import { ClaudeAdapter } from "./claude/adapter.js";
import {
	HandClock,
	memoryRecords,
	RESUME_OFF,
	RESUME_ON,
	resumeOff,
} from "./limitResumeTestKit.js";
import {
	RESET_MARGIN_MS,
	SOONEST_MS,
	type LimitResumeSettings,
} from "./limitResume.js";
import {
	AgentConversation,
	openedLater,
	type ConversationHost,
} from "./conversation.js";
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
	/** Called for a restart, after the mark is in the journal as the real host puts it. */
	onRestart: (args: readonly string[]) => void = () => undefined;
	readonly restarts: {
		args: readonly string[];
		mark: readonly string[];
	}[] = [];
	/** The next restart fails. */
	refuseRestart = false;
	/** The next `lines` stream fails after this many lines, once. */
	failAfter: number | undefined;
	/** The next write fails. */
	refuseWrite = false;
	/** Writes return a turn of the event loop after the CLI has taken them, as a real exec does. */
	slowWrites = false;

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
		if (this.slowWrites) await new Promise((resolve) => setImmediate(resolve));
	}

	async restart(
		args: readonly string[],
		mark: readonly string[],
	): Promise<void> {
		await Promise.resolve();
		if (this.refuseRestart) {
			this.refuseRestart = false;
			throw new HostLinkFailure(
				"write_failed",
				"the fake host did not start its CLI again",
				undefined,
			);
		}
		this.restarts.push({ args, mark });
		for (const line of mark) this.print(line);
		this.onRestart(args);
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
		resumeOff(),
	);
	conversation.start();
	await settle();
	await conversation.command({
		kind: "send",
		images: [],
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
		const after = (text: string) =>
			host.journal.find((each) => each.line.includes(text))!.offset;
		expect(host.inLog.map((each) => each.afterOffset)).toEqual([
			0,
			after('"commands"'),
			after('"subtype":"init"'),
			after("can_use_tool"),
			after('"type":"result"'),
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
			resumeOff(),
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
			resumeOff(),
		);
		conversation.start();
		await settle();
		await conversation.command({
			kind: "send",
			images: [],
			text: "Run pwd with Bash",
			origin: "person",
		});
		await settle();
		await conversation.stop();

		const again = new AgentConversation(
			host,
			new ClaudeAdapter("boot-b"),
			() => undefined,
			resumeOff(),
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
			resumeOff(),
		);
		conversation.start();
		await settle();
		const before = conversation.snapshot();
		host.refuseWrite = true;
		await expect(
			conversation.command({
				kind: "send",
				images: [],
				text: "Run pwd with Bash",
				origin: "person",
			}),
		).rejects.toThrow(HostLinkFailure);
		expect(conversation.snapshot()).toEqual(before);
		await conversation.stop();
	});
});

describe("a setting chosen", () => {
	it("writes the lines that set it and takes them back as sent, so the CLI's answer is expected", async () => {
		const host = new FakeHost();
		const conversation = new AgentConversation(
			host,
			new ClaudeAdapter("boot-a"),
			() => undefined,
			resumeOff(),
		);
		conversation.start();
		await settle();
		await conversation.configure("model", "opus");
		expect(JSON.parse(host.inLog.at(-1)!.line)).toEqual({
			type: "control_request",
			request_id: "boot-a:2",
			request: { subtype: "set_model", model: "opus" },
		});
		host.print(
			JSON.stringify({
				type: "control_response",
				response: { subtype: "success", request_id: "boot-a:2" },
			}),
		);
		await settle();
		expect(conversation.reading().transcript.session.model.current).toBe(
			"opus",
		);
		await conversation.stop();
	});
});

describe("a line printed while DevHub's write is still in flight", () => {
	it("is fed only after that write has been taken back as sent, so an answer never precedes its question", async () => {
		const host = new FakeHost();
		const conversation = new AgentConversation(
			host,
			new ClaudeAdapter("boot-a"),
			() => undefined,
			resumeOff(),
		);
		conversation.start();
		await settle();
		// The CLI answers inside the write, before the write has returned: the
		// journal has the answer before the caller could have called `sent`.
		host.slowWrites = true;
		host.onWrite = (line) => {
			const { request_id } = JSON.parse(line) as { request_id: string };
			host.print(
				JSON.stringify({
					type: "control_response",
					response: { subtype: "success", request_id },
				}),
			);
		};
		await conversation.configure("mode", "plan");
		await settle();
		const { transcript } = conversation.reading();
		expect(transcript.state.phase).not.toBe("broken");
		expect(transcript.session.mode.current).toBe("plan");
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
			resumeOff(),
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
		expect(
			await drawnAs(conversation.command({ kind: "interrupt" })),
		).toMatchObject({
			code: "conversation_stopped",
			detail: expect.stringMatching(
				/stopped taking input: assistant.message.content/,
			) as string,
		});
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
			resumeOff(),
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

describe("a host that could not be opened", () => {
	it("is this Agent's failure, read from its conversation, and not a round's", async () => {
		const conversation = new AgentConversation(
			openedLater(() => Promise.reject(new Error("the machine has no home"))),
			new ClaudeAdapter("boot-a"),
			() => undefined,
			resumeOff(),
		);
		conversation.start();
		await settle();
		expect(conversation.reading().crashed?.message).toBe(
			"the machine has no home",
		);
		await conversation.stop();
	});

	it("is opened once, by the first thing that needs it", async () => {
		const host = new FakeHost();
		let opened = 0;
		const conversation = new AgentConversation(
			openedLater(() => {
				opened += 1;
				return Promise.resolve(host);
			}),
			new ClaudeAdapter("boot-a"),
			() => undefined,
			resumeOff(),
		);
		conversation.start();
		await settle();
		host.print(JSON.stringify({ type: "hologram" }));
		await settle();
		expect(opened).toBe(1);
		expect(conversation.reading().transcript.entries).toHaveLength(1);
		await conversation.stop();
	});
});

describe("a failure that is neither the host's nor the protocol's", () => {
	it("stops the conversation and is read as a failure of this Agent, not of the round", async () => {
		const host = new FakeHost();
		host.sentLog = () => Promise.reject(new TypeError("a bug of DevHub's own"));
		const conversation = new AgentConversation(
			host,
			new ClaudeAdapter("boot-a"),
			() => undefined,
			resumeOff(),
		);
		conversation.start();
		await settle();
		const reading = conversation.reading();
		expect(reading.crashed).toBeInstanceOf(TypeError);
		expect(reading.crashed?.message).toBe("a bug of DevHub's own");
		// It does not start again on its own, and it takes no input.
		conversation.reattach();
		await expect(conversation.command({ kind: "interrupt" })).rejects.toThrow(
			/a bug of DevHub's own/,
		);
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
			resumeOff(),
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
			resumeOff(),
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
			resumeOff(),
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
			resumeOff(),
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
			resumeOff(),
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

/**
 * A Claude new enough to resume at a message, answering each message with
 * one line of its own; `hold` keeps it from ending the turn.
 */
function answeringCli(host: FakeHost, version = "2.1.282"): { hold: boolean } {
	const cli = { hold: false };
	let said = 0;
	let started = false;
	const print = (value: unknown) => host.print(JSON.stringify(value));
	host.onWrite = (line) => {
		const message = JSON.parse(line) as {
			type: string;
			request_id?: string;
			request?: { subtype: string };
			message?: { content: string };
		};
		if (message.type === "control_request") {
			print({
				type: "control_response",
				response: {
					subtype: "success",
					request_id: message.request_id,
					response:
						message.request?.subtype === "mcp_status"
							? { mcpServers: [] }
							: { commands: [], models: [] },
				},
			});
			return;
		}
		if (message.type !== "user") return;
		said += 1;
		if (!started) {
			started = true;
			print({
				type: "system",
				subtype: "init",
				session_id: "s-1",
				cwd: "/home/testuser/project",
				model: "claude-sonnet-5",
				permissionMode: "default",
				slash_commands: [],
				claude_code_version: version,
			});
		}
		print({
			type: "user",
			message: { role: "user", content: message.message!.content },
			parent_tool_use_id: null,
			session_id: "s-1",
			uuid: `u${said}`,
		});
		print({
			type: "assistant",
			message: {
				id: `msg_${said}`,
				role: "assistant",
				content: [{ type: "text", text: `answer ${said}` }],
			},
			parent_tool_use_id: null,
			session_id: "s-1",
			uuid: `a${said}`,
		});
		if (cli.hold) return;
		print({
			type: "result",
			subtype: "success",
			is_error: false,
			duration_ms: 100,
			result: "done",
			session_id: "s-1",
		});
	};
	host.onRestart = () => {
		started = false;
	};
	return cli;
}

async function turns(
	texts: readonly string[],
	version?: string,
): Promise<{
	host: FakeHost;
	conversation: AgentConversation;
	cli: { hold: boolean };
}> {
	const host = new FakeHost();
	const cli = answeringCli(host, version);
	const conversation = new AgentConversation(
		host,
		new ClaudeAdapter("boot-a"),
		() => undefined,
		resumeOff(),
	);
	conversation.start();
	await settle();
	for (const text of texts) {
		await conversation.submit(text, []);
		await settle();
	}
	return { host, conversation, cli };
}

const ids = (conversation: AgentConversation) =>
	conversation.reading().transcript.entries.map((each) => each.id);

const endTurn = (host: FakeHost) =>
	host.print(
		JSON.stringify({
			type: "result",
			subtype: "success",
			is_error: false,
			duration_ms: 100,
			result: "done",
			session_id: "s-1",
		}),
	);

describe("rewinding", () => {
	it("goes back to before an earlier message, dropping every turn from it on, and replays to the same after a restart of DevHub", async () => {
		const { host, conversation } = await turns(["first", "second", "third"]);
		expect([...rewindTargets(conversation.reading().transcript)]).toEqual([
			"user:u1",
			"user:u2",
			"user:u3",
		]);

		expect(await conversation.rewind(entryId("user:u2"))).toBe("rewound");
		await settle();
		expect(host.restarts).toEqual([
			{
				args: ["--resume", "s-1", "--resume-session-at", "a1"],
				mark: [JSON.stringify({ type: "devhub_rewind", message: "user:u2" })],
			},
		]);
		expect(ids(conversation)).toEqual([
			"user:u1",
			"assistant:msg_1:0",
			"turn:1",
		]);
		await conversation.submit("second, better", []);
		await settle();
		expect(ids(conversation)).toEqual([
			"user:u1",
			"assistant:msg_1:0",
			"turn:1",
			"user:u4",
			"assistant:msg_4:0",
			"turn:4",
		]);
		const live = conversation.reading().transcript;
		await conversation.stop();

		const writes = host.inLog.length;
		const again = new AgentConversation(
			host,
			new ClaudeAdapter("boot-b"),
			() => undefined,
			resumeOff(),
		);
		again.start();
		await settle();
		expect(again.reading().transcript).toEqual(live);
		expect(host.inLog).toHaveLength(writes);
		await again.stop();
	});

	it("refuses while a turn runs, saying to stop it first, and writes nothing", async () => {
		const { host, conversation, cli } = await turns(["first", "second"]);
		cli.hold = true;
		await conversation.submit("third", []);
		await settle();
		const writes = host.inLog.length;
		expect(
			await drawnAs(conversation.rewind(entryId("user:u1"))),
		).toMatchObject({
			code: "conversation_refused",
			detail: expect.stringContaining("Stop it before rewinding.") as string,
		});
		expect(host.inLog).toHaveLength(writes);
		expect(host.restarts).toEqual([]);
		await conversation.stop();
	});

	it("refuses when the CLI cannot take turns back", async () => {
		const { host, conversation } = await turns(["first", "second"], "2.1.0");
		expect(
			await drawnAs(conversation.rewind(entryId("user:u2"))),
		).toMatchObject({
			code: "conversation_refused",
			detail: expect.stringContaining(
				"This Agent's CLI cannot take turns back",
			) as string,
		});
		expect(host.restarts).toEqual([]);
		await conversation.stop();
	});

	it("refuses while messages of the person's are held", async () => {
		const { host, conversation, cli } = await turns(["first"]);
		cli.hold = true;
		await conversation.submit("second", []);
		await settle();
		await conversation.submit("held", []);
		// Its write fails as the turn ends: idle, with a message held.
		host.refuseWrite = true;
		endTurn(host);
		await settle();
		expect(conversation.reading().transcript.pending).toHaveLength(1);
		expect(
			await drawnAs(conversation.rewind(entryId("user:u1"))),
		).toMatchObject({
			code: "conversation_refused",
			detail: expect.stringContaining(
				"Send or remove them before rewinding.",
			) as string,
		});
		await conversation.stop();
	});

	it("is the rewind's failure when the host does not start the CLI again, and leaves the conversation usable", async () => {
		const { host, conversation } = await turns(["first", "second"]);
		host.refuseRestart = true;
		await expect(conversation.rewind(entryId("user:u2"))).rejects.toThrow(
			"the fake host did not start its CLI again",
		);
		expect(ids(conversation)).toContain("user:u2");
		await conversation.submit("third", []);
		await settle();
		expect(ids(conversation)).toContain("user:u3");
		await conversation.stop();
	});

	it("holds the person's words while the CLI is started again, and refuses every other input", async () => {
		const { host, conversation } = await turns(["first", "second"]);
		// The host takes the restart, but no new CLI answers yet.
		const answer = host.onWrite;
		host.onWrite = () => undefined;
		const rewind = conversation.rewind(entryId("user:u2"));
		await settle();
		expect(
			await drawnAs(conversation.command({ kind: "interrupt" })),
		).toMatchObject({
			code: "conversation_refused",
			detail: expect.stringContaining(
				"The conversation is being taken back.",
			) as string,
		});
		await conversation.submit("meanwhile", []);
		expect(
			conversation.reading().transcript.pending.map((each) => each.text),
		).toEqual(["meanwhile"]);
		// The new CLI answers the greeting it was sent: the rewind is over, and
		// the held message is written.
		host.onWrite = answer;
		const greeting = host.inLog.at(-1)!.line;
		answer(greeting);
		expect(await rewind).toBe("rewound");
		await settle();
		expect(conversation.reading().transcript.pending).toEqual([]);
		expect(
			conversation
				.reading()
				.transcript.entries.flatMap((each) =>
					each.kind === "user" ? [each.text] : [],
				),
		).toEqual(["first", "meanwhile"]);
		await conversation.stop();
	});

	it("rejects when the conversation stops before the CLI has taken the turns back", async () => {
		const { host, conversation } = await turns(["first", "second"]);
		host.onWrite = () => undefined;
		const rewind = conversation.rewind(entryId("user:u2"));
		await settle();
		await conversation.stop();
		expect(await drawnAs(rewind)).toMatchObject({
			code: "conversation_stopped",
			detail:
				"The conversation stopped before the CLI had taken the turns back.",
		});
	});
});

describe("going on with another session", () => {
	it("refuses while a turn runs, saying to stop it first", async () => {
		const { host, conversation, cli } = await turns(["first"]);
		cli.hold = true;
		await conversation.submit("second", []);
		await settle();
		expect(
			await drawnAs(conversation.resumeSession("s-other", [])),
		).toMatchObject({
			code: "conversation_refused",
			detail: expect.stringContaining(
				"Stop it before going on with another session.",
			) as string,
		});
		expect(host.restarts).toEqual([]);
		await conversation.stop();
	});

	it("rejects, as the conversation having stopped, when it stops before the CLI is on the other session", async () => {
		const { host, conversation } = await turns(["first"]);
		host.onWrite = () => undefined;
		const resumed = conversation.resumeSession("s-other", []);
		await settle();
		await conversation.stop();
		expect(await drawnAs(resumed)).toMatchObject({
			code: "conversation_stopped",
			detail: expect.stringContaining(
				"The conversation stopped before it went on with session s-other",
			) as string,
		});
	});
});

describe("the person's messages, held", () => {
	const pending = (conversation: AgentConversation) =>
		conversation.reading().transcript.pending.map((each) => each.text);
	const said = (conversation: AgentConversation) =>
		conversation
			.reading()
			.transcript.entries.flatMap((each) =>
				each.kind === "user" ? [each.text] : [],
			);

	it("are written one per turn as each turn ends, as the person left them", async () => {
		const { host, conversation, cli } = await turns(["first"]);
		cli.hold = true;
		await conversation.submit("second", []);
		await settle();
		const writes = host.inLog.length;
		await conversation.submit("third", []);
		await conversation.submit("fourth", []);
		await conversation.submit("fifth", []);
		expect(host.inLog).toHaveLength(writes);
		expect(pending(conversation)).toEqual(["third", "fourth", "fifth"]);

		const [third, fourth] = conversation.reading().transcript.pending;
		await conversation.editPending(third!.id, "third, reworded");
		await conversation.removePending(fourth!.id);
		expect(pending(conversation)).toEqual(["third, reworded", "fifth"]);

		endTurn(host);
		await settle();
		expect(said(conversation)).toEqual(["first", "second", "third, reworded"]);
		expect(pending(conversation)).toEqual(["fifth"]);
		endTurn(host);
		await settle();
		expect(said(conversation)).toEqual([
			"first",
			"second",
			"third, reworded",
			"fifth",
		]);
		expect(pending(conversation)).toEqual([]);
		await conversation.stop();
	});

	it("keep the images attached to them, through a change of their words, and are written with them", async () => {
		const { host, conversation, cli } = await turns(["first"]);
		cli.hold = true;
		await conversation.submit("second", []);
		await settle();
		const image = {
			mediaType: "image/png",
			source: { kind: "data", base64: "AAAA" },
			label: "shot.png",
		} as const;
		await conversation.submit("look at this", [image]);
		const [held] = conversation.reading().transcript.pending;
		expect(held!.images).toEqual([image]);
		await conversation.editPending(held!.id, "look at this one");
		expect(conversation.reading().transcript.pending[0]!.images).toEqual([
			image,
		]);
		const writes = host.inLog.length;
		endTurn(host);
		await settle();
		const written = JSON.parse(host.inLog[writes]!.line) as {
			message: { content: unknown };
		};
		expect(written.message.content).toEqual([
			{
				type: "image",
				source: { type: "base64", media_type: "image/png", data: "AAAA" },
			},
			{ type: "text", text: "look at this one" },
		]);
		await conversation.stop();
	});

	it("is written into the running turn when the person says now", async () => {
		const { host, conversation, cli } = await turns(["first"]);
		cli.hold = true;
		await conversation.submit("second", []);
		await settle();
		await conversation.submit("steer this way", []);
		const [held] = conversation.reading().transcript.pending;
		await conversation.sendPendingNow(held!.id);
		expect(JSON.parse(host.inLog.at(-1)!.line)).toMatchObject({
			type: "user",
			priority: "next",
			message: { content: "steer this way" },
		});
		expect(pending(conversation)).toEqual([]);
		await settle();
		expect(said(conversation)).toContain("steer this way");
		await conversation.stop();
	});

	it("stays held, saying why, when its write fails, and is written when the person tries again", async () => {
		const { host, conversation, cli } = await turns(["first"]);
		cli.hold = true;
		await conversation.submit("second", []);
		await settle();
		await conversation.submit("third", []);
		host.refuseWrite = true;
		endTurn(host);
		await settle();
		const [held] = conversation.reading().transcript.pending;
		expect(held).toMatchObject({
			text: "third",
			failure: "the fake host has ended",
		});
		await conversation.sendPendingNow(held!.id);
		await settle();
		expect(pending(conversation)).toEqual([]);
		expect(said(conversation)).toContain("third");
		await conversation.stop();
	});

	it("is not written while the person edits it, and is written as saved once they do", async () => {
		const { host, conversation, cli } = await turns(["first"]);
		cli.hold = true;
		await conversation.submit("second", []);
		await settle();
		await conversation.submit("third", []);
		const [third] = conversation.reading().transcript.pending;
		await conversation.startEditingPending(third!.id);
		expect(conversation.reading().transcript.pending[0]).toMatchObject({
			editing: true,
		});
		const messages = () =>
			host.inLog.filter((each) => JSON.parse(each.line).type === "user");
		const writes = messages().length;
		endTurn(host);
		await settle();
		expect(messages()).toHaveLength(writes);
		expect(pending(conversation)).toEqual(["third"]);
		expect(await drawnAs(conversation.sendPendingNow(third!.id))).toMatchObject(
			{
				code: "conversation_refused",
				detail: expect.stringContaining("being edited") as string,
			},
		);

		await conversation.editPending(third!.id, "third, reworded");
		await settle();
		expect(said(conversation)).toEqual(["first", "second", "third, reworded"]);
		expect(pending(conversation)).toEqual([]);
		await conversation.stop();
	});

	it("is written unchanged once the person gives the edit up, or the page lets go of it", async () => {
		const { host, conversation, cli } = await turns(["first"]);
		cli.hold = true;
		await conversation.submit("second", []);
		await settle();
		await conversation.submit("third", []);
		await conversation.submit("fourth", []);
		const [third, fourth] = conversation.reading().transcript.pending;
		await conversation.startEditingPending(third!.id);
		await conversation.startEditingPending(fourth!.id);
		endTurn(host);
		await settle();
		expect(pending(conversation)).toEqual(["third", "fourth"]);

		await conversation.stopEditingPending(third!.id);
		await settle();
		expect(said(conversation)).toEqual(["first", "second", "third"]);
		endTurn(host);
		await settle();
		expect(pending(conversation)).toEqual(["fourth"]);

		conversation.stopEditingAll();
		await settle();
		expect(said(conversation)).toEqual(["first", "second", "third", "fourth"]);
		await conversation.stop();
	});

	it("says a held message is gone when it was already written", async () => {
		const { conversation, cli } = await turns(["first"]);
		cli.hold = true;
		await conversation.submit("second", []);
		await settle();
		await conversation.submit("third", []);
		const [held] = conversation.reading().transcript.pending;
		await conversation.removePending(held!.id);
		expect(
			await drawnAs(conversation.editPending(held!.id, "x")),
		).toMatchObject({
			code: "conversation_refused",
			detail: expect.stringContaining(
				"That message is no longer waiting",
			) as string,
		});
		await conversation.stop();
	});
});

/**
 * What a refusal is drawn as: its own code and the sentence it was written
 * in, never the app shell's catch-all, which is for what DevHub did not
 * expect.
 */
async function drawnAs(settled: Promise<unknown>) {
	return errorWire(
		await settled.then(
			() => {
				throw new Error("it did not fail");
			},
			(failure: unknown) => failure,
		),
	);
}

describe("a turn a usage limit stopped", () => {
	/** When the five-hour window resets, in epoch seconds as the CLI says it. */
	const RESETS = 1_800_000_000;
	const DUE = RESETS * 1000 + RESET_MARGIN_MS;
	/** An hour before the reset. */
	const BEFORE = RESETS * 1000 - 3_600_000;

	/** What the CLI prints when a limit stops the turn under way; `null`, a refusal that names no reset. */
	const printLimit = (host: FakeHost, resetsAt: number | null) => {
		host.print(
			JSON.stringify({
				type: "rate_limit_event",
				rate_limit_info: {
					status: "rejected",
					...(resetsAt === null ? {} : { resetsAt }),
					rateLimitType: "five_hour",
				},
				session_id: "s-1",
			}),
		);
		host.print(
			JSON.stringify({
				type: "assistant",
				message: {
					id: "msg_limit",
					role: "assistant",
					content: [{ type: "text", text: "You've hit your limit" }],
				},
				parent_tool_use_id: null,
				session_id: "s-1",
				error: "rate_limit",
			}),
		);
		host.print(
			JSON.stringify({
				type: "result",
				subtype: "success",
				is_error: true,
				duration_ms: 100,
				result: "You've hit your limit",
				session_id: "s-1",
			}),
		);
	};

	/** One DevHub's conversation on `host`, going on after a limit as `settings` say. */
	async function following(
		host: FakeHost,
		clock: HandClock,
		records: ReturnType<typeof memoryRecords>,
		settings: LimitResumeSettings = RESUME_ON,
	): Promise<AgentConversation> {
		const conversation = new AgentConversation(
			host,
			new ClaudeAdapter("boot"),
			() => undefined,
			{
				settings: () => settings,
				record: {
					get: () => records.get("agent"),
					set: (record) => records.set("agent", record),
				},
				clock,
			},
		);
		conversation.start();
		await settle();
		return conversation;
	}

	/** A conversation whose first turn a limit stopped. */
	async function stopped(
		settings: LimitResumeSettings = RESUME_ON,
		resetsAt: number | null = RESETS,
	) {
		const host = new FakeHost();
		const cli = answeringCli(host);
		const clock = new HandClock(BEFORE);
		const records = memoryRecords();
		const conversation = await following(host, clock, records, settings);
		cli.hold = true;
		await conversation.submit("go", []);
		await settle();
		printLimit(host, resetsAt);
		await settle();
		return { host, cli, clock, records, conversation };
	}

	const resume = (conversation: AgentConversation) =>
		conversation.reading().transcript.limitResume;
	/** The user messages written to the CLI, with whom they were written for. */
	const written = (host: FakeHost) =>
		host.inLog.flatMap(({ line }) => {
			const message = JSON.parse(line) as {
				type: string;
				devhub_origin?: string;
				message?: { content: string };
			};
			return message.type === "user"
				? [`${message.devhub_origin} ${message.message!.content}`]
				: [];
		});

	it("is gone on with once the limit has reset, by a message written for the person", async () => {
		const { host, clock, records, conversation } = await stopped();
		expect(resume(conversation)).toEqual({ kind: "scheduled", at: DUE });
		expect(records.get("agent")).toMatchObject({ entry: "turn:1", at: DUE });

		clock.advance(DUE - BEFORE - 1);
		await settle();
		expect(written(host)).toEqual(["person go"]);

		clock.advance(1);
		await settle();
		expect(written(host)).toEqual(["person go", "after-limit 続けて"]);
		expect(resume(conversation)).toBeUndefined();
		expect(records.get("agent")?.at).toBeUndefined();
		expect(
			conversation
				.reading()
				.transcript.entries.filter((each) => each.kind === "user"),
		).toMatchObject([
			{ text: "go", origin: "person" },
			{ text: "続けて", origin: "after-limit" },
		]);
		await conversation.stop();
	});

	it("writes the words Settings give", async () => {
		const { host, clock, conversation } = await stopped({
			enabled: true,
			message: "Please continue",
		});
		clock.advance(DUE - BEFORE);
		await settle();
		expect(written(host).at(-1)).toBe("after-limit Please continue");
		await conversation.stop();
	});

	it("is cancelled by the person's Cancel, and nothing is written", async () => {
		const { host, clock, records, conversation } = await stopped();
		await conversation.cancelLimitResume();
		expect(resume(conversation)).toBeUndefined();
		expect(clock.pending).toBe(0);
		expect(records.get("agent")?.at).toBeUndefined();
		clock.advance(DUE - BEFORE);
		await settle();
		expect(written(host)).toEqual(["person go"]);
		await conversation.stop();
	});

	it("is cancelled by the person's own words", async () => {
		const { host, clock, conversation } = await stopped();
		await conversation.submit("never mind", []);
		await settle();
		expect(resume(conversation)).toBeUndefined();
		expect(clock.pending).toBe(0);
		clock.advance(DUE - BEFORE);
		await settle();
		expect(written(host)).toEqual(["person go", "person never mind"]);
		await conversation.stop();
	});

	it("is cancelled by a turn the Agent starts on its own", async () => {
		const { host, clock, conversation } = await stopped();
		host.print(
			JSON.stringify({
				type: "assistant",
				message: {
					id: "msg_own",
					role: "assistant",
					content: [{ type: "text", text: "A background task finished." }],
				},
				parent_tool_use_id: null,
				session_id: "s-1",
			}),
		);
		await settle();
		expect(resume(conversation)).toBeUndefined();
		expect(clock.pending).toBe(0);
		clock.advance(DUE - BEFORE);
		await settle();
		expect(written(host)).toEqual(["person go"]);
		await conversation.stop();
	});

	it("stops timing when the conversation is no longer followed, and keeps what it decided", async () => {
		const { clock, records, conversation } = await stopped();
		await conversation.stop();
		expect(clock.pending).toBe(0);
		expect(records.get("agent")?.at).toBe(DUE);
	});

	it("survives a restart of DevHub, at the same time", async () => {
		const { host, records, conversation } = await stopped();
		await conversation.stop();

		const clock = new HandClock(BEFORE + 60_000);
		const again = await following(host, clock, records);
		expect(resume(again)).toEqual({ kind: "scheduled", at: DUE });
		clock.advance(DUE - BEFORE - 60_000);
		await settle();
		expect(written(host)).toEqual(["person go", "after-limit 続けて"]);
		await again.stop();
	});

	it("is written soon after a restart of DevHub when its time passed meanwhile, once", async () => {
		const { host, records, conversation } = await stopped();
		await conversation.stop();

		const late = DUE + 3_600_000;
		const clock = new HandClock(late);
		const again = await following(host, clock, records);
		expect(resume(again)).toEqual({
			kind: "scheduled",
			at: late + SOONEST_MS,
		});
		clock.advance(SOONEST_MS);
		await settle();
		expect(written(host)).toEqual(["person go", "after-limit 続けて"]);
		await again.stop();

		const third = await following(host, new HandClock(late + 60_000), records);
		expect(resume(third)).toBeUndefined();
		await third.stop();
	});

	it("stays cancelled across a restart of DevHub", async () => {
		const { host, records, conversation } = await stopped();
		await conversation.cancelLimitResume();
		await conversation.stop();
		const clock = new HandClock(BEFORE);
		const again = await following(host, clock, records);
		expect(resume(again)).toBeUndefined();
		expect(clock.pending).toBe(0);
		await again.stop();
	});

	it("is not resumed for an earlier stop the replay passes on its way", async () => {
		const { host, clock, records, conversation } = await stopped();
		await conversation.submit("try again", []);
		await settle();
		printLimit(host, RESETS + 3600);
		await settle();
		const second = (RESETS + 3600) * 1000 + RESET_MARGIN_MS;
		expect(resume(conversation)).toEqual({ kind: "scheduled", at: second });
		await conversation.stop();

		const restarted = new HandClock(clock.now());
		const again = await following(host, restarted, records);
		expect(resume(again)).toEqual({ kind: "scheduled", at: second });
		expect(restarted.pending).toBe(1);
		restarted.advance(second - restarted.now());
		await settle();
		expect(written(host)).toEqual([
			"person go",
			"person try again",
			"after-limit 続けて",
		]);
		await again.stop();
	});

	it("says so, and writes nothing, when the CLI did not say when the limit resets", async () => {
		const { host, clock, conversation } = await stopped(RESUME_ON, null);
		expect(resume(conversation)).toEqual({
			kind: "unscheduled",
			reason: "the CLI did not say when the limit resets",
		});
		expect(clock.pending).toBe(0);
		await conversation.cancelLimitResume();
		expect(resume(conversation)).toBeUndefined();
		clock.advance(DUE - BEFORE);
		await settle();
		expect(written(host)).toEqual(["person go"]);
		await conversation.stop();
	});

	it("does nothing when Settings turn it off", async () => {
		const { clock, conversation } = await stopped(RESUME_OFF);
		expect(resume(conversation)).toBeUndefined();
		expect(clock.pending).toBe(0);
		await conversation.stop();
	});

	it("says why when the message could not be written, and does not try again", async () => {
		const { host, clock, records, conversation } = await stopped();
		host.refuseWrite = true;
		clock.advance(DUE - BEFORE);
		await settle();
		expect(resume(conversation)).toEqual({
			kind: "failed",
			failure: "the fake host has ended",
		});
		expect(records.get("agent")?.at).toBeUndefined();
		expect(clock.pending).toBe(0);
		clock.advance(3_600_000);
		await settle();
		expect(written(host)).toEqual(["person go"]);
		await conversation.cancelLimitResume();
		expect(resume(conversation)).toBeUndefined();
		await conversation.stop();
	});
});
