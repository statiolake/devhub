/**
 * Claude's stream-json conversation, as a `ProtocolAdapter` (design §3.3).
 *
 * # Entry ids
 *
 * Every entry's id is built from the CLI's own ids, so the same lines always
 * make the same transcript — live, or replayed from the journal by another
 * boot of DevHub:
 *
 * - `user:<uuid>` for a user message, by the uuid the CLI gave its echo;
 * - `assistant:<message id>:<first block>` for a run of text and thinking
 *   blocks of one message. A message that says something, calls a tool and
 *   says something more is two assistant entries with the tool between them,
 *   so the transcript keeps the order it was said in;
 * - `tool:<tool_use id>` for a tool call; a subagent's entries name the call
 *   that started it (`parent_tool_use_id`) as their parent;
 * - `notice:<n>` and `turn:<n>`, counted, for what has no id of its own.
 *
 * # Streaming
 *
 * `stream_event`s open a message and its blocks and grow them by deltas; the
 * complete `assistant` message that follows each block finalizes it. The CLI
 * prints the complete message one block at a time, so the n-th block of all
 * complete messages with one id is the n-th block that streamed. A message
 * that never streamed (a subagent's, without partial messages) arrives whole
 * and final from its complete messages alone, through the same code.
 *
 * # User messages
 *
 * A user message is written with the origin DevHub gave it (`devhub_origin`),
 * and it enters the transcript when the CLI echoes it back
 * (`--replay-user-messages`): that is when the CLI took it, which puts it in
 * its true place among the CLI's own lines, and it is when the turn starts.
 * An echo is matched to the first message DevHub sent with the same text. A
 * user message DevHub did not send (`[Request interrupted by user]`, the text
 * of a command's output) is shown as a notice — it is the CLI speaking, not
 * the person.
 */

import {
	EMPTY_TRANSCRIPT,
	answerTo,
	applyEvent,
	rewindTargets,
	entryId,
	requestId,
	sameRunningTasks,
	type AskedQuestion,
	type AssistantBlock,
	type AssistantEntry,
	type ConversationEvent,
	type EntryId,
	type FileDiff,
	type ImageRef,
	type JsonValue,
	type McpAction,
	type McpServer,
	type McpServerStatus,
	type McpState,
	type PlanStep,
	type Question,
	type RequestChoice,
	type RequestId,
	type SessionFacts,
	type Setting,
	type SlashCommand,
	type SendingMessage,
	type RunningTask,
	type UserOrigin,
	type SentOrigin,
	type SubagentInfo,
	type ToolEntry,
	type ToolOutput,
	type ToolOutputPart,
	type Transcript,
	type TranscriptEntry,
	type Usage,
	usedUpReset,
	withRateLimits,
} from "../../../../model/conversation.js";
import {
	ProtocolMismatch,
	RESTARTED,
	RESTART_MARK,
	requireStoppable,
	type AdapterStep,
	type ConversationCommand,
	type McpRequest,
	type ProtocolAdapter,
	type RewindPlan,
	type SettingName,
} from "../protocolAdapter.js";
import {
	type Elicitation,
	elicitationChoices,
	elicitationReply,
	elicitationSubject,
} from "../elicitation.js";
import { todoPlan, toolTitle } from "../toolTitle.js";
import {
	ASK_USER_QUESTION,
	NO_TOOL_RESULT,
	ORIGIN_KEY,
	decodeInitialize,
	decodeMcpStatus,
	decodeReceived,
	decodeSent,
	type AnsweredQuestions,
	type ClaudeLine,
	type ContentBlock,
	type InitializeFacts,
	type McpServerState,
	type PluginLoadError,
	type ToolUseResult,
	type StreamEvent,
	type UserBlock,
} from "./decode.js";

type JsonObject = { readonly [key: string]: JsonValue };

/**
 * Commands DevHub answers with its own picker rather than sending (design
 * §3.3): the header picker of a setting, or the Workspace's earlier sessions.
 */
const PICKED: Readonly<
	Record<string, Exclude<SlashCommand["route"], "message">>
> = {
	model: "model",
	effort: "effort",
	permissions: "mode",
	resume: "resume",
	restart: "restart",
	mcp: "mcp",
};

/**
 * DevHub's own commands, offered whether or not the CLI lists them:
 * `/resume`, since stream-json has no picker of its own, `/restart`, since
 * only DevHub can start the CLI again, and `/mcp`, since -p mode has no MCP
 * panel of its own (MCP docs, "non-interactive mode").
 */
const DEVHUB_COMMANDS = [
	{
		name: "resume",
		description: "Go on with an earlier session in this Workspace",
		argumentHint: undefined,
	},
	{
		name: "restart",
		description:
			"Restart the session: start the CLI again, reconnecting its MCP servers",
		argumentHint: undefined,
	},
	{
		name: "mcp",
		description:
			"MCP servers: how each stands, reconnect, enable or disable, sign in",
		argumentHint: undefined,
	},
] as const;

/** Claude's word for an MCP server's status, in the conversation's vocabulary. */
function mcpStatus(said: string): McpServerStatus {
	switch (said) {
		case "connected":
			return "connected";
		case "needs-auth":
			return "needs-sign-in";
		case "failed":
			return "failed";
		case "pending":
			return "connecting";
		case "disabled":
			return "disabled";
		default:
			return "unknown";
	}
}

/**
 * What the panel offers for a server that stands so: each a documented
 * control request (`mcp_reconnect`, `mcp_toggle`) or the documented
 * `claude mcp login`. A server still connecting is left to finish.
 */
function mcpActions(status: McpServerStatus): readonly McpAction[] {
	switch (status) {
		case "connected":
		case "failed":
		case "unknown":
			return ["reconnect", "disable"];
		case "needs-sign-in":
			return ["sign-in", "reconnect", "disable"];
		case "connecting":
			return ["disable"];
		case "disabled":
			return ["enable"];
	}
}

/** The person's MCP request a control request of DevHub's is, if it is one. */
function mcpWorking(request: JsonObject): McpState["working"] {
	const server = request.serverName;
	if (typeof server !== "string") return [];
	if (request.subtype === "mcp_reconnect")
		return [{ server, action: "reconnect" }];
	if (request.subtype === "mcp_toggle")
		return [
			{ server, action: request.enabled === true ? "enable" : "disable" },
		];
	return [];
}

/** How a refused MCP request reads in the panel. */
const MCP_ACTION_NAMES: Readonly<Record<string, string>> = {
	mcp_status: "Listing the MCP servers",
	mcp_reconnect: "Reconnecting",
	mcp_toggle: "Enabling or disabling",
};

/** Commands that only work in the TUI; "continue in terminal" is the way to them. */
const TUI_ONLY = new Set(["login", "logout"]);

/** The values `--permission-mode` takes, and the one the CLI reports when none was given. */
const MODES: Setting["choices"] = [
	{ id: "default", label: "Default" },
	{ id: "acceptEdits", label: "Accept edits" },
	{ id: "plan", label: "Plan" },
	{ id: "auto", label: "Auto" },
	{ id: "dontAsk", label: "Don't ask" },
	{ id: "bypassPermissions", label: "Bypass permissions" },
];

const EFFORT_COMMAND = /^\/effort\s+(\S+)\s*$/u;

/**
 * The suffix that picks a model's 1M token context window, on an alias or a
 * full model name alike (`opus[1m]`, `claude-opus-4-8[1m]`): Claude Code's
 * model configuration, "Extended context".
 */
const LONG_CONTEXT = "[1m]";

/**
 * The handshake's choice a model name is: the choice by that value (what
 * `set_model` was given), else one that resolves to it — a named alias
 * before `default`, which resolves to whatever the default is today.
 */
function listedAs(
	models: InitializeFacts["models"],
	name: string,
): InitializeFacts["models"][number] | undefined {
	return (
		models.find((model) => model.id === name) ??
		models.find((model) => model.id !== "default" && model.resolved === name) ??
		models.find((model) => model.resolved === name)
	);
}

/**
 * How a model choice reads, in the picker's list and as its current value
 * alike: the full model name the session would report for it, and the value
 * `/model` is given for it when that is another name (`opus`, `default`),
 * so two choices that resolve to the same model today still read apart. The
 * CLI's own display name goes beside it (`detail`).
 */
function modelChoice(
	value: string,
	resolved: string | undefined,
	displayName: string | undefined,
): Setting["choices"][number] {
	return {
		id: value,
		label:
			resolved === undefined || resolved === value
				? value
				: `${resolved} (${value})`,
		...(displayName === undefined ? {} : { detail: displayName }),
	};
}

/** The tools that start a subagent. */
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

const NO_USAGE: Usage = {
	inputTokens: undefined,
	outputTokens: undefined,
	cachedInputTokens: undefined,
	contextTokens: undefined,
	contextWindow: undefined,
	costUsd: undefined,
	rateLimits: undefined,
};

const ALLOW_ONCE: RequestChoice = {
	id: "allow",
	label: "Allow once",
	tone: "allow",
	takesText: false,
};
const DENY: RequestChoice = {
	id: "deny",
	label: "Deny",
	tone: "deny",
	takesText: true,
};
const DECLINE: RequestChoice = {
	id: "deny",
	label: "Decline",
	tone: "deny",
	takesText: true,
};

/** The `error` of an assistant message whose request the API refused as unauthenticated. */
const SIGNED_OUT = "authentication_failed";
/** How to sign claude in again, in its documented commands (CLI reference). */
const CLAUDE_SIGN_IN =
	"Sign in with `claude auth login` (or `/login` in claude) in a terminal on this Agent's machine, then try again.";
/** The API error of an answer a usage or rate limit refused (`SDKAssistantMessageError`). */
const RATE_LIMITED = "rate_limit";

const DENIED_WITHOUT_WORDS = "The person denied this in DevHub.";

/**
 * The first CLI whose print mode resumes a session cut after a message
 * (`--resume-session-at`, the Agent SDK's `resumeSessionAt`) together with
 * `--resume-drops-turn`, documented as needing it. DevHub does not pass
 * `--resume-drops-turn`: it declares the one turn a cut drops and refuses a
 * cut that drops more, and a rewind drops every turn after the cut.
 */
const RESUMES_AT_A_MESSAGE = [2, 1, 223] as const;

/** One block of a message, as far as it has come. */
type Slot =
	| {
			readonly kind: "text" | "thinking";
			readonly entry: EntryId;
			readonly block: number;
			final: boolean;
	  }
	| { readonly kind: "tool"; readonly entry: EntryId; readonly id: string }
	/**
	 * A thinking block with no text yet. The API may withhold thinking and send
	 * only its signature, so the block is drawn once it has something to say,
	 * and never if it has not.
	 */
	| { readonly kind: "unsaid" }
	| { readonly kind: "ignored" };

