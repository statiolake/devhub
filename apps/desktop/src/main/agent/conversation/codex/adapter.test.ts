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
	RESTARTED,
	RESTART_MARK,
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
			case "answer":
				line = `answer: ${entry.answers
					.map(
						(each) =>
							`${each.header}=${each.secret ? "(secret)" : [...each.chosen, ...(each.written === undefined ? [] : [`"${each.written}"`])].join("|")}`,
					)
					.join(", ")}`;
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
					entry.change !== undefined
						? ` -> ${entry.change.map((file) => file.path).join(",")}`
						: entry.output === undefined
							? ""
							: ` -> ${entry.output
									.map((part) =>
										JSON.stringify(
											part.kind === "command"
												? part.output
												: part.kind === "text"
													? part.text
													: part.kind,
										),
									)
									.join(" + ")}`
				}${entry.spawns === undefined ? "" : ` spawns ${entry.spawns.label}/${entry.spawns.state}`}`;
				break;
			case "notice":
				line = `notice(${entry.level}): ${entry.text}`;
				break;
			case "command":
				line = `command: ${entry.line ?? ""} -> ${entry.output ?? ""}`;
				break;
			case "compaction":
				line = `compaction ${entry.trigger ?? "-"}`;
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
	it("initializes, reads the account, starts a thread in the Workspace, and lists models and skills", () => {
		const harness = new Harness();
		const [initialize, account, start, started, models, skills] = fixture(
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
			{ id: 3, method: "model/list", params: { includeHidden: true } },
			{ id: 4, method: "skills/list", params: { cwds: [CWD] } },
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
				{
					id: "gpt-5.5-codex",
					label: "gpt-5.5-codex",
					detail: "GPT-5.5 Codex",
				},
				{ id: "gpt-5.5-mini", label: "gpt-5.5-mini", detail: "GPT-5.5 mini" },
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

		// The enabled skills, offered after `$` beside the commands after `/`.
		expect(
			session.commands.map((command) => `${command.trigger}${command.name}`),
		).toEqual([
			"/model",
			"/effort",
			"/approvals",
			"/resume",
			"/restart",
			"/mcp",
		]);
		harness.receive(skills!);
		expect(
			harness.transcript.session.commands.filter(
				(command) => command.trigger === "$",
			),
		).toEqual([
			{
				trigger: "$",
				name: "release-notes",
				description: "Write release notes",
				argumentHint: undefined,
				route: "message",
			},
			{
				trigger: "$",
				name: "skill-creator",
				description: "Create a skill",
				argumentHint: undefined,
				route: "message",
			},
		]);
	});

	it("says it could not list the skills, and offers none", () => {
		const harness = new Harness();
		harness.start();
		const lines = fixture("handshake.handwritten.ndjson");
		for (const line of lines.slice(0, 5)) harness.receive(line);
		harness.receive({ id: 4, error: { code: -32603, message: "no skills" } });
		expect(
			harness.transcript.session.commands.some(
				(command) => command.trigger === "$",
			),
		).toBe(false);
		expect(
			harness.transcript.entries.flatMap((entry) =>
				entry.kind === "notice" ? [[entry.level, entry.text]] : [],
			),
		).toEqual([
			[
				"warning",
				expect.stringContaining("could not list its skills: no skills"),
			],
		]);
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
			harness.command({
				kind: "send",
				text: "hi",
				images: [],
				origin: "person",
			}),
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
	it("sends each skill the words mention after $ as that skill, beside the words", () => {
		const harness = ready();
		const text =
			"Use $release-notes, then $skill-creator. Not $old-habit or $nothing, nor a$release-notes.";
		harness.command({ kind: "send", images: [], text, origin: "person" });
		expect(harness.lastWrite()).toMatchObject({
			id: 5,
			method: "turn/start",
			params: {
				input: [
					{ type: "text", text, text_elements: [] },
					{
						type: "skill",
						name: "release-notes",
						path: "/home/testuser/project/.codex/skills/release-notes/SKILL.md",
					},
					{
						type: "skill",
						name: "skill-creator",
						path: "/home/testuser/.codex/skills/.system/skill-creator/SKILL.md",
					},
				],
			},
		});
		// The message comes back with its skills, and is drawn as its words.
		harness.receive({
			method: "item/started",
			params: {
				threadId: MAIN,
				turnId: "turn-1",
				startedAtMs: 1790000000000,
				item: {
					type: "userMessage",
					id: "item-user",
					clientId: "devhub-person-0",
					content: [
						{ type: "text", text, text_elements: [] },
						{
							type: "skill",
							name: "release-notes",
							path: "/home/testuser/project/.codex/skills/release-notes/SKILL.md",
						},
					],
				},
			},
		});
		expect(harness.transcript.sending).toEqual([]);
		expect(outline(harness.transcript)).toEqual([`user(person): ${text}`]);
	});

	it("runs a whole turn with two approvals into one transcript", () => {
		const harness = ready();
		harness.command({
			kind: "send",
			images: [],
			text: "Run pwd, then fix the README title.",
			origin: "person",
		});
		expect(harness.lastWrite()).toEqual({
			id: 5,
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
		// working → waiting (approval) → working → … → idle. Working from the
		// first answer on: the message is written and not taken yet, which is
		// the turn it starts, not an Agent at its prompt.
		expect(statuses[0]).toBe("working");
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
					durationMinutes: 300,
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
		harness.command({ kind: "send", text: "go", images: [], origin: "person" });
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
		harness.command({ kind: "send", text: "go", images: [], origin: "person" });
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
		harness.command({ kind: "send", text: "go", images: [], origin: "person" });
		const lines = fixture("turn.handwritten.ndjson");
		for (const line of lines.slice(0, 4)) harness.receive(line);
		harness.command({
			kind: "send",
			images: [],
			text: "also check git",
			origin: "injection",
		});
		expect(harness.lastWrite()).toEqual({
			id: 6,
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

		harness.command({ kind: "send", text: "go", images: [], origin: "person" });
		const lines = fixture("turn.handwritten.ndjson");
		// Up to and including the command's approval request.
		for (const line of lines.slice(0, 15)) harness.receive(line);
		harness.command({ kind: "interrupt" });
		expect(harness.lastWrite()).toEqual({
			id: 6,
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
		harness.command({ kind: "send", text: "go", images: [], origin: "person" });
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
		harness.command({ kind: "send", text: "go", images: [], origin: "person" });
		harness.receive({
			id: 5,
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
		harness.command({
			kind: "send",
			text: "delegate",
			images: [],
			origin: "person",
		});
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
			  "user(person): delegate",
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
			// Its thread's turn ended; the activity item then names it again.
			"Explorer/completed",
			"explorer/completed",
		]);
		// A subagent's turn does not end the conversation's turn.
		expect(harness.entry(`${CHILD}/child-say`)).toMatchObject({
			parent: `${MAIN}/item-spawn`,
		});
		// A message in the subagent's thread that DevHub did not send is its
		// parent Agent's, not the person's; one in the Agent's own thread
		// without DevHub's id is the person's, typed at Codex's terminal.
		const said = (threadId: string, id: string) =>
			harness.receive({
				method: "item/completed",
				params: {
					threadId,
					turnId: "turn-x",
					completedAtMs: 0,
					item: {
						type: "userMessage",
						id,
						clientId: null,
						content: [{ type: "text", text: "and lib/", text_elements: [] }],
					},
				},
			});
		said(CHILD, "child-told");
		said(MAIN, "main-told");
		expect(harness.entry(`${CHILD}/child-told`)).toMatchObject({
			origin: "other",
		});
		expect(harness.entry(`${MAIN}/main-told`)).toMatchObject({
			origin: "person",
		});
	});

	it("says a subagent is done when its thread's turn ends, with no activity item to say so, and running again when it starts another", () => {
		const harness = ready();
		harness.command({
			kind: "send",
			text: "delegate",
			images: [],
			origin: "person",
		});
		const state = () => {
			const spawn = harness.entry(`${MAIN}/item-spawn`);
			return spawn?.kind === "tool" ? spawn.spawns?.state : undefined;
		};
		const lines = fixture("subagent.handwritten.ndjson").filter(
			(line) => !line.includes('"subAgentActivity"'),
		);
		const childEnd = lines.findIndex(
			(line) =>
				line.includes('"turn/completed"') && line.includes("child-turn-1"),
		);
		for (const line of lines.slice(0, childEnd)) harness.receive(line);
		expect(state()).toBe("running");
		harness.receive(lines[childEnd]!);
		expect(state()).toBe("completed");
		harness.receive(
			lines[childEnd]!.replace('"turn/completed"', '"turn/started"')
				.replaceAll("child-turn-1", "child-turn-2")
				.replace('"status":"completed"', '"status":"inProgress"'),
		);
		expect(state()).toBe("running");
		harness.receive(
			lines[childEnd]!.replaceAll("child-turn-1", "child-turn-2").replace(
				'"status":"completed"',
				'"status":"failed"',
			),
		);
		expect(state()).toBe("failed");
	});

	it("lists a subagent while its thread runs, as working in the background, and lets it go when that ends", () => {
		const harness = ready();
		harness.command({
			kind: "send",
			text: "delegate",
			images: [],
			origin: "person",
		});
		const lines = fixture("subagent.handwritten.ndjson").filter(
			(line) => !line.includes('"subAgentActivity"'),
		);
		const childEnd = lines.findIndex(
			(line) =>
				line.includes('"turn/completed"') && line.includes("child-turn-1"),
		);
		for (const line of lines.slice(0, childEnd)) harness.receive(line);
		expect(harness.transcript.backgroundTasks).toEqual([
			{
				id: `${MAIN}/item-spawn`,
				kind: "subagent",
				title: expect.any(String),
				call: entryId(`${MAIN}/item-spawn`),
				// The spawn call's own start, as app-server's item/started said it.
				startedAt: 1_790_000_000_000,
				stoppable: true,
			},
		]);
		harness.receive(lines[childEnd]!);
		expect(harness.transcript.backgroundTasks).toEqual([]);
	});

	describe("stopped from the background tasks", () => {
		const CHILD = "00000000-0000-7000-8000-00000000000b";
		const SPAWN = `${MAIN}/item-spawn`;

		function delegated(): { harness: Harness; lines: string[] } {
			const harness = ready();
			harness.command({
				kind: "send",
				text: "delegate",
				images: [],
				origin: "person",
			});
			const lines = fixture("subagent.handwritten.ndjson").filter(
				(line) => !line.includes('"subAgentActivity"'),
			);
			return { harness, lines };
		}

		function upTo(lines: readonly string[], found: (line: string) => boolean) {
			const index = lines.findIndex(found);
			if (index < 0) throw new Error("the fixture has no such line");
			return index;
		}

		const childStart = (line: string) =>
			line.includes('"turn/started"') && line.includes("child-turn-1");

		it("cannot be stopped until app-server has said which turn it runs", () => {
			const { harness, lines } = delegated();
			for (const line of lines.slice(0, upTo(lines, childStart)))
				harness.receive(line);
			expect(harness.transcript.backgroundTasks).toEqual([
				expect.objectContaining({
					id: SPAWN,
					stoppable: {
						reason:
							"Codex has not yet said which turn this subagent is running, so there is nothing to interrupt.",
					},
				}),
			]);
			expect(() =>
				harness.adapter.encode({ kind: "stop-task", task: SPAWN }),
			).toThrow(/cannot be stopped from DevHub/);
		});

		it("interrupts the turn its thread runs, and leaves the list only when that turn ends", () => {
			const { harness, lines } = delegated();
			for (const line of lines.slice(0, upTo(lines, childStart) + 1))
				harness.receive(line);
			expect(harness.transcript.backgroundTasks[0]!.stoppable).toBe(true);
			const from = harness.written.length;
			harness.command({ kind: "stop-task", task: SPAWN });
			const [written] = harness.writesSince(from) as [
				{ id: number; method: string; params: unknown },
			];
			expect(written.method).toBe("turn/interrupt");
			expect(written.params).toEqual({
				threadId: CHILD,
				turnId: "child-turn-1",
			});
			harness.receive({ id: written.id, result: {} });
			// Not gone on DevHub's say-so: the turn has not ended yet.
			expect(harness.transcript.backgroundTasks.map((task) => task.id)).toEqual(
				[SPAWN],
			);
			harness.receive({
				method: "turn/completed",
				params: {
					threadId: CHILD,
					turn: {
						id: "child-turn-1",
						items: [],
						itemsView: "notLoaded",
						status: "interrupted",
						error: null,
						startedAt: 1790000000,
						completedAt: 1790000002,
						durationMs: 500,
					},
				},
			});
			expect(harness.transcript.backgroundTasks).toEqual([]);
		});

		it("says so when app-server refuses, and the subagent stays listed", () => {
			const { harness, lines } = delegated();
			for (const line of lines.slice(0, upTo(lines, childStart) + 1))
				harness.receive(line);
			const from = harness.written.length;
			harness.command({ kind: "stop-task", task: SPAWN });
			const [written] = harness.writesSince(from) as [{ id: number }];
			harness.receive({
				id: written.id,
				error: { code: -32600, message: "no such turn" },
			});
			const notice = harness.transcript.entries.at(-1)!;
			expect(notice).toMatchObject({
				kind: "notice",
				level: "error",
				text: expect.stringMatching(/did not stop the subagent: no such turn$/),
			});
			expect(harness.transcript.backgroundTasks.map((task) => task.id)).toEqual(
				[SPAWN],
			);
		});

		it("refuses a task that is not running", () => {
			const { harness } = delegated();
			expect(() =>
				harness.adapter.encode({ kind: "stop-task", task: "nothing" }),
			).toThrow(/nothing is not a background task running now/);
		});
	});

	it("takes the person's messages when app-server says its thread does, steered into its turn or starting one", () => {
		const harness = ready();
		harness.command({
			kind: "send",
			text: "delegate",
			images: [],
			origin: "person",
		});
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
		harness.command({
			kind: "send",
			text: "delegate",
			images: [],
			origin: "person",
		});
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

	describe("a thread no call is known to have started", () => {
		const STRAY = "00000000-0000-7000-8000-00000000000c";
		const said = (
			phase: "started" | "completed",
			id: string,
			text: string,
		) => ({
			method: `item/${phase}`,
			params: {
				threadId: STRAY,
				turnId: "t",
				[phase === "started" ? "startedAtMs" : "completedAtMs"]: 0,
				item: {
					type: "agentMessage",
					id,
					text,
					phase: null,
					memoryCitation: null,
					delivery: null,
					questions: null,
				},
			},
		});
		const mainTurn = (status: "inProgress" | "completed") => ({
			method: status === "inProgress" ? "turn/started" : "turn/completed",
			params: {
				threadId: MAIN,
				turn: {
					id: "turn-2",
					items: [],
					itemsView: "notLoaded",
					status,
					error: null,
					startedAt: 1790000000,
					completedAt: null,
					durationMs: null,
				},
			},
		});
		const startedBy = (call: string) => ({
			method: "item/completed",
			params: {
				threadId: MAIN,
				turnId: "turn-2",
				completedAtMs: 0,
				item: {
					type: "subAgentActivity",
					id: call,
					kind: "started",
					agentThreadId: STRAY,
					agentPath: "/root/late",
				},
			},
		});

		it("holds what it says, and says once, when the turn ends, that it is not shown", () => {
			const harness = ready();
			harness.receive(mainTurn("inProgress"));
			for (let n = 0; n < 100; n += 1) {
				harness.receive(said("started", `m${n}`, ""));
				harness.receive({
					method: "item/agentMessage/delta",
					params: {
						threadId: STRAY,
						turnId: "t",
						itemId: `m${n}`,
						delta: "hi",
					},
				});
				harness.receive(said("completed", `m${n}`, "hi"));
			}
			expect(harness.transcript.entries).toEqual([]);
			harness.receive(mainTurn("completed"));
			harness.receive(mainTurn("inProgress"));
			harness.receive(said("completed", "later", "again"));
			harness.receive(mainTurn("completed"));
			expect(
				outline(harness.transcript).filter((line) => line.startsWith("notice")),
			).toEqual([
				`notice(warning): codex 0.156.1 ran subagent thread ${STRAY} but never said which call started it, so what that thread did is not shown.`,
			]);
		});

		it("draws what it held under the call once one is named, in the order it said it", () => {
			const harness = ready();
			harness.receive(said("started", "first", ""));
			harness.receive(said("completed", "first", "one"));
			harness.receive(said("started", "second", ""));
			harness.receive(said("completed", "second", "two"));
			harness.receive(startedBy("call_late"));
			expect(outline(harness.transcript)).toEqual([
				'tool spawnAgent "Start a subagent: /root/late" succeeded spawns /root/late/running',
				"  assistant: one",
				"  assistant: two",
			]);
		});

		it("is given up once it says more than DevHub keeps, said once, and drawn as a card whose state is not known", () => {
			const harness = ready();
			for (let n = 0; n < 1005; n += 1)
				harness.receive(said("completed", `m${n}`, `${n}`));
			harness.receive(startedBy("call_late"));
			harness.receive(said("started", "after", ""));
			harness.receive({
				method: "item/agentMessage/delta",
				params: { threadId: STRAY, turnId: "t", itemId: "after", delta: "x" },
			});
			harness.receive(mainTurn("completed"));
			expect(outline(harness.transcript)).toEqual([
				`notice(warning): codex 0.156.1 said more on subagent thread ${STRAY} than DevHub keeps before it knows which call started the thread, so what that thread did is not shown.`,
				'tool spawnAgent "Start a subagent: /root/late" succeeded spawns /root/late/unknown',
				"turn-end completed -ms",
			]);
			expect(harness.transcript.backgroundTasks).toEqual([]);
		});

		it("says once that app-server reported on it, however often it does", () => {
			const harness = ready();
			for (let n = 0; n < 50; n += 1) {
				harness.receive({
					method: "item/completed",
					params: {
						threadId: MAIN,
						turnId: "turn-2",
						completedAtMs: 0,
						item: {
							type: "subAgentActivity",
							id: `subagent-completed-t${n}`,
							kind: "completed",
							agentThreadId: STRAY,
							agentPath: "/root/gone",
						},
					},
				});
			}
			expect(outline(harness.transcript)).toEqual([
				`notice(warning): codex 0.156.1 reported on subagent thread ${STRAY}, which DevHub never saw started.`,
			]);
		});
	});
});

/**
 * Multi-agent v2, which codex-cli 0.158.0 runs: a spawn call is reported as
 * a `subAgentActivity` `started` item named by the call's id, with no
 * `collabAgentToolCall`, and the subagent's thread may have begun before it.
 */
describe("multi-agent v2 subagents", () => {
	const A = "00000000-0000-7000-8000-00000000000b";
	const B = "00000000-0000-7000-8000-00000000000c";
	const SPAWN_A = `${MAIN}/call_spawn_a`;
	const SPAWN_B = `${MAIN}/call_spawn_b`;
	const V1 = "00000000-0000-7000-8000-00000000000d";

	function delegated(
		lines: readonly string[] = fixture("subagent-v2.handwritten.ndjson"),
		each: (harness: Harness) => void = () => {},
	): Harness {
		const harness = ready();
		harness.command({
			kind: "send",
			text: "delegate",
			images: [],
			origin: "person",
		});
		for (const line of lines) {
			harness.receive(line);
			each(harness);
		}
		return harness;
	}

	it("draws each subagent's card from its started activity, what its thread said before that placed under it", () => {
		const harness = delegated();
		expect(outline(harness.transcript)).toMatchInlineSnapshot(`
			[
			  "tool spawnAgent "Start a subagent: /root/reader" succeeded spawns /root/reader/completed",
			  "  assistant: Reading src.",
			  "  tool commandExecution "ls src" succeeded -> "main.ts\\n"",
			  "tool spawnAgent "Start a subagent: /root/tester" succeeded spawns /root/tester/failed",
			  "  tool commandExecution "make test" succeeded -> "ok\\n"",
			  "tool wait "Wait for subagents" succeeded",
			  "assistant: src/ has main.ts; the tests could not finish.",
			  "user(person): delegate",
			  "turn-end completed 2100ms",
			]
		`);
		expect(harness.entry(`${A}/a-say`)).toMatchObject({ parent: SPAWN_A });
	});

	it("follows each subagent from running to done or failed, and lists it in the background while it runs", () => {
		const states = new Map<string, string[]>();
		const tasks: string[] = [];
		delegated(undefined, (harness) => {
			for (const spawn of [SPAWN_A, SPAWN_B]) {
				const entry = harness.transcript.entries.find(
					(each) => each.id === spawn,
				);
				if (entry?.kind !== "tool" || entry.spawns === undefined) continue;
				const seen = states.get(spawn) ?? [];
				if (seen.at(-1) !== entry.spawns.state) seen.push(entry.spawns.state);
				states.set(spawn, seen);
			}
			const listed = harness.transcript.backgroundTasks
				.map((task) => task.id)
				.join(",");
			if (tasks.at(-1) !== listed) tasks.push(listed);
		});
		expect(states.get(SPAWN_A)).toEqual(["running", "completed"]);
		expect(states.get(SPAWN_B)).toEqual(["running", "failed"]);
		expect(tasks).toEqual(["", SPAWN_A, `${SPAWN_A},${SPAWN_B}`, SPAWN_B, ""]);
	});

	it("stops a subagent by interrupting its thread's turn, and takes the person's words when its thread does", () => {
		const lines = fixture("subagent-v2.handwritten.ndjson").map((line) =>
			line.replace(
				`"parentThreadId":"${MAIN}",`,
				`"parentThreadId":"${MAIN}","canAcceptDirectInput":true,`,
			),
		);
		const running = lines.findIndex(
			(line) => line.includes('"turn/started"') && line.includes("child-b-1"),
		);
		const harness = delegated(lines.slice(0, running + 1));
		expect(harness.entry(SPAWN_B)).toMatchObject({
			spawns: { takesMessages: true, state: "running" },
		});
		expect(
			harness.transcript.backgroundTasks.find((task) => task.id === SPAWN_B),
		).toMatchObject({ stoppable: true });
		const from = harness.written.length;
		harness.command({ kind: "stop-task", task: SPAWN_B });
		expect(harness.writesSince(from)).toEqual([
			{
				id: expect.any(Number),
				method: "turn/interrupt",
				params: { threadId: B, turnId: "child-b-1" },
			},
		]);
		harness.command({
			kind: "instruct",
			subagent: entryId(SPAWN_A),
			text: "look in lib/ too",
		});
		expect(harness.lastWrite()).toMatchObject({
			method: "turn/steer",
			params: { threadId: A, expectedTurnId: "child-a-1" },
		});
	});

	it("gives many parallel subagents a card each, whichever comes first of a thread's words and its call", () => {
		const count = 40;
		const thread = (n: number) =>
			`00000000-0000-7000-8000-${(0x100 + n).toString(16).padStart(12, "0")}`;
		const item = (
			threadId: string,
			phase: "started" | "completed",
			value: object,
		) =>
			JSON.stringify({
				method: `item/${phase}`,
				params: {
					threadId,
					turnId: threadId === MAIN ? "turn-2" : "child",
					[phase === "started" ? "startedAtMs" : "completedAtMs"]: 0,
					item: value,
				},
			});
		const childTurn = (threadId: string, status: "inProgress" | "completed") =>
			JSON.stringify({
				method: status === "inProgress" ? "turn/started" : "turn/completed",
				params: {
					threadId,
					turn: {
						id: "child",
						items: [],
						itemsView: "notLoaded",
						status,
						error: null,
						startedAt: 1790000000,
						completedAt: null,
						durationMs: null,
					},
				},
			});
		const message = (n: number) => ({
			type: "agentMessage",
			id: `say-${n}`,
			text: `helper ${n}`,
			phase: null,
			memoryCitation: null,
			delivery: null,
			questions: null,
		});
		const started = (n: number) => ({
			type: "subAgentActivity",
			id: `call_${n}`,
			kind: "started",
			agentThreadId: thread(n),
			agentPath: `/root/helper_${n}`,
		});
		// Every thread starts and speaks; its call comes after its words for
		// an even thread, before them for an odd one.
		const lines: string[] = [];
		for (let n = 0; n < count; n += 1) {
			if (n % 2 === 1)
				lines.push(
					item(MAIN, "started", started(n)),
					item(MAIN, "completed", started(n)),
				);
			lines.push(
				childTurn(thread(n), "inProgress"),
				item(thread(n), "completed", message(n)),
			);
		}
		for (let n = 0; n < count; n += 2)
			lines.push(
				item(MAIN, "started", started(n)),
				item(MAIN, "completed", started(n)),
			);
		const harness = delegated(lines);
		expect(harness.transcript.backgroundTasks).toHaveLength(count);
		for (let n = 0; n < count; n += 1)
			harness.receive(childTurn(thread(n), "completed"));
		expect(harness.transcript.backgroundTasks).toEqual([]);
		expect(
			outline(harness.transcript).filter((line) => line.includes("notice")),
		).toEqual([]);
		for (let n = 0; n < count; n += 1) {
			expect(harness.entry(`${thread(n)}/say-${n}`)).toMatchObject({
				parent: `${MAIN}/call_${n}`,
			});
			expect(harness.entry(`${MAIN}/call_${n}`)).toMatchObject({
				spawns: { label: `/root/helper_${n}`, state: "completed" },
			});
		}
	});

	it("rebuilds the same transcript from the journals and writes nothing", () => {
		const live = delegated();
		const replayed = new Harness();
		for (const line of live.written) {
			for (const event of replayed.adapter.sent(line).events)
				replayed.transcript = applyEvent(replayed.transcript, event);
		}
		for (const line of live.received) replayed.receive(line);
		expect(replayed.written).toEqual([]);
		expect(replayed.transcript).toEqual(live.transcript);
	});

	it("draws a resumed thread's past subagents from its history: done when it says so, else unknown, never running", () => {
		const harness = new Harness({ ...OPTIONS, resumeThreadId: MAIN });
		harness.start();
		const [initialize, account, start] = fixture(
			"handshake.handwritten.ndjson",
		);
		harness.receive(initialize!);
		harness.receive(account!);
		const opened = JSON.parse(start!) as {
			result: { thread: { turns: unknown[] } };
		};
		const activity = (id: string, kind: string, thread: string) => ({
			type: "subAgentActivity",
			id,
			kind,
			agentThreadId: thread,
			agentPath: thread === A ? "/root/reader" : "/root/tester",
		});
		opened.result.thread.turns = [
			{
				id: "old-turn",
				items: [
					activity("call_spawn_a", "started", A),
					activity("call_ask_a", "interacted", A),
					activity("subagent-completed-old", "completed", A),
					// Its turn failed: upstream says nothing of that here.
					activity("call_spawn_b", "started", B),
					// A multi-agent v1 spawn, running when it was recorded.
					{
						type: "collabAgentToolCall",
						id: "call_v1",
						tool: "spawnAgent",
						status: "completed",
						senderThreadId: MAIN,
						receiverThreadIds: [V1],
						prompt: "Look around.",
						model: null,
						reasoningEffort: null,
						agentsStates: { [V1]: { status: "running", message: null } },
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
			'tool spawnAgent "Start a subagent: /root/reader" succeeded spawns /root/reader/completed',
			'tool sendMessage "Message a subagent: /root/reader" succeeded',
			'tool spawnAgent "Start a subagent: /root/tester" succeeded spawns /root/tester/unknown',
			'tool spawnAgent "Start a subagent: Look around." succeeded spawns subagent/unknown',
			"turn-end completed 10ms",
		]);
		expect(harness.transcript.backgroundTasks).toEqual([]);
	});

	describe("once the app-server that ran them is started again", () => {
		function restarted(): Harness {
			const lines = fixture("subagent-v2.handwritten.ndjson");
			const running = lines.findIndex(
				(line) => line.includes('"turn/started"') && line.includes("child-b-1"),
			);
			const harness = delegated(lines.slice(0, running + 1));
			expect(harness.transcript.backgroundTasks).toHaveLength(2);
			harness.receive(RESTART_MARK);
			return harness;
		}

		it("says of each subagent that was running that how it stands is unknown, and lists none", () => {
			const harness = restarted();
			expect(harness.entry(SPAWN_A)).toMatchObject({
				spawns: { state: "unknown" },
			});
			expect(harness.entry(SPAWN_B)).toMatchObject({
				spawns: { state: "unknown" },
			});
			expect(harness.transcript.backgroundTasks).toEqual([]);
		});

		it("says the same when the journal is read back after the restart", () => {
			const live = restarted();
			const replayed = new Harness();
			for (const line of live.written) {
				for (const event of replayed.adapter.sent(line).events)
					replayed.transcript = applyEvent(replayed.transcript, event);
			}
			for (const line of live.received) replayed.receive(line);
			expect(replayed.transcript.entries).toEqual(live.transcript.entries);
			expect(replayed.entry(SPAWN_A)).toMatchObject({
				spawns: { state: "unknown" },
			});
		});
	});

	it("says a subagent failed when its thread's turn ends failed or interrupted", () => {
		for (const status of ["failed", "interrupted"]) {
			const lines = fixture("subagent-v2.handwritten.ndjson").map((line) =>
				line.includes('"turn/completed"') && line.includes("child-a-1")
					? line.replace('"status":"completed"', `"status":"${status}"`)
					: line,
			);
			const harness = delegated(
				lines.filter((line) => !line.includes("subagent-completed")),
			);
			expect(harness.entry(SPAWN_A)).toMatchObject({
				spawns: { state: "failed" },
			});
		}
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
			id: "codex/0/7",
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

	/** requestUserInput with a question of each kind: options with Other, and a secret. */
	const ASKING = {
		id: 8,
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
					options: [
						{ label: "TypeScript", description: "" },
						{ label: "Rust", description: "" },
					],
				},
				{
					id: "token",
					header: "Token",
					question: "Your token?",
					isOther: true,
					isSecret: true,
					options: null,
				},
			],
		},
	};

	it("draws the person's answer as their message once DevHub has written it", () => {
		const harness = ready();
		harness.receive(ASKING);
		expect(harness.transcript.entries).toEqual([]);
		harness.command({
			kind: "answer",
			request: harness.transcript.requests[0]!.id,
			answer: {
				kind: "answers",
				values: { lang: "Zig", token: "not-a-real-token" },
			},
		});
		expect(outline(harness.transcript)).toEqual([
			'answer: Language="Zig", Token=(secret)',
		]);
	});

	it("draws the same answer from a replay of what DevHub wrote", () => {
		const live = ready();
		live.receive(ASKING);
		live.command({
			kind: "answer",
			request: live.transcript.requests[0]!.id,
			answer: { kind: "answers", values: { lang: "Rust", token: "x" } },
		});
		const replayed = ready();
		replayed.receive(ASKING);
		// A replay feeds `in.log` back to `sent`, as it was written.
		for (const event of replayed.adapter.sent(live.written.at(-1)!).events)
			replayed.transcript = applyEvent(replayed.transcript, event);
		expect(replayed.transcript.entries).toEqual(live.transcript.entries);
		expect(outline(replayed.transcript)).toEqual([
			"answer: Language=Rust, Token=(secret)",
		]);
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

	function elicit(harness: ReturnType<typeof ready>, params: object) {
		harness.receive({
			id: 8,
			method: "mcpServer/elicitation/request",
			params: {
				threadId: MAIN,
				turnId: null,
				serverName: "tickets",
				_meta: null,
				...params,
			},
		});
		return harness.transcript.requests[0]!;
	}

	it("offers a form elicitation of no fields as a confirmation, accepted with empty content", () => {
		const harness = ready();
		const request = elicit(harness, {
			mode: "form",
			message: "Allow the tickets server to file one?",
			requestedSchema: { type: "object", properties: {} },
		});
		expect(request.subject).toEqual({
			kind: "elicitation",
			server: "tickets",
			message: "Allow the tickets server to file one?",
			url: undefined,
			fields: [],
		});
		expect(request.choices.map((choice) => choice.id)).toEqual([
			"decline",
			"cancel",
		]);
		harness.command({
			kind: "answer",
			request: request.id,
			answer: { kind: "answers", values: {} },
		});
		expect(harness.lastWrite()).toEqual({
			id: 8,
			result: { action: "accept", content: {}, _meta: null },
		});
	});

	it.each(["decline", "cancel"] as const)(
		"answers an elicitation's %s with no content",
		(action) => {
			const harness = ready();
			const request = elicit(harness, {
				mode: "form",
				message: "Go on?",
				requestedSchema: { type: "object", properties: {} },
			});
			harness.command({
				kind: "answer",
				request: request.id,
				answer: { kind: "choice", choiceId: action, text: undefined },
			});
			expect(harness.lastWrite()).toEqual({
				id: 8,
				result: { action, content: null, _meta: null },
			});
		},
	);

	it("reads a form's fields from its schema and accepts it with their values, typed as the schema says", () => {
		const harness = ready();
		const request = elicit(harness, {
			mode: "form",
			message: "File a ticket",
			requestedSchema: {
				type: "object",
				properties: {
					title: { type: "string", title: "Title", maxLength: 80 },
					email: { type: "string", format: "email" },
					count: { type: "integer", minimum: 1, default: 2 },
					urgent: { type: "boolean", description: "Page someone" },
					team: { type: "string", enum: ["web", "api"] },
					area: {
						type: "string",
						oneOf: [
							{ const: "ui", title: "User interface" },
							{ const: "db", title: "Database" },
						],
					},
					labels: {
						type: "array",
						items: { type: "string", enum: ["bug", "chore"] },
						maxItems: 2,
					},
				},
				required: ["title", "team"],
			},
		});
		expect(request.subject).toMatchObject({
			kind: "elicitation",
			fields: [
				{
					key: "title",
					label: "Title",
					required: true,
					input: { kind: "text", maxLength: 80 },
				},
				{
					key: "email",
					label: "email",
					required: false,
					input: { kind: "text", format: "email" },
				},
				{
					key: "count",
					input: { kind: "number", integer: true, minimum: 1, default: 2 },
				},
				{
					key: "urgent",
					description: "Page someone",
					input: { kind: "boolean", default: undefined },
				},
				{
					key: "team",
					required: true,
					input: {
						kind: "choice",
						multiple: false,
						options: [
							{ value: "web", label: "web" },
							{ value: "api", label: "api" },
						],
					},
				},
				{
					key: "area",
					input: {
						kind: "choice",
						multiple: false,
						options: [
							{ value: "ui", label: "User interface" },
							{ value: "db", label: "Database" },
						],
					},
				},
				{
					key: "labels",
					input: { kind: "choice", multiple: true, maxItems: 2 },
				},
			],
		});
		harness.command({
			kind: "answer",
			request: request.id,
			answer: {
				kind: "answers",
				values: {
					title: "Login fails",
					email: "",
					count: "3",
					urgent: "true",
					team: "api",
					area: "",
					labels: ["bug"],
				},
			},
		});
		expect(harness.lastWrite()).toEqual({
			id: 8,
			result: {
				action: "accept",
				content: {
					title: "Login fails",
					count: 3,
					urgent: true,
					team: "api",
					labels: ["bug"],
				},
				_meta: null,
			},
		});
	});

	it("accepts a URL elicitation, which carries no content, and shows its page", () => {
		const harness = ready();
		const request = elicit(harness, {
			mode: "url",
			message: "Sign in to the tracker",
			url: "https://tracker.example.com/auth",
			elicitationId: "e-1",
		});
		expect(request.subject).toEqual({
			kind: "elicitation",
			server: "tickets",
			message: "Sign in to the tracker",
			url: "https://tracker.example.com/auth",
			fields: [],
		});
		harness.command({
			kind: "answer",
			request: request.id,
			answer: { kind: "answers", values: {} },
		});
		expect(harness.lastWrite()).toEqual({
			id: 8,
			result: { action: "accept", content: null, _meta: null },
		});
	});

	it.each([
		["session", "remember:session"],
		["always", "remember:always"],
	] as const)(
		"offers a confirmation's remembering for %s after Accept, and accepts it with _meta.persist",
		(persist, choiceId) => {
			const harness = ready();
			const request = elicit(harness, {
				mode: "form",
				message: "Allow the tickets server to run file_ticket?",
				requestedSchema: { type: "object", properties: {} },
				_meta: {
					codex_approval_kind: "mcp_tool_call",
					persist: ["session", "always"],
				},
			});
			expect(request.choices).toEqual([
				{
					id: "remember:session",
					label: "Accept for this session",
					tone: "allow",
					takesText: false,
				},
				{
					id: "remember:always",
					label: "Always accept",
					tone: "allow",
					takesText: false,
				},
				{ id: "decline", label: "Decline", tone: "deny", takesText: false },
				{ id: "cancel", label: "Cancel", tone: "neutral", takesText: false },
			]);
			harness.command({
				kind: "answer",
				request: request.id,
				answer: { kind: "choice", choiceId, text: undefined },
			});
			expect(harness.lastWrite()).toEqual({
				id: 8,
				result: { action: "accept", content: {}, _meta: { persist } },
			});
		},
	);

	it("offers only the remembering _meta.persist names, as one mode or a list, and none it does not know", () => {
		const ids = (meta: unknown) =>
			elicit(ready(), {
				mode: "form",
				message: "Go on?",
				requestedSchema: { type: "object", properties: {} },
				_meta: meta,
			}).choices.map((choice) => choice.id);
		expect(ids({ persist: "always" })).toEqual([
			"remember:always",
			"decline",
			"cancel",
		]);
		expect(ids({ persist: ["forever", "session"] })).toEqual([
			"remember:session",
			"decline",
			"cancel",
		]);
		expect(ids({ codex_approval_kind: "mcp_tool_call" })).toEqual([
			"decline",
			"cancel",
		]);
	});

	it("offers no remembering for a form with fields, as Codex's own UI does not", () => {
		const request = elicit(ready(), {
			mode: "form",
			message: "File a ticket",
			requestedSchema: {
				type: "object",
				properties: { title: { type: "string" } },
			},
			_meta: { persist: ["session", "always"] },
		});
		expect(request.choices.map((choice) => choice.id)).toEqual([
			"decline",
			"cancel",
		]);
	});
});

describe("what DevHub does not know", () => {
	it("shows an unknown notification as a quiet report, once per method, and goes on", () => {
		const harness = ready();
		harness.receive({ method: "thread/sparkles", params: { threadId: MAIN } });
		harness.receive({ method: "thread/sparkles", params: { threadId: MAIN } });
		expect(outline(harness.transcript)).toEqual([
			"notice(info): codex 0.156.1 reported `thread/sparkles`",
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
		harness.command({ kind: "send", text: "go", images: [], origin: "person" });
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
		replayed.command({
			kind: "send",
			text: "next",
			images: [],
			origin: "person",
		});
		expect(replayed.lastWrite()).toMatchObject({
			id: 6,
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
		harness.command({ kind: "send", text: "go", images: [], origin: "person" });
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
		id: 6,
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
			id: 6,
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
			images: [],
			text: "go, differently",
			origin: "person",
		});
		expect(harness.lastWrite()).toMatchObject({
			id: 7,
			method: "turn/start",
			params: { threadId: MAIN, clientUserMessageId: "devhub-person-1" },
		});
	});

	it("says so when app-server refuses, and drops nothing", () => {
		const harness = oneTurn();
		const before = harness.transcript.entries;
		harness.rewind(USER);
		harness.receive({
			id: 6,
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
		harness.command({ kind: "send", text: "go", images: [], origin: "person" });
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
		harness.command({
			kind: "send",
			text: "more",
			images: [],
			origin: "person",
		});
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
		harness.receive({ id: 6, result: { turn: turn2 } });
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
			id: 7,
			method: "thread/revert",
			params: { threadId: MAIN, beforeTurnId: "turn-1" },
		});
		harness.receive({ ...REVERTED, id: 7 });
		expect(harness.transcript.entries).toEqual([]);
		expect(harness.transcript.state).toEqual({ phase: "ready", turn: "none" });
	});

	it("shows a message as sending from its write until its item comes back", () => {
		const harness = oneTurn();
		harness.command({
			kind: "send",
			text: "more",
			images: [],
			origin: "person",
		});
		expect(harness.transcript.sending).toEqual([
			{ id: "devhub-person-1", text: "more", images: [], origin: "person" },
		]);
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
		expect(harness.transcript.sending).toEqual([]);
		expect(harness.transcript.entries.at(-1)).toMatchObject({
			kind: "user",
			text: "more",
		});
	});

	it("lets go of a sending message whose turn app-server refused", () => {
		const harness = oneTurn();
		harness.command({
			kind: "send",
			text: "more",
			images: [],
			origin: "person",
		});
		harness.receive({ id: 6, error: { code: -32600, message: "no" } });
		expect(harness.transcript.sending).toEqual([]);
	});

	it("is working from a message's write until the end of its turn, which answers it even when its item never came back", () => {
		const harness = oneTurn();
		harness.command({
			kind: "send",
			text: "more",
			images: [],
			origin: "person",
		});
		expect(conversationStatus(harness.transcript)).toBe("working");
		const turn2 = {
			id: "turn-2",
			items: [],
			itemsView: "notLoaded",
			status: "inProgress",
			error: null,
			startedAt: null,
			completedAt: null,
			durationMs: null,
		};
		harness.receive({ id: 6, result: { turn: turn2 } });
		harness.receive({
			method: "turn/started",
			params: { threadId: MAIN, turn: turn2 },
		});
		harness.receive({
			method: "turn/completed",
			params: {
				threadId: MAIN,
				turn: { ...turn2, status: "completed", durationMs: 3 },
			},
		});
		expect(harness.transcript.sending).toEqual([]);
		expect(conversationStatus(harness.transcript)).toBe("idle");
		expect(
			harness.transcript.entries
				.slice(-2)
				.map((each) =>
					each.kind === "user"
						? `user(${each.origin}): ${each.text}`
						: each.kind,
				),
		).toEqual(["user(person): more", "turn-end"]);
	});

	it("shows the conversation compacting while its contextCompaction item runs, and the divider once it is done", () => {
		const harness = oneTurn();
		harness.command({
			kind: "send",
			text: "more",
			images: [],
			origin: "person",
		});
		const turn2 = {
			id: "turn-2",
			items: [],
			itemsView: "notLoaded",
			status: "inProgress",
			error: null,
			startedAt: null,
			completedAt: null,
			durationMs: null,
		};
		harness.receive({ id: 6, result: { turn: turn2 } });
		harness.receive({
			method: "turn/started",
			params: { threadId: MAIN, turn: turn2 },
		});
		const compaction = (method: string) => ({
			method,
			params: {
				threadId: MAIN,
				turnId: "turn-2",
				startedAtMs: 0,
				completedAtMs: 0,
				item: { type: "contextCompaction", id: "item-compact" },
			},
		});
		harness.receive(compaction("item/started"));
		expect(harness.transcript.compacting).toBe(true);
		expect(harness.transcript.entries.at(-1)?.kind).not.toBe("compaction");
		harness.receive(compaction("item/completed"));
		expect(harness.transcript.compacting).toBe(false);
		expect(harness.transcript.entries.at(-1)).toMatchObject({
			kind: "compaction",
			id: `${MAIN}/item-compact`,
		});
		expect(conversationStatus(harness.transcript)).toBe("working");
	});

	it("replays to the same rewound transcript and writes nothing", () => {
		const live = oneTurn();
		live.rewind(USER);
		live.receive(REVERTED);
		live.command({ kind: "send", text: "again", images: [], origin: "person" });

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
					"codex 0.156.1 is not signed in. Sign in with `codex login` in a terminal on this Agent's machine, then try again.",
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
			{
				window: "5-hour",
				durationMinutes: 300,
				usedPercent: 0,
				resetsAt: 1_790_313_079_000,
			},
			{
				window: "7-day",
				durationMinutes: 10_080,
				usedPercent: 17,
				resetsAt: 1_790_593_906_000,
			},
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
		harness.command({
			kind: "send",
			text: "here",
			images: [],
			origin: "person",
		});
		harness.receive({
			id: (harness.lastWrite() as { id: number }).id,
			result: {
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
		harness.command({
			kind: "send",
			text: "go on",
			images: [],
			origin: "person",
		});
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

describe("restarting the session", () => {
	/** A turn running on the main thread, with the person's message in it. */
	function running(): Harness {
		const harness = ready();
		harness.command({
			kind: "send",
			text: "here",
			images: [],
			origin: "person",
		});
		harness.receive({
			id: (harness.lastWrite() as { id: number }).id,
			result: {
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
		return harness;
	}

	it("stops a thread whose turn the provider refused as unauthorized, and a restart goes on from it", () => {
		const harness = running();
		harness.receive({
			method: "turn/completed",
			params: {
				threadId: MAIN,
				turn: {
					id: "t-1",
					items: [],
					itemsView: "notLoaded",
					status: "failed",
					error: {
						message: "Your access token could not be refreshed.",
						codexErrorInfo: "unauthorized",
						additionalDetails: null,
					},
					startedAt: null,
					completedAt: null,
					durationMs: null,
				},
			},
		});
		expect(harness.transcript.state).toMatchObject({
			phase: "broken",
			failure: {
				code: "not_signed_in",
				detail: expect.stringMatching(
					/said: “Your access token could not be refreshed\.”\. Sign in with `codex login`/,
				) as string,
			},
		});
		// Stopped, it reads nothing but a new server's start.
		expect(harness.adapter.restart()).toEqual({
			kind: "restart",
			session: [],
			mark: [RESTART_MARK],
		});
		const before = harness.written.length;
		harness.receive(RESTART_MARK);
		expect(harness.transcript.state).toEqual({
			phase: "ready",
			turn: "rewinding",
		});
		expect(harness.writesSince(before)).toMatchObject([
			{ method: "initialize" },
		]);
	});

	it("starts app-server again, with the restart mark between the two", () => {
		const harness = running();
		expect(harness.adapter.restart()).toEqual({
			kind: "restart",
			session: [],
			mark: [RESTART_MARK],
		});
		expect(harness.transcript.state).toEqual({
			phase: "ready",
			turn: "running",
		});
	});

	it("keeps the thread drawn under a quiet divider, greets the new server afresh and resumes the same thread on it", () => {
		const harness = running();
		const drawn = outline(harness.transcript);
		const before = harness.written.length;
		const step = harness.receive(RESTART_MARK);
		expect(step.events).toContainEqual({ type: "restarted" });
		expect(outline(harness.transcript)).toEqual([
			...drawn,
			`notice(info): ${RESTARTED}`,
		]);
		expect(harness.transcript.sending).toEqual([]);
		expect(harness.transcript.state).toEqual({
			phase: "ready",
			turn: "rewinding",
		});
		const [initialize] = harness.writesSince(before) as {
			id: number;
			method: string;
		}[];
		expect(initialize).toMatchObject({ method: "initialize" });

		const handshake = fixture("handshake.handwritten.ndjson").map(
			(line) => JSON.parse(line) as { id?: number },
		);
		const answer = (asked: { id: number }, index: number) =>
			harness.receive({ ...handshake[index], id: asked.id });
		answer(initialize!, 0);
		const [initialized, account] = harness.writesSince(before + 1) as {
			id: number;
			method: string;
		}[];
		expect(initialized).toEqual({ method: "initialized" });
		expect(account).toMatchObject({ method: "account/read" });
		answer(account!, 1);
		const resumed = harness.lastWrite() as { id: number };
		expect(resumed).toEqual({
			id: resumed.id,
			method: "thread/resume",
			params: { threadId: MAIN, cwd: CWD },
		});
		// app-server hands the thread back with its past, which is drawn already.
		const opened = handshake[2] as {
			result: { thread: { turns: unknown[] } };
		};
		harness.receive({
			id: resumed.id,
			result: {
				...opened.result,
				thread: {
					...opened.result.thread,
					turns: [
						{
							id: "t-1",
							items: [
								{
									type: "userMessage",
									id: "past-user",
									clientId: null,
									content: [{ type: "text", text: "here", text_elements: [] }],
								},
							],
							itemsView: "full",
							status: "interrupted",
							error: null,
							startedAt: null,
							completedAt: null,
							durationMs: 5,
						},
					],
				},
			},
		});
		// The same thread, not drawn a second time.
		expect(outline(harness.transcript)).toEqual([
			...drawn,
			`notice(info): ${RESTARTED}`,
		]);
		expect(harness.transcript.session.sessionId).toBe(MAIN);
		expect(harness.transcript.state).toEqual({ phase: "ready", turn: "none" });
		// The new server is asked for its models and skills again.
		expect(
			(harness.writesSince(before) as { method?: string }[]).map(
				(line) => line.method,
			),
		).toEqual([
			"initialize",
			"initialized",
			"account/read",
			"thread/resume",
			"model/list",
			"skills/list",
		]);

		harness.command({
			kind: "send",
			text: "go on",
			images: [],
			origin: "person",
		});
		expect(harness.lastWrite()).toMatchObject({
			method: "turn/start",
			params: { threadId: MAIN },
		});
	});

	it("names a request of the new server apart from the old one's with the same id", () => {
		const harness = ready();
		const ask = {
			id: 7,
			method: "item/tool/requestUserInput",
			params: {
				threadId: MAIN,
				turnId: "t-1",
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
		};
		harness.receive(ask);
		const [first] = harness.transcript.requests;
		harness.receive(RESTART_MARK);
		expect(harness.transcript.requests).toEqual([]);
		harness.receive(ask);
		const [second] = harness.transcript.requests;
		expect(second!.id).not.toBe(first!.id);
	});

	it("offers /restart as DevHub's own command", () => {
		expect(
			ready().transcript.session.commands.find(
				(command) => command.name === "restart",
			),
		).toMatchObject({ trigger: "/", route: "restart" });
	});
});

describe("an MCP tool's result", () => {
	it("keeps its text and its images, in order, as the call's output", () => {
		const harness = ready();
		harness.command({ kind: "send", text: "go", images: [], origin: "person" });
		harness.receive({
			method: "item/completed",
			params: {
				threadId: MAIN,
				turnId: "turn-1",
				completedAtMs: 0,
				item: {
					type: "mcpToolCall",
					id: "item-mcp",
					server: "browser",
					tool: "screenshot",
					status: "completed",
					arguments: { tabId: 1 },
					result: {
						content: [
							{ type: "text", text: "Captured." },
							{ type: "image", data: "AAAA", mimeType: "image/png" },
						],
						structuredContent: null,
						_meta: null,
					},
					error: null,
					durationMs: 5,
				},
			},
		});
		expect(harness.entry(`${MAIN}/item-mcp`)).toMatchObject({
			kind: "tool",
			title: "browser · screenshot",
			output: [
				{ kind: "text", text: "Captured." },
				{
					kind: "image",
					image: {
						mediaType: "image/png",
						source: { kind: "data", base64: "AAAA" },
					},
				},
			],
		});
	});
});

describe("images the person sends", () => {
	it("go to app-server as data URLs after the words, and the message is sending with them", () => {
		const harness = ready();
		harness.command({
			kind: "send",
			text: "what is this?",
			images: [
				{
					mediaType: "image/png",
					source: { kind: "data", base64: "AAAA" },
					label: "shot.png",
				},
			],
			origin: "person",
		});
		expect(harness.lastWrite()).toMatchObject({
			method: "turn/start",
			params: {
				input: [
					{ type: "text", text: "what is this?", text_elements: [] },
					{ type: "image", url: "data:image/png;base64,AAAA" },
				],
			},
		});
		expect(harness.transcript.sending).toEqual([
			{
				id: "devhub-person-0",
				text: "what is this?",
				images: [
					{
						mediaType: "image/png",
						source: { kind: "url", url: "data:image/png;base64,AAAA" },
						label: "image",
					},
				],
				origin: "person",
			},
		]);
	});
});

describe("the thread's model, against the models model/list names", () => {
	function model(name: string, hidden: boolean, efforts: readonly string[]) {
		return {
			id: name,
			model: name,
			upgrade: null,
			upgradeInfo: null,
			availabilityNux: null,
			displayName: `${name} (label)`,
			description: "",
			modelSpecialty: null,
			hidden,
			supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
				reasoningEffort,
				description: reasoningEffort,
			})),
			defaultReasoningEffort: efforts[0],
			inputModalities: ["text"],
			supportsPersonality: false,
			multiAgentVersion: null,
			additionalSpeedTiers: [],
			serviceTiers: [],
			defaultServiceTier: null,
			availableAccessPrograms: null,
			isDefault: false,
		};
	}
	const SHOWN = model("shown-model", false, ["low", "high"]);
	const HIDDEN = model("older-model", true, ["medium", "xhigh"]);

	/** A resumed thread on `thread`, its handshake answered up to `model/list`. */
	function resumedOn(thread: string): Harness {
		const harness = new Harness({ ...OPTIONS, resumeThreadId: MAIN });
		harness.start();
		const [initialize, account, start] = fixture(
			"handshake.handwritten.ndjson",
		);
		harness.receive(initialize!);
		harness.receive(account!);
		const opened = JSON.parse(start!) as {
			result: { model: string; reasoningEffort: string | null };
		};
		opened.result.model = thread;
		opened.result.reasoningEffort = null;
		harness.receive(opened);
		return harness;
	}

	it("lists hidden models too, and offers the thread's own hidden model with its efforts", () => {
		const harness = resumedOn("older-model");
		expect(harness.writesSince(harness.written.length - 2)[0]).toEqual({
			id: 3,
			method: "model/list",
			params: { includeHidden: true },
		});
		harness.receive({
			id: 3,
			result: { data: [SHOWN, HIDDEN], nextCursor: null },
		});
		const { session } = harness.transcript;
		expect(session.model).toEqual({
			current: "older-model",
			choices: [
				{
					id: "shown-model",
					label: "shown-model",
					detail: "shown-model (label)",
				},
				{
					id: "older-model",
					label: "older-model",
					detail: "older-model (label)",
				},
			],
		});
		expect(session.effort).toEqual({
			current: "medium",
			choices: [
				{ id: "medium", label: "medium" },
				{ id: "xhigh", label: "xhigh" },
			],
		});
	});

	it("offers no hidden model the thread is not on", () => {
		const harness = resumedOn("shown-model");
		harness.receive({
			id: 3,
			result: { data: [SHOWN, HIDDEN], nextCursor: null },
		});
		expect(harness.transcript.session.model.choices).toEqual([
			{
				id: "shown-model",
				label: "shown-model",
				detail: "shown-model (label)",
			},
		]);
	});

	it("reads every page of the list before it names the thread's model", () => {
		const harness = resumedOn("older-model");
		harness.receive({ id: 3, result: { data: [SHOWN], nextCursor: "page-2" } });
		expect(harness.lastWrite()).toEqual({
			id: 5,
			method: "model/list",
			params: { includeHidden: true, cursor: "page-2" },
		});
		expect(harness.transcript.session.effort.unchangeable).toBeUndefined();
		harness.receive({ id: 5, result: { data: [HIDDEN], nextCursor: null } });
		const { session } = harness.transcript;
		expect(session.model.current).toBe("older-model");
		expect(session.effort.choices.map((choice) => choice.id)).toEqual([
			"medium",
			"xhigh",
		]);
	});

	it("is a choice of its own when the list does not name it, and says why its effort can't be changed", () => {
		const harness = resumedOn("retired-model");
		harness.receive({
			id: 3,
			result: { data: [SHOWN, HIDDEN], nextCursor: null },
		});
		const { session } = harness.transcript;
		expect(session.model.current).toBe("retired-model");
		expect(session.model.choices[0]).toEqual({
			id: "retired-model",
			label: "retired-model",
		});
		expect(session.effort.choices).toEqual([]);
		expect(session.effort.unchangeable).toContain("retired-model");
	});

	it("says why neither the model nor the effort can be changed when the list failed", () => {
		const harness = resumedOn("shown-model");
		harness.receive({
			id: 3,
			error: { code: -32603, message: "catalog unavailable" },
		});
		const { session } = harness.transcript;
		expect(session.model.current).toBe("shown-model");
		expect(session.model.choices).toEqual([]);
		expect(session.model.unchangeable).toContain("catalog unavailable");
		expect(session.effort.unchangeable).toContain("catalog unavailable");
	});
});

describe("the MCP servers", () => {
	/** One `McpServerStatus` as `mcpServerStatus/list` names it, with the fields the panel does not read. */
	function server(fields: Record<string, unknown>): Record<string, unknown> {
		return {
			runtimeStatus: null,
			pluginId: null,
			httpOrigin: null,
			serverInfo: null,
			serverCapabilities: null,
			tools: {},
			toolsError: null,
			resources: [],
			resourceTemplates: [],
			authStatus: "unsupported",
			...fields,
		};
	}

	/** The last request written: its id, method and params. */
	function lastCall(harness: Harness): {
		readonly id: number;
		readonly method: string;
		readonly params?: unknown;
	} {
		return harness.lastWrite() as never;
	}

	it("asks for them with the documented mcpServerStatus/list, for the thread, following every page", () => {
		const harness = ready();
		harness.command({ kind: "mcp", request: { action: "refresh" } });
		const first = lastCall(harness);
		expect(first.method).toBe("mcpServerStatus/list");
		expect(first.params).toEqual({
			detail: "toolsAndAuthOnly",
			threadId: MAIN,
		});
		harness.receive({
			id: first.id,
			result: {
				data: [server({ name: "docs", runtimeStatus: "connected" })],
				nextCursor: "page-2",
			},
		});
		expect(harness.transcript.mcp.servers).toBeUndefined();
		const second = lastCall(harness);
		expect(second.params).toEqual({
			detail: "toolsAndAuthOnly",
			threadId: MAIN,
			cursor: "page-2",
		});
		harness.receive({
			id: second.id,
			result: {
				data: [
					server({
						name: "linear",
						runtimeStatus: "authenticationRequired",
						authStatus: "notLoggedIn",
						pluginId: "linear@openai-curated",
					}),
					server({
						name: "broken",
						runtimeStatus: "failed",
						toolsError: "connection refused",
					}),
					server({ name: "later", authStatus: "notLoggedIn" }),
					server({ name: "off", runtimeStatus: "disabled" }),
				],
				nextCursor: null,
			},
		});
		expect(harness.transcript.mcp.servers).toEqual([
			{
				name: "docs",
				status: "connected",
				said: "connected",
				error: undefined,
				source: undefined,
				actions: ["reconnect"],
			},
			{
				name: "linear",
				status: "needs-sign-in",
				said: "authenticationRequired",
				error: undefined,
				source: "plugin linear@openai-curated",
				actions: ["sign-in", "reconnect"],
			},
			{
				name: "broken",
				status: "failed",
				said: "failed",
				error: "connection refused",
				source: undefined,
				actions: ["reconnect"],
			},
			{
				name: "later",
				status: "needs-sign-in",
				said: "notLoggedIn",
				error: undefined,
				source: undefined,
				actions: ["sign-in", "reconnect"],
			},
			{
				name: "off",
				status: "disabled",
				said: "disabled",
				error: undefined,
				source: undefined,
				actions: [],
			},
		]);
		// Nothing about them in the conversation itself.
		expect(harness.transcript.entries).toEqual([]);
	});

	function listing(servers: readonly Record<string, unknown>[]): Harness {
		const harness = ready();
		harness.command({ kind: "mcp", request: { action: "refresh" } });
		harness.receive({
			id: lastCall(harness).id,
			result: { data: servers.map(server), nextCursor: null },
		});
		return harness;
	}

	it("reconnects with the documented config/mcpServer/reload, every server working until it is answered, and asks again after", () => {
		const harness = listing([
			{ name: "docs", runtimeStatus: "connected" },
			{ name: "broken", runtimeStatus: "failed" },
		]);
		harness.command({
			kind: "mcp",
			request: { action: "reconnect", server: "broken" },
		});
		const reload = lastCall(harness);
		expect(reload).toEqual({
			id: reload.id,
			method: "config/mcpServer/reload",
		});
		expect(harness.transcript.mcp.working).toEqual([
			{ server: "docs", action: "reconnect" },
			{ server: "broken", action: "reconnect" },
		]);
		harness.receive({ id: reload.id, result: {} });
		expect(harness.transcript.mcp.working).toEqual([]);
		expect(lastCall(harness).method).toBe("mcpServerStatus/list");
	});

	it("offers no enabling or disabling, which Codex keeps in its config", () => {
		const harness = listing([{ name: "off", runtimeStatus: "disabled" }]);
		expect(() =>
			harness.command({
				kind: "mcp",
				request: { action: "enable", server: "off" },
			}),
		).toThrow("enable is not offered for the MCP server off now");
	});

	it("says a refused request in the panel until the person makes the next one", () => {
		const harness = listing([{ name: "broken", runtimeStatus: "failed" }]);
		harness.command({
			kind: "mcp",
			request: { action: "reconnect", server: "broken" },
		});
		harness.receive({
			id: lastCall(harness).id,
			error: { code: -32603, message: "failed to refresh MCP servers: boom" },
		});
		expect(harness.transcript.mcp.failure).toBe(
			"Reconnecting the MCP servers failed: failed to refresh MCP servers: boom",
		);
		expect(harness.transcript.mcp.working).toEqual([]);
		harness.command({
			kind: "mcp",
			request: { action: "reconnect", server: "broken" },
		});
		expect(harness.transcript.mcp.failure).toBeUndefined();
	});
});

describe("a turn the plan's usage limit stopped", () => {
	const RESETS = 1_790_003_600;
	/** A turn started by "go": its answer, its start and the message, as app-server gives them. */
	function started(): Harness {
		const harness = ready();
		harness.command({ kind: "send", text: "go", images: [], origin: "person" });
		for (const line of fixture("turn.handwritten.ndjson").slice(0, 4))
			harness.receive(line);
		return harness;
	}
	const limits = (usedPercent: number) => ({
		method: "account/rateLimits/updated",
		params: {
			rateLimits: {
				limitId: "codex",
				limitName: null,
				normalModelSlug: null,
				primary: { usedPercent, windowDurationMins: 300, resetsAt: RESETS },
				secondary: {
					usedPercent: 20,
					windowDurationMins: 10080,
					resetsAt: RESETS + 99,
				},
				credits: null,
				individualLimit: null,
				spendControlReached: null,
				planType: null,
				rateLimitReachedType: usedPercent >= 100 ? "rate_limit_reached" : null,
			},
		},
	});
	const failed = (codexErrorInfo: unknown) => ({
		method: "turn/completed",
		params: {
			threadId: MAIN,
			turn: {
				id: "turn-1",
				items: [],
				itemsView: "notLoaded",
				status: "failed",
				error: {
					message: "You've hit your usage limit.",
					codexErrorInfo,
					additionalDetails: null,
				},
				startedAt: null,
				completedAt: null,
				durationMs: null,
			},
		},
	});
	const lastEnd = (harness: Harness) =>
		harness.transcript.entries.findLast((each) => each.kind === "turn-end");

	it("ends with the limit, reset when the used-up window resets", () => {
		const harness = started();
		harness.receive(limits(100));
		harness.receive(failed("usageLimitExceeded"));
		expect(lastEnd(harness)).toMatchObject({
			outcome: "failed",
			limit: { resetsAt: RESETS * 1000 },
		});
	});

	it("learns the reset from the rate limits Codex reports after the turn", () => {
		const harness = started();
		harness.receive(limits(60));
		harness.receive(failed("usageLimitExceeded"));
		expect(lastEnd(harness)).toMatchObject({ limit: { resetsAt: undefined } });
		harness.receive(limits(100));
		expect(lastEnd(harness)).toMatchObject({
			limit: { resetsAt: RESETS * 1000 },
		});
	});

	it("is not a turn that failed for another reason", () => {
		for (const info of [
			null,
			"serverOverloaded",
			{ httpConnectionFailed: { httpStatusCode: 429 } },
		]) {
			const harness = started();
			harness.receive(limits(100));
			harness.receive(failed(info));
			expect(lastEnd(harness), JSON.stringify(info)).toMatchObject({
				limit: undefined,
			});
		}
	});

	it("goes on with a message sent for the person, which says so", () => {
		const harness = started();
		harness.receive(limits(100));
		harness.receive(failed("usageLimitExceeded"));
		harness.command({
			kind: "send",
			text: "続けて",
			images: [],
			origin: "after-limit",
		});
		const clientUserMessageId = (
			harness.lastWrite() as { params: { clientUserMessageId: string } }
		).params.clientUserMessageId;
		expect(clientUserMessageId).toMatch(/^devhub-after-limit-\d+$/);
		expect(harness.transcript.sending).toMatchObject([
			{ text: "続けて", origin: "after-limit" },
		]);
		harness.receive({
			method: "item/completed",
			params: {
				item: {
					type: "userMessage",
					id: "item-resume",
					clientId: clientUserMessageId,
					content: [{ type: "text", text: "続けて", text_elements: [] }],
				},
				threadId: MAIN,
				turnId: "turn-2",
				completedAtMs: 1790000000000,
			},
		});
		expect(harness.entry(`${MAIN}/item-resume`)).toMatchObject({
			kind: "user",
			origin: "after-limit",
		});
	});
});
