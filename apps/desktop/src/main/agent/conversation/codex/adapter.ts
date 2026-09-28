/**
 * The Codex protocol adapter: `codex app-server`'s JSON-RPC lines in,
 * `ConversationEvent`s out; DevHub's commands in, JSON-RPC lines out.
 *
 * Pure: no I/O, no process, no clock. Whoever holds it (the conversation, in
 * stage 5) moves the lines.
 *
 * It implements the `ProtocolAdapter` seam both adapters share
 * (`../protocolAdapter.ts`); what follows is what Codex adds to it.
 *
 * # One path for live and replay
 *
 * The adapter learns what DevHub said only from `sent(line)`, and what the
 * server said only from `received(line)`. Replies to a request are matched to
 * it by id, so after a restart a replay can feed all of `in.log` to `sent` and
 * then all of `out` to `received`, with the same code that runs live.
 *
 * The handshake is a chain: `initialize`, then (once it is answered)
 * `initialized` and `account/read`, then `thread/start` or `thread/resume`,
 * then `model/list`. `opening()` returns only the first link; each later one
 * is a `reply` to the answer before it, and is returned only while nothing fed
 * to `sent` says it was already made. So a replay does not repeat a step, and
 * a DevHub that died between two steps finishes the handshake when it comes
 * back.
 *
 * # Failure
 *
 * A known message of the wrong shape, or one that contradicts what the adapter
 * was told before (a reply to a request DevHub never made, a delta for a
 * message that never started), throws the shared `ProtocolMismatch`, and the
 * adapter is spent. A notification DevHub does not know is an information
 * `notice` (once per method) and the conversation goes on; an item DevHub
 * does not know is a warning, since it is part of the conversation not drawn; a request DevHub does not know is also answered with
 * a JSON-RPC error, because leaving it unanswered would stall the turn with
 * nothing on screen saying why. A signed-out account or a refused handshake
 * is not a mismatch: it is `state: broken` with its own code, and the adapter
 * reads nothing further after it.
 *
 * A command DevHub's own page should never have sent (answering a request
 * that is not open, sending while broken) throws a plain `Error`: that is
 * DevHub's bug, not Codex's, and the caller's root reports it.
 */

import {
	EMPTY_SESSION,
	EMPTY_TRANSCRIPT,
	answerTo,
	applyEvent,
	rewindTargets,
	entryId,
	sameRunningTasks,
	requestId,
	type AnswerEntry,
	type AssistantBlock,
	type ConversationEvent,
	type ConversationState,
	type EntryId,
	type JsonValue,
	type PendingRequest,
	type Question,
	type RequestAnswer,
	type RequestChoice,
	type RequestId,
	type SessionFacts,
	type SendingMessage,
	type SubagentInfo,
	type RunningTask,
	type ToolEntry,
	type ImageRef,
	type ToolOutput,
	type ToolOutputPart,
	type ToolStatus,
	type Transcript,
	type TranscriptEntry,
	type Usage,
	withRateLimits,
} from "../../../../model/conversation.js";
import {
	elicitationChoices,
	elicitationReply,
	elicitationSubject,
} from "../elicitation.js";
import {
	ProtocolMismatch,
	RESTARTED,
	RESTART_MARK,
	requireStoppable,
	type AdapterStep,
	type ConversationCommand,
	type ProtocolAdapter,
	type RewindPlan,
	type SettingName,
} from "../protocolAdapter.js";
import { toolTitle } from "../toolTitle.js";
import {
	Reader,
	accountResponse,
	anyObjectResponse,
	commandApproval,
	decodeLine,
	elicitation,
	errorNotification,
	fileChangeApproval,
	initializeResponse,
	itemNotification,
	modelListResponse,
	skillsListResponse,
	patchUpdated,
	permissionsApproval,
	planUpdated,
	rateLimits,
	reasoningSummaryDelta,
	reasoningTextDelta,
	requestResolved,
	rerouted,
	summaryNotice,
	summaryPartAdded,
	textDelta,
	threadClosed,
	threadOpenedResponse,
	threadRevertResponse,
	threadStarted,
	tokenUsage,
	turnNotification,
	userInputRequest,
	warning,
	type FileChange,
	type Item,
	type ModelChoice,
	type SkillChoice,
	type ReasoningDelta,
	type ThreadFacts,
	type ThreadOpened,
	type TurnFacts,
} from "./decode.js";
import type { InitializeParams } from "./protocol/InitializeParams.js";
import type { RequestId as RpcId } from "./protocol/RequestId.js";
import type { ServerNotification } from "./protocol/ServerNotification.js";
import type { ServerRequest } from "./protocol/ServerRequest.js";
import type { AskForApproval } from "./protocol/v2/AskForApproval.js";
import type { CollabAgentStatus } from "./protocol/v2/CollabAgentStatus.js";
import type { CommandExecutionRequestApprovalResponse } from "./protocol/v2/CommandExecutionRequestApprovalResponse.js";
import type { FileChangeRequestApprovalResponse } from "./protocol/v2/FileChangeRequestApprovalResponse.js";
import type { GetAccountParams } from "./protocol/v2/GetAccountParams.js";
import type { McpServerElicitationRequestResponse } from "./protocol/v2/McpServerElicitationRequestResponse.js";
import type { ModelListParams } from "./protocol/v2/ModelListParams.js";
import type { SkillsListParams } from "./protocol/v2/SkillsListParams.js";
import type { PermissionsRequestApprovalResponse } from "./protocol/v2/PermissionsRequestApprovalResponse.js";
import type { SandboxPolicy } from "./protocol/v2/SandboxPolicy.js";
import type { ThreadResumeParams } from "./protocol/v2/ThreadResumeParams.js";
import type { ThreadRevertParams } from "./protocol/v2/ThreadRevertParams.js";
import type { ThreadStartParams } from "./protocol/v2/ThreadStartParams.js";
import type { ToolRequestUserInputResponse } from "./protocol/v2/ToolRequestUserInputResponse.js";
import type { TurnInterruptParams } from "./protocol/v2/TurnInterruptParams.js";
import type { TurnStartParams } from "./protocol/v2/TurnStartParams.js";
import type { TurnSteerParams } from "./protocol/v2/TurnSteerParams.js";
import type { UserInput } from "./protocol/v2/UserInput.js";

export interface CodexAdapterOptions {
	/** DevHub's own version, sent as `clientInfo.version`. */
	readonly clientVersion: string;
	/** The Workspace folder the thread works in. */
	readonly cwd: string;
	/** Continue this thread (`thread/resume`) instead of starting one. */
	readonly resumeThreadId: string | undefined;
}

// ---------------------------------------------------------------------------
// Modes: Codex TUI's approval presets, as approval policy + sandbox pairs.

interface Mode {
	readonly id: string;
	readonly label: string;
	readonly approvalPolicy: AskForApproval;
	readonly sandboxPolicy: SandboxPolicy;
}

const MODES: readonly Mode[] = [
	{
		id: "read-only",
		label: "Read only",
		approvalPolicy: "on-request",
		sandboxPolicy: { type: "readOnly", networkAccess: false },
	},
	{
		id: "auto",
		label: "Auto",
		approvalPolicy: "on-request",
		sandboxPolicy: {
			type: "workspaceWrite",
			writableRoots: [],
			networkAccess: false,
			excludeTmpdirEnvVar: false,
			excludeSlashTmp: false,
		},
	},
	{
		id: "full-access",
		label: "Full access",
		approvalPolicy: "never",
		sandboxPolicy: { type: "dangerFullAccess" },
	},
];

/** The preset a thread's policy pair is, if it is one; a hand-written config may be none. */
function modeOf(
	approvalPolicy: JsonValue,
	sandbox: JsonValue,
): string | undefined {
	const sandboxType =
		typeof sandbox === "object" && sandbox !== null && !Array.isArray(sandbox)
			? (sandbox as { readonly type?: JsonValue }).type
			: undefined;
	return MODES.find(
		(mode) =>
			mode.approvalPolicy === approvalPolicy &&
			mode.sandboxPolicy.type === sandboxType,
	)?.id;
}

// ---------------------------------------------------------------------------
// Methods: every one the vendored protocol names is placed here, so a method a
// new Codex adds is a compile error until someone decides what it means.

/** A method DevHub reads nothing from, and why. */
interface Unused {
	readonly unused: string;
}
const unused = (why: string): Unused => ({ unused: why });

type NotificationMethod = ServerNotification["method"];
type RequestMethod = ServerRequest["method"];

type ClientMethod =
	| "initialize"
	| "account/read"
	| "thread/start"
	| "thread/resume"
	| "thread/revert"
	| "model/list"
	| "skills/list"
	| "turn/start"
	| "turn/steer"
	| "turn/interrupt";

const CLIENT_METHODS: readonly ClientMethod[] = [
	"initialize",
	"account/read",
	"thread/start",
	"thread/resume",
	"thread/revert",
	"model/list",
	"skills/list",
	"turn/start",
	"turn/steer",
	"turn/interrupt",
];

/**
 * How many words (an item, a turn's start or end) DevHub keeps of a child
 * thread it cannot place yet. Many more than a subagent says in the moment
 * between its thread starting and the call that started it being reported;
 * a bound so a thread that is never placed cannot grow without end. A thread
 * that says more is given up (`abandoned`).
 */
const HELD_LIMIT = 1000;

const SUBAGENT_TURN_UNKNOWN =
	"Codex has not yet said which turn this subagent is running, so there is nothing to interrupt.";

/** JSON-RPC's own "method not found". */
const METHOD_NOT_FOUND = -32601;

const USER_MESSAGE_ID = /^devhub-(person|injection)-(\d+)$/;

/**
 * The skill names words mention: each `$name` that starts a word, without
 * the punctuation a sentence puts after it.
 */
function mentions(text: string): ReadonlySet<string> {
	return new Set(
		[...text.matchAll(/(?:^|\s)\$([\w:-]+(?:\.[\w:-]+)*)/gu)].map(
			(match) => match[1]!,
		),
	);
}

/** A request the server made that DevHub is showing, and how each answer is spelled. */
interface OpenRequest {
	readonly rpcId: RpcId;
	readonly respond: (answer: RequestAnswer) => JsonValue;
	/** For questions: the person's answer, as the reply DevHub wrote says it. */
	readonly answered: ((result: JsonValue) => AnswerEntry) | undefined;
}

/**
 * How a request answered by filling something in — questions, an
 * elicitation's form — is answered, and, for questions, how the answer reads
 * back.
 */
interface FormReply {
	readonly build: (
		values: Extract<RequestAnswer, { kind: "answers" }>["values"],
	) => JsonValue;
	readonly answered: ((result: JsonValue) => AnswerEntry) | undefined;
}

/**
 * `model/list` leaves out the models hidden from the default picker unless
 * asked (`ModelListParams.includeHidden`), and a thread can be on one.
 */
const LIST_EVERY_MODEL = { includeHidden: true } as const;

interface Chosen {
	model: string | undefined;
	effort: string | undefined;
	mode: string | undefined;
}

interface ThreadDefaults {
	readonly model: string;
	readonly effort: string | undefined;
	readonly mode: string | undefined;
	readonly cwd: string;
}

interface Tokens {
	readonly input: number;
	readonly output: number;
	readonly cached: number;
}

const COLLAB_TITLES: Readonly<Record<string, string>> = {
	spawnAgent: "Start a subagent",
	sendInput: "Message a subagent",
	resumeAgent: "Resume a subagent",
	wait: "Wait for subagents",
	closeAgent: "Close a subagent",
	sendMessage: "Message a subagent",
	followupTask: "Give a subagent a follow-up task",
	interruptAgent: "Interrupt a subagent",
	listAgents: "List subagents",
};

function rpcKey(id: RpcId): string {
	return JSON.stringify(id);
}