interface MessageState {
	readonly id: string;
	readonly parent: EntryId | null;
	readonly slots: Map<number, Slot>;
	/** How many of its blocks complete messages have delivered. */
	finals: number;
}

/** A request of the CLI's that DevHub has not answered. */
type Pending = Permission | PendingElicitation;

/** A permission request (`can_use_tool`). */
interface Permission {
	readonly kind: "permission";
	readonly input: JsonObject;
	readonly suggestions: readonly JsonObject[];
	readonly choices: readonly RequestChoice[];
	readonly asksQuestions: boolean;
	readonly entry: EntryId | undefined;
}

/** A user message DevHub wrote, waiting for the end of the turn that answers it. */
interface Unanswered {
	readonly message: SendingMessage;
	/** The CLI echoed it into the conversation: drawn as an entry, no longer sending. */
	taken: boolean;
}

/** An MCP server's elicitation, which is about no call. */
interface PendingElicitation {
	readonly kind: "elicitation";
	readonly elicitation: Elicitation;
	readonly entry: undefined;
}

export class ClaudeAdapter implements ProtocolAdapter {
	private current: Transcript = EMPTY_TRANSCRIPT;
	private spent = false;
	private events: ConversationEvent[] = [];
	private replies: string[] = [];

	private nextRequest = 1;
	/** Control requests DevHub wrote that the CLI has not answered, by id. */
	private readonly ours = new Map<string, JsonObject>();
	/**
	 * The user messages DevHub wrote that the CLI has not answered yet,
	 * oldest first: each until the end of the turn that answers it (the
	 * `result`), whatever the CLI printed or did not print on the way.
	 * `taken` once the CLI echoed it into the conversation; until then it is
	 * drawn as sending.
	 */
	private readonly unanswered: Unanswered[] = [];
	/** How many user messages DevHub has written: what names each while it is sending. */
	private written = 0;
	private readonly pending = new Map<string, Pending>();
	private readonly denied = new Set<EntryId>();
	/**
	 * The CLI's requests DevHub has answered. The CLI prints each answer back
	 * (as it replays user messages), and an echo is not a response to a
	 * request of DevHub's own.
	 */
	private readonly answered = new Set<string>();
	/** DevHub asked the running turn to stop. */
	private interrupting = false;
	/**
	 * What of a usage limit the turn under way has been told: the model's
	 * answer was the API's `rate_limit` error (`limitAnswered`), and the
	 * reset of the window a `rate_limit_event` with status `rejected` named
	 * (`rejected`, whose `resetsAt` may be unknown). Read when the turn ends.
	 */
	private limitAnswered = false;
	private rejected: { readonly resetsAt: number | undefined } | undefined;
	/**
	 * The end of the last turn, when a usage limit stopped it and the CLI has
	 * not said when that limit resets: a `rate_limit_event` that says so
	 * before the next turn starts fills it in.
	 */
	private unresetLimit: EntryId | undefined;
	/**
	 * The subagent call each background task belongs to, by task id: what a
	 * notification that names only the task (not its call) is matched by.
	 */
	private readonly tasks = new Map<string, EntryId>();
	/**
	 * When each call was made, by the CLI's own clock: the `timestamp` of the
	 * assistant line that carried it. A background task started by a call
	 * started then.
	 */
	private readonly callTimes = new Map<EntryId, number>();
	/** The call that spawned each teammate, by the name its messages come from. */
	private readonly teammates = new Map<string, EntryId>();
	/**
	 * The tasks the CLI last said it has working in the background
	 * (`background_tasks_changed`), which `reportBackground` makes the
	 * transcript's.
	 */
	private background: Extract<
		ClaudeLine,
		{ type: "background_tasks" }
	>["tasks"] = [];

	private readonly messages = new Map<string, MessageState>();
	/** The message streaming now, per parent (null for the top level). */
	private readonly streaming = new Map<EntryId | null, MessageState>();

	private described: InitializeFacts["commands"] = [];
	/** The models the handshake listed; none known until it answers. */
	private models: InitializeFacts["models"] | undefined;
	/** The model the top level last wrote with: whose context window the usage is measured against. */
	private mainModel: string | undefined;
	private announced: readonly string[] = [];
	/**
	 * The session's MCP servers as the CLI last reported them (`system/init`,
	 * `mcp_status`); undefined until it has.
	 */
	private mcpServers: readonly McpServerState[] | undefined;
	/** The plugins the CLI last said did not load (`system/init`). */
	private pluginErrors: readonly PluginLoadError[] = [];
	/** The last MCP request of the person's the CLI refused (`McpState.failure`). */
	private mcpFailure: string | undefined;
	private readonly unknownSeen = new Set<string>();
	private notices = 0;
	private commandCount = 0;
	private compactions = 0;
	private turns = 0;
	private users = 0;

	/** The uuid of the last top-level message the session holds: where a resume would cut it now. */
	private lastUuid: string | undefined;
	/**
	 * For each of the person's messages that has a uuid, where a resume cuts
	 * the session to leave that message out: the message before it, or `null`
	 * for the first, which leaves nothing to resume.
	 */
	private readonly cutBefore = new Map<EntryId, string | null>();

	constructor(
		/** Names this boot of DevHub in the ids of its control requests, so none repeats across restarts. */
		private readonly bootId: string,
	) {}

	get transcript(): Transcript {
		return this.current;
	}

	opening(): readonly string[] {
		this.refuseIfSpent();
		return [this.controlRequest({ subtype: "initialize" })];
	}

	encode(command: ConversationCommand): readonly string[] {
		this.refuseIfSpent();
		switch (command.kind) {
			case "send":
				return [
					userLine(
						command.text,
						command.images,
						command.origin,
						this.running(),
					),
				];
			case "instruct":
				throw new Error(
					"Claude Code's stream-json has no way to say something to a subagent, so no subagent takes the person's messages",
				);
			case "interrupt":
				return [this.controlRequest({ subtype: "interrupt" })];
			case "stop-task":
				requireStoppable(this.current.backgroundTasks, command.task);
				return [
					this.controlRequest({ subtype: "stop_task", task_id: command.task }),
				];
			case "answer":
				return [this.answerLine(command.request, command.answer)];
			case "mcp":
				return [this.controlRequest(this.mcpRequest(command.request))];
		}
	}

	/**
	 * The control request that carries an MCP request: the SDK's
	 * `mcpServerStatus()`, `reconnectMcpServer(name)` and
	 * `toggleMcpServer(name, enabled)`. An action the adapter does not offer
	 * for that server now is DevHub's bug: the panel draws only the offered.
	 */
	private mcpRequest(request: McpRequest): JsonObject {
		if (request.action === "refresh") return { subtype: "mcp_status" };
		const server = this.current.mcp.servers?.find(
			(each) => each.name === request.server,
		);
		if (server === undefined || !server.actions.includes(request.action)) {
			throw new Error(
				`${request.action} is not offered for the MCP server ${request.server} now`,
			);
		}
		switch (request.action) {
			case "reconnect":
				return { subtype: "mcp_reconnect", serverName: request.server };
			case "enable":
			case "disable":
				return {
					subtype: "mcp_toggle",
					serverName: request.server,
					enabled: request.action === "enable",
				};
		}
	}

	configure(which: SettingName, id: string): AdapterStep {
		return this.step(() => {
			switch (which) {
				case "model":
					this.replies.push(
						this.controlRequest({ subtype: "set_model", model: id }),
					);
					return;
				case "mode":
					this.replies.push(
						this.controlRequest({ subtype: "set_permission_mode", mode: id }),
					);
					return;
				case "effort":
					this.replies.push(userLine(`/effort ${id}`, [], "person"));
					return;
			}
		});
	}

	rewind(message: EntryId): RewindPlan {
		this.refuseIfSpent();
		const { sessionId, agentVersion } = this.current.session;
		if (!this.current.session.canRewind || sessionId === undefined) {
			throw new Error(
				`claude ${agentVersion ?? "(version unknown)"} cannot take back a turn: resuming at a message needs ${RESUMES_AT_A_MESSAGE.join(".")} or later`,
			);
		}
		if (!rewindTargets(this.current).has(message)) {
			throw new Error(
				`${message} is not a message the conversation can be rewound to now`,
			);
		}
		const cut = this.cutBefore.get(message);
		if (cut === undefined) {
			throw new Error(
				`${message} has no place in the session DevHub knows of, so its turn cannot be taken back`,
			);
		}
		return {
			kind: "restart",
			session:
				cut === null ? [] : ["--resume", sessionId, "--resume-session-at", cut],
			mark: [JSON.stringify({ type: "devhub_rewind", message })],
		};
	}

	resumeSession(session: string, history: readonly string[]): RewindPlan {
		this.refuseIfSpent();
		const { state, requests } = this.current;
		if (
			state.phase !== "ready" ||
			state.turn !== "none" ||
			requests.length > 0
		) {
			throw new Error(
				"the Claude conversation is not idle, so it cannot go on with another session now",
			);
		}
		return {
			kind: "restart",
			session: ["--resume", session],
			mark: [JSON.stringify({ type: "devhub_resume", session }), ...history],
		};
	}

	restart(): RewindPlan & { readonly kind: "restart" } {
		this.refuseIfSpent();
		const { sessionId } = this.current.session;
		return {
			kind: "restart",
			session: sessionId === undefined ? [] : ["--resume", sessionId],
			mark: [RESTART_MARK],
		};
	}

	sent(line: string): AdapterStep {
		return this.step(() => {
			const sent = decodeSent(line);
			switch (sent.type) {
				case "user": {
					this.written += 1;
					this.unanswered.push({
						message: {
							id: `sent:${this.written}`,
							text: sent.text,
							images: sent.images,
							origin: sent.origin,
						},
						taken: false,
					});
					this.emitSending();
					// A message written is a turn under way until the CLI ends
					// the turn that answers it.
					const { state } = this.current;
					if (state.phase === "ready" && state.turn === "none")
						this.turn("running");
					const effort = EFFORT_COMMAND.exec(sent.text);
					if (effort !== null) {
						this.setSession({
							effort: { ...this.current.session.effort, current: effort[1] },
						});
					}
					return;
				}
				case "control_request":
					this.ours.set(sent.requestId, sent.request);
					if (sent.subtype === "interrupt") this.interrupting = true;
					// The person's next MCP request: what the last one ended in
					// has been read, and this one's outcome replaces it.
					if (sent.subtype === "mcp_reconnect" || sent.subtype === "mcp_toggle")
						this.mcpFailure = undefined;
					return;
				case "control_response": {
					this.answered.add(sent.requestId);
					const pending = this.pending.get(sent.requestId);
					// Cancelled by the CLI before the answer reached it: already closed.
					if (pending === undefined) return;
					this.pending.delete(sent.requestId);
					if (sent.answer === "deny" && pending.entry !== undefined) {
						this.denied.add(pending.entry);
					}
					this.emit({
						type: "request-closed",
						request: requestId(sent.requestId),
					});
					return;
				}
				case "control_refusal":
					return;
			}
		});
	}

