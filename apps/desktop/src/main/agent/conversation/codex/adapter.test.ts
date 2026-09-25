/**
 * The Codex adapter against hand-written app-server output.
 *
 * The fixtures in `./fixtures/` are written from the vendored protocol types,
 * not captured from a running app-server (see their README). The harness below
 * drives the adapter the way the conversation will: every line it writes —
 * the opening, an encoded command, a reply — goes back through `sent` once
 * written, and every event is folded with the one fold.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	EMPTY_TRANSCRIPT,
	applyEvent,
	childrenOf,
	conversationStatus,
	entryId,
	rewindTargets,
	type ConversationEvent,
	type PendingRequest,
	type Transcript,
	type TranscriptEntry,
} from "../../../../model/conversation.js";
import {
	ProtocolMismatch,
	type AdapterStep,
	type ConversationCommand,
} from "../protocolAdapter.js";
import { CodexAdapter, type CodexAdapterOptions } from "./adapter.js";
import { appServerArgs } from "./argv.js";

const MAIN = "00000000-0000-7000-8000-00000000000a";
const CHILD = "00000000-0000-7000-8000-00000000000b";
const CWD = "/home/testuser/project";

function fixture(name: string): string[] {
	return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")
		.split("\n")
		.filter((line) => line !== "");
}

const OPTIONS: CodexAdapterOptions = {
	clientVersion: "0.1.0",
	cwd: CWD,
	resumeThreadId: undefined,
};

class Harness {
	readonly adapter: CodexAdapter;
	transcript: Transcript = EMPTY_TRANSCRIPT;
	readonly written: string[] = [];
	readonly received: string[] = [];
	readonly events: ConversationEvent[] = [];

	constructor(options: CodexAdapterOptions = OPTIONS) {
		this.adapter = new CodexAdapter(options);
	}

	private fold(step: AdapterStep): AdapterStep {
		for (const event of step.events) {
			this.transcript = applyEvent(this.transcript, event);
			this.events.push(event);
		}
		for (const line of step.replies) this.write(line);
		return step;
	}

	/** A line reached app-server's stdin: it is written, and then the adapter hears of it. */
	private write(line: string): void {
		this.written.push(line);
		this.fold(this.adapter.sent(line));
	}

	start(): void {
		for (const line of this.adapter.opening()) this.write(line);
	}

	receive(line: string | object): AdapterStep {
		const text = typeof line === "string" ? line : JSON.stringify(line);
		this.received.push(text);
		return this.fold(this.adapter.received(text));
	}

	command(command: ConversationCommand): void {
		for (const line of this.adapter.encode(command)) this.write(line);
	}

	/** Takes back the turns from a message on, as the conversation does with a plan to write. */
	rewind(message: string): void {
		const plan = this.adapter.rewind(entryId(message));
		if (plan.kind !== "write")
			throw new Error(`Codex planned a ${plan.kind} for a rewind`);
		for (const line of plan.lines) this.write(line);
	}

	configure(which: "model" | "effort" | "mode", id: string): void {
		this.fold(this.adapter.configure(which, id));
	}

	/** The written lines since `from`, parsed. */
	writesSince(from: number): unknown[] {
		return this.written.slice(from).map((line) => JSON.parse(line) as unknown);
	}

	lastWrite(): unknown {
		return JSON.parse(this.written.at(-1)!) as unknown;
	}

	entry(id: string): TranscriptEntry {
		const found = this.transcript.entries.find((entry) => entry.id === id);
		if (found === undefined) throw new Error(`no entry ${id}`);
		return found;
	}
}

/** A conversation past its handshake, ready for a first turn. */
function ready(): Harness {
	const harness = new Harness();
	harness.start();
	for (const line of fixture("handshake.handwritten.ndjson"))
		harness.receive(line);
	return harness;
}

/** One line per entry, indented under its parent: what the transcript says, readably. */
function outline(
	transcript: Transcript,
	parent: string | null = null,
	depth = 0,
): string[] {
	return childrenOf(
		transcript,
		parent === null ? null : entryId(parent),
	).flatMap((entry) => {
		const pad = "  ".repeat(depth);
		let line: string;
		switch (entry.kind) {
			case "user":
				line = `user(${entry.origin}): ${entry.text}`;
				break;
			case "assistant":
				line = `assistant${entry.streaming ? "(streaming)" : ""}: ${entry.blocks
					.map((block) =>
						block.kind === "text"
							? block.markdown
							: block.kind === "thinking"
								? `[thinking] ${block.text}`
								: `[plan] ${block.steps.map((step) => `${step.text}=${step.status}`).join(", ")}`,
					)
					.join(" | ")}`;
				break;
			case "tool":
				line = `tool ${entry.tool} "${entry.title}" ${entry.status}${
					entry.output === undefined
						? ""
						: ` -> ${
								entry.output.kind === "diff"
									? entry.output.files.map((file) => file.path).join(",")
									: JSON.stringify(
											entry.output.kind === "command"
												? entry.output.output
												: entry.output.text,
										)
							}`
				}${entry.spawns === undefined ? "" : ` spawns ${entry.spawns.label}/${entry.spawns.state}`}`;
				break;
			case "notice":
				line = `notice(${entry.level}): ${entry.text}`;
				break;
			case "turn-end":
				line = `turn-end ${entry.outcome} ${entry.durationMs ?? "-"}ms`;
				break;
		}
		return [`${pad}${line}`, ...outline(transcript, entry.id, depth + 1)];
	});
}

describe("the app-server argv", () => {
	it("puts the profile's arguments before the subcommand", () => {
		expect(appServerArgs(["-c", "model=o3"])).toEqual([
			"-c",
			"model=o3",
			"app-server",
		]);
	});
});