function firstLine(text: string): string {
	const line = text.split("\n", 1)[0] ?? "";
	return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

export class CodexAdapter implements ProtocolAdapter {
	private current: Transcript = EMPTY_TRANSCRIPT;
	/** An earlier call threw; the bookkeeping may be half-updated. */
	private spent = false;
	/** The conversation is broken (signed out, refused, or a failure it reported). */
	private broken = false;
	private version: string | undefined;
	/**
	 * How many times app-server was started again (Restart session). A new
	 * server numbers its requests afresh, so what DevHub names after one of
	 * them is named in the server's start too (`serverKey`).
	 */
	private starts = 0;
	/** app-server was started again and its thread is not open yet: the thread DevHub draws is resumed, not drawn again. */
	private reopening = false;

	// What DevHub said (from `sent`), and the counters `encode` draws ids from.
	private nextRpcId = 0;
	private nextUserMessage = 0;
	private readonly calls = new Map<string, ClientMethod>();
	/** The messages written and not yet taken, by the call that wrote each, with the thread it went to. */
	private readonly sending = new Map<
		string,
		{ readonly thread: string; readonly message: SendingMessage }
	>();
	private readonly sentMethods = new Set<string>();
	private readonly responded = new Set<string>();
	/** `thread/revert` requests DevHub made, by id: the turn each takes back from. */
	private readonly reverts = new Map<string, string>();
	/** `thread/resume` requests made once a thread was open (`/resume`), by id. */
	private readonly switches = new Set<string>();
	/** `turn/interrupt` requests DevHub made, by id: the thread each interrupts. */
	private readonly interrupts = new Map<string, string>();
	private readonly chosen: Chosen = {
		model: undefined,
		effort: undefined,
		mode: undefined,
	};

	// What the server said (from `received`).
	private mainThread: string | undefined;
	/** Only a paginated thread can be reverted (`thread/revert`). */
	private historyMode: ThreadFacts["historyMode"] | undefined;
	/** The main thread's turns, each by the first message the person sent in it. */
	private readonly turnMessages = new Map<string, EntryId>();
	private runningTurn: string | undefined;
	private defaults: ThreadDefaults | undefined;
	/**
	 * What `model/list` said: the pages so far while it is still listing,
	 * every model once the last page is in, or why it could not list them.
	 * Hidden models are listed too, since a thread may be on one (a resumed
	 * thread keeps the model it was on); the picker offers them only then.
	 */
	private listing:
		| {
				readonly state: "listing" | "listed";
				readonly models: readonly ModelChoice[];
		  }
		| { readonly state: "failed"; readonly why: string } = {
		state: "listing",
		models: [],
	};
	/** The skills `skills/list` named for the thread's directory; none until it answers. */
	private skills: readonly SkillChoice[] = [];
	private readonly open = new Map<RequestId, OpenRequest>();
	/** Child thread → the tool entry that started it. */
	private readonly threadParents = new Map<string, EntryId>();
	/** When each item started, by app-server's clock, as `item/started` said. */
	private readonly itemTimes = new Map<EntryId, number>();
	private readonly threadLabels = new Map<string, string>();
	/** Child threads app-server says the person may start and steer turns of. */
	private readonly directInput = new Set<string>();
	/** The turn each child thread is running, while it runs one. */
	private readonly childTurns = new Map<string, string>();
	/**
	 * What child threads said before DevHub knew which call started them, by
	 * thread, to be drawn once each is linked (`link`): each item's latest
	 * word and each turn's start and end, in the order first said, at most
	 * `HELD_LIMIT` of them a thread. Deltas are not kept: the item's
	 * completion carries what they add up to.
	 */
	private readonly held = new Map<string, Map<string, () => void>>();
	/**
	 * Child threads that said more than `HELD_LIMIT` before being placed:
	 * what they say is not drawn, even once the call that started one is
	 * named, since part of it is gone. One warning says so.
	 */
	private readonly abandoned = new Set<string>();
	/** Running tools and streaming messages, by thread: a thread runs one turn at a time. */
	private readonly unfinished = new Map<string, Set<EntryId>>();
	private readonly commandOutput = new Map<EntryId, string>();
	private readonly fileChanges = new Map<EntryId, readonly FileChange[]>();
	private noticeCount = 0;
	/** The keys of the notices said once (`noticeOnce`). */
	private readonly said = new Set<string>();
	private total: Tokens | undefined;
	private totalAtTurnStart: Tokens | undefined;
	private usage: Usage | undefined;

	// What the current call produced.
	private events: ConversationEvent[] = [];
	private writes: string[] = [];

	constructor(private readonly options: CodexAdapterOptions) {}

	get transcript(): Transcript {
		return this.current;
	}

	// -------------------------------------------------------------------------
	// The port.

	opening(): readonly string[] {
		return this.lines(() => this.initialize());
	}

	/** The handshake's first link, for the first server and each one started again. */
	private initialize(): void {
		this.call("initialize", {
			clientInfo: {
				name: "devhub",
				title: "DevHub",
				version: this.options.clientVersion,
			},
			// The stable surface only: it is the one the vendored types describe.
			capabilities: { experimentalApi: false, requestAttestation: false },
		} satisfies InitializeParams);
	}

	encode(command: ConversationCommand): readonly string[] {
		return this.lines(() => {
			if (this.broken) {
				throw new Error(
					"the Codex conversation is broken and takes no more commands",
				);
			}
			switch (command.kind) {
				case "send":
					return this.send(command.text, command.images, command.origin);
				case "instruct":
					return this.instruct(command.subagent, command.text);
				case "interrupt":
					return this.interrupt();
				case "stop-task":
					return this.stopSubagent(command.task);
				case "answer":
					return this.answer(command.request, command.answer);
			}
		});
	}

	configure(which: SettingName, id: string): AdapterStep {
		// Checked before the step, so a choice DevHub should not have offered
		// is refused and leaves the adapter as it was, not spent.
		this.refuseIfSpent();
		if (
			!this.sessionFacts()[which].choices.some((choice) => choice.id === id)
		) {
			throw new Error(`${id} is not a ${which} this Codex offers`);
		}
		return this.step(() => {
			this.choose(which, id);
			this.publishSession();
		});
	}

	rewind(message: EntryId): RewindPlan {
		const lines = this.lines(() => {
			if (this.broken) {
				throw new Error(
					"the Codex conversation is broken and takes no more commands",
				);
			}
			if (this.mainThread === undefined || this.historyMode !== "paginated") {
				throw new Error(
					`${this.codexName} cannot take back a turn of this thread: only a paginated thread can be reverted`,
				);
			}
			if (!rewindTargets(this.current).has(message)) {
				throw new Error(
					`${message} is not a message the conversation can be rewound to now`,
				);
			}
			const turn = [...this.turnMessages].find(([, id]) => id === message);
			if (turn === undefined) {
				throw new Error(
					`${message} did not start a turn, so there is no turn to take back from it`,
				);
			}
			this.call("thread/revert", {
				threadId: this.mainThread,
				beforeTurnId: turn[0],
			} satisfies ThreadRevertParams);
		});
		return { kind: "write", lines };
	}

	resumeSession(session: string, history: readonly string[]): RewindPlan {
		if (history.length > 0) {
			throw new Error(
				"Codex hands back a thread's past itself: a resume takes no history",
			);
		}
		const lines = this.lines(() => {
			const { state, requests } = this.current;
			if (
				this.broken ||
				state.phase !== "ready" ||
				state.turn !== "none" ||
				requests.length > 0
			) {
				throw new Error(
					"the Codex conversation is not idle, so it cannot go on with another thread now",
				);
			}
			this.call("thread/resume", {
				threadId: session,
				cwd: this.options.cwd,
			} satisfies ThreadResumeParams);
		});
		return { kind: "write", lines };
	}

	restart(): RewindPlan & { readonly kind: "restart" } {
		this.refuseIfSpent();
		if (this.broken) {
			throw new Error(
				"the Codex conversation is broken and cannot be started again",
			);
		}
		// app-server takes no thread on its command line: the new one is
		// handed the thread in the handshake (`openThread`).
		return { kind: "restart", session: [], mark: [RESTART_MARK] };
	}

	sent(line: string): AdapterStep {
		return this.step(() => this.noteSent(line));
	}

	received(line: string): AdapterStep {
		return this.step(() => {
			if (!this.broken) this.dispatch(line);
			this.reportBackground();
		});
	}

	// -------------------------------------------------------------------------
	// Call plumbing.

	private refuseIfSpent(): void {
		if (this.spent) {
			throw new Error(
				"this Codex adapter is spent: an earlier line broke it, and it takes nothing further",
			);
		}
	}

	/** Runs one call. A throw leaves the adapter spent, since its bookkeeping may be half-updated. */
	private step(work: () => void): AdapterStep {
		this.refuseIfSpent();
		this.spent = true;
		this.events = [];
		this.writes = [];
		work();
		this.spent = false;
		return { events: this.events, replies: this.writes };
	}

	/**
	 * `encode` and `opening`: lines only. Nothing is emitted, and nothing moves
	 * but the id counters, and those only after every check has passed — so a
	 * refused command (DevHub's own bug) leaves the adapter as it was, not spent.
	 */
	private lines(work: () => void): readonly string[] {
		this.refuseIfSpent();
		this.events = [];
		this.writes = [];
		work();
		if (this.events.length > 0) {
			throw new Error("encoding a Codex command produced events");
		}
		return this.writes;
	}

	/** The reader for one line, knowing the CLI's version for the failure it may raise. */
	private get reader(): Reader {
		return new Reader(this.version);
	}

	private mismatch(path: string, expected: string): never {
		throw new ProtocolMismatch(path, expected, this.version);
	}

	/** Every event goes through here, so the adapter's own copy is the fold's. */
	private emit(event: ConversationEvent): void {
		this.current = applyEvent(this.current, event);
		this.events.push(event);
	}

	private entry(id: EntryId): TranscriptEntry | undefined {
		const { entries } = this.current;
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			if (entries[index]!.id === id) return entries[index];
		}
		return undefined;
	}

	private setState(state: ConversationState): void {
		this.emit({ type: "state", state });
	}

	private notice(
		level: "info" | "warning" | "error",
		text: string,
		raw: JsonValue | undefined,
		parent: EntryId | null = null,
		id: EntryId = entryId(`notice/${(this.noticeCount += 1)}`),
	): void {
		this.emit({
			type: "entry",
			entry: { kind: "notice", id, parent, level, text, raw },
		});
	}

	/**
	 * A notice said once per `key` for the adapter's life: news that every
	 * message carrying it would otherwise repeat, a flood saying one thing.
	 */
	private noticeOnce(
		key: string,
		level: "info" | "warning" | "error",
		text: string,
		raw: JsonValue | undefined,
	): void {
		if (this.said.has(key)) return;
		this.said.add(key);
		this.notice(level, text, raw);
	}

	private get codexName(): string {
		return this.version === undefined ? "codex" : `codex ${this.version}`;
	}

	// -------------------------------------------------------------------------
	// Writing.

	private call(method: ClientMethod, params: unknown): void {
		const id = this.nextRpcId;
		this.nextRpcId += 1;
		this.writes.push(JSON.stringify({ id, method, params }));
	}

	/** A handshake step: made only if no line DevHub has sent already made it. */
	private callOnce(method: ClientMethod, params: unknown): void {
		if (!this.sentMethods.has(method)) this.call(method, params);
	}

	private respond(id: RpcId, result: unknown): void {
		this.writes.push(JSON.stringify({ id, result }));
	}

	/**
	 * The conversation's messages written and not yet taken, as the transcript
	 * shows them sending: those to its own thread, not to a subagent's.
	 */
	private emitSending(): void {
		this.emit({
			type: "sending",
			sending: [...this.sending.values()].flatMap((each) =>
				each.thread === this.mainThread ? [each.message] : [],
			),
		});
	}

	private noteSent(line: string): void {
		const message = JSON.parse(line) as {
			readonly id?: RpcId;
			readonly method?: string;
			readonly params?: unknown;
		};
		if (message.method === undefined) {
			if (message.id === undefined)
				throw new Error(
					`DevHub sent Codex a line with neither method nor id: ${line}`,
				);
			this.responded.add(rpcKey(message.id));
			for (const request of this.open.values()) {
				if (
					request.answered !== undefined &&
					rpcKey(request.rpcId) === rpcKey(message.id)
				) {
					this.emit({
						type: "entry",
						entry: request.answered(
							(message as { readonly result?: JsonValue }).result ?? null,
						),
					});
				}
			}
			return;
		}
		const threadOpen =
			this.sentMethods.has("thread/start") ||
			this.sentMethods.has("thread/resume");
		this.sentMethods.add(message.method);
		if (message.id === undefined) return;
		if (message.method === "thread/resume" && threadOpen) {
			this.switches.add(rpcKey(message.id));
			this.setState({ phase: "ready", turn: "rewinding" });
		}
		const method = CLIENT_METHODS.find((known) => known === message.method);
		if (method === undefined)
			throw new Error(
				`DevHub sent Codex a request it has no reader for: ${line}`,
			);
		this.calls.set(rpcKey(message.id), method);
		if (typeof message.id === "number")
			this.nextRpcId = Math.max(this.nextRpcId, message.id + 1);
		if (method === "turn/start" || method === "turn/steer") {
			const params = message.params as TurnStartParams | TurnSteerParams;
			const match = USER_MESSAGE_ID.exec(params.clientUserMessageId ?? "");
			if (match !== null) {
				this.nextUserMessage = Math.max(
					this.nextUserMessage,
					Number(match[2]) + 1,
				);
				// Sending until its item comes back.
				this.sending.set(rpcKey(message.id), {
					thread: params.threadId,
					message: {
						id: params.clientUserMessageId!,
						text: params.input
							.flatMap((input) => (input.type === "text" ? [input.text] : []))
							.join("\n"),
						images: params.input.flatMap((input) =>
							input.type === "image" && "url" in input
								? [dataImage(input.url)]
								: [],
						),
						origin: match[1] === "injection" ? "injection" : "person",
					},
				});
				this.emitSending();
			}
		}
		if (method === "turn/interrupt") {
			const params = message.params as TurnInterruptParams;
			this.interrupts.set(rpcKey(message.id), params.threadId);
		}
		if (method === "thread/revert") {
			const params = message.params as ThreadRevertParams;
			this.reverts.set(rpcKey(message.id), params.beforeTurnId);
			this.setState({ phase: "ready", turn: "rewinding" });
		}
		if (method === "turn/start") {
			// What a turn was started with is what the next one starts with too.
			const params = message.params as TurnStartParams;
			if (params.model != null) this.chosen.model = params.model;
			if (params.effort != null) this.chosen.effort = params.effort;
			const mode = MODES.find(
				(candidate) =>
					candidate.approvalPolicy === params.approvalPolicy &&
					candidate.sandboxPolicy.type === params.sandboxPolicy?.type,
			);
			if (mode !== undefined) this.chosen.mode = mode.id;
			this.publishSession();
		}
	}

	// -------------------------------------------------------------------------
	// Reading.

	private dispatch(line: string): void {
		const message = decodeLine(this.reader, line);
		switch (message.kind) {
			case "restart":
				return this.takeRestart();
			case "response":
				return this.onResponse(message.id, message.result);
			case "error":
				return this.onErrorResponse(
					message.id,
					message.code,
					message.message,
					message.data,
				);
			case "notification": {
				const route = Object.hasOwn(this.notifications, message.method)
					? this.notifications[message.method as NotificationMethod]
					: undefined;
				// A notification is Codex's word about the conversation, whose
				// content arrives as items; one DevHub does not know is said quietly,
				// once per method, so a new one Codex sends often is not a flood.
				if (route === undefined) {
					return this.noticeOnce(
						`method/${message.method}`,
						"info",
						`${this.codexName} reported \`${message.method}\``,
						JSON.parse(line) as JsonValue,
					);
				}
				if (typeof route === "function") route(message.params);
				return;
			}
			case "request": {
				const route = Object.hasOwn(this.requests, message.method)
					? this.requests[message.method as RequestMethod]
					: undefined;
				if (typeof route === "function")
					return route(message.id, message.params);
				return this.decline(
					message.id,
					message.method,
					route,
					JSON.parse(line) as JsonValue,
				);
			}
		}
	}

	/**
	 * The host stopped app-server and started it again on the same thread:
	 * the conversation stays, and nothing the server that was stopped had
	 * going goes on (`restarted`). What DevHub kept about that server goes
	 * with it — its requests, the calls DevHub made of it, the handshake — and
	 * the new one is greeted afresh, as a reply, so a replay does not greet it
	 * twice; the handshake then resumes the thread already drawn.
	 */
	private takeRestart(): void {
		this.emit({ type: "restarted" });
		this.notice("info", RESTARTED, undefined);
		this.processEnded();
		this.starts += 1;
		this.reopening = true;
		this.sending.clear();
		this.open.clear();
		this.responded.clear();
		this.calls.clear();
		this.sentMethods.clear();
		this.reverts.clear();
		this.switches.clear();
		this.interrupts.clear();
		this.runningTurn = undefined;
		this.childTurns.clear();
		this.directInput.clear();
		this.held.clear();
		this.abandoned.clear();
		this.unfinished.clear();
		this.listing = { state: "listing", models: [] };
		this.setState({ phase: "ready", turn: "rewinding" });
		this.initialize();
	}

	/** A request of the server's, named apart from a request of an earlier server's with the same id. */
	private serverKey(rpcId: RpcId): string {
		return `${this.starts}/${rpcKey(rpcId)}`;
	}

	private methodOf(id: RpcId | null, path: string): ClientMethod {
		const method = id === null ? undefined : this.calls.get(rpcKey(id));
		if (method === undefined) {
			this.mismatch(
				path,
				`a reply to a request DevHub made, got one to ${JSON.stringify(id)}`,
			);
		}
		return method;
	}

	private onResponse(id: RpcId, result: unknown): void {
		const method = this.methodOf(id, "message.id");
		switch (method) {
			case "initialize": {
				this.version = versionOf(
					initializeResponse(this.reader, result).userAgent,
				);
				this.publishSession();
				if (!this.sentMethods.has("initialized")) {
					this.writes.push(JSON.stringify({ method: "initialized" }));
				}
				return this.callOnce("account/read", {} satisfies GetAccountParams);
			}
			case "account/read": {
				const account = accountResponse(this.reader, result);
				if (!account.signedIn && account.requiresOpenaiAuth) {
					this.broken = true;
					return this.setState({
						phase: "broken",
						failure: {
							code: "not_signed_in",
							detail: `${this.codexName} is not signed in. Run \`codex login\` in a terminal.`,
						},
					});
				}
				return this.openThread();
			}
			case "thread/start":
			case "thread/resume": {
				const opened = threadOpenedResponse(this.reader, result);
				if (this.switches.delete(rpcKey(id))) this.leaveThread(opened);
				return this.onThreadOpened(opened);
			}
			case "model/list": {
				const page = modelListResponse(this.reader, result);
				const models = [
					...(this.listing.state === "failed" ? [] : this.listing.models),
					...page.models,
				];
				if (page.next !== null) {
					this.listing = { state: "listing", models };
					return this.call("model/list", {
						...LIST_EVERY_MODEL,
						cursor: page.next,
					} satisfies ModelListParams);
				}
				this.listing = { state: "listed", models };
				return this.publishSession();
			}
			case "skills/list":
				this.skills = skillsListResponse(this.reader, result);
				return this.publishSession();
			case "thread/revert":
				threadRevertResponse(this.reader, result);
				return this.onReverted(id);
			case "turn/interrupt":
				this.interrupts.delete(rpcKey(id));
				return anyObjectResponse(this.reader, result);
			case "turn/start":
			case "turn/steer":
				// What these say again arrives as `turn/started` and the items.
				return anyObjectResponse(this.reader, result);
		}
	}

	private onErrorResponse(
		id: RpcId | null,
		code: number,
		message: string,
		data: JsonValue,
	): void {
		const method = this.methodOf(id, "message.id");
		const raw = { code, message, data };
		if (method === "thread/resume" && this.switches.delete(rpcKey(id!))) {
			this.notice(
				"error",
				`${this.codexName} did not go on with that thread: ${message}`,
				raw,
			);
			return this.setState({ phase: "ready", turn: "none" });
		}
		switch (method) {
			case "initialize":
			case "thread/start":
			case "thread/resume":
				this.broken = true;
				return this.setState({
					phase: "broken",
					failure: {
						code: "refused",
						detail: `${method} failed: ${message} (${code})`,
					},
				});
			case "account/read":
				// The account is read only to say "sign in" early; the thread will say it too.
				this.notice(
					"warning",
					`${this.codexName} could not read its account: ${message}`,
					raw,
				);
				return this.openThread();
			case "model/list":
				this.listing = { state: "failed", why: message };
				this.publishSession();
				return this.notice(
					"warning",
					`${this.codexName} could not list its models: ${message}. The model can't be changed here.`,
					raw,
				);
			case "skills/list":
				return this.notice(
					"warning",
					`${this.codexName} could not list its skills: ${message}. None are offered after $.`,
					raw,
				);
			case "thread/revert":
				this.reverts.delete(rpcKey(id!));
				this.notice(
					"error",
					`${this.codexName} did not take back the last turn: ${message}`,
					raw,
				);
				return this.setState({ phase: "ready", turn: "none" });
			case "turn/start":
				this.sending.delete(rpcKey(id!));
				this.emitSending();
				return this.notice(
					"error",
					`${this.codexName} did not start the turn: ${message}`,
					raw,
				);
			case "turn/steer":
				this.sending.delete(rpcKey(id!));
				this.emitSending();
				return this.notice(
					"error",
					`${this.codexName} did not take the message: ${message}`,
					raw,
				);
			case "turn/interrupt": {
				const thread = this.interrupts.get(rpcKey(id!));
				this.interrupts.delete(rpcKey(id!));
				return this.notice(
					"error",
					thread === this.mainThread
						? `${this.codexName} did not interrupt the turn: ${message}`
						: `${this.codexName} did not stop the subagent: ${message}`,
					raw,
				);
			}
		}
	}

	private openThread(): void {
		const { cwd } = this.options;
		// A server started again goes on with the thread already open.
		const resumeThreadId = this.mainThread ?? this.options.resumeThreadId;
		if (
			this.sentMethods.has("thread/start") ||
			this.sentMethods.has("thread/resume")
		)
			return;
		if (resumeThreadId === undefined) {
			this.call("thread/start", { cwd } satisfies ThreadStartParams);
		} else {
			this.call("thread/resume", {
				threadId: resumeThreadId,
				cwd,
			} satisfies ThreadResumeParams);
		}
	}

	private onThreadOpened(opened: ThreadOpened): void {
		const { thread } = opened;
		this.mainThread = thread.id;
		this.historyMode = thread.historyMode;
		this.defaults = {
			model: opened.model,
			effort: opened.reasoningEffort ?? undefined,
			mode: modeOf(opened.approvalPolicy, opened.sandbox),
			cwd: opened.cwd,
		};
		this.publishSession();
		// The thread a restarted server resumes is the one drawn already.
		if (!this.reopening)
			for (const turn of thread.turns) this.replayTurn(thread.id, turn);
		this.reopening = false;
		// Its history tells of no subagent running on this server now.
		this.processEnded();
		this.emitSending();
		this.setState({
			phase: "ready",
			turn: this.runningTurn === undefined ? "none" : "running",
		});
		this.callOnce("model/list", LIST_EVERY_MODEL satisfies ModelListParams);
		this.callOnce("skills/list", {
			cwds: [opened.cwd],
		} satisfies SkillsListParams);
	}

	/**
	 * The thread `/resume` left: everything DevHub kept about it goes, before
	 * the other one is drawn. The server keeps the old thread loaded; it is
	 * idle (a resume is refused while a turn runs), so nothing more of it is
	 * expected.
	 */
	private leaveThread(opened: ThreadOpened): void {
		this.reportBackground(() => false);
		this.emit({ type: "session-switched", session: opened.thread.id });
		this.sending.clear();
		this.emitSending();
		this.turnMessages.clear();
		this.runningTurn = undefined;
		this.threadParents.clear();
		this.threadLabels.clear();
		this.held.clear();
		this.abandoned.clear();
		this.unfinished.clear();
		this.commandOutput.clear();
		this.fileChanges.clear();
		this.total = undefined;
		this.totalAtTurnStart = undefined;
		this.usage = undefined;
	}

	/**
	 * What works in the background, as the transcript has it, after each line:
	 * every subagent running. Codex starts each on a thread of its own that
	 * runs beside the turn that started it, and tells of no other background
	 * task — a command it keeps running after its call has returned reports no
	 * end, so it cannot be listed honestly. `keep` leaves out calls about to be
	 * taken back.
	 */
	private reportBackground(
		keep: (entry: TranscriptEntry) => boolean = () => true,
	): void {
		const tasks: RunningTask[] = this.current.entries.flatMap((entry) =>
			entry.kind === "tool" && entry.spawns?.state === "running" && keep(entry)
				? [
						{
							id: entry.id,
							kind: "subagent",
							title: entry.spawns.label,
							call: entry.id,
							startedAt: this.itemTimes.get(entry.id),
							// Stopped by interrupting its threads' turns, once one is known.
							stoppable:
								this.runningThreadsOf(entry.id).length > 0
									? true
									: { reason: SUBAGENT_TURN_UNKNOWN },
						},
					]
				: [],
		);
		if (sameRunningTasks(tasks, this.current.backgroundTasks)) return;
		this.emit({ type: "background-tasks", tasks });
	}

	/** A turn `thread/resume` hands back whole: its items as completed, then its end. */
	private replayTurn(threadId: string, turn: TurnFacts): void {
		for (const item of turn.items)
			this.onItem(threadId, turn.id, item, "completed");
		if (turn.status === "inProgress") {
			this.runningTurn = turn.id;
		} else {
			// What a past turn used is not in what `thread/resume` hands back.
			this.endTurn(threadId, turn, undefined);
		}
	}

	// -------------------------------------------------------------------------
	// Session and usage.

	private publishSession(): void {
		const session = this.sessionFacts();
		if (JSON.stringify(session) === JSON.stringify(this.current.session))
			return;
		this.emit({ type: "session", session });
	}

	/** The session as DevHub knows it now, the choices not yet sent included. */
	private sessionFacts(): SessionFacts {
		const model = this.chosen.model ?? this.defaults?.model;
		const { listing } = this;
		const models = listing.state === "listed" ? listing.models : [];
		const listed = models.find((candidate) => candidate.model === model);
		// A model the whole list does not name is still the thread's: a choice
		// of its own, with no efforts DevHub could offer for it.
		const own =
			listing.state === "listed" && model !== undefined && listed === undefined
				? model
				: undefined;
		const unchangeable =
			listing.state === "failed"
				? `${this.codexName} could not list its models: ${listing.why}`
				: own === undefined
					? undefined
					: `${this.codexName}'s model list does not name ${own}, so its reasoning efforts are not known here`;
		const efforts = listed?.efforts ?? [];
		return {
			...EMPTY_SESSION,
			agentVersion: this.version,
			sessionId: this.mainThread,
			cwd: this.defaults?.cwd,
			canRewind: this.historyMode === "paginated",
			model: {
				current: model,
				choices: [
					...(own === undefined ? [] : [{ id: own, label: own }]),
					...models
						.filter((candidate) => !candidate.hidden || candidate === listed)
						// Read by the name the thread reports, in the list and as the
						// current value alike; Codex's display name goes beside it.
						.map((candidate) => ({
							id: candidate.model,
							label: candidate.model,
							detail: candidate.displayName,
						})),
				],
				...(listing.state === "failed" ? { unchangeable } : {}),
			},
			effort: {
				// What the next turn runs at: the effort chosen here, else the
				// thread's own while its model is the one it opened with, else the
				// model's default, which `model/list` names (a turn given no
				// effort runs at it).
				current:
					this.chosen.effort ??
					(this.chosen.model === undefined
						? this.defaults?.effort
						: undefined) ??
					listed?.defaultEffort,
				choices: efforts.map((effort) => ({ id: effort, label: effort })),
				...(unchangeable === undefined ? {} : { unchangeable }),
			},
			mode: {
				current: this.chosen.mode ?? this.defaults?.mode,
				choices: MODES.map((mode) => ({ id: mode.id, label: mode.label })),
			},
			commands: [
				{
					trigger: "/",
					name: "model",
					description: "Choose the model",
					argumentHint: undefined,
					route: "model",
				},
				{
					trigger: "/",
					name: "effort",
					description: "Choose the reasoning effort",
					argumentHint: undefined,
					route: "effort",
				},
				{
					trigger: "/",
					name: "approvals",
					description: "Choose what Codex may do without asking",
					argumentHint: undefined,
					route: "mode",
				},
				{
					trigger: "/",
					name: "resume",
					description: "Go on with an earlier thread in this Workspace",
					argumentHint: undefined,
					route: "resume",
				},
				{
					trigger: "/",
					name: "restart",
					description:
						"Restart the session: start Codex again, reconnecting its MCP servers",
					argumentHint: undefined,
					route: "restart",
				},
				...this.skills.map((skill) => ({
					trigger: "$" as const,
					name: skill.name,
					description: skill.description,
					argumentHint: undefined,
					route: "message" as const,
				})),
			],
		};
	}

	private publishUsage(next: Partial<Usage>): void {
		this.usage = {
			inputTokens: undefined,
			outputTokens: undefined,
			cachedInputTokens: undefined,
			contextTokens: undefined,
			contextWindow: undefined,
			costUsd: undefined,
			rateLimits: undefined,
			...this.usage,
			...next,
		};
		this.emit({ type: "usage", usage: this.usage });
	}

	// -------------------------------------------------------------------------
	// Threads, turns, items.

	/** Where a thread's entries hang: the top level, under the call that started it, or nowhere known. */
	private parentOf(threadId: string): EntryId | null | undefined {
		if (threadId === this.mainThread) return null;
		return this.threadParents.get(threadId);
	}

	/**
	 * Whether what `threadId` says can be drawn now: the main thread's always,
	 * a child thread's once it is linked to the call that started it, unless
	 * it was given up before that.
	 */
	private placed(threadId: string): boolean {
		return (
			!this.abandoned.has(threadId) && this.parentOf(threadId) !== undefined
		);
	}

	/**
	 * Whether what `threadId` says is not to be drawn now. If the thread
	 * waits for its link, `replay` waits under `key`: a later word under the
	 * same key (an item's completion after its start) takes the earlier one's
	 * place.
	 */
	private waits(threadId: string, key: string, replay: () => void): boolean {
		if (this.placed(threadId)) return false;
		if (this.abandoned.has(threadId)) return true;
		const waiting = this.held.get(threadId) ?? new Map<string, () => void>();
		if (!waiting.has(key) && waiting.size === HELD_LIMIT) {
			this.held.delete(threadId);
			this.abandoned.add(threadId);
			this.noticeOnce(
				`unplaced/${threadId}`,
				"warning",
				`${this.codexName} said more on subagent thread ${threadId} than DevHub keeps before it knows which call started the thread, so what that thread did is not shown.`,
				undefined,
			);
			return true;
		}
		waiting.set(key, replay);
		this.held.set(threadId, waiting);
		return true;
	}

	/**
	 * A child thread is the work of the call `spawn`: its entries hang under
	 * that call's, and what it said before DevHub knew so is drawn now, in the
	 * order it said it. Codex names the call either way it reports one — a
	 * `collabAgentToolCall` `spawnAgent` naming the thread, or a
	 * `subAgentActivity` `started` (multi-agent v2, which draws no call
	 * item) — and the first call named for a thread keeps it.
	 */
	private link(threadId: string, spawn: EntryId): void {
		if (this.threadParents.has(threadId)) return;
		this.threadParents.set(threadId, spawn);
		// Given up: how the subagent stands is not known either.
		if (this.abandoned.has(threadId))
			return this.setSpawnState(threadId, "unknown", undefined);
		const waiting = this.held.get(threadId);
		this.held.delete(threadId);
		for (const replay of waiting?.values() ?? []) replay();
	}

	private idOf(threadId: string, itemId: string): EntryId {
		return entryId(`${threadId}/${itemId}`);
	}

	private onTurnStarted(params: unknown): void {
		const { threadId, turn } = turnNotification(this.reader, params);
		if (
			this.waits(threadId, `turn/started/${turn.id}`, () =>
				this.onTurnStarted(params),
			)
		)
			return;
		if (threadId !== this.mainThread) {
			this.childTurns.set(threadId, turn.id);
			// A subagent's thread taking a turn is the subagent running, whether
			// or not a `subAgentActivity` item says so too.
			this.setSpawnState(threadId, "running", undefined);
			return;
		}
		this.runningTurn = turn.id;
		this.totalAtTurnStart = this.total;
		this.setState({ phase: "ready", turn: "running" });
	}

	private onTurnCompleted(params: unknown): void {
		const { threadId, turn } = turnNotification(this.reader, params);
		if (turn.status === "inProgress") {
			this.mismatch("params.turn.status", "a finished turn, got inProgress");
		}
		if (
			this.waits(threadId, `turn/completed/${turn.id}`, () =>
				this.onTurnCompleted(params),
			)
		)
			return;
		this.endTurn(threadId, turn, this.turnUsage());
	}

	/**
	 * A turn is over: whatever of it was still running is not any more, and for
	 * the main thread the turn ends in the transcript. A subagent's turn ends
	 * only in its `spawns.state`, which its thread's turn ending sets — app-server
	 * does not always follow it with a `subAgentActivity` item: a turn-end entry
	 * has no parent to hang under.
	 */
	private endTurn(
		threadId: string,
		turn: TurnFacts,
		usage: Usage | undefined,
	): void {
		for (const id of this.unfinished.get(threadId) ?? []) {
			const entry = this.entry(id);
			if (entry?.kind === "tool" && entry.status === "running") {
				this.emit({
					type: "entry",
					entry: { ...entry, status: "interrupted" },
				});
			} else if (entry?.kind === "assistant" && entry.streaming) {
				this.emit({ type: "entry", entry: { ...entry, streaming: false } });
			}
		}
		this.unfinished.delete(threadId);
		if (threadId !== this.mainThread) {
			this.childTurns.delete(threadId);
			this.setSpawnState(
				threadId,
				turn.status === "completed" ? "completed" : "failed",
				undefined,
			);
			return;
		}
		// Every call a turn made is reported by its end, so a child thread
		// still waiting to be placed was started by none DevHub was told of.
		for (const thread of this.held.keys()) {
			this.noticeOnce(
				`unplaced/${thread}`,
				"warning",
				`${this.codexName} ran subagent thread ${thread} but never said which call started it, so what that thread did is not shown.`,
				undefined,
			);
		}
		const outcome = turn.status === "inProgress" ? "failed" : turn.status;
		this.emit({
			type: "entry",
			entry: {
				kind: "turn-end",
				id: entryId(`${threadId}/turn/${turn.id}`),
				outcome,
				detail: turn.error ?? undefined,
				usage,
				durationMs: turn.durationMs ?? undefined,
			},
		});
		if (this.runningTurn === turn.id) this.runningTurn = undefined;
		this.setState({
			phase: "ready",
			turn: this.runningTurn === undefined ? "none" : "running",
		});
	}

	private turnUsage(): Usage | undefined {
		const now = this.total;
		if (now === undefined) return undefined;
		const before = this.totalAtTurnStart ?? { input: 0, output: 0, cached: 0 };
		return {
			inputTokens: now.input - before.input,
			outputTokens: now.output - before.output,
			cachedInputTokens: now.cached - before.cached,
			contextTokens: this.usage?.contextTokens,
			contextWindow: this.usage?.contextWindow,
			costUsd: undefined,
			rateLimits: undefined,
		};
	}

	/** Adds or replaces an item's entry, and remembers whether its thread's turn has to finish it. */
	private put(entry: TranscriptEntry, threadId: string): void {
		this.emit({ type: "entry", entry });
		const open =
			(entry.kind === "tool" && entry.status === "running") ||
			(entry.kind === "assistant" && entry.streaming);
		const set = this.unfinished.get(threadId) ?? new Set<EntryId>();
		if (open) set.add(entry.id);
		else set.delete(entry.id);
		this.unfinished.set(threadId, set);
	}

	private onItemNotification(
		params: unknown,
		phase: "started" | "completed",
	): void {
		const { threadId, turnId, item, startedAtMs } = itemNotification(
			this.reader,
			params,
		);
		if (
			this.waits(threadId, `item/${item.id}`, () =>
				this.onItemNotification(params, phase),
			)
		)
			return;
		if (phase === "started" && startedAtMs !== null)
			this.itemTimes.set(this.idOf(threadId, item.id), startedAtMs);
		this.onItem(threadId, turnId, item, phase);
	}

	/** The thread was reverted to before a turn: that turn's first message and all after it go. */
	private onReverted(id: RpcId): void {
		const turn = this.reverts.get(rpcKey(id));
		const from = turn === undefined ? undefined : this.turnMessages.get(turn);
		if (turn === undefined || from === undefined) {
			throw new Error(
				`app-server answered thread/revert ${JSON.stringify(id)}, which names no turn DevHub knows the first message of`,
			);
		}
		this.reverts.delete(rpcKey(id));
		const gone = this.current.entries.slice(
			this.current.entries.findIndex((entry) => entry.id === from),
		);
		// A subagent started in what goes is no longer the conversation's to show.
		this.reportBackground((entry) => !gone.includes(entry));
		this.emit({ type: "rewound", from });
		for (const [turnId, message] of [...this.turnMessages]) {
			if (gone.some((entry) => entry.id === message))
				this.turnMessages.delete(turnId);
		}
		this.setState({ phase: "ready", turn: "none" });
	}

	private onItem(
		threadId: string,
		turnId: string,
		item: Item,
		phase: "started" | "completed",
	): void {
		const id = this.idOf(threadId, item.id);
		const parent = this.parentOf(threadId);
		if (parent === undefined) {
			throw new Error(
				`item ${item.id} of thread ${threadId} was drawn before that thread was placed`,
			);
		}
		const streaming = phase === "started";
		switch (item.type) {
			case "userMessage": {
				const match = USER_MESSAGE_ID.exec(item.clientId ?? "");
				if (threadId === this.mainThread && !this.turnMessages.has(turnId))
					this.turnMessages.set(turnId, id);
				this.put(
					{
						kind: "user",
						id,
						parent,
						text: item.content
							.flatMap((input) => (input.type === "text" ? [input.text] : []))
							.join("\n"),
						images: item.content.flatMap((input) =>
							input.type === "image" ? [input.image] : [],
						),
						// DevHub's own id says whom it sent the message for. Without
						// one, a subagent's message is its parent Agent's, not the
						// person's; the Agent's own is the person's, typed at
						// Codex's terminal in a thread read back.
						origin:
							match !== null
								? match[1] === "injection"
									? "injection"
									: "person"
								: threadId === this.mainThread
									? "person"
									: "other",
						rewindable:
							threadId === this.mainThread &&
							this.turnMessages.get(turnId) === id,
					},
					threadId,
				);
				// In the conversation now, no longer sending: in the same step.
				for (const [call, each] of this.sending) {
					if (each.message.id === item.clientId) this.sending.delete(call);
				}
				return this.emitSending();
			}
			case "agentMessage":
			case "plan":
				return this.put(
					{
						kind: "assistant",
						id,
						parent,
						blocks: [{ kind: "text", markdown: item.text }],
						streaming,
					},
					threadId,
				);
			case "reasoning": {
				this.put(
					{
						kind: "assistant",
						id,
						parent,
						blocks: item.summary.map((text) => ({ kind: "thinking", text })),
						streaming,
					},
					threadId,
				);
				const rawId = entryId(`${id}#raw`);
				if (item.content.length > 0 || this.entry(rawId) !== undefined) {
					this.put(
						{
							kind: "assistant",
							id: rawId,
							parent,
							blocks: item.content.map((text) => ({ kind: "thinking", text })),
							streaming,
						},
						threadId,
					);
				}
				return;
			}
			case "commandExecution": {
				const streamed = this.commandOutput.get(id);
				const output =
					item.aggregatedOutput !== null ||
					item.exitCode !== null ||
					streamed !== undefined
						? [
								commandPart(
									item.exitCode ?? undefined,
									item.aggregatedOutput ?? streamed ?? "",
								),
							]
						: undefined;
				if (phase === "completed") this.commandOutput.delete(id);
				return this.put(
					this.tool(
						id,
						parent,
						"commandExecution",
						item.command,
						{ command: item.command, cwd: item.cwd },
						commandStatus(item.status),
						output,
					),
					threadId,
				);
			}
			case "fileChange": {
				this.fileChanges.set(id, item.changes);
				return this.put(
					this.fileChangeEntry(
						id,
						parent,
						item.changes,
						commandStatus(item.status),
					),
					threadId,
				);
			}
			case "mcpToolCall": {
				const output: ToolOutput | undefined =
					item.error !== null
						? [{ kind: "text", text: item.error }]
						: item.result === null
							? undefined
							: mcpParts(item.result);
				return this.put(
					this.tool(
						id,
						parent,
						`mcp:${item.server}/${item.tool}`,
						toolTitle(
							`mcp__${item.server}__${item.tool}`,
							argumentsOf(item.arguments),
						),
						item.arguments,
						toolCallStatus(item.status),
						output,
					),
					threadId,
				);
			}
			case "dynamicToolCall":
				return this.put(
					this.tool(
						id,
						parent,
						item.namespace === null
							? item.tool
							: `${item.namespace}/${item.tool}`,
						toolTitle(item.tool, argumentsOf(item.arguments)),
						item.arguments,
						toolCallStatus(item.status),
						item.output.length === 0
							? undefined
							: [{ kind: "text", text: item.output.join("\n") }],
					),
					threadId,
				);
			case "collabAgentToolCall":
				return this.onCollab(id, parent, threadId, item);
			case "subAgentActivity":
				return this.onSubagentActivity(id, parent, threadId, item);
			case "webSearch":
				return this.put(
					this.tool(
						id,
						parent,
						"webSearch",
						`Search: ${item.query}`,
						{ query: item.query },
						streaming ? "running" : "succeeded",
						item.results === null
							? undefined
							: [
									{
										kind: "text",
										text: JSON.stringify(item.results, null, 2),
									},
								],
					),
					threadId,
				);
			case "imageView":
				return this.put(
					this.tool(
						id,
						parent,
						"imageView",
						`View image: ${item.path}`,
						{ path: item.path },
						streaming ? "running" : "succeeded",
						// A file on the Agent's machine, which the page names
						// rather than opens.
						[
							{
								kind: "image",
								image: {
									mediaType: "image/*",
									source: { kind: "file", path: item.path },
									label: item.path,
								},
							},
						],
					),
					threadId,
				);
			case "enteredReviewMode":
				return this.notice(
					"info",
					`Review started: ${item.review}`,
					undefined,
					parent,
					id,
				);
			case "exitedReviewMode":
				return this.notice(
					"info",
					`Review finished: ${item.review}`,
					undefined,
					parent,
					id,
				);
			case "contextCompaction":
				return this.put(
					{
						kind: "compaction",
						id,
						parent,
						trigger: undefined,
						preTokens: undefined,
					},
					threadId,
				);
			case "other":
				return this.notice(
					"info",
					`${this.codexName} ${item.itemType} item`,
					item.raw,
					parent,
					id,
				);
			case "unknown":
				return this.notice(
					"warning",
					`${this.codexName} sent a \`${item.itemType}\` item, which DevHub does not know.`,
					item.raw,
					parent,
					id,
				);
		}
	}

	private tool(
		id: EntryId,
		parent: EntryId | null,
		tool: string,
		title: string,
		input: JsonValue,
		status: ToolStatus,
		output: ToolEntry["output"],
		spawns: SubagentInfo | undefined = undefined,
		change: ToolEntry["change"] = undefined,
	): ToolEntry {
		return {
			kind: "tool",
			id,
			parent,
			tool,
			title,
			input,
			status,
			output,
			spawns,
			// Codex tells of no background task but a subagent's.
			background: undefined,
			// Codex sandboxes a turn, by its policy, not a call.
			outsideSandbox: false,
			// Codex's plan is an item of its own (`turn/plan/updated`).
			plan: undefined,
			denial: undefined,
			change,
			// Codex's questions are a request of their own, not a call's.
			asked: undefined,
		};
	}

	private fileChangeEntry(
		id: EntryId,
		parent: EntryId | null,
		changes: readonly FileChange[],
		status: ToolStatus,
	): ToolEntry {
		const title =
			changes.length === 1
				? `Edit: ${changes[0]!.path}`
				: `Edit ${changes.length} files`;
		return this.tool(
			id,
			parent,
			"fileChange",
			title,
			{
				changes: changes.map((change) => ({
					path: change.path,
					kind: change.kind,
				})),
			},
			status,
			undefined,
			undefined,
			changes.map((change) => ({
				path: change.path,
				unifiedDiff: change.diff,
			})),
		);
	}

	private onCollab(
		id: EntryId,
		parent: EntryId | null,
		threadId: string,

		item: Extract<Item, { type: "collabAgentToolCall" }>,
	): void {
		let spawns: SubagentInfo | undefined;
		if (item.tool === "spawnAgent") {
			const receiver = item.receiverThreadIds[0];
			const agentState =
				receiver === undefined ? undefined : item.agentsStates[receiver];
			spawns = {
				label:
					(receiver === undefined
						? undefined
						: this.threadLabels.get(receiver)) ?? "subagent",
				prompt: item.prompt ?? "",
				model: item.model ?? undefined,
				state:
					agentState !== undefined
						? subagentState(agentState)
						: item.status === "failed"
							? "failed"
							: "running",
				takesMessages: receiver !== undefined && this.directInput.has(receiver),
			};
		}
		this.put(
			this.tool(
				id,
				parent,
				item.tool,
				item.prompt === null
					? COLLAB_TITLES[item.tool]!
					: `${COLLAB_TITLES[item.tool]!}: ${firstLine(item.prompt)}`,
				{
					prompt: item.prompt,
					model: item.model,
					receiverThreadIds: item.receiverThreadIds,
				},
				collabStatus(item.status),
				undefined,
				spawns,
			),
			threadId,
		);
		if (item.tool === "spawnAgent") {
			for (const receiver of item.receiverThreadIds) this.link(receiver, id);
		}
		// Any collab call may report on agents another call started.
		for (const [agent, status] of Object.entries(item.agentsStates)) {
			if (this.threadParents.get(agent) !== id)
				this.setSpawnState(agent, subagentState(status), undefined);
		}
	}

	/**
	 * A subagent's news in the thread of the agent that runs it, as
	 * multi-agent v2 reports its calls instead of a `collabAgentToolCall`.
	 * `started` is the spawn call itself, by its call id: the subagent's card,
	 * and the link from its thread to that card. `interacted` (a message or a
	 * follow-up task) and `interrupted` are calls about a subagent already
	 * started, drawn as such; the subagent's state follows its thread's turns,
	 * since a message need not start one. `completed` is not a call but a
	 * turn of the subagent's having ended, which its own `turn/completed`
	 * says too; it counts unless the subagent is running a later turn.
	 */
	private onSubagentActivity(
		id: EntryId,
		parent: EntryId | null,
		threadId: string,
		item: Extract<Item, { type: "subAgentActivity" }>,
	): void {
		const child = item.agentThreadId;
		this.relabel(child, item.agentPath);
		const input = { agentThreadId: child, agentPath: item.agentPath };
		switch (item.kind) {
			case "started": {
				// Its start and its completion each say it: the second keeps
				// what the subagent's thread said in between.
				const drawn = this.entry(id);
				this.put(
					this.tool(
						id,
						parent,
						"spawnAgent",
						`${COLLAB_TITLES["spawnAgent"]!}: ${item.agentPath}`,
						input,
						"succeeded",
						undefined,
						drawn?.kind === "tool" && drawn.spawns !== undefined
							? drawn.spawns
							: {
									label: item.agentPath,
									prompt: "",
									model: undefined,
									state: "running",
									takesMessages: this.directInput.has(child),
								},
					),
					threadId,
				);
				return this.link(child, id);
			}
			case "interacted":
			case "interrupted": {
				const tool =
					item.kind === "interacted" ? "sendMessage" : "interruptAgent";
				return this.put(
					this.tool(
						id,
						parent,
						tool,
						`${COLLAB_TITLES[tool]!}: ${item.agentPath}`,
						input,
						"succeeded",
						undefined,
					),
					threadId,
				);
			}
			case "completed":
				if (this.childTurns.has(child)) return;
				return this.setSpawnState(child, "completed", item);
		}
	}

	/** The spawn entry of a child thread, if DevHub knows it. */
	private spawnEntry(threadId: string): ToolEntry | undefined {
		const id = this.threadParents.get(threadId);
		const entry = id === undefined ? undefined : this.entry(id);
		return entry?.kind === "tool" && entry.spawns !== undefined
			? entry
			: undefined;
	}

	private setSpawnState(
		threadId: string,
		state: SubagentInfo["state"],
		about: Item | undefined,
	): void {
		const entry = this.spawnEntry(threadId);
		if (entry === undefined) {
			if (about === undefined) return; // a status report about an agent DevHub never saw started
			return this.noticeOnce(
				`unstarted/${threadId}`,
				"warning",
				`${this.codexName} reported on subagent thread ${threadId}, which DevHub never saw started.`,
				about as unknown as JsonValue,
			);
		}
		this.spawnState(entry, state);
	}

	/** Where every change of a drawn subagent's state is made. */
	private spawnState(entry: ToolEntry, state: SubagentInfo["state"]): void {
		if (entry.spawns!.state === state) return;
		this.emit({
			type: "entry",
			entry: { ...entry, spawns: { ...entry.spawns!, state } },
		});
	}

	/**
	 * The app-server that ran the subagents drawn so far is not the one DevHub
	 * hears live: it was started again (a restart, live or read back from the
	 * journal), or they were read from a thread's history. A subagent it ran
	 * cannot be running now, and how it ended nobody said — so one drawn as
	 * running is unknown, until its thread's own turn says otherwise.
	 */
	private processEnded(): void {
		for (const entry of this.current.entries) {
			if (entry.kind === "tool" && entry.spawns?.state === "running")
				this.spawnState(entry, "unknown");
		}
	}

	/** A child thread takes the person's messages: its spawn entry says so, once DevHub knows it. */
	private takesMessages(threadId: string): void {
		const entry = this.spawnEntry(threadId);
		if (entry === undefined || entry.spawns!.takesMessages) return;
		this.emit({
			type: "entry",
			entry: { ...entry, spawns: { ...entry.spawns!, takesMessages: true } },
		});
	}

	private relabel(threadId: string, label: string): void {
		this.threadLabels.set(threadId, label);
		const entry = this.spawnEntry(threadId);
		if (entry === undefined || entry.spawns!.label === label) return;
		this.emit({
			type: "entry",
			entry: { ...entry, spawns: { ...entry.spawns!, label } },
		});
	}

	// -------------------------------------------------------------------------
	// Deltas.

	/** The streaming assistant entry a delta is for. */
	private streamingEntry(
		threadId: string,
		itemId: string,
		entry: EntryId = this.idOf(threadId, itemId),
	) {
		const found = this.entry(entry);
		if (found?.kind !== "assistant" || !found.streaming) {
			this.mismatch(
				"params.itemId",
				`a delta for a streaming message, got one for ${itemId} (${found === undefined ? "never started" : `a ${found.kind} entry`})`,
			);
		}
		return found;
	}

	private onTextDelta(params: unknown): void {
		const { threadId, itemId, delta } = textDelta(this.reader, params);
		// A thread not yet placed: its item's completion, held, says it whole.
		if (!this.placed(threadId)) return;
		const entry = this.streamingEntry(threadId, itemId);
		this.emit({ type: "text-delta", entry: entry.id, block: 0, text: delta });
	}

	/** Makes sure the reasoning entry has a thinking block at `index`, adding empty ones up to it. */
	private reasoningBlock(
		threadId: string,
		itemId: string,
		index: number,
		raw: boolean,
	) {
		if (!this.placed(threadId)) return undefined;
		const base = this.idOf(threadId, itemId);
		const id = raw ? entryId(`${base}#raw`) : base;
		if (raw && this.entry(id) === undefined) {
			const summary = this.streamingEntry(threadId, itemId);
			this.put({ ...summary, id, blocks: [] }, threadId);
		}
		const entry = this.streamingEntry(threadId, itemId, id);
		if (entry.blocks.length <= index) {
			const blocks: AssistantBlock[] = [...entry.blocks];
			while (blocks.length <= index)
				blocks.push({ kind: "thinking", text: "" });
			this.emit({ type: "entry", entry: { ...entry, blocks } });
		}
		return id;
	}

	private onReasoningDelta(delta: ReasoningDelta, raw: boolean): void {
		const id = this.reasoningBlock(
			delta.threadId,
			delta.itemId,
			delta.index,
			raw,
		);
		if (id === undefined) return;
		this.emit({
			type: "text-delta",
			entry: id,
			block: delta.index,
			text: delta.delta,
		});
	}

	private onCommandOutput(params: unknown): void {
		const { threadId, itemId, delta } = textDelta(this.reader, params);
		if (!this.placed(threadId)) return;
		const id = this.idOf(threadId, itemId);
		const entry = this.entry(id);
		if (entry?.kind !== "tool" || entry.status !== "running") {
			this.mismatch(
				"params.itemId",
				`output for a running command, got output for ${itemId}`,
			);
		}
		const output = (this.commandOutput.get(id) ?? "") + delta;
		this.commandOutput.set(id, output);
		this.emit({
			type: "entry",
			entry: {
				...entry,
				output: [commandPart(undefined, output)],
			},
		});
	}

	private onPatchUpdated(params: unknown): void {
		const { threadId, itemId, changes } = patchUpdated(this.reader, params);
		if (!this.placed(threadId)) return;
		const id = this.idOf(threadId, itemId);
		const entry = this.entry(id);
		if (entry?.kind !== "tool") {
			this.mismatch(
				"params.itemId",
				`a patch for a file change, got one for ${itemId}`,
			);
		}
		this.fileChanges.set(id, changes);
		this.emit({
			type: "entry",
			entry: this.fileChangeEntry(id, entry.parent, changes, entry.status),
		});
	}

	private onPlanUpdated(params: unknown): void {
		const { threadId, turnId, plan } = planUpdated(this.reader, params);
		if (
			this.waits(threadId, `plan/${turnId}`, () => this.onPlanUpdated(params))
		)
			return;
		const parent = this.parentOf(threadId)!;
		this.emit({
			type: "entry",
			entry: {
				kind: "assistant",
				id: entryId(`${threadId}/plan/${turnId}`),
				parent,
				blocks: [
					{
						kind: "plan",
						steps: plan.map((step) => ({
							text: step.step,
							status:
								step.status === "inProgress" ? "in_progress" : step.status,
						})),
					},
				],
				streaming: false,
			},
		});
	}

	// -------------------------------------------------------------------------
	// Requests from the server.

	private openRequest(
		rpcId: RpcId,
		threadId: string,
		itemId: string | undefined,
		subject: PendingRequest["subject"],
		choices: readonly (RequestChoice & { readonly result?: JsonValue })[],
		answers: FormReply | undefined,
	): void {
		const id = requestId(`codex/${this.serverKey(rpcId)}`);
		const about =
			itemId === undefined
				? undefined
				: this.entry(this.idOf(threadId, itemId));
		const byChoice = new Map(
			choices.map((choice) => [choice.id, choice.result]),
		);
		this.open.set(id, {
			rpcId,
			respond: (answer) => {
				if (answer.kind === "answers") {
					if (answers === undefined)
						throw new Error(`request ${id} takes a choice, not answers`);
					return answers.build(answer.values);
				}
				const result = byChoice.get(answer.choiceId);
				if (result === undefined)
					throw new Error(`request ${id} has no choice ${answer.choiceId}`);
				if (answer.text !== undefined)
					throw new Error(
						`choice ${answer.choiceId} of request ${id} takes no text`,
					);
				return result;
			},
			answered: answers?.answered,
		});
		this.emit({
			type: "request-opened",
			request: {
				id,
				entry: about?.kind === "tool" ? about.id : undefined,
				subject,
				choices: choices.map(({ id: choiceId, label, tone, takesText }) => ({
					id: choiceId,
					label,
					tone,
					takesText,
				})),
			},
		});
	}

	private onCommandApproval(rpcId: RpcId, params: unknown): void {
		const request = commandApproval(this.reader, params);
		const decide = (
			decision: CommandExecutionRequestApprovalResponse["decision"],
		): JsonValue =>
			({
				decision,
			}) satisfies CommandExecutionRequestApprovalResponse as JsonValue;
		const choices: (RequestChoice & { result: JsonValue })[] = [
			{
				id: "accept",
				label: "Allow once",
				tone: "allow",
				takesText: false,
				result: decide("accept"),
			},
			{
				id: "acceptForSession",
				label: "Allow for this session",
				tone: "allow",
				takesText: false,
				result: decide("acceptForSession"),
			},
		];
		if (request.execpolicyAmendment !== null) {
			choices.push({
				id: "execpolicy",
				label: `Always allow \`${request.execpolicyAmendment.join(" ")}\``,
				tone: "allow",
				takesText: false,
				result: decide({
					acceptWithExecpolicyAmendment: {
						execpolicy_amendment: [...request.execpolicyAmendment],
					},
				}),
			});
		}
		request.networkAmendments.forEach((amendment, index) => {
			choices.push({
				id: `network:${index}`,
				label: `Always ${amendment.action} network access to ${amendment.host}`,
				tone: amendment.action === "allow" ? "allow" : "deny",
				takesText: false,
				result: decide({
					applyNetworkPolicyAmendment: {
						network_policy_amendment: { ...amendment },
					},
				}),
			});
		});
		choices.push(
			{
				id: "decline",
				label: "Decline",
				tone: "deny",
				takesText: false,
				result: decide("decline"),
			},
			{
				id: "cancel",
				label: "Decline and stop the turn",
				tone: "deny",
				takesText: false,
				result: decide("cancel"),
			},
		);
		const subject: PendingRequest["subject"] =
			request.command !== null
				? {
						kind: "command",
						command: request.command,
						cwd: request.cwd ?? "",
						reason: request.reason ?? undefined,
					}
				: {
						kind: "tool",
						tool: request.networkHost !== null ? "network" : request.kind,
						title:
							request.networkHost !== null
								? `Network access to ${request.networkHost}`
								: request.kind === "writeStdin"
									? "Write to a running command"
									: "Run a command",
						input: params as JsonValue,
						reason: request.reason ?? undefined,
					};
		this.openRequest(
			rpcId,
			request.threadId,
			request.itemId,
			subject,
			choices,
			undefined,
		);
	}

	private onFileChangeApproval(rpcId: RpcId, params: unknown): void {
		const request = fileChangeApproval(this.reader, params);
		const decide = (
			decision: FileChangeRequestApprovalResponse["decision"],
		): JsonValue =>
			({ decision }) satisfies FileChangeRequestApprovalResponse as JsonValue;
		const changes =
			this.fileChanges.get(this.idOf(request.threadId, request.itemId)) ?? [];
		this.openRequest(
			rpcId,
			request.threadId,
			request.itemId,
			{
				kind: "file-change",
				files: changes.map((change) => ({
					path: change.path,
					unifiedDiff: change.diff,
				})),
			},
			[
				{
					id: "accept",
					label: "Allow once",
					tone: "allow",
					takesText: false,
					result: decide("accept"),
				},
				{
					id: "acceptForSession",
					label: "Allow for this session",
					tone: "allow",
					takesText: false,
					result: decide("acceptForSession"),
				},
				{
					id: "decline",
					label: "Decline",
					tone: "deny",
					takesText: false,
					result: decide("decline"),
				},
				{
					id: "cancel",
					label: "Decline and stop the turn",
					tone: "deny",
					takesText: false,
					result: decide("cancel"),
				},
			],
			undefined,
		);
	}

	private onPermissionsApproval(rpcId: RpcId, params: unknown): void {
		const request = permissionsApproval(this.reader, params);
		const requested = request.permissions;
		const granted = {
			...(requested.network === null ? {} : { network: requested.network }),
			...(requested.fileSystem === null
				? {}
				: { fileSystem: requested.fileSystem }),
		};
		const grant = (
			scope: PermissionsRequestApprovalResponse["scope"],
			permissions: JsonValue,
		): JsonValue => ({ permissions, scope }) as JsonValue;
		this.openRequest(
			rpcId,
			request.threadId,
			request.itemId,
			{
				kind: "tool",
				tool: "permissions",
				title: "Grant more permissions",
				input: { cwd: request.cwd, ...granted },
				reason: request.reason ?? undefined,
			},
			[
				{
					id: "turn",
					label: "Allow for this turn",
					tone: "allow",
					takesText: false,
					result: grant("turn", granted),
				},
				{
					id: "session",
					label: "Allow for this session",
					tone: "allow",
					takesText: false,
					result: grant("session", granted),
				},
				// Granting nothing is how a permission request is declined.
				{
					id: "decline",
					label: "Decline",
					tone: "deny",
					takesText: false,
					result: grant("turn", {}),
				},
			],
			undefined,
		);
	}

	private onUserInput(rpcId: RpcId, params: unknown): void {
		const request = userInputRequest(this.reader, params);
		const questions = request.questions.map(
			(question): Question => ({
				id: question.id,
				header: question.header,
				text: question.question,
				options: question.options.map((option) => ({
					...option,
					preview: undefined,
				})),
				multiSelect: false,
				allowsOther: question.isOther,
			}),
		);
		const parent = this.parentOf(request.threadId) ?? null;
		this.openRequest(
			rpcId,
			request.threadId,
			request.itemId,
			{ kind: "question", questions },
			[],
			{
				build: (values) => {
					const answers: ToolRequestUserInputResponse["answers"] = {};
					for (const question of request.questions) {
						const value = values[question.id];
						if (value === undefined)
							throw new Error(`no answer to question ${question.id}`);
						answers[question.id] = {
							answers: typeof value === "string" ? [value] : [...value],
						};
					}
					return {
						answers,
					} satisfies ToolRequestUserInputResponse as JsonValue;
				},
				answered: (result) => {
					const { answers } = result as ToolRequestUserInputResponse;
					return {
						kind: "answer",
						id: entryId(`answer/${this.serverKey(rpcId)}`),
						parent,
						answers: questions.map((question, index) =>
							answerTo(
								question,
								answers[question.id]?.answers ?? [],
								undefined,
								request.questions[index]!.isSecret,
							),
						),
					};
				},
			},
		);
	}

	/**
	 * An elicitation, answered by the one rule both CLIs' are
	 * (`../elicitation.ts`), in app-server's words: remembering an acceptance
	 * is `_meta.persist`, as Codex's own terminal UI sends it.
	 */
	private onElicitation(rpcId: RpcId, params: unknown): void {
		const { threadId, elicitation: request } = elicitation(this.reader, params);
		const name = JSON.stringify(rpcId);
		const wire = (answer: RequestAnswer): JsonValue => {
			const reply = elicitationReply(request, answer, name);
			return {
				action: reply.action,
				content: (reply.content ??
					null) as McpServerElicitationRequestResponse["content"],
				_meta:
					reply.remember === undefined ? null : { persist: reply.remember },
			} satisfies McpServerElicitationRequestResponse as JsonValue;
		};
		this.openRequest(
			rpcId,
			threadId,
			undefined,
			elicitationSubject(request),
			elicitationChoices(request).map((choice) => ({
				...choice,
				result: wire({ kind: "choice", choiceId: choice.id, text: undefined }),
			})),
			{
				build: (values) => wire({ kind: "answers", values }),
				answered: undefined,
			},
		);
	}

	/** A request DevHub will not handle is answered with an error, never left to stall the turn. */
	private decline(
		rpcId: RpcId,
		method: string,
		route: Unused | undefined,
		raw: JsonValue,
	): void {
		this.notice(
			"warning",
			route === undefined
				? `${this.codexName} asked DevHub for \`${method}\`, which DevHub does not know; DevHub answered that it cannot.`
				: `${this.codexName} asked DevHub for \`${method}\`, which DevHub does not do (${route.unused}); DevHub answered that it cannot.`,
			raw,
		);
		if (this.responded.has(rpcKey(rpcId))) return;
		this.writes.push(
			JSON.stringify({
				id: rpcId,
				error: {
					code: METHOD_NOT_FOUND,
					message: `DevHub does not handle ${method}`,
				},
			}),
		);
	}

	private onResolved(params: unknown): void {
		const { requestId: rpcId } = requestResolved(this.reader, params);
		const id = requestId(`codex/${this.serverKey(rpcId)}`);
		// A request DevHub declined with an error was never opened.
		if (!this.open.has(id)) return;
		this.open.delete(id);
		this.emit({ type: "request-closed", request: id });
	}

	// -------------------------------------------------------------------------
	// Commands.

	/**
	 * A message as app-server takes it: its words, each skill they mention
	 * (`$name`) as the protocol's `skill` input, the way a client hands Codex
	 * a skill, and its images.
	 */
	private inputOf(text: string, images: readonly ImageRef[]): UserInput[] {
		// Images as data URLs, which app-server takes as it takes any image
		// URL: the file is on the page's machine, not necessarily the Agent's.
		return [
			...(text === ""
				? []
				: [{ type: "text" as const, text, text_elements: [] }]),
			...this.skills
				.filter((skill) => mentions(text).has(skill.name))
				.map(
					(skill): UserInput => ({
						type: "skill",
						name: skill.name,
						path: skill.path,
					}),
				),
			...images.map((image): UserInput => {
				if (image.source.kind !== "data") {
					throw new Error(
						`Codex is sent only an image's own bytes, not ${image.source.kind} ${JSON.stringify(image.label)}`,
					);
				}
				return {
					type: "image",
					url: `data:${image.mediaType};base64,${image.source.base64}`,
				};
			}),
		];
	}

	private send(
		text: string,
		images: readonly ImageRef[],
		origin: "person" | "injection",
	): void {
		const { state } = this.current;
		if (state.phase !== "ready" || this.mainThread === undefined) {
			throw new Error(
				`cannot send to a Codex conversation that is ${state.phase}`,
			);
		}
		const input = this.inputOf(text, images);
		const clientUserMessageId = `devhub-${origin}-${this.nextUserMessage}`;
		this.nextUserMessage += 1;
		if (this.runningTurn !== undefined) {
			// Typing during a turn adds to it, as it does in Codex's own TUI.
			this.call("turn/steer", {
				threadId: this.mainThread,
				input,
				clientUserMessageId,
				expectedTurnId: this.runningTurn,
			} satisfies TurnSteerParams);
			return;
		}
		const mode = MODES.find((candidate) => candidate.id === this.chosen.mode);
		this.call("turn/start", {
			threadId: this.mainThread,
			input,
			clientUserMessageId,
			...(this.chosen.model === undefined ? {} : { model: this.chosen.model }),
			...(this.chosen.effort === undefined
				? {}
				: { effort: this.chosen.effort }),
			...(mode === undefined
				? {}
				: {
						approvalPolicy: mode.approvalPolicy,
						sandboxPolicy: mode.sandboxPolicy,
					}),
		} satisfies TurnStartParams);
	}

	/**
	 * The person's words to a subagent's thread: steered into the turn it is
	 * running, or starting one. Its thread is the first the spawn call names,
	 * the one its entry is drawn for.
	 */
	private instruct(subagent: EntryId, text: string): void {
		const thread = [...this.threadParents].find(
			([, spawn]) => spawn === subagent,
		)?.[0];
		if (thread === undefined || !this.directInput.has(thread)) {
			throw new Error(
				`${subagent} started no subagent thread that takes the person's messages`,
			);
		}
		const input = this.inputOf(text, []);
		const clientUserMessageId = `devhub-person-${this.nextUserMessage}`;
		this.nextUserMessage += 1;
		const running = this.childTurns.get(thread);
		if (running !== undefined) {
			this.call("turn/steer", {
				threadId: thread,
				input,
				clientUserMessageId,
				expectedTurnId: running,
			} satisfies TurnSteerParams);
			return;
		}
		this.call("turn/start", {
			threadId: thread,
			input,
			clientUserMessageId,
		} satisfies TurnStartParams);
	}

	/** Interrupting when no turn runs asks for what is already true, and sends nothing. */
	private interrupt(): void {
		if (this.runningTurn === undefined || this.mainThread === undefined) return;
		this.call("turn/interrupt", {
			threadId: this.mainThread,
			turnId: this.runningTurn,
		} satisfies TurnInterruptParams);
	}

	/**
	 * A subagent stopped: the turn each of its threads is running is
	 * interrupted, as the main thread's is. Its row goes when those turns end.
	 */
	private stopSubagent(task: string): void {
		const { call } = requireStoppable(this.current.backgroundTasks, task);
		for (const [thread, turnId] of this.runningThreadsOf(call!)) {
			this.call("turn/interrupt", {
				threadId: thread,
				turnId,
			} satisfies TurnInterruptParams);
		}
	}

	/** The subagent threads a spawn call started that are running a turn now, with that turn. */
	private runningThreadsOf(spawn: EntryId): readonly [string, string][] {
		return [...this.threadParents].flatMap(([thread, parent]) => {
			const turn = this.childTurns.get(thread);
			return parent === spawn && turn !== undefined ? [[thread, turn]] : [];
		});
	}

	private answer(id: RequestId, answer: RequestAnswer): void {
		const request = this.open.get(id);
		if (request === undefined) throw new Error(`request ${id} is not open`);
		if (this.responded.has(rpcKey(request.rpcId)))
			throw new Error(`request ${id} was already answered`);
		this.respond(request.rpcId, request.respond(answer));
	}

	/**
	 * Codex keeps no setting on the thread: model, effort and mode travel on
	 * each `turn/start`, so choosing one writes nothing. The choice is held
	 * here, shown at once (`configure` publishes the session), and carried by
	 * the next `turn/start`, whose `sent` makes it survive a replay.
	 */
	private choose(which: SettingName, id: string): void {
		this.chosen[which] = id;
		if (which === "model") this.chosen.effort = undefined;
	}

	// -------------------------------------------------------------------------
	// The method tables.

	private readonly notifications: {
		readonly [M in NotificationMethod]: ((params: unknown) => void) | Unused;
	} = {
		error: (params) => {
			const error = errorNotification(this.reader, params);
			this.notice(
				error.willRetry ? "warning" : "error",
				error.willRetry ? `${error.message} (retrying)` : error.message,
				params as JsonValue,
				this.parentOf(error.threadId) ?? null,
			);
		},
		"thread/started": (params) => {
			const thread = threadStarted(this.reader, params);
			if (thread.parentThreadId !== null && thread.agentNickname !== null) {
				this.relabel(thread.id, thread.agentNickname);
			}
			if (thread.parentThreadId !== null && thread.takesDirectInput) {
				this.directInput.add(thread.id);
				this.takesMessages(thread.id);
			}
		},
		"thread/status/changed": unused(
			"DevHub reads the status off turns and requests",
		),
		"thread/archived": unused("DevHub keeps no thread list"),
		"thread/deleted": unused("DevHub keeps no thread list"),
		"thread/unarchived": unused("DevHub keeps no thread list"),
		"thread/closed": (params) => {
			const { threadId } = threadClosed(this.reader, params);
			if (threadId === this.mainThread) {
				this.notice(
					"warning",
					`${this.codexName} closed this conversation's thread.`,
					params as JsonValue,
				);
			}
		},
		"thread/reverted": unused(
			"the answer to DevHub's thread/revert says the same, for the one thread DevHub reverts",
		),
		"skills/changed": unused(
			"DevHub lists the skills once, when the thread opens",
		),
		"thread/name/updated": unused("the Agent's name is DevHub's"),
		"thread/attachment/updated": unused("DevHub attaches nothing"),
		"thread/goal/updated": unused("DevHub sets no goals"),
		"thread/goal/cleared": unused("DevHub sets no goals"),
		"thread/queue/changed": unused("DevHub queues nothing on the thread"),
		"project/changed": unused("DevHub keeps no Codex projects"),
		"thread/project/updated": unused("DevHub keeps no Codex projects"),
		"thread/environment/connected": unused(
			"DevHub runs Codex where the Agent lives",
		),
		"thread/environment/disconnected": unused(
			"DevHub runs Codex where the Agent lives",
		),
		"thread/settings/updated": unused(
			"DevHub holds the next turn's settings itself",
		),
		"thread/tokenUsage/updated": (params) => {
			const usage = tokenUsage(this.reader, params);
			if (usage.threadId !== this.mainThread) return;
			this.total = {
				input: usage.total.inputTokens,
				output: usage.total.outputTokens,
				cached: usage.total.cachedInputTokens,
			};
			this.publishUsage({
				inputTokens: usage.total.inputTokens,
				outputTokens: usage.total.outputTokens,
				cachedInputTokens: usage.total.cachedInputTokens,
				contextTokens: usage.last.totalTokens,
				contextWindow: usage.modelContextWindow ?? undefined,
			});
		},
		"turn/started": (params) => this.onTurnStarted(params),
		"hook/started": unused("hook events are not drawn in v1"),
		"turn/completed": (params) => this.onTurnCompleted(params),
		"hook/completed": unused("hook events are not drawn in v1"),
		"turn/diff/updated": unused("each file change shows its own diff"),
		"turn/plan/updated": (params) => this.onPlanUpdated(params),
		"item/started": (params) => this.onItemNotification(params, "started"),
		"item/autoApprovalReview/started": unused(
			"DevHub does not run automatic approval review",
		),
		"item/autoApprovalReview/completed": unused(
			"DevHub does not run automatic approval review",
		),
		"autoApprovalReview/strictReviewRequired": unused(
			"DevHub does not run automatic approval review",
		),
		"item/completed": (params) => this.onItemNotification(params, "completed"),
		"rawResponseItem/completed": unused("DevHub does not ask for raw events"),
		"rawResponse/completed": unused("DevHub does not ask for raw events"),
		"item/agentMessage/delta": (params) => this.onTextDelta(params),
		"item/plan/delta": (params) => this.onTextDelta(params),
		"command/exec/outputDelta": unused("DevHub runs no command/exec"),
		"process/outputDelta": unused("DevHub runs no command/exec"),
		"process/exited": unused("DevHub runs no command/exec"),
		"item/commandExecution/outputDelta": (params) =>
			this.onCommandOutput(params),
		"item/commandExecution/terminalInteraction": unused(
			"the command's output already shows what it printed",
		),
		"item/fileChange/outputDelta": unused(
			"deprecated; the server no longer sends it",
		),
		"item/fileChange/patchUpdated": (params) => this.onPatchUpdated(params),
		"serverRequest/resolved": (params) => this.onResolved(params),
		"item/mcpToolCall/progress": unused(
			"progress messages are not drawn in v1",
		),
		"mcpServer/oauthLogin/completed": unused("DevHub starts no MCP login"),
		"mcpServer/startupStatus/updated": unused(
			"MCP server status is not drawn in v1",
		),
		"mcpServer/event/stream/notification": unused(
			"MCP server events are not drawn in v1",
		),
		"account/updated": unused("sign-in happens in a terminal"),
		"account/gatewayOAuth/changed": unused("sign-in happens in a terminal"),
		"account/rateLimits/updated": (params) => {
			const { windows } = rateLimits(this.reader, params);
			this.publishUsage({
				rateLimits: withRateLimits(this.usage?.rateLimits, windows),
			});
		},
		"app/list/updated": unused("DevHub lists no Codex apps"),
		"remoteControl/status/changed": unused("DevHub is the remote control"),
		"externalAgentConfig/import/progress": unused(
			"DevHub imports no agent config",
		),
		"externalAgentConfig/import/completed": unused(
			"DevHub imports no agent config",
		),
		"fs/changed": unused("DevHub watches no files through Codex"),
		"item/reasoning/summaryTextDelta": (params) =>
			this.onReasoningDelta(reasoningSummaryDelta(this.reader, params), false),
		"item/reasoning/summaryPartAdded": (params) => {
			const part = summaryPartAdded(this.reader, params);
			this.reasoningBlock(part.threadId, part.itemId, part.summaryIndex, false);
		},
		"item/reasoning/textDelta": (params) =>
			this.onReasoningDelta(reasoningTextDelta(this.reader, params), true),
		"thread/compacted": unused("the contextCompaction item says it"),
		"model/rerouted": (params) => {
			const reroute = rerouted(this.reader, params);
			this.notice(
				"info",
				`${reroute.fromModel} was rerouted to ${reroute.toModel} (${reroute.reason})`,
				params as JsonValue,
				this.parentOf(reroute.threadId) ?? null,
			);
		},
		"model/verification": unused("model verification is not drawn in v1"),
		"modelProvider/authRecoveryStarted": unused(
			"sign-in happens in a terminal",
		),
		"modelProvider/authRecoveryCompleted": unused(
			"sign-in happens in a terminal",
		),
		"turn/moderationMetadata": unused("moderation metadata is not drawn"),
		"model/safetyBuffering/updated": unused(
			"safety buffering is not drawn in v1",
		),
		warning: (params) => {
			const note = warning(this.reader, params);
			this.notice(
				"warning",
				note.message,
				params as JsonValue,
				note.threadId === null ? null : (this.parentOf(note.threadId) ?? null),
			);
		},
		guardianWarning: (params) => {
			const note = warning(this.reader, params);
			this.notice(
				"warning",
				note.message,
				params as JsonValue,
				note.threadId === null ? null : (this.parentOf(note.threadId) ?? null),
			);
		},
		deprecationNotice: (params) => {
			const note = summaryNotice(this.reader, params);
			this.notice(
				"warning",
				note.details === null
					? note.summary
					: `${note.summary}\n${note.details}`,
				params as JsonValue,
			);
		},
		configWarning: (params) => {
			const note = summaryNotice(this.reader, params);
			this.notice(
				"warning",
				note.details === null
					? note.summary
					: `${note.summary}\n${note.details}`,
				params as JsonValue,
			);
		},
		"fuzzyFileSearch/sessionUpdated": unused(
			"DevHub runs no fuzzy file search through Codex",
		),
		"fuzzyFileSearch/sessionCompleted": unused(
			"DevHub runs no fuzzy file search through Codex",
		),
		"thread/realtime/started": unused("DevHub has no voice mode"),
		"thread/realtime/itemAdded": unused("DevHub has no voice mode"),
		"thread/realtime/item/started": unused("DevHub has no voice mode"),
		"thread/realtime/item/transcript/delta": unused("DevHub has no voice mode"),
		"thread/realtime/item/completed": unused("DevHub has no voice mode"),
		"thread/realtime/transcript/delta": unused("DevHub has no voice mode"),
		"thread/realtime/transcript/done": unused("DevHub has no voice mode"),
		"thread/realtime/outputAudio/delta": unused("DevHub has no voice mode"),
		"thread/realtime/sdp": unused("DevHub has no voice mode"),
		"thread/realtime/error": unused("DevHub has no voice mode"),
		"thread/realtime/closed": unused("DevHub has no voice mode"),
		"windows/worldWritableWarning": unused(
			"DevHub runs on macOS and Unix hosts",
		),
		"windowsSandbox/setupCompleted": unused(
			"DevHub runs on macOS and Unix hosts",
		),
		"account/login/completed": unused("sign-in happens in a terminal"),
	};

	private readonly requests: {
		readonly [M in RequestMethod]:
			| ((id: RpcId, params: unknown) => void)
			| Unused;
	} = {
		"item/commandExecution/requestApproval": (id, params) =>
			this.onCommandApproval(id, params),
		"item/fileChange/requestApproval": (id, params) =>
			this.onFileChangeApproval(id, params),
		"item/tool/requestUserInput": (id, params) => this.onUserInput(id, params),
		"mcpServer/elicitation/request": (id, params) =>
			this.onElicitation(id, params),
		"item/permissions/requestApproval": (id, params) =>
			this.onPermissionsApproval(id, params),
		"item/tool/call": unused("DevHub registers no dynamic tools"),
		"account/chatgptAuthTokens/refresh": unused(
			"DevHub never hands Codex credentials",
		),
		"attestation/generate": unused("DevHub does not offer attestation"),
		applyPatchApproval: unused("a v1 approval; DevHub speaks v2"),
		execCommandApproval: unused("a v1 approval; DevHub speaks v2"),
	};
}

