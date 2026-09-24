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
 * adapter is spent. A method DevHub does not know is a `notice` and the
 * conversation goes on; a request DevHub does not know is also answered with
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
	applyEvent,
	entryId,
	requestId,
	type AssistantBlock,
	type ConversationEvent,
	type ConversationState,
	type EntryId,
	type JsonValue,
	type PendingRequest,
	type RequestAnswer,
	type RequestChoice,
	type RequestId,
	type SessionFacts,
	type SubagentInfo,
	type ToolEntry,
	type ToolStatus,
	type Transcript,
	type TranscriptEntry,
	type Usage,
} from "../../../../model/conversation.js";
import {
	ProtocolMismatch,
	type AdapterStep,
	type ConversationCommand,
	type ProtocolAdapter,
} from "../protocolAdapter.js";
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
	threadStarted,
	tokenUsage,
	turnNotification,
	userInputRequest,
	warning,
	type FileChange,
	type Item,
	type ModelChoice,
	type ReasoningDelta,
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
import type { PermissionsRequestApprovalResponse } from "./protocol/v2/PermissionsRequestApprovalResponse.js";
import type { SandboxPolicy } from "./protocol/v2/SandboxPolicy.js";
import type { ThreadResumeParams } from "./protocol/v2/ThreadResumeParams.js";
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
	| "model/list"
	| "turn/start"
	| "turn/steer"
	| "turn/interrupt";

const CLIENT_METHODS: readonly ClientMethod[] = [
	"initialize",
	"account/read",
	"thread/start",
	"thread/resume",
	"model/list",
	"turn/start",
	"turn/steer",
	"turn/interrupt",
];

/** JSON-RPC's own "method not found". */
const METHOD_NOT_FOUND = -32601;

const USER_MESSAGE_ID = /^devhub-(person|injection)-(\d+)$/;