	received(line: string): AdapterStep {
		return this.step(() => {
			this.take(decodeReceived(line, this.current.session.agentVersion));
			this.reportBackground();
		});
	}

	// -------------------------------------------------------------------------

	private refuseIfSpent(): void {
		if (this.spent) {
			throw new Error(
				"this Claude adapter is spent: an earlier line broke it, and it takes nothing further",
			);
		}
	}

	/** Runs one call. A throw leaves the adapter spent, since its bookkeeping may be half-updated. */
	private step(work: () => void): AdapterStep {
		this.refuseIfSpent();
		this.spent = true;
		this.events = [];
		this.replies = [];
		work();
		this.publishMcp();
		this.spent = false;
		return { events: this.events, replies: this.replies };
	}

	/**
	 * The MCP servers as they stand after a step, emitted when that is news:
	 * what the CLI last reported, the person's requests it has not answered
	 * (the MCP control requests of `ours`), and the last it refused.
	 */
	private publishMcp(): void {
		const known = this.mcpServers;
		const mcp: McpState = {
			servers: known?.map((server): McpServer => {
				const status = mcpStatus(server.status);
				return {
					name: server.name,
					status,
					said: server.status,
					error: server.error,
					source: server.scope,
					actions: mcpActions(status),
				};
			}),
			pluginErrors: this.pluginErrors,
			working: [...this.ours.values()].flatMap(mcpWorking),
			failure: this.mcpFailure,
		};
		if (JSON.stringify(mcp) === JSON.stringify(this.current.mcp)) return;
		this.emit({ type: "mcp", mcp });
	}

	private emit(event: ConversationEvent): void {
		this.current = applyEvent(this.current, event);
		this.events.push(event);
	}

	private mismatch(path: string, expected: string): never {
		throw new ProtocolMismatch(
			path,
			expected,
			this.current.session.agentVersion,
		);
	}

	private controlRequest(request: JsonObject): string {
		const id = `${this.bootId}:${this.nextRequest}`;
		this.nextRequest += 1;
		return JSON.stringify({ type: "control_request", request_id: id, request });
	}

	private answerLine(
		request: RequestId,
		answer: Parameters<typeof answerResponse>[1],
	): string {
		const pending = this.pending.get(request);
		if (pending === undefined) {
			throw new Error(
				`request ${request} is not pending, so it cannot be answered`,
			);
		}
		return JSON.stringify({
			type: "control_response",
			response: {
				subtype: "success",
				request_id: request,
				response:
					pending.kind === "permission"
						? answerResponse(pending, answer, request)
						: elicitationResponse(pending.elicitation, answer, request),
			},
		});
	}