describe("the handshake", () => {
	it("initializes, reads the account, starts a thread in the Workspace, and lists models", () => {
		const harness = new Harness();
		const [initialize, account, start, started, models] = fixture(
			"handshake.handwritten.ndjson",
		);

		harness.start();
		expect(harness.writesSince(0)).toEqual([
			{
				id: 0,
				method: "initialize",
				params: {
					clientInfo: { name: "devhub", title: "DevHub", version: "0.1.0" },
					capabilities: { experimentalApi: false, requestAttestation: false },
				},
			},
		]);

		harness.receive(initialize!);
		expect(harness.writesSince(1)).toEqual([
			{ method: "initialized" },
			{ id: 1, method: "account/read", params: {} },
		]);

		harness.receive(account!);
		expect(harness.writesSince(3)).toEqual([
			{ id: 2, method: "thread/start", params: { cwd: CWD } },
		]);
		expect(harness.transcript.state).toEqual({ phase: "connecting" });

		harness.receive(start!);
		expect(harness.writesSince(4)).toEqual([
			{ id: 3, method: "model/list", params: {} },
		]);
		expect(harness.transcript.state).toEqual({ phase: "ready", turn: "none" });
		expect(conversationStatus(harness.transcript)).toBe("idle");

		harness.receive(started!);
		expect(harness.events.at(-1)?.type).not.toBe("entry");
		harness.receive(models!);
		const { session } = harness.transcript;
		expect(session.agentVersion).toBe("0.156.1");
		expect(session.sessionId).toBe(MAIN);
		expect(session.cwd).toBe(CWD);
		expect(session.model).toEqual({
			current: "gpt-5.5-codex",
			choices: [
				{ id: "gpt-5.5-codex", label: "GPT-5.5 Codex" },
				{ id: "gpt-5.5-mini", label: "GPT-5.5 mini" },
			],
		});
		expect(session.effort).toEqual({
			current: "medium",
			choices: ["low", "medium", "high"].map((effort) => ({
				id: effort,
				label: effort,
			})),
		});
		// on-request + workspaceWrite is the TUI's "Auto" preset.
		expect(session.mode.current).toBe("auto");
		expect(session.mode.choices.map((choice) => choice.id)).toEqual([
			"read-only",
			"auto",
			"full-access",
		]);
		expect(harness.transcript.entries).toEqual([]);
	});

	it("stops at a signed-out account and says to sign in, without starting a thread", () => {
		const harness = new Harness();
		harness.start();
		harness.receive(fixture("handshake.handwritten.ndjson")[0]!);
		harness.receive({
			id: 1,
			result: { account: null, requiresOpenaiAuth: true },
		});

		expect(harness.transcript.state).toEqual({
			phase: "broken",
			failure: {
				code: "not_signed_in",
				detail: expect.stringContaining("codex login") as string,
			},
		});
		expect(
			harness.written.map((line) => JSON.parse(line).method),
		).not.toContain("thread/start");
		expect(() =>
			harness.command({ kind: "send", text: "hi", origin: "person" }),
		).toThrow(/broken/);
	});

	it("goes on to the thread when the account cannot be read, and says so", () => {
		const harness = new Harness();
		harness.start();
		harness.receive(fixture("handshake.handwritten.ndjson")[0]!);
		harness.receive({
			id: 1,
			error: { code: -32603, message: "keyring locked" },
		});

		expect(harness.lastWrite()).toMatchObject({ method: "thread/start" });
		expect(outline(harness.transcript)).toEqual([
			"notice(warning): codex 0.156.1 could not read its account: keyring locked",
		]);
	});

	it("is refused when app-server will not initialize or open the thread", () => {
		for (const failing of [0, 2]) {
			const harness = new Harness();
			harness.start();
			const lines = fixture("handshake.handwritten.ndjson");
			for (const line of lines.slice(0, failing)) harness.receive(line);
			harness.receive({
				id: failing,
				error: { code: -32600, message: "unsupported cwd" },
			});
			expect(harness.transcript.state).toEqual({
				phase: "broken",
				failure: {
					code: "refused",
					detail: `${failing === 0 ? "initialize" : "thread/start"} failed: unsupported cwd (-32600)`,
				},
			});
		}
	});

	it("resumes a thread it is given, and draws the turns that come back with it", () => {
		const harness = new Harness({ ...OPTIONS, resumeThreadId: MAIN });
		harness.start();
		const [initialize, account, start] = fixture(
			"handshake.handwritten.ndjson",
		);
		harness.receive(initialize!);
		harness.receive(account!);
		expect(harness.lastWrite()).toEqual({
			id: 2,
			method: "thread/resume",
			params: { threadId: MAIN, cwd: CWD },
		});

		const opened = JSON.parse(start!) as {
			result: { thread: { turns: unknown[] } };
		};
		opened.result.thread.turns = [
			{
				id: "old-turn",
				items: [
					{
						type: "userMessage",
						id: "old-user",
						clientId: null,
						content: [{ type: "text", text: "earlier", text_elements: [] }],
					},
					{
						type: "agentMessage",
						id: "old-say",
						text: "done",
						phase: null,
						memoryCitation: null,
						delivery: null,
						questions: null,
					},
				],
				itemsView: "full",
				status: "completed",
				error: null,
				startedAt: null,
				completedAt: null,
				durationMs: 10,
			},
		];
		harness.receive(opened);
		expect(outline(harness.transcript)).toEqual([
			"user(person): earlier",
			"assistant: done",
			"turn-end completed 10ms",
		]);
		expect(harness.transcript.state).toEqual({ phase: "ready", turn: "none" });
	});
});