// ---------------------------------------------------------------------------
// Status words.

function commandStatus(
	status: "inProgress" | "completed" | "failed" | "declined",
): ToolStatus {
	switch (status) {
		case "inProgress":
			return "running";
		case "completed":
			return "succeeded";
		case "failed":
			return "failed";
		case "declined":
			return "denied";
	}
}

function toolCallStatus(
	status: "inProgress" | "completed" | "failed",
): ToolStatus {
	return commandStatus(status);
}

function collabStatus(
	status: "inProgress" | "completed" | "failed" | "interrupted",
): ToolStatus {
	return status === "interrupted" ? "interrupted" : commandStatus(status);
}

function subagentState(status: CollabAgentStatus): SubagentInfo["state"] {
	switch (status) {
		case "pendingInit":
		case "running":
			return "running";
		case "completed":
		case "shutdown":
			return "completed";
		case "errored":
		case "interrupted":
			return "failed";
		case "notFound":
			return "unknown";
	}
}

/** An MCP result's text parts, or the result whole when it has none. */
/** A call's arguments, as a title reads them: an object, or nothing to read. */
function argumentsOf(value: JsonValue): { readonly [key: string]: JsonValue } {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as { readonly [key: string]: JsonValue })
		: {};
}

/** An image sent as a data URL, read back as the page draws it. */
function dataImage(url: string): ImageRef {
	return {
		mediaType: /^data:([^;,]+)/u.exec(url)?.[1] ?? "image/*",
		source: { kind: "url", url },
		label: "image",
	};
}