/** A request the server made that DevHub is showing, and how each answer is spelled. */
interface OpenRequest {
	readonly rpcId: RpcId;
	readonly respond: (answer: RequestAnswer) => JsonValue;
}

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

	// What DevHub said (from `sent`), and the counters `encode` draws ids from.
	private nextRpcId = 0;
	private nextUserMessage = 0;
	private readonly calls = new Map<string, ClientMethod>();
	private readonly sentMethods = new Set<string>();
	private readonly responded = new Set<string>();
	private readonly chosen: Chosen = {
		model: undefined,
		effort: undefined,
		mode: undefined,
	};

	// What the server said (from `received`).
	private mainThread: string | undefined;
	private runningTurn: string | undefined;
	private defaults: ThreadDefaults | undefined;
	private models: readonly ModelChoice[] = [];
	private readonly open = new Map<RequestId, OpenRequest>();
	/** Child thread → the tool entry that started it. */
	private readonly threadParents = new Map<string, EntryId>();
	private readonly threadLabels = new Map<string, string>();
	/** Items of child threads DevHub could not place under a call. */
	private readonly unplaced = new Set<string>();
	/** Running tools and streaming messages, by thread: a thread runs one turn at a time. */
	private readonly unfinished = new Map<string, Set<EntryId>>();
	private readonly commandOutput = new Map<EntryId, string>();
	private readonly fileChanges = new Map<EntryId, readonly FileChange[]>();
	private noticeCount = 0;
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
		return this.lines(() => {
			const params: InitializeParams = {
				clientInfo: {
					name: "devhub",
					title: "DevHub",
					version: this.options.clientVersion,
				},
				// The stable surface only: it is the one the vendored types describe.
				capabilities: { experimentalApi: false, requestAttestation: false },
			};
			this.call("initialize", params);
		});
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
					return this.send(command.text, command.origin);
				case "interrupt":
					return this.interrupt();
				case "answer":
					return this.answer(command.request, command.answer);
				case "set-setting":
					return this.choose(command.which, command.id);
			}
		});
	}

	sent(line: string): AdapterStep {
		return this.step(() => this.noteSent(line));
	}

	received(line: string): AdapterStep {
		return this.step(() => {
			if (!this.broken) this.dispatch(line);
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
		// A setting chosen since the last step is shown now (see `choose`).
		this.publishSession();
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

	private get codexName(): string {
		return this.version ?? "codex";
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
			return;
		}
		this.sentMethods.add(message.method);
		if (message.id === undefined) return;
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
			}
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
				if (route === undefined) {
					return this.notice(
						"warning",
						`${this.codexName} sent \`${message.method}\`, which DevHub does not know.`,
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
				this.version = initializeResponse(this.reader, result).userAgent;
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
			case "thread/resume":
				return this.onThreadOpened(threadOpenedResponse(this.reader, result));
			case "model/list": {
				this.models = modelListResponse(this.reader, result);
				return this.publishSession();
			}
			case "turn/start":
			case "turn/steer":
			case "turn/interrupt":
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
				return this.notice(
					"warning",
					`${this.codexName} could not list its models: ${message}. The model can't be changed here.`,
					raw,
				);
			case "turn/start":
				return this.notice(
					"error",
					`${this.codexName} did not start the turn: ${message}`,
					raw,
				);
			case "turn/steer":
				return this.notice(
					"error",
					`${this.codexName} did not take the message: ${message}`,
					raw,
				);
			case "turn/interrupt":
				return this.notice(
					"error",
					`${this.codexName} did not interrupt the turn: ${message}`,
					raw,
				);
		}
	}

	private openThread(): void {
		const { cwd, resumeThreadId } = this.options;
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
		this.defaults = {
			model: opened.model,
			effort: opened.reasoningEffort ?? undefined,
			mode: modeOf(opened.approvalPolicy, opened.sandbox),
			cwd: opened.cwd,
		};
		this.publishSession();
		for (const turn of thread.turns) this.replayTurn(thread.id, turn);
		this.setState({
			phase: "ready",
			turn: this.runningTurn === undefined ? "none" : "running",
		});
		this.callOnce("model/list", {} satisfies ModelListParams);
	}

	/** A turn `thread/resume` hands back whole: its items as completed, then its end. */
	private replayTurn(threadId: string, turn: TurnFacts): void {
		for (const item of turn.items) this.onItem(threadId, item, "completed");
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
		const efforts =
			this.models.find((candidate) => candidate.id === model)?.efforts ?? [];
		return {
			...EMPTY_SESSION,
			agentVersion: this.version,
			sessionId: this.mainThread,
			cwd: this.defaults?.cwd,
			model: {
				current: model,
				choices: this.models
					.filter((candidate) => !candidate.hidden)
					.map((candidate) => ({
						id: candidate.id,
						label: candidate.displayName,
					})),
			},
			effort: {
				// A newly chosen model starts at its own default effort, which
				// only the server knows: shown as not set.
				current:
					this.chosen.effort ??
					(this.chosen.model === undefined ? this.defaults?.effort : undefined),
				choices: efforts.map((effort) => ({ id: effort, label: effort })),
			},
			mode: {
				current: this.chosen.mode ?? this.defaults?.mode,
				choices: MODES.map((mode) => ({ id: mode.id, label: mode.label })),
			},
			commands: [
				{
					name: "model",
					description: "Choose the model",
					argumentHint: undefined,
					route: "model",
				},
				{
					name: "effort",
					description: "Choose the reasoning effort",
					argumentHint: undefined,
					route: "effort",
				},
				{
					name: "approvals",
					description: "Choose what Codex may do without asking",
					argumentHint: undefined,
					route: "mode",
				},
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
			rateLimit: undefined,
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

	private idOf(threadId: string, itemId: string): EntryId {
		return entryId(`${threadId}/${itemId}`);
	}

	private onTurnStarted(params: unknown): void {
		const { threadId, turn } = turnNotification(this.reader, params);
		if (threadId !== this.mainThread) return;
		this.runningTurn = turn.id;
		this.totalAtTurnStart = this.total;
		this.setState({ phase: "ready", turn: "running" });
	}

	private onTurnCompleted(params: unknown): void {
		const { threadId, turn } = turnNotification(this.reader, params);
		if (turn.status === "inProgress") {
			this.mismatch("params.turn.status", "a finished turn, got inProgress");
		}
		this.endTurn(threadId, turn, this.turnUsage());
	}

	/**
	 * A turn is over: whatever of it was still running is not any more, and for
	 * the main thread the turn ends in the transcript. A subagent's turn ends
	 * only in its `spawns.state`: a turn-end entry has no parent to hang under.
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
		if (threadId !== this.mainThread) return;
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
			rateLimit: undefined,
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
		const { threadId, item } = itemNotification(this.reader, params);
		this.onItem(threadId, item, phase);
	}

	private onItem(
		threadId: string,
		item: Item,
		phase: "started" | "completed",
	): void {
		const id = this.idOf(threadId, item.id);
		const parent = this.parentOf(threadId);
		if (parent === undefined) {
			// Stage 0 has not yet shown in which order a subagent's first items and
			// the call that started it arrive. Until it has, an item DevHub cannot
			// place is shown whole at the top level when it completes.
			this.unplaced.add(id);
			if (phase === "completed") {
				this.notice(
					"warning",
					`A ${item.type === "other" || item.type === "unknown" ? item.itemType : item.type} item from subagent thread ${threadId} arrived before DevHub knew which call started that thread.`,
					item as unknown as JsonValue,
				);
			}
			return;
		}
		const streaming = phase === "started";
		switch (item.type) {
			case "userMessage": {
				const match = USER_MESSAGE_ID.exec(item.clientId ?? "");
				return this.put(
					{
						kind: "user",
						id,
						parent,
						text: item.content
							.flatMap((input) => (input.type === "text" ? [input.text] : []))
							.join("\n"),
						images: item.content.flatMap((input) =>
							input.type === "image"
								? [{ mediaType: "image/*", label: input.label }]
								: [],
						),
						origin: match?.[1] === "injection" ? "injection" : "person",
					},
					threadId,
				);
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
						? {
								kind: "command" as const,
								exitCode: item.exitCode ?? undefined,
								output: item.aggregatedOutput ?? streamed ?? "",
							}
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
				const text =
					item.error ??
					(item.result === null ? undefined : mcpText(item.result));
				return this.put(
					this.tool(
						id,
						parent,
						`mcp:${item.server}/${item.tool}`,
						`${item.server}: ${item.tool}`,
						item.arguments,
						toolCallStatus(item.status),
						text === undefined
							? undefined
							: { kind: "text", text, truncated: false },
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
						item.tool,
						item.arguments,
						toolCallStatus(item.status),
						item.output.length === 0
							? undefined
							: {
									kind: "text",
									text: item.output.join("\n"),
									truncated: false,
								},
					),
					threadId,
				);
			case "collabAgentToolCall":
				return this.onCollab(id, parent, threadId, item);
			case "subAgentActivity":
				this.relabel(item.agentThreadId, item.agentPath);
				return this.setSpawnState(
					item.agentThreadId,
					item.kind === "completed"
						? "completed"
						: item.kind === "interrupted"
							? "failed"
							: "running",
					item,
				);
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
							: {
									kind: "text",
									text: JSON.stringify(item.results, null, 2),
									truncated: false,
								},
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
						undefined,
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
				return this.notice("info", "Context compacted", undefined, parent, id);
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
			{
				kind: "diff",
				files: changes.map((change) => ({
					path: change.path,
					unifiedDiff: change.diff,
				})),
			},
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
			for (const receiver of item.receiverThreadIds) {
				if (!this.threadParents.has(receiver))
					this.threadParents.set(receiver, id);
			}
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
		// Any collab call may report on agents another call started.
		for (const [agent, status] of Object.entries(item.agentsStates)) {
			if (this.threadParents.get(agent) !== id)
				this.setSpawnState(agent, subagentState(status), undefined);
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
			return this.notice(
				"warning",
				`${this.codexName} reported on subagent thread ${threadId}, which DevHub never saw started.`,
				about as unknown as JsonValue,
			);
		}
		if (entry.spawns!.state === state) return;
		this.emit({
			type: "entry",
			entry: { ...entry, spawns: { ...entry.spawns!, state } },
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

	/** The streaming assistant entry a delta is for, or undefined for an item DevHub could not place. */
	private streamingEntry(
		threadId: string,
		itemId: string,
		entry: EntryId = this.idOf(threadId, itemId),
	) {
		if (this.unplaced.has(this.idOf(threadId, itemId))) return undefined;
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
		const entry = this.streamingEntry(threadId, itemId);
		if (entry === undefined) return;
		this.emit({ type: "text-delta", entry: entry.id, block: 0, text: delta });
	}

	/** Makes sure the reasoning entry has a thinking block at `index`, adding empty ones up to it. */
	private reasoningBlock(
		threadId: string,
		itemId: string,
		index: number,
		raw: boolean,
	) {
		const base = this.idOf(threadId, itemId);
		if (this.unplaced.has(base)) return undefined;
		const id = raw ? entryId(`${base}#raw`) : base;
		if (raw && this.entry(id) === undefined) {
			const summary = this.streamingEntry(threadId, itemId);
			if (summary === undefined) return undefined;
			this.put({ ...summary, id, blocks: [] }, threadId);
		}
		const entry = this.streamingEntry(threadId, itemId, id)!;
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
		const id = this.idOf(threadId, itemId);
		if (this.unplaced.has(id)) return;
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
				output: { kind: "command", exitCode: undefined, output },
			},
		});
	}

	private onPatchUpdated(params: unknown): void {
		const { threadId, itemId, changes } = patchUpdated(this.reader, params);
		const id = this.idOf(threadId, itemId);
		if (this.unplaced.has(id)) return;
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
		const parent = this.parentOf(threadId);
		if (parent === undefined) return;
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
		answers:
			| ((
					values: Extract<RequestAnswer, { kind: "answers" }>["values"],
			  ) => JsonValue)
			| undefined,
	): void {
		const id = requestId(`codex/${rpcKey(rpcId)}`);
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
					return answers(answer.values);
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
		this.openRequest(
			rpcId,
			request.threadId,
			request.itemId,
			{
				kind: "question",
				questions: request.questions.map((question) => ({
					id: question.id,
					header: question.header,
					text: question.question,
					options: question.options,
					multiSelect: false,
					allowsOther: question.isOther,
				})),
			},
			[],
			(values) => {
				const answers: ToolRequestUserInputResponse["answers"] = {};
				for (const question of request.questions) {
					const value = values[question.id];
					if (value === undefined)
						throw new Error(`no answer to question ${question.id}`);
					answers[question.id] = {
						answers: typeof value === "string" ? [value] : [...value],
					};
				}
				return { answers } satisfies ToolRequestUserInputResponse as JsonValue;
			},
		);
	}

	private onElicitation(rpcId: RpcId, params: unknown): void {
		const request = elicitation(this.reader, params);
		const act = (
			action: McpServerElicitationRequestResponse["action"],
		): JsonValue =>
			({
				action,
				content: null,
				_meta: null,
			}) satisfies McpServerElicitationRequestResponse as JsonValue;
		this.openRequest(
			rpcId,
			request.threadId,
			undefined,
			{
				kind: "elicitation",
				server: request.serverName,
				message: request.message,
				schema: request.schema,
			},
			[
				// A form needs its content filled in, which DevHub has no UI for yet.
				...(request.mode === "url"
					? [
							{
								id: "accept",
								label: "Done",
								tone: "allow" as const,
								takesText: false,
								result: act("accept"),
							},
						]
					: []),
				{
					id: "decline",
					label: "Decline",
					tone: "deny",
					takesText: false,
					result: act("decline"),
				},
				{
					id: "cancel",
					label: "Cancel",
					tone: "neutral",
					takesText: false,
					result: act("cancel"),
				},
			],
			undefined,
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
		const id = requestId(`codex/${rpcKey(rpcId)}`);
		// A request DevHub declined with an error was never opened.
		if (!this.open.has(id)) return;
		this.open.delete(id);
		this.emit({ type: "request-closed", request: id });
	}

	// -------------------------------------------------------------------------
	// Commands.

	private send(text: string, origin: "person" | "injection"): void {
		const { state } = this.current;
		if (state.phase !== "ready" || this.mainThread === undefined) {
			throw new Error(
				`cannot send to a Codex conversation that is ${state.phase}`,
			);
		}
		const input: UserInput[] = [{ type: "text", text, text_elements: [] }];
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

	/** Interrupting when no turn runs asks for what is already true, and sends nothing. */
	private interrupt(): void {
		if (this.runningTurn === undefined || this.mainThread === undefined) return;
		this.call("turn/interrupt", {
			threadId: this.mainThread,
			turnId: this.runningTurn,
		} satisfies TurnInterruptParams);
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
	 * here, shown by the next step (`step` publishes the session first), and
	 * carried by the next `turn/start`, whose `sent` makes it survive a replay.
	 *
	 * This is the one place `encode` moves state beyond an id counter, because
	 * there is no line for the choice to come back through. Whether the seam
	 * should carry it instead is an open question to stage 5.
	 */
	private choose(which: "model" | "effort" | "mode", id: string): void {
		if (
			!this.sessionFacts()[which].choices.some((choice) => choice.id === id)
		) {
			throw new Error(`${id} is not a ${which} this Codex offers`);
		}
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
		"thread/reverted": unused("DevHub never rolls a thread back"),
		"skills/changed": unused("DevHub lists no skills yet"),
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
		"account/rateLimits/updated": (params) => {
			const { primary } = rateLimits(this.reader, params);
			// A sparse update without the window does not clear the last one seen.
			if (primary === null) return;
			this.publishUsage({
				rateLimit: {
					usedPercent: primary.usedPercent,
					// Unix seconds, as Codex's core protocol keeps it; stage 0 confirms on a real capture.
					resetsAt:
						primary.resetsAt === null ? undefined : primary.resetsAt * 1000,
				},
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
function mcpText(result: JsonValue): string {
	const content =
		typeof result === "object" && result !== null && !Array.isArray(result)
			? (result as { readonly content?: JsonValue }).content
			: undefined;
	const texts = Array.isArray(content)
		? content.flatMap((part) =>
				typeof part === "object" &&
				part !== null &&
				!Array.isArray(part) &&
				typeof (part as { text?: unknown }).text === "string"
					? [(part as { text: string }).text]
					: [],
			)
		: [];
	return texts.length > 0 ? texts.join("\n") : JSON.stringify(result, null, 2);
}