describe("a turn", () => {
	it("runs a whole turn with two approvals into one transcript", () => {
		const harness = ready();
		harness.command({
			kind: "send",
			text: "Run pwd, then fix the README title.",
			origin: "person",
		});
		expect(harness.lastWrite()).toEqual({
			id: 4,
			method: "turn/start",
			params: {
				threadId: MAIN,
				input: [
					{
						type: "text",
						text: "Run pwd, then fix the README title.",
						text_elements: [],
					},
				],
				clientUserMessageId: "devhub-person-0",
			},
		});

		const statuses: string[] = [];
		for (const line of fixture("turn.handwritten.ndjson")) {
			const step = harness.receive(line);
			statuses.push(conversationStatus(harness.transcript));
			const opened = step.events.find(
				(event) => event.type === "request-opened",
			);
			if (opened?.type !== "request-opened") continue;
			if (opened.request.subject.kind === "command") {
				expect(opened.request).toMatchObject({
					entry: entryId(`${MAIN}/item-pwd`),
					subject: {
						kind: "command",
						command: "pwd",
						cwd: CWD,
						reason: "Needs to read the working directory",
					},
				} satisfies Partial<PendingRequest>);
				expect(opened.request.choices.map((choice) => choice.label)).toEqual([
					"Allow once",
					"Allow for this session",
					"Always allow `pwd`",
					"Decline",
					"Decline and stop the turn",
				]);
				harness.command({
					kind: "answer",
					request: opened.request.id,
					answer: { kind: "choice", choiceId: "accept", text: undefined },
				});
				expect(harness.lastWrite()).toEqual({
					id: 0,
					result: { decision: "accept" },
				});
			} else {
				expect(opened.request.subject).toEqual({
					kind: "file-change",
					files: [
						{
							path: "README.md",
							unifiedDiff: "@@ -1 +1 @@\n-# Projet\n+# Project\n",
						},
					],
				});
				harness.command({
					kind: "answer",
					request: opened.request.id,
					answer: {
						kind: "choice",
						choiceId: "acceptForSession",
						text: undefined,
					},
				});
				expect(harness.lastWrite()).toEqual({
					id: 1,
					result: { decision: "acceptForSession" },
				});
			}
		}

		expect(outline(harness.transcript)).toMatchInlineSnapshot(`
      [
        "user(person): Run pwd, then fix the README title.",
        "assistant: [thinking] **Checking** where I am",
        "assistant: I'll run \`pwd\` first.",
        "tool commandExecution "pwd" succeeded -> "/home/testuser/project\\n"",
        "tool fileChange "Edit: README.md" succeeded -> README.md",
        "assistant: [plan] Run pwd=completed, Fix the README title=in_progress",
        "assistant: Fixed the title.",
        "turn-end completed 4200ms",
      ]
    `);
		expect(harness.transcript.requests).toEqual([]);
		expect(harness.transcript.state).toEqual({ phase: "ready", turn: "none" });
		// idle → working → waiting (approval) → working → … → idle
		expect(statuses[0]).toBe("idle");
		expect(statuses).toContain("waiting");
		expect(statuses.at(-2)).toBe("working");
		expect(statuses.at(-1)).toBe("idle");

		expect(harness.transcript.usage).toEqual({
			inputTokens: 1200,
			outputTokens: 300,
			cachedInputTokens: 800,
			contextTokens: 900,
			contextWindow: 272000,
			costUsd: undefined,
			rateLimits: [
				{
					window: "5-hour",
					usedPercent: 42,
					resetsAt: (1790000000 + 3600) * 1000,
				},
			],
		});
		const end = harness.transcript.entries.at(-1)!;
		expect(end).toMatchObject({
			kind: "turn-end",
			usage: { inputTokens: 1200, outputTokens: 300, cachedInputTokens: 800 },
		});
	});

	it("streams deltas into the entries they belong to", () => {
		const harness = ready();
		harness.command({ kind: "send", text: "go", origin: "person" });
		const lines = fixture("turn.handwritten.ndjson");
		// Up to and including the second agentMessage delta.
		for (const line of lines.slice(0, 12)) harness.receive(line);
		expect(harness.entry(`${MAIN}/item-say`)).toEqual({
			kind: "assistant",
			id: `${MAIN}/item-say`,
			parent: null,
			blocks: [{ kind: "text", markdown: "I'll run `pwd` first." }],
			streaming: true,
		});
		expect(harness.entry(`${MAIN}/item-think`)).toMatchObject({
			blocks: [{ kind: "thinking", text: "**Checking** where I am" }],
			streaming: false,
		});
	});

	it("offers an execpolicy amendment as an 'always' choice and spells it back", () => {
		const harness = ready();
		harness.command({ kind: "send", text: "go", origin: "person" });
		const lines = fixture("turn.handwritten.ndjson");
		let request: PendingRequest | undefined;
		for (const line of lines.slice(0, 15)) {
			for (const event of harness.receive(line).events) {
				if (event.type === "request-opened") request = event.request;
			}
		}
		expect(conversationStatus(harness.transcript)).toBe("waiting");
		harness.command({
			kind: "answer",
			request: request!.id,
			answer: { kind: "choice", choiceId: "execpolicy", text: undefined },
		});
		expect(harness.lastWrite()).toEqual({
			id: 0,
			result: {
				decision: {
					acceptWithExecpolicyAmendment: { execpolicy_amendment: ["pwd"] },
				},
			},
		});
		// Answered, but open until the server says it is resolved.
		expect(harness.transcript.requests).toHaveLength(1);
		expect(() =>
			harness.command({
				kind: "answer",
				request: request!.id,
				answer: { kind: "choice", choiceId: "accept", text: undefined },
			}),
		).toThrow(/already answered/);
		harness.receive(lines[15]!);
		expect(harness.transcript.requests).toEqual([]);
		expect(() =>
			harness.command({
				kind: "answer",
				request: request!.id,
				answer: { kind: "choice", choiceId: "accept", text: undefined },
			}),
		).toThrow(/not open/);
	});

	it("steers a running turn instead of starting another", () => {
		const harness = ready();
		harness.command({ kind: "send", text: "go", origin: "person" });
		const lines = fixture("turn.handwritten.ndjson");
		for (const line of lines.slice(0, 4)) harness.receive(line);
		harness.command({
			kind: "send",
			text: "also check git",
			origin: "injection",
		});
		expect(harness.lastWrite()).toEqual({
			id: 5,
			method: "turn/steer",
			params: {
				threadId: MAIN,
				input: [{ type: "text", text: "also check git", text_elements: [] }],
				clientUserMessageId: "devhub-injection-1",
				expectedTurnId: "turn-1",
			},
		});
		harness.receive({
			method: "item/completed",
			params: {
				threadId: MAIN,
				turnId: "turn-1",
				completedAtMs: 0,
				item: {
					type: "userMessage",
					id: "item-steer",
					clientId: "devhub-injection-1",
					content: [
						{ type: "text", text: "also check git", text_elements: [] },
					],
				},
			},
		});
		expect(harness.entry(`${MAIN}/item-steer`)).toMatchObject({
			kind: "user",
			origin: "injection",
			// Taken into turn-1, which its first message starts: no place to cut.
			rewindable: false,
		});
	});

	it("interrupts the running turn, and interrupting nothing sends nothing", () => {
		const harness = ready();
		const before = harness.written.length;
		harness.command({ kind: "interrupt" });
		expect(harness.written).toHaveLength(before);

		harness.command({ kind: "send", text: "go", origin: "person" });
		const lines = fixture("turn.handwritten.ndjson");
		// Up to and including the command's approval request.
		for (const line of lines.slice(0, 15)) harness.receive(line);
		harness.command({ kind: "interrupt" });
		expect(harness.lastWrite()).toEqual({
			id: 5,
			method: "turn/interrupt",
			params: { threadId: MAIN, turnId: "turn-1" },
		});
		harness.receive({
			method: "turn/completed",
			params: {
				threadId: MAIN,
				turn: {
					id: "turn-1",
					items: [],
					itemsView: "notLoaded",
					status: "interrupted",
					error: null,
					startedAt: null,
					completedAt: null,
					durationMs: null,
				},
			},
		});
		// The command that never finished is interrupted with the turn.
		expect(harness.entry(`${MAIN}/item-pwd`)).toMatchObject({
			status: "interrupted",
		});
		expect(harness.transcript.entries.at(-1)).toMatchObject({
			kind: "turn-end",
			outcome: "interrupted",
		});
		expect(conversationStatus(harness.transcript)).toBe("waiting"); // the approval is still open
	});

	it("carries chosen settings into the next turn/start", () => {
		const harness = ready();
		const before = harness.written.length;
		harness.configure("model", "gpt-5.5-mini");
		// Choosing writes nothing (Codex takes settings per turn), and the
		// choice shows at once.
		expect(harness.written).toHaveLength(before);
		expect(harness.transcript.session.model.current).toBe("gpt-5.5-mini");
		// A model chosen here runs at its own default effort until one is.
		expect(harness.transcript.session.effort).toEqual({
			current: "low",
			choices: [{ id: "low", label: "low" }],
		});
		harness.configure("effort", "low");
		harness.configure("mode", "read-only");
		expect(() => harness.configure("effort", "extreme")).toThrow(
			/not a effort/,
		);
		harness.command({ kind: "send", text: "go", origin: "person" });
		expect(harness.lastWrite()).toMatchObject({
			method: "turn/start",
			params: {
				model: "gpt-5.5-mini",
				effort: "low",
				approvalPolicy: "on-request",
				sandboxPolicy: { type: "readOnly", networkAccess: false },
			},
		});
	});

	it("says when app-server does not start or steer a turn", () => {
		const harness = ready();
		harness.command({ kind: "send", text: "go", origin: "person" });
		harness.receive({
			id: 4,
			error: { code: -32600, message: "model not available" },
		});
		expect(outline(harness.transcript).at(-1)).toMatch(
			/did not start the turn: model not available$/,
		);
		expect(harness.transcript.state).toEqual({ phase: "ready", turn: "none" });
	});

	it("shows an error app-server will retry as a warning, and one it will not as an error", () => {
		const harness = ready();
		for (const willRetry of [true, false]) {
			harness.receive({
				method: "error",
				params: {
					error: {
						message: "stream disconnected",
						codexErrorInfo: null,
						additionalDetails: null,
						misalignment: null,
					},
					willRetry,
					threadId: MAIN,
					turnId: "turn-1",
				},
			});
		}
		expect(outline(harness.transcript)).toEqual([
			"notice(warning): stream disconnected (retrying)",
			"notice(error): stream disconnected",
		]);
	});
});