/** A command's output as Codex gives it: stdout and stderr as one. */
function commandPart(
	exitCode: number | undefined,
	output: string,
): ToolOutputPart {
	return {
		kind: "command",
		exitCode,
		output,
		stderr: undefined,
		interrupted: false,
	};
}

/**
 * An MCP tool's result, as MCP content: its text and its images (which carry
 * their pixels inline), in order. A result with neither is shown as the JSON
 * it is.
 */
function mcpParts(result: JsonValue): ToolOutput {
	const content =
		typeof result === "object" && result !== null && !Array.isArray(result)
			? (result as { readonly content?: JsonValue }).content
			: undefined;
	const parts = (Array.isArray(content) ? content : []).flatMap(
		(part): ToolOutputPart[] => {
			if (typeof part !== "object" || part === null || Array.isArray(part))
				return [];
			const { type, text, data, mimeType } = part as {
				readonly [key: string]: JsonValue;
			};
			if (type === "text" && typeof text === "string")
				return [{ kind: "text", text }];
			if (
				type === "image" &&
				typeof data === "string" &&
				typeof mimeType === "string"
			) {
				return [
					{
						kind: "image",
						image: {
							mediaType: mimeType,
							source: { kind: "data", base64: data },
							label: "image",
						},
					},
				];
			}
			return [];
		},
	);
	return parts.length > 0
		? parts
		: [{ kind: "text", text: JSON.stringify(result, null, 2) }];
}

/**
 * Codex's version, from the user agent `initialize` answers with.
 *
 * The agent is `<client name>/<codex version> (<platform>) …` — the name at
 * its head is the one DevHub sent as `clientInfo.name`, so the whole string
 * reads as DevHub's, not Codex's. The version after the slash is Codex's own.
 */
function versionOf(userAgent: string): string | undefined {
	return /^[^/\s]+\/(\S+)/u.exec(userAgent)?.[1];
}
