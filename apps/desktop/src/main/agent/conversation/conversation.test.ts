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
	requestId,
	type ConversationEvent,
	type Transcript,
} from "../../../model/conversation.js";
import { CancellationToken } from "../../terminal/ports.js";
import { ClaudeAdapter } from "./claude/adapter.js";
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
	readonly restarts: { args: readonly string[]; mark: string }[] = [];
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

	async restart(args: readonly string[], mark: string): Promise<void> {
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
		this.print(mark);
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

describe("a setting chosen", () => {
	it("writes the lines that set it and takes them back as sent, so the CLI's answer is expected", async () => {
		const host = new FakeHost();
		const conversation = new AgentConversation(
			host,
			new ClaudeAdapter("boot-a"),
			() => undefined,
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

describe("a host that could not be opened", () => {
	it("is this Agent's failure, read from its conversation, and not a round's", async () => {
		const conversation = new AgentConversation(
			openedLater(() => Promise.reject(new Error("the machine has no home"))),
			new ClaudeAdapter("boot-a"),
			() => undefined,
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

describe("editing the person's last message", () => {
	/**
	 * A Claude new enough to resume at a message, answering each message with
	 * one line of its own; `hold` keeps it from ending the turn.
	 */
	function answeringCli(
		host: FakeHost,
		version = "2.1.282",
	): { hold: boolean } {
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
						response: { commands: [], models: [] },
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

	async function twoTurns(version?: string): Promise<{
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
		);
		conversation.start();
		await settle();
		for (const text of ["first", "second"]) {
			await conversation.command({ kind: "send", text, origin: "person" });
			await settle();
		}
		return { host, conversation, cli };
	}

	const ids = (conversation: AgentConversation) =>
		conversation.reading().transcript.entries.map((each) => each.id);

	it("takes the turn back, sends the new words in its place, and replays to the same after a restart of DevHub", async () => {
		const { host, conversation } = await twoTurns();
		expect(ids(conversation)).toEqual([
			"user:u1",
			"assistant:msg_1:0",
			"turn:1",
			"user:u2",
			"assistant:msg_2:0",
			"turn:2",
		]);

		const outcome = await conversation.editLastMessage(
			entryId("user:u2"),
			"second, better",
		);
		await settle();
		expect(outcome).toBe("sent");
		expect(host.restarts).toEqual([
			{
				args: [
					"--resume",
					"s-1",
					"--resume-session-at",
					"a1",
					"--resume-drops-turn",
					"u2",
				],
				mark: JSON.stringify({ type: "devhub_rewind", message: "user:u2" }),
			},
		]);
		expect(ids(conversation)).toEqual([
			"user:u1",
			"assistant:msg_1:0",
			"turn:1",
			"user:u3",
			"assistant:msg_3:0",
			"turn:3",
		]);
		expect(conversation.reading().transcript.state).toEqual({
			phase: "ready",
			turn: "none",
		});
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

	it("refuses while a turn runs, saying to stop it first, and writes nothing", async () => {
		const { host, conversation, cli } = await twoTurns();
		cli.hold = true;
		await conversation.command({
			kind: "send",
			text: "third",
			origin: "person",
		});
		await settle();
		const writes = host.inLog.length;
		await expect(
			conversation.editLastMessage(entryId("user:u3"), "third, better"),
		).rejects.toThrow("Stop it before editing your last message.");
		expect(host.inLog).toHaveLength(writes);
		expect(host.restarts).toEqual([]);
		await conversation.stop();
	});

	it("refuses when the CLI cannot take a turn back", async () => {
		const { host, conversation } = await twoTurns("2.1.0");
		await expect(
			conversation.editLastMessage(entryId("user:u2"), "second, better"),
		).rejects.toThrow("This Agent's CLI cannot take back a turn");
		expect(host.restarts).toEqual([]);
		await conversation.stop();
	});

	it("is the edit's failure when the host does not start the CLI again, and leaves the conversation usable", async () => {
		const { host, conversation } = await twoTurns();
		host.refuseRestart = true;
		await expect(
			conversation.editLastMessage(entryId("user:u2"), "second, better"),
		).rejects.toThrow("the fake host did not start its CLI again");
		expect(ids(conversation)).toContain("user:u2");
		await conversation.command({
			kind: "send",
			text: "third",
			origin: "person",
		});
		await settle();
		expect(ids(conversation)).toContain("user:u3");
		await conversation.stop();
	});

	it("refuses other input while the edit waits for the CLI", async () => {
		const { host, conversation } = await twoTurns();
		// The host takes the restart, but no new CLI answers yet.
		host.onWrite = () => undefined;
		const edit = conversation.editLastMessage(
			entryId("user:u2"),
			"second, better",
		);
		await settle();
		await expect(
			conversation.command({
				kind: "send",
				text: "meanwhile",
				origin: "person",
			}),
		).rejects.toThrow("Your last message is being edited.");
		await conversation.stop();
		await expect(edit).rejects.toThrow(
			"The conversation stopped before your edited message could be sent.",
		);
	});
});