describe("subagents", () => {
	it("hangs a subagent's thread under the call that started it", () => {
		const harness = ready();
		harness.command({ kind: "send", text: "delegate", origin: "person" });
		const states: string[] = [];
		for (const line of fixture("subagent.handwritten.ndjson")) {
			harness.receive(line);
			const spawn = harness.transcript.entries.find(
				(entry) => entry.id === `${MAIN}/item-spawn`,
			);
			if (spawn?.kind === "tool" && spawn.spawns !== undefined) {
				states.push(`${spawn.spawns.label}/${spawn.spawns.state}`);
			}
		}
		expect(outline(harness.transcript)).toMatchInlineSnapshot(`
      [
        "tool spawnAgent "Start a subagent: List the files in src/" succeeded spawns explorer/completed",
        "  assistant: Listing.",
        "  tool commandExecution "ls src" succeeded -> "main.ts\\n"",
        "tool wait "Wait for subagents" succeeded",
        "assistant: src/ has main.ts.",
        "turn-end completed 2100ms",
      ]
    `);
		expect(harness.entry(`${MAIN}/item-spawn`)).toMatchObject({
			spawns: {
				prompt: "List the files in src/\nand report back.",
				model: "gpt-5.5-mini",
			},
		});
		expect([...new Set(states)]).toEqual([
			"subagent/running",
			"Explorer/running",
			"explorer/completed",
		]);
		// A subagent's turn does not end the conversation's turn.
		expect(harness.entry(`${CHILD}/child-say`)).toMatchObject({
			parent: `${MAIN}/item-spawn`,
		});
	});

	it("takes the person's messages when app-server says its thread does, steered into its turn or starting one", () => {
		const harness = ready();
		harness.command({ kind: "send", text: "delegate", origin: "person" });
		const lines = fixture("subagent.handwritten.ndjson").map((line) =>
			// The fixture's child thread, as app-server prints one that takes direct input.
			line.replace(
				'"parentThreadId":"00000000-0000-7000-8000-00000000000a",',
				'"parentThreadId":"00000000-0000-7000-8000-00000000000a","canAcceptDirectInput":true,',
			),
		);
		const childTurnStarted = lines.findIndex(
			(line) => line.includes('"turn/started"') && line.includes(CHILD),
		);
		for (const line of lines.slice(0, childTurnStarted + 1))
			harness.receive(line);
		expect(harness.entry(`${MAIN}/item-spawn`)).toMatchObject({
			spawns: { takesMessages: true },
		});
		harness.command({
			kind: "instruct",
			subagent: entryId(`${MAIN}/item-spawn`),
			text: "look in lib/ too",
		});
		expect(harness.lastWrite()).toMatchObject({
			method: "turn/steer",
			params: {
				threadId: CHILD,
				input: [{ type: "text", text: "look in lib/ too", text_elements: [] }],
				expectedTurnId: "child-turn-1",
			},
		});
		for (const line of lines.slice(childTurnStarted + 1)) harness.receive(line);
		harness.command({
			kind: "instruct",
			subagent: entryId(`${MAIN}/item-spawn`),
			text: "now summarize",
		});
		expect(harness.lastWrite()).toMatchObject({
			method: "turn/start",
			params: {
				threadId: CHILD,
				input: [{ type: "text", text: "now summarize", text_elements: [] }],
			},
		});
	});

	it("takes none when app-server does not say its thread does", () => {
		const harness = ready();
		harness.command({ kind: "send", text: "delegate", origin: "person" });
		for (const line of fixture("subagent.handwritten.ndjson"))
			harness.receive(line);
		expect(harness.entry(`${MAIN}/item-spawn`)).toMatchObject({
			spawns: { takesMessages: false },
		});
		expect(() =>
			harness.command({
				kind: "instruct",
				subagent: entryId(`${MAIN}/item-spawn`),
				text: "hello",
			}),
		).toThrow(/started no subagent thread that takes the person's messages/);
	});

	it("shows an item from a thread no call is known to have started, whole, when it completes", () => {
		const harness = ready();
		const stray = "00000000-0000-7000-8000-00000000000c";
		harness.receive({
			method: "item/started",
			params: {
				threadId: stray,
				turnId: "t",
				startedAtMs: 0,
				item: {
					type: "agentMessage",
					id: "m",
					text: "",
					phase: null,
					memoryCitation: null,
					delivery: null,
					questions: null,
				},
			},
		});
		harness.receive({
			method: "item/agentMessage/delta",
			params: { threadId: stray, turnId: "t", itemId: "m", delta: "hi" },
		});
		expect(harness.transcript.entries).toEqual([]);
		harness.receive({
			method: "item/completed",
			params: {
				threadId: stray,
				turnId: "t",
				completedAtMs: 0,
				item: {
					type: "agentMessage",
					id: "m",
					text: "hi",
					phase: null,
					memoryCitation: null,
					delivery: null,
					questions: null,
				},
			},
		});
		expect(outline(harness.transcript)).toEqual([
			`notice(warning): A agentMessage item from subagent thread ${stray} arrived before DevHub knew which call started that thread.`,
		]);
	});
});

describe("requests that are not approvals", () => {
	it("asks requestUserInput's questions and answers them by id", () => {
		const harness = ready();
		harness.receive({
			id: 7,
			method: "item/tool/requestUserInput",
			params: {
				threadId: MAIN,
				turnId: "turn-1",
				itemId: "ask",
				isBlocking: true,
				autoResolutionMs: null,
				questions: [
					{
						id: "lang",
						header: "Language",
						question: "Which language?",
						isOther: true,
						isSecret: false,
						options: [{ label: "TypeScript", description: "the usual" }],
					},
				],
			},
		});
		const request = harness.transcript.requests[0]!;
		expect(request).toEqual({
			id: "codex/7",
			entry: undefined,
			subject: {
				kind: "question",
				questions: [
					{
						id: "lang",
						header: "Language",
						text: "Which language?",
						options: [{ label: "TypeScript", description: "the usual" }],
						multiSelect: false,
						allowsOther: true,
					},
				],
			},
			choices: [],
		});
		expect(() =>
			harness.command({
				kind: "answer",
				request: request.id,
				answer: { kind: "choice", choiceId: "accept", text: undefined },
			}),
		).toThrow(/has no choice/);
		harness.command({
			kind: "answer",
			request: request.id,
			answer: { kind: "answers", values: { lang: "Rust" } },
		});
		expect(harness.lastWrite()).toEqual({
			id: 7,
			result: { answers: { lang: { answers: ["Rust"] } } },
		});
	});

	it("grants the permissions asked for, for a turn or the session, or grants none", () => {
		const harness = ready();
		harness.receive({
			id: "perm-1",
			method: "item/permissions/requestApproval",
			params: {
				threadId: MAIN,
				turnId: "turn-1",
				itemId: "p",
				environmentId: null,
				startedAtMs: 0,
				cwd: CWD,
				reason: "needs the network",
				permissions: { network: { enabled: true }, fileSystem: null },
			},
		});
		const request = harness.transcript.requests[0]!;
		expect(request.subject).toEqual({
			kind: "tool",
			tool: "permissions",
			title: "Grant more permissions",
			input: { cwd: CWD, network: { enabled: true } },
			reason: "needs the network",
		});
		expect(request.choices.map((choice) => choice.id)).toEqual([
			"turn",
			"session",
			"decline",
		]);
		harness.command({
			kind: "answer",
			request: request.id,
			answer: { kind: "choice", choiceId: "session", text: undefined },
		});
		expect(harness.lastWrite()).toEqual({
			id: "perm-1",
			result: { permissions: { network: { enabled: true } }, scope: "session" },
		});
	});

	it("offers only decline and cancel for a form elicitation DevHub cannot fill in", () => {
		const harness = ready();
		harness.receive({
			id: 8,
			method: "mcpServer/elicitation/request",
			params: {
				threadId: MAIN,
				turnId: null,
				serverName: "tickets",
				mode: "form",
				_meta: null,
				message: "Which project?",
				requestedSchema: { type: "object", properties: {} },
			},
		});
		const request = harness.transcript.requests[0]!;
		expect(request.subject).toEqual({
			kind: "elicitation",
			server: "tickets",
			message: "Which project?",
			schema: { type: "object", properties: {} },
		});
		expect(request.choices.map((choice) => choice.id)).toEqual([
			"decline",
			"cancel",
		]);
		harness.command({
			kind: "answer",
			request: request.id,
			answer: { kind: "choice", choiceId: "decline", text: undefined },
		});
		expect(harness.lastWrite()).toEqual({
			id: 8,
			result: { action: "decline", content: null, _meta: null },
		});
	});
});

describe("what DevHub does not know", () => {
	it("shows an unknown notification and goes on", () => {
		const harness = ready();
		harness.receive({ method: "thread/sparkles", params: { threadId: MAIN } });
		expect(outline(harness.transcript)).toEqual([
			"notice(warning): codex 0.156.1 sent `thread/sparkles`, which DevHub does not know.",
		]);
		expect(harness.transcript.entries[0]).toMatchObject({
			raw: { method: "thread/sparkles" },
		});
		expect(harness.transcript.state).toEqual({ phase: "ready", turn: "none" });
	});

	it("says nothing for a method it knows and does not use", () => {
		const harness = ready();
		harness.receive({
			method: "turn/diff/updated",
			params: { threadId: MAIN, turnId: "t", diff: "" },
		});
		expect(harness.transcript.entries).toEqual([]);
	});

	it("answers a request it does not handle with an error, and shows it", () => {
		const harness = ready();
		const before = harness.written.length;
		harness.receive({
			id: 9,
			method: "item/tool/call",
			params: { threadId: MAIN },
		});
		harness.receive({ id: 10, method: "item/tool/teleport", params: {} });
		expect(harness.writesSince(before)).toEqual([
			{
				id: 9,
				error: {
					code: -32601,
					message: "DevHub does not handle item/tool/call",
				},
			},
			{
				id: 10,
				error: {
					code: -32601,
					message: "DevHub does not handle item/tool/teleport",
				},
			},
		]);
		expect(outline(harness.transcript)).toEqual([
			expect.stringMatching(
				/asked DevHub for `item\/tool\/call`, which DevHub does not do \(DevHub registers no dynamic tools\)/,
			),
			expect.stringMatching(
				/asked DevHub for `item\/tool\/teleport`, which DevHub does not know/,
			),
		]);
		// The server clears a request it got an error for; that is not DevHub's to close.
		harness.receive({
			method: "serverRequest/resolved",
			params: { threadId: MAIN, requestId: 9 },
		});
		expect(harness.transcript.requests).toEqual([]);
	});

	it("shows an item type it does not know as a notice with the item", () => {
		const harness = ready();
		harness.receive({
			method: "item/completed",
			params: {
				threadId: MAIN,
				turnId: "t",
				completedAtMs: 0,
				item: { type: "hologram", id: "h" },
			},
		});
		expect(outline(harness.transcript)[0]).toMatch(
			/sent a `hologram` item, which DevHub does not know/,
		);
	});
});

describe("a protocol DevHub stopped understanding", () => {
	const cases: [string, object | string, RegExp][] = [
		[
			"a known item with a status it does not have",
			{
				method: "item/completed",
				params: {
					threadId: MAIN,
					turnId: "t",
					completedAtMs: 0,
					item: {
						type: "commandExecution",
						id: "c",
						command: "ls",
						cwd: CWD,
						status: "teleported",
						aggregatedOutput: null,
						exitCode: null,
					},
				},
			},
			/^params\.item\.status: expected one of inProgress \| completed \| failed \| declined, got a string \(CLI 0\.156\.1/,
		],
		[
			"a line that is not JSON",
			"{not json",
			/^line: expected JSON, got \{not json/,
		],
		[
			"a reply to a request DevHub never made",
			{ id: 99, result: {} },
			/^message\.id: expected a reply to a request DevHub made, got one to 99/,
		],
		[
			"a delta for a message that never started",
			{
				method: "item/agentMessage/delta",
				params: { threadId: MAIN, turnId: "t", itemId: "ghost", delta: "x" },
			},
			/^params\.itemId: expected a delta for a streaming message, got one for ghost \(never started\)/,
		],
	];

	for (const [name, line, detail] of cases) {
		it(`throws the shared ProtocolMismatch on ${name}, and is spent after`, () => {
			const harness = ready();
			let thrown: unknown;
			try {
				harness.receive(line);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(ProtocolMismatch);
			expect((thrown as ProtocolMismatch).message).toMatch(detail);
			expect((thrown as ProtocolMismatch).agentVersion).toContain("0.156.1");
			expect(() =>
				harness.receive({
					method: "warning",
					params: { threadId: null, message: "later" },
				}),
			).toThrow(/spent/);
			expect(() => harness.command({ kind: "interrupt" })).toThrow(/spent/);
		});
	}
});

describe("replay", () => {
	function liveRun(): Harness {
		const harness = ready();
		harness.command({ kind: "send", text: "go", origin: "person" });
		for (const line of fixture("turn.handwritten.ndjson")) {
			const step = harness.receive(line);
			for (const event of step.events) {
				if (event.type === "request-opened") {
					harness.command({
						kind: "answer",
						request: event.request.id,
						answer: { kind: "choice", choiceId: "accept", text: undefined },
					});
				}
			}
		}
		return harness;
	}

	it("rebuilds the same transcript from the journals and writes nothing", () => {
		const live = liveRun();
		const replayed = new Harness();
		for (const line of live.written) {
			for (const event of replayed.adapter.sent(line).events) {
				replayed.transcript = applyEvent(replayed.transcript, event);
			}
		}
		for (const line of live.received) replayed.receive(line);

		expect(replayed.written).toEqual([]);
		expect(replayed.transcript).toEqual(live.transcript);
		// And it carries on where the live one left off.
		replayed.command({ kind: "send", text: "next", origin: "person" });
		expect(replayed.lastWrite()).toMatchObject({
			id: 5,
			method: "turn/start",
			params: { clientUserMessageId: "devhub-person-1" },
		});
	});

	it("finishes a handshake a DevHub that died halfway through did not", () => {
		const replayed = new Harness();
		replayed.adapter.sent(
			JSON.stringify({ id: 0, method: "initialize", params: {} }),
		);
		replayed.receive(fixture("handshake.handwritten.ndjson")[0]!);
		expect(replayed.writesSince(0)).toEqual([
			{ method: "initialized" },
			{ id: 1, method: "account/read", params: {} },
		]);
	});

	it("does not answer again a request it declined before the restart", () => {
		const replayed = new Harness();
		for (const line of [
			JSON.stringify({ id: 0, method: "initialize", params: {} }),
			JSON.stringify({
				id: 9,
				error: {
					code: -32601,
					message: "DevHub does not handle item/tool/call",
				},
			}),
		]) {
			replayed.adapter.sent(line);
		}
		replayed.receive({ id: 9, method: "item/tool/call", params: {} });
		expect(replayed.written).toEqual([]);
	});
});

/**
 * Real app-server sessions, scrubbed (see each capture's header): the lines
 * it printed and the lines DevHub wrote, in the order they happened. Where
 * they and the hand-written fixtures disagree, the captures are right.
 */
function played(
	name: string,
	adapter = new CodexAdapter(OPTIONS),
): CodexAdapter {
	for (const line of readFileSync(
		new URL(`./fixtures/${name}`, import.meta.url),
		"utf8",
	).split("\n")) {
		if (line.startsWith("> ")) adapter.sent(line.slice(2));
		else if (line.startsWith("< ")) adapter.received(line.slice(2));
	}
	return adapter;
}

describe("taking back the last turn", () => {
	/** A thread past one whole turn, "go", with both approvals accepted. */
	function oneTurn(): Harness {
		const harness = ready();
		harness.command({ kind: "send", text: "go", origin: "person" });
		for (const line of fixture("turn.handwritten.ndjson")) {
			for (const event of harness.receive(line).events) {
				if (event.type === "request-opened") {
					harness.command({
						kind: "answer",
						request: event.request.id,
						answer: { kind: "choice", choiceId: "accept", text: undefined },
					});
				}
			}
		}
		return harness;
	}

	const USER = `${MAIN}/item-user`;
	const REVERTED = {
		id: 5,
		result: {
			thread: { id: MAIN, turns: [] },
			turnsBackwardsCursor: null,
			itemsBackwardsCursor: null,
		},
	};

	it("is offered on a paginated thread, and reverts the thread to before the message's turn", () => {
		const harness = oneTurn();
		expect(harness.transcript.session.canRewind).toBe(true);
		expect(harness.transcript.state).toEqual({ phase: "ready", turn: "none" });

		harness.rewind(USER);
		expect(harness.lastWrite()).toEqual({
			id: 5,
			method: "thread/revert",
			params: { threadId: MAIN, beforeTurnId: "turn-1" },
		});
		expect(harness.transcript.state).toEqual({
			phase: "ready",
			turn: "rewinding",
		});

		harness.receive({ method: "thread/reverted", params: { threadId: MAIN } });
		harness.receive(REVERTED);
		expect(harness.transcript.entries).toEqual([]);
		expect(harness.transcript.state).toEqual({ phase: "ready", turn: "none" });

		// And the next message starts a turn on the reverted thread.
		harness.command({
			kind: "send",
			text: "go, differently",
			origin: "person",
		});
		expect(harness.lastWrite()).toMatchObject({
			id: 6,
			method: "turn/start",
			params: { threadId: MAIN, clientUserMessageId: "devhub-person-1" },
		});
	});

	it("says so when app-server refuses, and drops nothing", () => {
		const harness = oneTurn();
		const before = harness.transcript.entries;
		harness.rewind(USER);
		harness.receive({
			id: 5,
			error: {
				code: -32600,
				message: "thread/revert only supports paginated threads",
			},
		});
		expect(harness.transcript.entries.slice(0, before.length)).toEqual(before);
		expect(harness.transcript.entries.at(-1)).toMatchObject({
			kind: "notice",
			level: "error",
			text: "codex 0.156.1 did not take back the last turn: thread/revert only supports paginated threads",
		});
		expect(harness.transcript.state).toEqual({ phase: "ready", turn: "none" });
	});

	it("is not offered on a legacy thread, and refused if asked", () => {
		const harness = new Harness();
		harness.start();
		for (const line of fixture("handshake.handwritten.ndjson"))
			harness.receive(
				line.replaceAll('"historyMode":"paginated"', '"historyMode":"legacy"'),
			);
		expect(harness.transcript.session.canRewind).toBe(false);
		harness.command({ kind: "send", text: "go", origin: "person" });
		harness.receive(fixture("turn.handwritten.ndjson")[2]!);
		expect(() => harness.adapter.rewind(entryId(USER))).toThrow(
			/cannot take back a turn of this thread/,
		);
	});

	it("refuses a message that is not a rewind target", () => {
		const harness = oneTurn();
		expect(() => harness.adapter.rewind(entryId(`${MAIN}/item-say`))).toThrow(
			/is not a message the conversation can be rewound to now/,
		);
	});

	it("reverts to before an earlier turn, and every turn from it on goes", () => {
		const harness = oneTurn();
		harness.command({ kind: "send", text: "more", origin: "person" });
		const turn2 = {
			id: "turn-2",
			items: [],
			itemsView: "notLoaded",
			status: "inProgress",
			error: null,
			startedAt: 1790000010,
			completedAt: null,
			durationMs: null,
		};
		harness.receive({ id: 5, result: { turn: turn2 } });
		harness.receive({
			method: "turn/started",
			params: { threadId: MAIN, turn: turn2 },
		});
		harness.receive({
			method: "item/completed",
			params: {
				threadId: MAIN,
				turnId: "turn-2",
				completedAtMs: 0,
				item: {
					type: "userMessage",
					id: "item-more",
					clientId: "devhub-person-1",
					content: [{ type: "text", text: "more", text_elements: [] }],
				},
			},
		});
		harness.receive({
			method: "turn/completed",
			params: {
				threadId: MAIN,
				turn: { ...turn2, status: "completed", completedAt: 1790000011 },
			},
		});
		expect([...rewindTargets(harness.transcript)]).toEqual([
			USER,
			`${MAIN}/item-more`,
		]);
		harness.rewind(USER);
		expect(harness.lastWrite()).toEqual({
			id: 6,
			method: "thread/revert",
			params: { threadId: MAIN, beforeTurnId: "turn-1" },
		});
		harness.receive({ ...REVERTED, id: 6 });
		expect(harness.transcript.entries).toEqual([]);
		expect(harness.transcript.state).toEqual({ phase: "ready", turn: "none" });
	});

	it("replays to the same rewound transcript and writes nothing", () => {
		const live = oneTurn();
		live.rewind(USER);
		live.receive(REVERTED);
		live.command({ kind: "send", text: "again", origin: "person" });

		const replayed = new Harness();
		for (const line of live.written) {
			for (const event of replayed.adapter.sent(line).events) {
				replayed.transcript = applyEvent(replayed.transcript, event);
			}
		}
		for (const line of live.received) replayed.receive(line);
		expect(replayed.written).toEqual([]);
		expect(replayed.transcript).toEqual(live.transcript);
	});
});

describe("a captured app-server that is not signed in", () => {
	it("stops, naming codex and its version rather than the user agent DevHub is sent back", () => {
		const { transcript } = played("signed-out.capture.ndjson");
		expect(transcript.session.agentVersion).toBe("0.156.1");
		expect(transcript.state).toEqual({
			phase: "broken",
			failure: {
				code: "not_signed_in",
				detail:
					"codex 0.156.1 is not signed in. Run `codex login` in a terminal.",
			},
		});
		expect(transcript.entries).toEqual([]);
	});
});

describe("a captured greeting on the owner's signed-in app-server", () => {
	it("plays to one completed turn: the message, the answer, nothing it does not know", () => {
		const { transcript } = played("codex-greeting.capture.ndjson");
		expect(transcript.state).toEqual({ phase: "ready", turn: "none" });
		expect(
			transcript.entries.map((entry) =>
				entry.kind === "user"
					? `user: ${entry.text}`
					: entry.kind === "assistant"
						? `assistant: ${entry.blocks.map((block) => (block.kind === "text" ? block.markdown : block.kind)).join("|")}`
						: entry.kind === "turn-end"
							? `turn-end: ${entry.outcome}`
							: `${entry.kind}`,
			),
		).toEqual([
			"user: Hello! Please reply with a one-line greeting.",
			"assistant: Hello! 👋",
			"turn-end: completed",
		]);
	});

	it("keeps, across a replay, the settings the turn was started with", () => {
		const { session } = played("codex-greeting.capture.ndjson").transcript;
		expect(session.agentVersion).toBe("0.156.1");
		expect(session.sessionId).toBe("00000000-0000-7000-8000-000000000006");
		expect(session.model.current).toBe("gpt-6-luna");
		expect(session.effort.current).toBe("low");
		expect(session.mode.current).toBe("read-only");
	});

	it("keeps the primary and secondary windows, their resets sent in seconds read as milliseconds", () => {
		const { usage } = played("codex-greeting.capture.ndjson").transcript;
		expect(usage?.rateLimits).toEqual([
			{ window: "5-hour", usedPercent: 0, resetsAt: 1_790_313_079_000 },
			{ window: "7-day", usedPercent: 17, resetsAt: 1_790_593_906_000 },
		]);
		expect(usage).toMatchObject({
			inputTokens: 21669,
			outputTokens: 8,
			contextWindow: 258400,
		});
	});
});

describe("going on with another thread (/resume)", () => {
	const OTHER = "00000000-0000-7000-8000-0000000000b2";
	/** The handshake's thread/start answer, as the answer to a resume of `OTHER` with one past turn. */
	function resumedAnswer(id: number): object {
		const start = JSON.parse(fixture("handshake.handwritten.ndjson")[2]!) as {
			result: { thread: { id: string; turns: unknown[] } };
		};
		start.result.thread.id = OTHER;
		start.result.thread.turns = [
			{
				id: "other-turn",
				items: [
					{
						type: "userMessage",
						id: "other-user",
						clientId: null,
						content: [{ type: "text", text: "elsewhere", text_elements: [] }],
					},
				],
				itemsView: "full",
				status: "completed",
				error: null,
				startedAt: null,
				completedAt: null,
				durationMs: 5,
			},
		];
		return { id, result: start.result };
	}

	function resume(harness: Harness): void {
		const plan = harness.adapter.resumeSession(OTHER, []);
		if (plan.kind !== "write") throw new Error(`a ${plan.kind} for a resume`);
		for (const line of plan.lines)
			(harness as unknown as { write(line: string): void }).write(line);
	}

	it("resumes the other thread on the same app-server, and draws it in place of this one", () => {
		const harness = ready();
		harness.command({ kind: "send", text: "here", origin: "person" });
		harness.receive({
			method: "turn/started",
			params: {
				threadId: MAIN,
				turn: {
					id: "t-1",
					items: [],
					itemsView: "full",
					status: "inProgress",
					error: null,
					startedAt: null,
					completedAt: null,
					durationMs: null,
				},
			},
		});
		harness.receive({
			method: "turn/completed",
			params: {
				threadId: MAIN,
				turn: {
					id: "t-1",
					items: [],
					itemsView: "full",
					status: "completed",
					error: null,
					startedAt: null,
					completedAt: null,
					durationMs: 1,
				},
			},
		});
		const before = harness.written.length;
		resume(harness);
		const [asked] = harness.writesSince(before) as { id: number }[];
		expect(asked).toEqual({
			id: asked!.id,
			method: "thread/resume",
			params: { threadId: OTHER, cwd: CWD },
		});
		expect(harness.transcript.state).toEqual({
			phase: "ready",
			turn: "rewinding",
		});
		harness.receive(resumedAnswer(asked!.id));
		expect(outline(harness.transcript)).toEqual([
			"user(person): elsewhere",
			"turn-end completed 5ms",
		]);
		expect(harness.transcript.session.sessionId).toBe(OTHER);
		expect(harness.transcript.state).toEqual({ phase: "ready", turn: "none" });

		// The next turn is on the other thread.
		harness.command({ kind: "send", text: "go on", origin: "person" });
		expect(harness.lastWrite()).toMatchObject({
			method: "turn/start",
			params: { threadId: OTHER },
		});
	});

	it("says so and stays on this thread when app-server refuses the other", () => {
		const harness = ready();
		const before = harness.written.length;
		resume(harness);
		const [asked] = harness.writesSince(before) as { id: number }[];
		harness.receive({
			id: asked!.id,
			error: { code: -32600, message: "no rollout found" },
		});
		expect(harness.transcript.state).toEqual({ phase: "ready", turn: "none" });
		expect(harness.transcript.session.sessionId).toBe(MAIN);
		expect(outline(harness.transcript)).toEqual([
			"notice(error): codex 0.156.1 did not go on with that thread: no rollout found",
		]);
	});

	it("offers /resume as DevHub's own picker", () => {
		expect(
			ready().transcript.session.commands.find(
				(command) => command.name === "resume",
			),
		).toMatchObject({ route: "resume" });
	});
});