	private find(id: EntryId): TranscriptEntry | undefined {
		const { entries } = this.current;
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			if (entries[index]!.id === id) return entries[index];
		}
		return undefined;
	}

	private tool(id: EntryId): ToolEntry | undefined {
		const found = this.find(id);
		return found?.kind === "tool" ? found : undefined;
	}

	/** The entry a message's `parent_tool_use_id` names, which must be a call already made. */
	private parentOf(parent: string | null, type: string): EntryId | null {
		if (parent === null) return null;
		const id = toolEntryId(parent);
		if (this.tool(id) === undefined) {
			return this.mismatch(
				`${type}.parent_tool_use_id`,
				"a tool call that was made",
			);
		}
		return id;
	}

	private setSession(patch: Partial<SessionFacts>): void {
		const next = { ...this.current.session, ...patch };
		if (JSON.stringify(next) === JSON.stringify(this.current.session)) return;
		this.emit({ type: "session", session: next });
	}

	private commands(): readonly SlashCommand[] {
		const described = new Set(this.described.map((command) => command.name));
		const announced = this.announced
			.filter((name) => !described.has(name))
			.map((name) => ({ name, description: "", argumentHint: undefined }));
		const listed = [...this.described, ...announced];
		return [
			...listed,
			...DEVHUB_COMMANDS.filter(
				(own) => !listed.some((command) => command.name === own.name),
			),
		]
			.filter((command) => !TUI_ONLY.has(command.name))
			.map((command) => ({
				...command,
				trigger: "/" as const,
				route: Object.hasOwn(PICKED, command.name)
					? PICKED[command.name]!
					: "message",
			}));
	}

	/**
	 * The model a session reports, as one of the choices the handshake listed,
	 * and the effort that model takes. Every way a session names its model —
	 * `system/init` on a fresh start, a resume, a rewind; a `set_model` the CLI
	 * agreed to — comes here, so they all read the same.
	 *
	 * A session names its model in full (`claude-haiku-4-5-…`) and the choices
	 * are aliases (`haiku`), so the choice is found by what it resolves to
	 * (`listedAs`). A resumed session keeps the model its transcript was saved
	 * with, whatever the current setting (model-config, "Model on resume"), so
	 * it can report a model the list does not resolve to — typically the 1M
	 * context variant (`claude-opus-5-5[1m]`) of a model the list offers only
	 * as `opus`. That name is itself a value `/model` takes (a full model name,
	 * with or without the documented `[1m]` suffix), so it is a choice of its
	 * own, under its own name. Its effort levels are the model's: the `[1m]`
	 * suffix picks the context window, not the model, and the CLI lists
	 * effort levels per model, so they are those of the choice the name
	 * without the suffix resolves to. A model the list names in neither form
	 * has no effort levels DevHub could offer, and the effort says so.
	 *
	 * The effort is the one the session last said it runs at (`system/init`'s
	 * `effort`, on a CLI that publishes it) or was set to here with `/effort`.
	 * Claude says nothing else about it: an effort nothing named is whatever
	 * the CLI resolves from `--effort`, `CLAUDE_CODE_EFFORT_LEVEL`, the saved
	 * settings and the model's own default, and it stays unnamed.
	 */
	private modelSettings(
		reported: string | undefined,
		effort: string | undefined = this.current.session.effort.current,
	): Pick<SessionFacts, "model" | "effort"> {
		const models = this.models ?? [];
		const listed =
			reported === undefined ? undefined : listedAs(models, reported);
		// Until the handshake has listed the models, nothing is known to be missing.
		const own =
			reported !== undefined &&
			this.models !== undefined &&
			listed === undefined
				? reported
				: undefined;
		const model =
			listed ??
			(own?.endsWith(LONG_CONTEXT)
				? listedAs(models, own.slice(0, -LONG_CONTEXT.length))
				: undefined);
		const efforts = model?.efforts ?? [];
		return {
			model: {
				current: listed?.id ?? reported,
				choices: [
					...(own === undefined ? [] : [modelChoice(own, own, undefined)]),
					...models.map((each) =>
						modelChoice(each.id, each.resolved, each.label),
					),
				],
			},
			effort: {
				current:
					effort !== undefined && efforts.includes(effort) ? effort : undefined,
				choices: efforts.map((level) => ({ id: level, label: level })),
				...(own !== undefined && model === undefined
					? {
							unchangeable: `claude's model list does not name ${own}, so its effort levels are not known here`,
						}
					: {}),
			},
		};
	}

	/** The CLI is up: a conversation that was connecting, or waiting for a CLI started again, is ready. */
	private becomeReady(): void {
		const { state } = this.current;
		if (
			state.phase === "connecting" ||
			(state.phase === "ready" && state.turn === "rewinding")
		)
			this.turn(this.unanswered.length > 0 ? "running" : "none");
	}

	/**
	 * The host started the CLI again without the turns from `message` on.
	 * What DevHub kept about the CLI that is gone goes with it, and the new
	 * one is greeted as the first was: a reply, so a replay does not greet it
	 * twice.
	 */
	private takeRewind(message: EntryId): void {
		this.endBackground();
		this.emit({ type: "rewound", from: message });
		const cut = this.cutBefore.get(message);
		this.lastUuid = cut ?? undefined;
		const kept = new Set(this.current.entries.map((each) => each.id));
		for (const id of [...this.cutBefore.keys()]) {
			if (!kept.has(id)) this.cutBefore.delete(id);
		}
		this.ours.clear();
		this.unanswered.length = 0;
		this.emitSending();
		this.answered.clear();
		this.streaming.clear();
		this.interrupting = false;
		this.processEnded(this.current.entries);
		this.turn("rewinding");
		this.replies.push(this.controlRequest({ subtype: "initialize" }));
	}

	/**
	 * The host started the CLI again on another session. Everything DevHub
	 * kept about the one it left goes; that session's past follows as history
	 * lines, and the new CLI is greeted as a rewound one is.
	 */
	private takeResume(session: string): void {
		this.endBackground();
		this.emit({ type: "session-switched", session });
		this.lastUuid = undefined;
		this.cutBefore.clear();
		this.ours.clear();
		this.unanswered.length = 0;
		this.emitSending();
		this.pending.clear();
		this.denied.clear();
		this.answered.clear();
		this.messages.clear();
		this.streaming.clear();
		this.tasks.clear();
		this.teammates.clear();
		this.callTimes.clear();
		this.interrupting = false;
		this.turn("rewinding");
		this.replies.push(this.controlRequest({ subtype: "initialize" }));
	}

	/**
	 * The host stopped the CLI and started it again on the same session: the
	 * conversation stays, and nothing the CLI that was stopped had going goes
	 * on (`restarted`). What DevHub kept about that CLI goes with it, and the
	 * new one is greeted as a rewound one is.
	 */
	private takeRestart(): void {
		this.background = [];
		this.emit({ type: "restarted" });
		this.notice("info", RESTARTED, undefined);
		this.ours.clear();
		this.unanswered.length = 0;
		this.pending.clear();
		this.answered.clear();
		this.streaming.clear();
		this.interrupting = false;
		// Not `turn`, which never moves a broken conversation: a new CLI is
		// the one thing that ends what the stopped one said (signed out, a
		// refused handshake), and it is greeted afresh.
		this.emit({ type: "state", state: { phase: "ready", turn: "rewinding" } });
		this.replies.push(this.controlRequest({ subtype: "initialize" }));
	}

	/** Where a resume would now cut the session: after this top-level message. */
	private placed(uuid: string | undefined, parent: EntryId | null): void {
		if (parent === null && uuid !== undefined) this.lastUuid = uuid;
	}

	/**
	 * Whether a turn is running. The one way the state moves, and it never
	 * moves a broken conversation: what broke it stays the last word, whatever
	 * the CLI goes on to print about the turn it was in.
	 */
	private running(): boolean {
		const { state } = this.current;
		return state.phase === "ready" && state.turn === "running";
	}

	private turn(turn: "none" | "running" | "rewinding"): void {
		const { state } = this.current;
		if (state.phase === "broken") return;
		if (state.phase === "ready" && state.turn === turn) return;
		if (turn === "running") {
			// A turn starts: what a limit said of the last one is over.
			this.limitAnswered = false;
			this.rejected = undefined;
			this.unresetLimit = undefined;
		}
		this.emit({ type: "state", state: { phase: "ready", turn } });
	}

	/**
	 * What works in the background, as the transcript has it, after each line:
	 * each task the CLI lists, with the call that started it once a task event
	 * or the call's result has named it, and each teammate at work that the
	 * list does not already name. A subagent that sits idle waiting to be told
	 * something is not working, whatever the list says. Re-read after every
	 * line, because the list, the call a task belongs to and a subagent's state
	 * each arrive on lines of their own, in no fixed order.
	 */
	private reportBackground(): void {
		const tasks: RunningTask[] = [];
		for (const task of this.background) {
			const call = this.tasks.get(task.taskId);
			const tool = call === undefined ? undefined : this.tool(call);
			if (tool?.spawns?.state === "idle") continue;
			tasks.push({
				id: task.taskId,
				kind: TASK_KINDS[task.taskType] ?? task.taskType,
				title: task.description,
				call: tool?.id,
				startedAt: tool === undefined ? undefined : this.callTimes.get(tool.id),
				// The SDK's `stop_task` stops any task the CLI lists.
				stoppable: true,
			});
		}
		for (const [name, call] of this.teammates) {
			const tool = this.tool(call);
			if (tool?.spawns?.state !== "running") continue;
			if (tasks.some((task) => task.call === call)) continue;
			tasks.push({
				id: `teammate:${name}`,
				kind: "teammate",
				title: tool.spawns.label,
				call,
				startedAt: this.callTimes.get(call),
				// Only the tasks the CLI lists are documented to take `stop_task`.
				stoppable: { reason: TEAMMATE_UNSTOPPABLE },
			});
		}
		if (sameRunningTasks(tasks, this.current.backgroundTasks)) return;
		this.emit({ type: "background-tasks", tasks });
	}

	/**
	 * The CLI that ran them is being replaced (a rewind, a resume): nothing it
	 * had working in the background is, before what it started is taken back.
	 */
	private endBackground(): void {
		this.background = [];
		if (this.current.backgroundTasks.length > 0)
			this.emit({ type: "background-tasks", tasks: [] });
	}

	/** The messages written and not yet taken, as the transcript shows them sending. */
	private emitSending(): void {
		this.emit({
			type: "sending",
			sending: this.unanswered.flatMap((each) =>
				each.taken ? [] : [each.message],
			),
		});
	}

	/** Whether the CLI is compacting the conversation now: a turn is under way while it does. */
	private setCompacting(compacting: boolean): void {
		if (compacting) {
			this.turn("running");
			if (!this.running()) return;
		}
		if (this.current.compacting !== compacting)
			this.emit({ type: "compacting", compacting });
	}

	/**
	 * The messages a turn's end answers, out of those waiting for one. The
	 * CLI reads its input in order, so it has answered every message up to
	 * the last one this turn took in (echoed); when the turn took none, it
	 * answered the oldest. A message it answered without echoing it — a
	 * command it ran by itself (`/compact`, `/clear`, `/cost`), or anything
	 * else it printed nothing of — is answered all the same, and drawn where
	 * it was sending: as the command line, or as the person's words. With
	 * nothing waiting, the turn was one the CLI started by itself.
	 */
	private answer(line: Extract<ClaudeLine, { type: "result" }>): void {
		let last = -1;
		this.unanswered.forEach((each, index) => {
			if (each.taken) last = index;
		});
		const answered = this.unanswered.splice(0, last >= 0 ? last + 1 : 1);
		for (const { message, taken } of answered) {
			if (taken) continue;
			this.emit({
				type: "entry",
				entry:
					invocation(message.text) !== undefined
						? {
								kind: "command",
								id: entryId(`command:${message.id}`),
								parent: null,
								line: message.text.trim(),
								// What the CLI said, when it answered without the model.
								output:
									line.modelTurns === 0 && line.result !== ""
										? line.result
										: undefined,
								failed: line.isError,
							}
						: {
								kind: "user",
								id: entryId(`user:${message.id}`),
								parent: null,
								text: message.text,
								images: message.images,
								origin: message.origin,
								rewindable: false,
							},
			});
		}
		if (answered.some((each) => !each.taken)) this.emitSending();
	}

	private notice(
		level: "info" | "warning" | "error",
		text: string,
		raw: JsonValue | undefined,
		parent: EntryId | null = null,
	): void {
		this.notices += 1;
		this.emit({
			type: "entry",
			entry: {
				kind: "notice",
				id: entryId(`notice:${this.notices}`),
				parent,
				level,
				text,
				raw,
			},
		});
	}

	/**
	 * An event DevHub does not know, said once per kind of event, so a new
	 * event the CLI prints often is one line in the transcript, not a flood.
	 * What may have carried part of the conversation is a warning; a system
	 * event, the CLI's word beside the conversation, is information.
	 */
	private unknown(key: string, raw: JsonObject): void {
		this.once(
			key,
			"warning",
			`claude ${this.versionName()} printed a "${key}" event DevHub does not know`,
			raw,
		);
	}

	private reported(subtype: string, raw: JsonObject): void {
		this.once(
			`system/${subtype}`,
			"info",
			`claude ${this.versionName()} reported "${subtype}"`,
			raw,
		);
	}

	private once(
		key: string,
		level: "info" | "warning",
		text: string,
		raw: JsonObject,
	): void {
		if (this.unknownSeen.has(key)) return;
		this.unknownSeen.add(key);
		this.notice(level, text, raw);
	}

	private versionName(): string {
		return this.current.session.agentVersion ?? "(version not yet known)";
	}

	private take(line: ClaudeLine): void {
		switch (line.type) {
			case "control_response":
				return this.takeControlResponse(line);
			case "can_use_tool":
				return this.takePermission(line);
			case "elicitation":
				this.pending.set(line.requestId, {
					kind: "elicitation",
					elicitation: line.elicitation,
					entry: undefined,
				});
				return this.emit({
					type: "request-opened",
					request: {
						id: requestId(line.requestId),
						entry: undefined,
						subject: elicitationSubject(line.elicitation),
						choices: elicitationChoices(line.elicitation),
					},
				});
			case "control_request_unserved":
				this.replies.push(
					JSON.stringify({
						type: "control_response",
						response: {
							subtype: "error",
							request_id: line.requestId,
							error: `DevHub does not serve the control request "${line.subtype}"`,
						},
					}),
				);
				return this.notice(
					"warning",
					`claude asked DevHub for "${line.subtype}", which DevHub does not serve; DevHub refused it`,
					line.raw,
				);
			case "control_cancel_request":
				if (!this.pending.delete(line.requestId)) return;
				return this.emit({
					type: "request-closed",
					request: requestId(line.requestId),
				});
			case "init":
				this.announced = line.slashCommands;
				this.setSession({
					agentVersion: line.version,
					canRewind: resumesAtAMessage(line.version),
					sessionId: line.sessionId,
					cwd: line.cwd,
					...this.modelSettings(
						line.model,
						line.effort ?? this.current.session.effort.current,
					),
					mode: {
						current: line.permissionMode ?? this.current.session.mode.current,
						choices: MODES,
					},
					commands: this.commands(),
				});
				if (line.mcpServers !== undefined) {
					// `system/init` does not say where a server is configured;
					// what `mcp_status` said of it stands.
					const before = new Map(
						(this.mcpServers ?? []).map((server) => [server.name, server]),
					);
					this.mcpServers = line.mcpServers.map((server) => ({
						...server,
						scope: server.scope ?? before.get(server.name)?.scope,
					}));
				}
				this.pluginErrors = line.pluginErrors;
				return this.becomeReady();
			case "stream":
				return this.takeStream(
					this.parentOf(line.parent, "stream_event"),
					line.event,
				);
			case "assistant":
				return this.takeAssistant(line, "live");
			case "user":
				return this.takeUser(line, "live");
			case "rewind":
				return this.takeRewind(entryId(line.message));
			case "resume":
				return this.takeResume(line.session);
			case "restart":
				return this.takeRestart();
			// The resumed session's past: the same messages, drawn the same way,
			// except that they are not a turn running now.
			case "history":
				return line.message.type === "assistant"
					? this.takeAssistant(line.message, "history")
					: this.takeUser(line.message, "history");
			case "result":
				return this.takeResult(line);
			case "api_retry":
				return this.notice("warning", retrySentence(line), line.raw);
			case "compact_boundary":
				this.setCompacting(false);
				this.compactions += 1;
				return this.emit({
					type: "entry",
					entry: {
						kind: "compaction",
						id: entryId(`compaction:${this.compactions}`),
						parent: null,
						trigger: line.trigger,
						preTokens: line.preTokens,
						postTokens: line.postTokens,
					},
				});
			case "status":
				if (line.permissionMode !== undefined) {
					this.setSession({
						mode: { current: line.permissionMode, choices: MODES },
					});
				}
				if (line.compacting !== undefined) this.setCompacting(line.compacting);
				if (line.compactFailure !== undefined) {
					this.notice(
						"error",
						`Compacting the conversation failed: ${line.compactFailure}`,
						undefined,
					);
				}
				return;
			case "permission_denied":
				return this.takeDenial(line);
			case "said":
				return this.notice(line.level, line.text, undefined);
			case "local_command":
				return this.takeUser(
					{
						type: "user",
						parent: null,
						uuid: undefined,
						content: line.blocks,
						toolResult: NO_TOOL_RESULT,
					},
					"history",
				);
			case "task":
				return this.takeTask(line);
			case "background_tasks":
				this.background = line.tasks;
				return;
			case "rate_limit":
				return this.takeRateLimit(line);
			case "unused":
				return;
			case "reported":
				return this.reported(line.subtype, line.raw);
			case "unknown":
				return this.unknown(line.key, line.raw);
		}
	}

	private takeControlResponse(
		line: Extract<ClaudeLine, { type: "control_response" }>,
	): void {
		const request = this.ours.get(line.requestId);
		// DevHub's own answer to one of the CLI's requests, printed back.
		if (request === undefined && this.answered.has(line.requestId)) return;
		if (request === undefined) {
			return this.mismatch(
				"control_response.response.request_id",
				"a request DevHub made",
			);
		}
		this.ours.delete(line.requestId);
		const subtype = request.subtype as string;
		if (!line.outcome.ok && Object.hasOwn(MCP_ACTION_NAMES, subtype)) {
			// Said in the panel, where the request was made.
			const server =
				typeof request.serverName === "string" ? ` ${request.serverName}` : "";
			this.mcpFailure = `${MCP_ACTION_NAMES[subtype]!}${server} failed: ${line.outcome.error}`;
			return;
		}
		if (!line.outcome.ok) {
			// Without the handshake there is no conversation to have; any other
			// refusal is one request that did not happen, said where it happened.
			if (subtype === "initialize") {
				return this.emit({
					type: "state",
					state: {
						phase: "broken",
						failure: {
							code: "refused",
							detail: `claude refused the handshake: ${line.outcome.error}`,
						},
					},
				});
			}
			return this.notice(
				"error",
				`${subtype} was refused: ${line.outcome.error}`,
				undefined,
			);
		}
		switch (subtype) {
			case "initialize": {
				const facts = decodeInitialize(
					line.outcome.payload,
					this.current.session.agentVersion,
				);
				this.described = facts.commands;
				this.models = facts.models;
				this.setSession({
					...this.modelSettings(this.current.session.model.current),
					mode: {
						current: this.current.session.mode.current ?? facts.currentMode,
						choices: MODES,
					},
					commands: this.commands(),
				});
				this.askMcpStatus();
				return this.becomeReady();
			}
			case "mcp_status":
				this.mcpServers = decodeMcpStatus(
					line.outcome.payload,
					this.current.session.agentVersion,
				);
				return;
			case "mcp_reconnect":
			case "mcp_toggle":
				// Done: how the servers stand now is asked again.
				return this.askMcpStatus();
			case "set_model":
				return this.setSession(this.modelSettings(request.model as string));
			case "set_permission_mode":
				return this.setSession({
					mode: { current: request.mode as string, choices: MODES },
				});
			default:
				return;
		}
	}

	private takePermission(
		line: Extract<ClaudeLine, { type: "can_use_tool" }>,
	): void {
		const about =
			line.toolUseId === undefined ? undefined : toolEntryId(line.toolUseId);
		const entry =
			about !== undefined && this.tool(about) !== undefined ? about : undefined;
		const asksQuestions = line.questions !== undefined;
		const choices = asksQuestions
			? [DECLINE]
			: [
					ALLOW_ONCE,
					...line.suggestions.map(
						(suggestion, index): RequestChoice => ({
							id: `suggestion:${index}`,
							label: suggestionLabel(suggestion),
							tone: "allow",
							takesText: false,
						}),
					),
					DENY,
				];
		this.pending.set(line.requestId, {
			kind: "permission",
			input: line.input,
			suggestions: line.suggestions,
			choices,
			asksQuestions,
			entry,
		});
		this.emit({
			type: "request-opened",
			request: {
				id: requestId(line.requestId),
				entry,
				subject:
					line.questions !== undefined
						? { kind: "question", questions: line.questions }
						: {
								kind: "tool",
								tool: line.toolName,
								title: toolTitle(line.toolName, line.input),
								input: line.input,
								reason: line.reason,
							},
				choices,
			},
		});
	}

	private takeStream(parent: EntryId | null, event: StreamEvent): void {
		switch (event.kind) {
			case "message_start": {
				const message: MessageState = {
					id: event.messageId,
					parent,
					slots: new Map(),
					finals: 0,
				};
				this.messages.set(event.messageId, message);
				this.streaming.set(parent, message);
				// The model is answering at the top level, so a turn is under
				// way — one the CLI can start by itself, with no message of
				// DevHub's to echo, when a background subagent finishes.
				if (parent === null) this.turn("running");
				return;
			}
			case "block_start":
				return this.openBlock(
					this.streamingUnder(parent, "content_block_start"),
					event.index,
					event.block,
					false,
				);
			case "delta": {
				const message = this.streamingUnder(parent, "content_block_delta");
				const slot = message.slots.get(event.index);
				if (slot === undefined) {
					return this.mismatch(
						"stream_event.event(content_block_delta).index",
						"a block that started",
					);
				}
				const { delta } = event;
				switch (delta.kind) {
					case "text":
					case "thinking":
						if (slot.kind === "unsaid" && delta.kind === "thinking") {
							if (delta.text === "") return;
							return this.openBlock(
								message,
								event.index,
								{ kind: "thinking", text: delta.text },
								false,
							);
						}
						if (slot.kind !== delta.kind) {
							return this.mismatch(
								"stream_event.event(content_block_delta).delta.type",
								`a delta for the ${slot.kind} block that started`,
							);
						}
						return this.emit({
							type: "text-delta",
							entry: slot.entry,
							block: slot.block,
							text: delta.text,
						});
					case "unused":
						return;
					case "unknown":
						return this.unknown(delta.key, delta.raw);
				}
				return;
			}
			case "message_stop":
				this.streaming.delete(parent);
				return;
			case "unused":
				return;
			case "unknown":
				return this.unknown(event.key, event.raw);
		}
	}

	private streamingUnder(parent: EntryId | null, event: string): MessageState {
		const message = this.streaming.get(parent);
		if (message === undefined) {
			return this.mismatch(
				`stream_event.event(${event})`,
				"a message_start before it",
			);
		}
		return message;
	}

	private takeAssistant(
		line: Extract<ClaudeLine, { type: "assistant" }>,
		when: "live" | "history",
	): void {
		const parent = this.parentOf(line.parent, "assistant");
		this.placed(line.uuid, parent);
		if (parent === null && when === "live") this.turn("running");
		if (parent === null && line.contextTokens !== undefined) {
			// The conversation's size is its latest top-level message's: a
			// subagent's messages are its own context, not this one's.
			this.mainModel = line.model;
			this.emit({
				type: "usage",
				usage: {
					...(this.current.usage ?? NO_USAGE),
					contextTokens: line.contextTokens,
				},
			});
		}
		let message = this.messages.get(line.messageId);
		if (message === undefined) {
			message = { id: line.messageId, parent, slots: new Map(), finals: 0 };
			this.messages.set(line.messageId, message);
		}
		if (line.timestamp !== undefined) {
			for (const block of line.content) {
				if (block.kind === "tool_use")
					this.callTimes.set(toolEntryId(block.id), line.timestamp);
			}
		}
		line.content.forEach((block, position) => {
			const index = message.finals;
			message.finals += 1;
			const slot = message.slots.get(index);
			if (slot === undefined)
				return this.openBlock(message, index, block, true);
			this.finalize(
				message,
				index,
				slot,
				block,
				`assistant.message.content[${position}]`,
			);
		});
		// The CLI that made the calls of a message read back from a session
		// file has ended: none of its subagents runs now.
		if (when === "history") {
			this.processEnded(
				[...message.slots.values()].flatMap((slot) =>
					slot.kind === "tool" ? [this.tool(slot.entry)!] : [],
				),
			);
		}
		if (line.error === SIGNED_OUT) {
			// The one API error no turn can get past: the CLI has no sign-in to
			// use. What it said stays in the transcript above, and is the reason
			// the failure gives; the fix is the CLI's documented sign-in, after
			// which Restart Session starts it again on the same session.
			const said = line.content
				.flatMap((block) => (block.kind === "text" ? [block.text.trim()] : []))
				.filter((text) => text.length > 0)
				.join(" ");
			this.emit({
				type: "state",
				state: {
					phase: "broken",
					failure: {
						code: "not_signed_in",
						detail: `${said.length > 0 ? `claude said: “${said}”. ` : ""}${CLAUDE_SIGN_IN}`,
					},
				},
			});
		} else if (line.error !== undefined) {
			if (line.error === RATE_LIMITED && parent === null && when === "live")
				this.limitAnswered = true;
			this.notice(
				"error",
				`The API refused the request: ${line.error}`,
				undefined,
			);
		}
	}

	/** A block first heard of: from its stream start, or whole from a complete message. */
	private openBlock(
		message: MessageState,
		index: number,
		block: ContentBlock,
		final: boolean,
	): void {
		if (block.kind === "thinking" && block.text === "") {
			message.slots.set(
				index,
				final ? { kind: "ignored" } : { kind: "unsaid" },
			);
			return;
		}
		switch (block.kind) {
			case "text":
			case "thinking": {
				const content: AssistantBlock =
					block.kind === "text"
						? { kind: "text", markdown: block.text }
						: { kind: "thinking", text: block.text };
				const previous = message.slots.get(index - 1);
				if (
					previous !== undefined &&
					(previous.kind === "text" || previous.kind === "thinking")
				) {
					const segment = this.find(previous.entry) as AssistantEntry;
					const slot = {
						kind: block.kind,
						entry: previous.entry,
						block: segment.blocks.length,
						final,
					};
					message.slots.set(index, slot);
					return this.emit({
						type: "entry",
						entry: {
							...segment,
							blocks: [...segment.blocks, content],
							streaming: this.segmentStreaming(message, previous.entry),
						},
					});
				}
				const id = entryId(`assistant:${message.id}:${index}`);
				message.slots.set(index, {
					kind: block.kind,
					entry: id,
					block: 0,
					final,
				});
				return this.emit({
					type: "entry",
					entry: {
						kind: "assistant",
						id,
						parent: message.parent,
						blocks: [content],
						streaming: !final,
					},
				});
			}
			case "tool_use": {
				const id = toolEntryId(block.id);
				message.slots.set(index, { kind: "tool", entry: id, id: block.id });
				return this.emit({
					type: "entry",
					entry: {
						kind: "tool",
						id,
						parent: message.parent,
						tool: block.name,
						title: toolTitle(block.name, block.input),
						input: block.input,
						status: "running",
						output: undefined,
						spawns: spawnsOf(block.name, block.input, undefined),
						background: undefined,
						outsideSandbox: block.input.dangerouslyDisableSandbox === true,
						plan: planOf(block.name, block.input),
						denial: undefined,
						change: changeOf(block.name, block.input, undefined),
						// Known once answered: the result says what was asked and chosen.
						asked: undefined,
					},
				});
			}
			case "unused":
				message.slots.set(index, { kind: "ignored" });
				return;
			case "unknown":
				message.slots.set(index, { kind: "ignored" });
				return this.unknown(block.key, block.raw);
		}
	}

	/** A streamed block, made final by its complete message. */
	private finalize(
		message: MessageState,
		index: number,
		slot: Slot,
		block: ContentBlock,
		path: string,
	): void {
		switch (slot.kind) {
			case "unsaid": {
				if (block.kind !== "thinking") {
					return this.mismatch(
						`${path}.type`,
						"the thinking block that streamed",
					);
				}
				return this.openBlock(message, index, block, true);
			}
			case "text":
			case "thinking": {
				if (block.kind !== slot.kind)
					return this.mismatch(
						`${path}.type`,
						`the ${slot.kind} block that streamed`,
					);
				slot.final = true;
				const segment = this.find(slot.entry) as AssistantEntry;
				const blocks = [...segment.blocks];
				blocks[slot.block] =
					block.kind === "text"
						? { kind: "text", markdown: block.text }
						: { kind: "thinking", text: block.text };
				return this.emit({
					type: "entry",
					entry: {
						...segment,
						blocks,
						streaming: this.segmentStreaming(message, slot.entry),
					},
				});
			}
			case "tool": {
				if (block.kind !== "tool_use" || block.id !== slot.id) {
					return this.mismatch(
						`${path}`,
						`the tool_use ${slot.id} that streamed`,
					);
				}
				const tool = this.tool(slot.entry)!;
				return this.emit({
					type: "entry",
					entry: {
						...tool,
						title: toolTitle(block.name, block.input),
						input: block.input,
						spawns: spawnsOf(block.name, block.input, tool.spawns),
						outsideSandbox: block.input.dangerouslyDisableSandbox === true,
						plan: planOf(block.name, block.input),
					},
				});
			}
			case "ignored":
				return;
		}
	}

	private segmentStreaming(message: MessageState, segment: EntryId): boolean {
		for (const slot of message.slots.values()) {
			if (
				(slot.kind === "text" || slot.kind === "thinking") &&
				slot.entry === segment &&
				!slot.final
			)
				return true;
		}
		return false;
	}

	private takeUser(
		line: Extract<ClaudeLine, { type: "user" }>,
		when: "live" | "history",
	): void {
		const parent = this.parentOf(line.parent, "user");
		const before = this.lastUuid;
		// A message that only tells of tasks ending is the CLI's, not a
		// message of the conversation's own: no place for a resume to cut.
		if (line.content.some((block) => block.kind !== "task_notification"))
			this.placed(line.uuid, parent);
		const texts: string[] = [];
		const images: ImageRef[] = [];
		line.content.forEach((block, position) => {
			switch (block.kind) {
				case "text":
					texts.push(block.text);
					return;
				case "image":
					images.push(block.image);
					return;
				case "command":
					return this.takeCommand(line.uuid, block.line, when, parent);
				case "command_output":
					return this.takeCommandOutput(line.uuid, block, parent);
				case "teammate_message":
					return this.takeTeammateMessage(block);
				case "task_notification":
					return this.takeTask({
						type: "task",
						subtype: "task_notification",
						taskId: block.taskId,
						toolUseId: block.toolUseId,
						status: block.status,
						text: block.summary,
						raw: block.raw,
					});
				case "tool_result":
					return this.takeToolResult(
						block,
						line.toolResult,
						`user.message.content[${position}]`,
						when,
					);
				case "unused":
					return;
				case "unknown":
					return this.unknown(block.key, block.raw);
			}
		});
		// A subagent's first user message is the prompt it was given, which the
		// Task call that started it already carries (`spawns.prompt`).
		if ((texts.length === 0 && images.length === 0) || parent !== null) return;
		const text = texts.join("\n");
		// Live, a message is whoever DevHub wrote it for, and one DevHub did not
		// write is not from the person: only DevHub writes to the CLI. A message
		// of the past is the person's: nothing DevHub wrote this time is waiting
		// to be matched with it, and the session file does not say who.
		let origin: UserOrigin = "person";
		if (when === "live") {
			const taken = this.unanswered.find(
				(each) => !each.taken && each.message.text === text,
			);
			if (taken === undefined) origin = "other";
			else {
				taken.taken = true;
				origin = taken.message.origin;
			}
		}
		this.users += 1;
		const id = entryId(`user:${line.uuid ?? `#${this.users}`}`);
		if (line.uuid !== undefined) this.cutBefore.set(id, before ?? null);
		this.emit({
			type: "entry",
			entry: {
				kind: "user",
				id,
				parent: null,
				text,
				images,
				origin,
				rewindable: line.uuid !== undefined,
			},
		});
		// The message is in the conversation now, no longer sending: in the
		// same step, so it is never drawn twice or not at all. One DevHub did
		// not send was never sending, and the model's answer to it starts
		// whatever turn it starts.
		if (when === "live" && origin !== "other") {
			this.emitSending();
			this.turn("running");
		}
	}

	/**
	 * A command the CLI ran itself. One DevHub sent (a slash command typed in
	 * the composer, or a template's) comes back in this form — echoed, or
	 * answered by the CLI on its own — and is taken as sent then: the oldest
	 * message sending that invokes a command, since the CLI reads its input
	 * in order. Neither the text nor the name has to match: the CLI reads the
	 * command's arguments its own way (spaces and newlines around them are
	 * gone), and names the command it ran, not the alias sent (`/cost` runs
	 * `usage`).
	 */
	private takeCommand(
		uuid: string | undefined,
		line: string,
		when: "live" | "history",
		parent: EntryId | null,
	): void {
		if (parent !== null) return;
		if (when === "live") {
			const taken = this.unanswered.find(
				(each) => !each.taken && invocation(each.message.text) !== undefined,
			);
			if (taken !== undefined) {
				taken.taken = true;
				this.emitSending();
				this.turn("running");
			}
		}
		this.commandCount += 1;
		this.emit({
			type: "entry",
			entry: {
				kind: "command",
				id: entryId(`command:${uuid ?? `#${this.commandCount}`}`),
				parent: null,
				line,
				output: undefined,
				failed: false,
			},
		});
	}

	/** What a command printed: on the command it follows, or alone when none said what ran. */
	private takeCommandOutput(
		uuid: string | undefined,
		block: Extract<UserBlock, { kind: "command_output" }>,
		parent: EntryId | null,
	): void {
		if (parent !== null) return;
		const last = this.current.entries.at(-1);
		if (last?.kind === "command" && last.output === undefined) {
			return this.emit({
				type: "entry",
				entry: { ...last, output: block.output, failed: block.failed },
			});
		}
		this.commandCount += 1;
		this.emit({
			type: "entry",
			entry: {
				kind: "command",
				id: entryId(`command:${uuid ?? `#${this.commandCount}`}`),
				parent: null,
				line: undefined,
				output: block.output,
				failed: block.failed,
			},
		});
	}

	/**
	 * A teammate's message. The team protocol's messages say how it stands —
	 * idle between tasks, failed, or shut down — and are not drawn; its words
	 * are a quiet line from it, never the person's.
	 */
	private takeTeammateMessage(
		block: Extract<UserBlock, { kind: "teammate_message" }>,
	): void {
		if (block.signal === undefined) {
			return this.notice(
				"info",
				`From ${block.from}: ${block.text}`,
				undefined,
			);
		}
		const call = this.teammates.get(block.from);
		const tool = call === undefined ? undefined : this.tool(call);
		if (tool?.spawns === undefined) return;
		const state: SubagentInfo["state"] | undefined =
			block.signal.type === "idle_notification"
				? block.signal.failure === undefined
					? "idle"
					: "failed"
				: block.signal.type === "shutdown_approved" ||
					  block.signal.type === "teammate_terminated"
					? "completed"
					: undefined;
		if (state === undefined || state === tool.spawns.state) return;
		this.emit({
			type: "entry",
			entry: { ...tool, spawns: { ...tool.spawns, state } },
		});
	}

	/**
	 * A tool call's result. A subagent call's result is also the subagent's
	 * end — unless the call only started it in the background
	 * (`launchedTask`), whose end a task notification tells later.
	 */
	private takeToolResult(
		block: Extract<UserBlock, { kind: "tool_result" }>,
		result: ToolUseResult,
		path: string,
		when: "live" | "history",
	): void {
		const id = toolEntryId(block.toolUseId);
		const tool = this.tool(id);
		if (tool === undefined)
			return this.mismatch(`${path}.tool_use_id`, "a tool call that was made");
		for (const part of block.parts) {
			if (part.kind === "unknown") this.unknown(part.key, part.raw);
		}
		const { launchedTask } = result;
		const status = this.denied.has(id)
			? "denied"
			: block.isError && this.interrupting
				? "interrupted"
				: block.isError
					? "failed"
					: "succeeded";
		if (tool.spawns !== undefined && launchedTask !== undefined)
			this.bindTask(launchedTask, id);
		if (result.backgroundTask !== undefined)
			this.bindTask(result.backgroundTask, id);
		if (tool.spawns !== undefined && result.teammate !== undefined)
			this.teammates.set(result.teammate, id);
		// A call that only started its subagent — in the background, or as
		// a teammate — does not end it.
		const started = launchedTask !== undefined || result.teammate !== undefined;
		const asksQuestions =
			tool.tool === ASK_USER_QUESTION && status === "succeeded";
		if (asksQuestions && result.answered === undefined)
			return this.mismatch(
				"user.tool_use_result.answers",
				"the answers to the questions an AskUserQuestion call asked",
			);
		const asked =
			asksQuestions && result.answered !== undefined
				? askedOf(result.answered)
				: undefined;
		this.emit({
			type: "entry",
			entry: {
				...tool,
				status,
				output: toolOutput(tool, block, result),
				asked: asked ?? tool.asked,
				change:
					result.patch === undefined
						? tool.change
						: changeOf(tool.tool, tool.input as JsonObject, result.patch),
				// A command that went on in the background — asked to, or moved
				// there when it outran its timeout — runs on from here, until
				// news of its task says how it ended. One read back from a
				// session file ran in a CLI that has ended.
				background:
					result.backgroundTask === undefined || tool.background !== undefined
						? tool.background
						: {
								state: when === "live" ? "running" : "unknown",
								summary: undefined,
							},
				spawns:
					tool.spawns === undefined || started
						? tool.spawns
						: {
								...tool.spawns,
								state: status === "succeeded" ? "completed" : "failed",
							},
			},
		});
		// The person's answer is their message, as well as the call's record.
		if (asked !== undefined) {
			this.emit({
				type: "entry",
				entry: {
					kind: "answer",
					id: entryId(`answer:${block.toolUseId}`),
					parent: tool.parent,
					answers: asked.map((each) => each.answer),
				},
			});
		}
	}

	/**
	 * The CLI process that ran these calls has ended (it was replaced, or the
	 * calls are read back from a session file): a subagent or background task
	 * it was running cannot run now, and how it ended nobody recorded — unless a
	 * notification or its call's result says so later.
	 */
	private processEnded(entries: readonly TranscriptEntry[]): void {
		for (const each of entries) {
			if (each.kind !== "tool") continue;
			if (each.spawns?.state === "running" || each.spawns?.state === "idle") {
				this.emit({
					type: "entry",
					entry: { ...each, spawns: { ...each.spawns, state: "unknown" } },
				});
			} else if (each.background?.state === "running") {
				this.emit({
					type: "entry",
					entry: {
						...each,
						background: { state: "unknown", summary: undefined },
					},
				});
			}
		}
	}

	/**
	 * A `rate_limit_event`: the windows it reports are the conversation's
	 * usage, and one whose status is `rejected` is a usage limit refusing the
	 * CLI — the turn under way's, or, when the CLI says it after that turn's
	 * end, the reset that end did not know.
	 */
	private takeRateLimit(
		line: Extract<ClaudeLine, { type: "rate_limit" }>,
	): void {
		const rateLimits = withRateLimits(
			this.current.usage?.rateLimits,
			line.windows,
		);
		this.emit({
			type: "usage",
			usage: { ...(this.current.usage ?? NO_USAGE), rateLimits },
		});
		const resetsAt =
			(line.status === "rejected" ? line.resetsAt : undefined) ??
			usedUpReset(rateLimits);
		if (this.unresetLimit !== undefined) {
			if (resetsAt === undefined) return;
			const end = this.current.entries.find(
				(each) => each.id === this.unresetLimit,
			);
			// Rewound away, or left with another session: nothing to fill in.
			if (end === undefined) {
				this.unresetLimit = undefined;
				return;
			}
			if (end.kind !== "turn-end") {
				throw new Error(
					`${this.unresetLimit}, the end of a turn a usage limit stopped, is a ${end.kind} entry`,
				);
			}
			this.unresetLimit = undefined;
			this.emit({ type: "entry", entry: { ...end, limit: { resetsAt } } });
			return;
		}
		if (line.status === "rejected") this.rejected = { resetsAt };
	}

	private takeResult(line: Extract<ClaudeLine, { type: "result" }>): void {
		const outcome = this.interrupting
			? "interrupted"
			: line.isError
				? "failed"
				: "completed";
		// A usage limit stopped the turn: the model's answer was the API's
		// limit error, or the turn failed after the CLI was refused by a limit.
		// A turn the person stopped was stopped by them.
		const limit =
			outcome !== "interrupted" &&
			(this.limitAnswered ||
				(outcome === "failed" && this.rejected !== undefined))
				? {
						resetsAt:
							this.rejected?.resetsAt ??
							usedUpReset(this.current.usage?.rateLimits),
					}
				: undefined;
		this.limitAnswered = false;
		this.rejected = undefined;
		this.answer(line);
		const usage: Usage = {
			...NO_USAGE,
			inputTokens: line.usage?.inputTokens,
			outputTokens: line.usage?.outputTokens,
			cachedInputTokens: line.usage?.cacheReadTokens,
			costUsd: line.costUsd,
			rateLimits: this.current.usage?.rateLimits,
			contextTokens: this.current.usage?.contextTokens,
			contextWindow:
				(this.mainModel === undefined
					? undefined
					: line.contextWindows[this.mainModel]) ??
				this.current.usage?.contextWindow,
		};
		this.turns += 1;
		this.emit({
			type: "entry",
			entry: {
				kind: "turn-end",
				id: entryId(`turn:${this.turns}`),
				outcome,
				detail:
					outcome !== "failed"
						? undefined
						: line.errors.length > 0
							? line.errors.join("\n")
							: line.result,
				usage,
				durationMs: line.durationMs,
				limit,
			},
		});
		this.emit({ type: "usage", usage });
		// A message written and not answered yet is the next turn, under way.
		this.turn(this.unanswered.length > 0 ? "running" : "none");
		this.unresetLimit =
			limit !== undefined && limit.resetsAt === undefined
				? entryId(`turn:${this.turns}`)
				: undefined;
		this.interrupting = false;
		// A server still connecting when the turn began (`system/init`) has
		// settled one way or the other by now, most likely.
		this.askMcpStatus();
	}

	/**
	 * Ask the CLI how its MCP servers stand now (`mcp_status`, the SDK's
	 * `mcpServerStatus()`): once it is up, after each turn, since
	 * `system/init` reports them only as each turn begins, and after each of
	 * the person's MCP requests is done — so the MCP panel (`/mcp`) opens on
	 * what is true now and shows what a request changed. The panel asks too
	 * as it opens.
	 */
	private askMcpStatus(): void {
		this.replies.push(this.controlRequest({ subtype: "mcp_status" }));
	}

	/**
	 * A call the CLI's own permission check refused. It is told on the call,
	 * wherever that call is drawn; a call not drawn is told in the subagent it
	 * was made in (`agent_id`), and only one that names neither is told in
	 * the conversation itself.
	 */
	private takeDenial(
		line: Extract<ClaudeLine, { type: "permission_denied" }>,
	): void {
		const denial = {
			summary: denialSummary(line.reasonType, line.reason),
			detail: line.message,
		};
		const call =
			line.toolUseId === undefined
				? undefined
				: this.tool(toolEntryId(line.toolUseId));
		if (call !== undefined) {
			this.denied.add(call.id);
			return this.emit({ type: "entry", entry: { ...call, denial } });
		}
		const text =
			line.toolName === undefined
				? denial.summary
				: `${line.toolName}: ${denial.summary}`;
		this.notice("info", text, line.raw, this.callOfTask(line.agentId));
	}

	/**
	 * The call a task id names — a background command's, or a subagent's by
	 * its agent id — once a task event or the call's result has said so.
	 */
	private callOfTask(task: string | undefined): EntryId | null {
		const call = task === undefined ? undefined : this.tasks.get(task);
		return call !== undefined && this.tool(call) !== undefined ? call : null;
	}

	/**
	 * Ties a task to the call that started it — once. A subagent's task keeps
	 * its id when SendMessage wakes it again, and the CLI then names the
	 * SendMessage call on its task events; the task is still the subagent the
	 * Agent call started, whose state the news is about.
	 */
	private bindTask(task: string, call: EntryId): void {
		if (!this.tasks.has(task)) this.tasks.set(task, call);
	}

	/**
	 * A background task's news, from the CLI's `task_*` events or from a
	 * notification in the conversation (all a session file keeps). It is
	 * matched to the call its task was first tied to (`bindTask`), or else to
	 * the call it names.
	 */
	private takeTask(line: Extract<ClaudeLine, { type: "task" }>): void {
		const bound =
			line.taskId === undefined ? undefined : this.tasks.get(line.taskId);
		const call =
			bound ??
			(line.toolUseId !== undefined ? toolEntryId(line.toolUseId) : undefined);
		const tool = call === undefined ? undefined : this.tool(call);
		const state: SubagentInfo["state"] =
			line.subtype !== "task_notification"
				? "running"
				: line.status === "completed"
					? "completed"
					: line.status === "failed" ||
						  line.status === "stopped" ||
						  line.status === "killed"
						? "failed"
						: "unknown";
		// A task no call DevHub drew started (a session file that never named
		// it, a check-in about all of them): only its end is news.
		if (tool === undefined) {
			if (line.subtype !== "task_notification") return;
			return this.notice(
				"info",
				`Background task ${line.status ?? "ended"}: ${line.text ?? ""}`,
				line.raw,
			);
		}
		if (line.taskId !== undefined) this.bindTask(line.taskId, tool.id);
		if (tool.spawns !== undefined) {
			if (state === tool.spawns.state) return;
			return this.emit({
				type: "entry",
				entry: { ...tool, spawns: { ...tool.spawns, state } },
			});
		}
		// Any other task a call started (a command run in the background)
		// stands on that call, quietly.
		const summary = state === "running" ? undefined : line.text;
		if (tool.background?.state === state && tool.background.summary === summary)
			return;
		this.emit({
			type: "entry",
			entry: { ...tool, background: { state, summary } },
		});
	}
}

/** Who refused a call, by the CLI's `decision_reason_type`. */
const DENIED_BY: Readonly<Record<string, string>> = {
	classifier: "auto mode",
	rule: "a permission rule",
	mode: "the permission mode",
	hook: "a hook",
};

/**
 * A refusal in a line: `Denied by auto mode: Modify Shared Resources`. The
 * reason's brackets, which the CLI writes around a classifier's category, are
 * left off.
 */
function denialSummary(
	type: string | undefined,
	reason: string | undefined,
): string {
	const who =
		type === undefined ? "Denied" : `Denied by ${DENIED_BY[type] ?? type}`;
	const why = reason?.trim().replace(/^\[(.*)\]$/su, "$1");
	return why === undefined || why === "" ? who : `${who}: ${why}`;
}

/** The CLI's kinds of background task, in DevHub's word; any other goes by the CLI's own name. */
const TEAMMATE_UNSTOPPABLE = "A teammate can't be stopped from here.";

const TASK_KINDS: Readonly<Record<string, string>> = {
	local_bash: "shell",
	local_agent: "subagent",
};

/** Whether a CLI of this version can be resumed at a message (`RESUMES_AT_A_MESSAGE`). */
function resumesAtAMessage(version: string | undefined): boolean {
	const parts = /^(\d+)\.(\d+)\.(\d+)/u.exec(version ?? "");
	if (parts === null) return false;
	for (let index = 0; index < RESUMES_AT_A_MESSAGE.length; index += 1) {
		const have = Number(parts[index + 1]);
		const need = RESUMES_AT_A_MESSAGE[index]!;
		if (have !== need) return have > need;
	}
	return true;
}

function toolEntryId(toolUseId: string): EntryId {
	return entryId(`tool:${toolUseId}`);
}

/**
 * The command a line invokes: the `/name` of a slash command, or `!` of a
 * shell-mode one; nothing for words to the model.
 */
function invocation(text: string): string | undefined {
	return /^\s*(\/\S+|!)/u.exec(text)?.[1];
}

/**
 * A user message for stdin. One written while a turn runs is queued for that
 * turn's next step (`priority: "next"`, which the CLI also assumes when none
 * is given): the running turn takes it in between tool calls instead of it
 * waiting for the turn to end (`later`) or stopping the turn (`now`).
 */
function userLine(
	text: string,
	images: readonly ImageRef[],
	origin: SentOrigin,
	midTurn = false,
): string {
	return JSON.stringify({
		type: "user",
		message: {
			role: "user",
			// Plain words stay a string, as the CLI's own messages are; with
			// images, the images come first, as the API advises.
			content:
				images.length === 0
					? text
					: [
							...images.map(imageBlock),
							...(text === "" ? [] : [{ type: "text", text }]),
						],
		},
		parent_tool_use_id: null,
		session_id: "",
		...(midTurn ? { priority: "next" } : {}),
		[ORIGIN_KEY]: origin,
	});
}

/** An image the person attached, as the API's image block. */
function imageBlock(image: ImageRef): JsonObject {
	if (image.source.kind !== "data") {
		throw new Error(
			`Claude is sent only an image's own bytes, not ${image.source.kind} ${JSON.stringify(image.label)}`,
		);
	}
	return {
		type: "image",
		source: {
			type: "base64",
			media_type: image.mediaType,
			data: image.source.base64,
		},
	};
}

function answerResponse(
	permission: Permission,
	answer: Extract<ConversationCommand, { kind: "answer" }>["answer"],
	request: RequestId,
): JsonObject {
	if (answer.kind === "answers") {
		if (!permission.asksQuestions) {
			throw new Error(
				`request ${request} asks no questions, so it cannot be answered with answers`,
			);
		}
		return {
			behavior: "allow",
			updatedInput: {
				...permission.input,
				answers: Object.fromEntries(
					Object.entries(answer.values).map(([question, value]) => [
						question,
						typeof value === "string" ? value : value.join(", "),
					]),
				),
			},
		};
	}
	if (!permission.choices.some((choice) => choice.id === answer.choiceId)) {
		throw new Error(
			`request ${request} did not offer the choice ${JSON.stringify(answer.choiceId)}`,
		);
	}
	if (answer.choiceId === DENY.id) {
		return { behavior: "deny", message: answer.text ?? DENIED_WITHOUT_WORDS };
	}
	if (answer.choiceId === ALLOW_ONCE.id) {
		return { behavior: "allow", updatedInput: permission.input };
	}
	const suggestion =
		permission.suggestions[
			Number(answer.choiceId.slice("suggestion:".length))
		]!;
	return {
		behavior: "allow",
		updatedInput: permission.input,
		updatedPermissions: [suggestion],
	};
}

/**
 * An elicitation's answer, by the one rule both CLIs' are
 * (`../elicitation.ts`), as the SDK's `ElicitationResult`: MCP's
 * `ElicitResult`, whose `content` is there only for an accepted form.
 */
function elicitationResponse(
	elicitation: Elicitation,
	answer: Extract<ConversationCommand, { kind: "answer" }>["answer"],
	request: RequestId,
): JsonObject {
	const reply = elicitationReply(elicitation, answer, request);
	if (reply.remember !== undefined)
		throw new Error(
			`elicitation ${request} was answered with remembering, which Claude never offers`,
		);
	return reply.content === undefined
		? { action: reply.action }
		: { action: reply.action, content: reply.content };
}

/**
 * What the person answered, question by question, as the CLI recorded it: the
 * record the live answer, a replay and a resumed session all read.
 */
function askedOf(answered: AnsweredQuestions): readonly AskedQuestion[] {
	return answered.questions.map((question) => ({
		question,
		answer: answerTo(
			question,
			givenAnswers(question, answered.answers[question.id] ?? ""),
			answered.notes[question.id],
			false,
		),
	}));
}

/**
 * A question's answer as the answers it gives. A multi-select one's labels
 * come joined with `", "` — and a label, or the words written beside them,
 * may hold a `", "` too — so the joined answer is read back label by label:
 * the longest run of pieces that names an option is that option, and a run
 * that names none is what the person wrote.
 */
function givenAnswers(
	question: Question,
	answer: string | readonly string[],
): readonly string[] {
	if (typeof answer !== "string") return answer;
	if (!question.multiSelect) return [answer];
	const labels = new Set(question.options.map((option) => option.label));
	const pieces = answer.split(", ");
	const given: string[] = [];
	let written: string[] = [];
	let at = 0;
	while (at < pieces.length) {
		let end = pieces.length;
		while (end > at && !labels.has(pieces.slice(at, end).join(", "))) end -= 1;
		if (end === at) {
			written.push(pieces[at]!);
			at += 1;
			continue;
		}
		if (written.length > 0) given.push(written.join(", "));
		written = [];
		given.push(pieces.slice(at, end).join(", "));
		at = end;
	}
	if (written.length > 0) given.push(written.join(", "));
	return given;
}

/** The plan a call sets: TodoWrite's. */
function planOf(
	name: string,
	input: JsonObject,
): readonly PlanStep[] | undefined {
	return name === "TodoWrite" ? todoPlan(input) : undefined;
}

/** The tools whose result is a file they changed. */
const FILE_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);

const EXIT_CODE = /^Exit code (\d+)\n?/u;

const PERSISTED = /<persisted-output>\n?([\s\S]*?)\n?<\/persisted-output>/u;

/**
 * A tool call's result, drawn as what it gave back: the blocks the model
 * read (text, images, tools it made available), with what the tool says of
 * its own result standing in where it says more — a command's streams and
 * exit code, a file tool's diff, output too large for the conversation.
 */
function toolOutput(
	tool: ToolEntry,
	block: Extract<UserBlock, { kind: "tool_result" }>,
	result: ToolUseResult,
): ToolOutput {
	const parts = block.parts.flatMap((part): ToolOutputPart[] =>
		part.kind === "unknown"
			? []
			: part.kind === "text"
				? [persistedPart(part.text, result)]
				: [part],
	);
	if (parts.some((part) => part.kind === "persisted")) return parts;
	const text = parts
		.flatMap((part) => (part.kind === "text" ? [part.text] : []))
		.join("\n");
	const others = parts.filter((part) => part.kind !== "text");
	if (tool.tool === "Bash") {
		const exit = block.isError ? EXIT_CODE.exec(text) : null;
		if (exit !== null) {
			return [
				{
					kind: "command",
					exitCode: Number(exit[1]),
					output: text.slice(exit[0].length),
					stderr: undefined,
					interrupted: false,
				},
				...others,
			];
		}
		if (result.stdout !== undefined) {
			return [
				{
					kind: "command",
					exitCode: undefined,
					output: result.stdout,
					stderr: result.stderr === "" ? undefined : result.stderr,
					interrupted: result.interrupted,
				},
				...others,
			];
		}
	}
	return parts;
}

/** A text that is the CLI's note of output it saved to a file, as that note; any other, as itself. */
function persistedPart(text: string, result: ToolUseResult): ToolOutputPart {
	const found = PERSISTED.exec(text);
	if (found === null) return { kind: "text", text };
	const inner = found[1]!;
	const preview = /\n\s*Preview[^\n]*:\n/u.exec(inner);
	return {
		kind: "persisted",
		note: (preview === null ? inner : inner.slice(0, preview.index)).trim(),
		path:
			result.persistedPath ??
			/saved to:\s*(\S+)/u.exec(inner)?.[1] ??
			undefined,
		preview:
			preview === null ? "" : inner.slice(preview.index + preview[0].length),
	};
}

/**
 * The change a file tool made: the CLI's own patch when it gives one (with
 * line numbers), else what the call's input says it replaced.
 */
/**
 * The change a file tool's call makes: the CLI's own patch once its result
 * gives one, else what its input asks for. Undefined for any other tool.
 */
function changeOf(
	name: string,
	input: JsonObject,
	patch: ToolUseResult["patch"],
): readonly FileDiff[] | undefined {
	if (!FILE_TOOLS.has(name)) return undefined;
	if (patch !== undefined)
		return [{ path: patch.path, unifiedDiff: patch.hunks }];
	const diff = inputDiff(name, input);
	return diff === undefined ? undefined : [diff];
}

function inputDiff(name: string, input: JsonObject): FileDiff | undefined {
	const path = input.file_path;
	if (typeof path !== "string") return undefined;
	const lines = (mark: string, text: JsonValue | undefined) =>
		typeof text === "string" ? text.split("\n").map((line) => mark + line) : [];
	const replaced = (edit: JsonValue) => {
		const { old_string: before, new_string: after } = edit as JsonObject;
		return [...lines("-", before), ...lines("+", after)];
	};
	const hunks =
		name === "Write"
			? [lines("+", input.content)]
			: name === "MultiEdit"
				? (Array.isArray(input.edits) ? input.edits : []).map(replaced)
				: [replaced(input)];
	const written = hunks.filter((hunk) => hunk.length > 0);
	if (written.length === 0) return undefined;
	return {
		path,
		unifiedDiff: written.map((hunk) => ["@@", ...hunk].join("\n")).join("\n"),
	};
}

function spawnsOf(
	name: string,
	input: JsonObject,
	before: SubagentInfo | undefined,
): SubagentInfo | undefined {
	if (!SUBAGENT_TOOLS.has(name)) return undefined;
	const text = (key: string) =>
		typeof input[key] === "string" ? (input[key] as string) : undefined;
	return {
		label: text("subagent_type") ?? text("description") ?? name,
		prompt: text("prompt") ?? "",
		model: text("model"),
		state: before?.state ?? "running",
		takesMessages: false,
	};
}

/**
 * What a permission suggestion does, in a sentence. The suggestion itself goes
 * back to the CLI untouched; this is only its label, so a shape DevHub cannot
 * describe still offers the choice, named by its type.
 */
function suggestionLabel(suggestion: JsonObject): string {
	const { type } = suggestion;
	if (type === "addRules" && Array.isArray(suggestion.rules)) {
		const rules = suggestion.rules.flatMap((rule) => {
			if (typeof rule !== "object" || rule === null || Array.isArray(rule))
				return [];
			const { toolName, ruleContent } = rule as JsonObject;
			if (typeof toolName !== "string") return [];
			return [
				typeof ruleContent === "string"
					? `${toolName}(${ruleContent})`
					: toolName,
			];
		});
		if (rules.length > 0) return `Always allow ${rules.join(", ")}`;
	}
	if (type === "setMode" && typeof suggestion.mode === "string")
		return `Switch to ${suggestion.mode}`;
	if (type === "addDirectories" && Array.isArray(suggestion.directories)) {
		return `Always allow access to ${suggestion.directories.join(", ")}`;
	}
	return `Apply the suggested permission (${typeof type === "string" ? type : "unnamed"})`;
}

function retrySentence(
	line: Extract<ClaudeLine, { type: "api_retry" }>,
): string {
	const status = line.errorStatus === undefined ? "" : ` (${line.errorStatus})`;
	const delay =
		line.retryDelayMs === undefined
			? ""
			: ` in ${Math.round(line.retryDelayMs / 1000)}s`;
	const attempt =
		line.attempt === undefined
			? ""
			: ` (attempt ${line.attempt}${line.maxRetries === undefined ? "" : ` of ${line.maxRetries}`})`;
	return `The API request failed${status}; retrying${delay}${attempt}`;
}
