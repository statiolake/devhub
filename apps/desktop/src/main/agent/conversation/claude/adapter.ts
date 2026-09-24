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
	applyEvent,
	entryId,
	requestId,
	type AssistantBlock,
	type AssistantEntry,
	type ConversationEvent,
	type EntryId,
	type JsonValue,
	type RequestChoice,
	type RequestId,
	type SessionFacts,
	type Setting,
	type SlashCommand,
	type SubagentInfo,
	type ToolEntry,
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
	ORIGIN_KEY,
	decodeInitialize,
	decodeReceived,
	decodeSent,
	type ClaudeLine,
	type ContentBlock,
	type InitializeFacts,
	type StreamEvent,
	type UserBlock,
} from "./decode.js";

type JsonObject = { readonly [key: string]: JsonValue };

/**
 * Commands DevHub answers with its own header picker rather than sending
 * (design §3.3), and the setting each one opens.
 */
const PICKED: Readonly<Record<string, "model" | "effort" | "mode">> = {
	model: "model",
	effort: "effort",
	permissions: "mode",
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

const EFFORTS: Setting["choices"] = [
	{ id: "low", label: "Low" },
	{ id: "medium", label: "Medium" },
	{ id: "high", label: "High" },
	{ id: "max", label: "Max" },
];

const EFFORT_COMMAND = /^\/effort\s+(\S+)\s*$/u;

/** The input field that says, in a word, what a call of each well-known tool does. */
const TITLE_FIELDS: Readonly<Record<string, string>> = {
	Bash: "command",
	Read: "file_path",
	Edit: "file_path",
	MultiEdit: "file_path",
	Write: "file_path",
	NotebookEdit: "notebook_path",
	Glob: "pattern",
	Grep: "pattern",
	WebFetch: "url",
	WebSearch: "query",
	Task: "description",
	Agent: "description",
	Skill: "skill",
};

/** The tools that start a subagent. */
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

const NO_USAGE: Usage = {
	inputTokens: undefined,
	outputTokens: undefined,
	cachedInputTokens: undefined,
	contextTokens: undefined,
	contextWindow: undefined,
	costUsd: undefined,
	rateLimit: undefined,
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

const DENIED_WITHOUT_WORDS = "The person denied this in DevHub.";

/** One block of a message, as far as it has come. */
type Slot =
	| {
			readonly kind: "text" | "thinking";
			readonly entry: EntryId;
			readonly block: number;
			final: boolean;
	  }
	| { readonly kind: "tool"; readonly entry: EntryId; readonly id: string }
	| { readonly kind: "ignored" };

interface MessageState {
	readonly id: string;
	readonly parent: EntryId | null;
	readonly slots: Map<number, Slot>;
	/** How many of its blocks complete messages have delivered. */
	finals: number;
}

/** A permission request of the CLI's that DevHub has not answered. */
interface Permission {
	readonly input: JsonObject;
	readonly suggestions: readonly JsonObject[];
	readonly choices: readonly RequestChoice[];
	readonly asksQuestions: boolean;
	readonly entry: EntryId | undefined;
}

export class ClaudeAdapter implements ProtocolAdapter {
	private current: Transcript = EMPTY_TRANSCRIPT;
	private spent = false;
	private events: ConversationEvent[] = [];
	private replies: string[] = [];

	private nextRequest = 1;
	/** Control requests DevHub wrote that the CLI has not answered, by id. */
	private readonly ours = new Map<string, JsonObject>();
	/** User messages DevHub wrote that the CLI has not echoed yet, oldest first. */
	private readonly untaken: {
		readonly text: string;
		readonly origin: "person" | "injection";
	}[] = [];
	private readonly permissions = new Map<string, Permission>();
	private readonly denied = new Set<EntryId>();
	/** DevHub asked the running turn to stop. */
	private interrupting = false;

	private readonly messages = new Map<string, MessageState>();
	/** The message streaming now, per parent (null for the top level). */
	private readonly streaming = new Map<EntryId | null, MessageState>();

	private described: InitializeFacts["commands"] = [];
	private announced: readonly string[] = [];
	private readonly unknownSeen = new Set<string>();
	private notices = 0;
	private turns = 0;
	private users = 0;

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
				return [userLine(command.text, command.origin)];
			case "interrupt":
				return [this.controlRequest({ subtype: "interrupt" })];
			case "answer":
				return [this.answerLine(command.request, command.answer)];
			case "set-setting":
				switch (command.which) {
					case "model":
						return [
							this.controlRequest({ subtype: "set_model", model: command.id }),
						];
					case "mode":
						return [
							this.controlRequest({
								subtype: "set_permission_mode",
								mode: command.id,
							}),
						];
					case "effort":
						return [userLine(`/effort ${command.id}`, "person")];
				}
		}
	}

	sent(line: string): AdapterStep {
		return this.step(() => {
			const sent = decodeSent(line);
			switch (sent.type) {
				case "user": {
					this.untaken.push({ text: sent.text, origin: sent.origin });
					const effort = EFFORT_COMMAND.exec(sent.text);
					if (effort !== null) {
						this.setSession({
							effort: { current: effort[1], choices: EFFORTS },
						});
					}
					return;
				}
				case "control_request":
					this.ours.set(sent.requestId, sent.request);
					if (sent.subtype === "interrupt") this.interrupting = true;
					return;
				case "control_response": {
					const permission = this.permissions.get(sent.requestId);
					// Cancelled by the CLI before the answer reached it: already closed.
					if (permission === undefined) return;
					this.permissions.delete(sent.requestId);
					if (sent.behavior === "deny" && permission.entry !== undefined) {
						this.denied.add(permission.entry);
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
		return this.step(() =>
			this.take(decodeReceived(line, this.current.session.agentVersion)),
		);
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
		this.spent = false;
		return { events: this.events, replies: this.replies };
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
		const permission = this.permissions.get(request);
		if (permission === undefined) {
			throw new Error(
				`request ${request} is not pending, so it cannot be answered`,
			);
		}
		return JSON.stringify({
			type: "control_response",
			response: {
				subtype: "success",
				request_id: request,
				response: answerResponse(permission, answer, request),
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
		return [
			...this.described,
			...this.announced
				.filter((name) => !described.has(name))
				.map((name) => ({ name, description: "", argumentHint: undefined })),
		]
			.filter((command) => !TUI_ONLY.has(command.name))
			.map((command) => ({
				...command,
				route: Object.hasOwn(PICKED, command.name)
					? PICKED[command.name]!
					: "message",
			}));
	}

	private becomeReady(): void {
		if (this.current.state.phase === "connecting") {
			this.emit({ type: "state", state: { phase: "ready", turn: "none" } });
		}
	}

	private notice(
		level: "info" | "warning" | "error",
		text: string,
		raw: JsonValue | undefined,
	): void {
		this.notices += 1;
		this.emit({
			type: "entry",
			entry: {
				kind: "notice",
				id: entryId(`notice:${this.notices}`),
				parent: null,
				level,
				text,
				raw,
			},
		});
	}

	/** Once per kind of event, so a new event the CLI prints often is one line in the transcript, not a flood. */
	private unknown(key: string, raw: JsonObject): void {
		if (this.unknownSeen.has(key)) return;
		this.unknownSeen.add(key);
		const version =
			this.current.session.agentVersion ?? "(version not yet known)";
		this.notice(
			"warning",
			`claude ${version} printed a "${key}" event DevHub does not know`,
			raw,
		);
	}

	private take(line: ClaudeLine): void {
		switch (line.type) {
			case "control_response":
				return this.takeControlResponse(line);
			case "can_use_tool":
				return this.takePermission(line);
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
				if (!this.permissions.delete(line.requestId)) return;
				return this.emit({
					type: "request-closed",
					request: requestId(line.requestId),
				});
			case "init":
				this.announced = line.slashCommands;
				this.setSession({
					agentVersion: line.version,
					sessionId: line.sessionId,
					cwd: line.cwd,
					model: { ...this.current.session.model, current: line.model },
					effort: { ...this.current.session.effort, choices: EFFORTS },
					mode: {
						current: line.permissionMode ?? this.current.session.mode.current,
						choices: MODES,
					},
					commands: this.commands(),
				});
				return this.becomeReady();
			case "stream":
				return this.takeStream(
					this.parentOf(line.parent, "stream_event"),
					line.event,
				);
			case "assistant":
				return this.takeAssistant(line);
			case "user":
				return this.takeUser(line);
			case "result":
				return this.takeResult(line);
			case "api_retry":
				return this.notice("warning", retrySentence(line), line.raw);
			case "compact_boundary":
				return this.notice(
					"info",
					`The conversation was compacted${parenthesized([
						line.trigger,
						line.preTokens === undefined
							? undefined
							: `from ${line.preTokens} tokens`,
					])}`,
					undefined,
				);
			case "status":
				if (line.permissionMode === undefined) return;
				return this.setSession({
					mode: { current: line.permissionMode, choices: MODES },
				});
			case "permission_denied":
				return this.notice(
					"info",
					"A tool call was denied by the permission rules",
					line.raw,
				);
			case "task":
				return this.takeTask(line);
			case "rate_limit":
				return this.emit({
					type: "usage",
					usage: {
						...(this.current.usage ?? NO_USAGE),
						rateLimit: {
							usedPercent: line.usedPercent,
							resetsAt: line.resetsAt,
						},
					},
				});
			case "unused":
				return;
			case "unknown":
				return this.unknown(line.key, line.raw);
		}
	}

	private takeControlResponse(
		line: Extract<ClaudeLine, { type: "control_response" }>,
	): void {
		const request = this.ours.get(line.requestId);
		if (request === undefined) {
			return this.mismatch(
				"control_response.response.request_id",
				"a request DevHub made",
			);
		}
		this.ours.delete(line.requestId);
		const subtype = request.subtype as string;
		if (!line.outcome.ok) {
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
				this.setSession({
					model: {
						current: this.current.session.model.current,
						choices: facts.models,
					},
					commands: this.commands(),
				});
				return this.becomeReady();
			}
			case "set_model":
				return this.setSession({
					model: {
						...this.current.session.model,
						current: request.model as string,
					},
				});
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
		this.permissions.set(line.requestId, {
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
	): void {
		const parent = this.parentOf(line.parent, "assistant");
		let message = this.messages.get(line.messageId);
		if (message === undefined) {
			message = { id: line.messageId, parent, slots: new Map(), finals: 0 };
			this.messages.set(line.messageId, message);
		}
		line.content.forEach((block, position) => {
			const index = message.finals;
			message.finals += 1;
			const slot = message.slots.get(index);
			if (slot === undefined)
				return this.openBlock(message, index, block, true);
			this.finalize(
				message,
				slot,
				block,
				`assistant.message.content[${position}]`,
			);
		});
		if (line.error !== undefined) {
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
		slot: Slot,
		block: ContentBlock,
		path: string,
	): void {
		switch (slot.kind) {
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

	private takeUser(line: Extract<ClaudeLine, { type: "user" }>): void {
		const parent = this.parentOf(line.parent, "user");
		const texts: string[] = [];
		line.content.forEach((block, position) => {
			switch (block.kind) {
				case "text":
					texts.push(block.text);
					return;
				case "tool_result":
					return this.takeToolResult(
						block,
						`user.message.content[${position}]`,
					);
				case "unused":
					return;
				case "unknown":
					return this.unknown(block.key, block.raw);
			}
		});
		// A subagent's first user message is the prompt it was given, which the
		// Task call that started it already carries (`spawns.prompt`).
		if (texts.length === 0 || parent !== null) return;
		const text = texts.join("\n");
		const taken = this.untaken.findIndex((each) => each.text === text);
		if (taken < 0) return this.notice("info", text, undefined);
		const [{ origin }] = this.untaken.splice(taken, 1) as [
			(typeof this.untaken)[number],
		];
		this.users += 1;
		this.emit({
			type: "entry",
			entry: {
				kind: "user",
				id: entryId(`user:${line.uuid ?? `#${this.users}`}`),
				parent: null,
				text,
				images: [],
				origin,
			},
		});
		const { state } = this.current;
		if (
			state.phase !== "broken" &&
			!(state.phase === "ready" && state.turn === "running")
		) {
			this.emit({ type: "state", state: { phase: "ready", turn: "running" } });
		}
	}

	private takeToolResult(
		block: Extract<UserBlock, { kind: "tool_result" }>,
		path: string,
	): void {
		const id = toolEntryId(block.toolUseId);
		const tool = this.tool(id);
		if (tool === undefined)
			return this.mismatch(`${path}.tool_use_id`, "a tool call that was made");
		this.emit({
			type: "entry",
			entry: {
				...tool,
				status: this.denied.has(id)
					? "denied"
					: block.isError && this.interrupting
						? "interrupted"
						: block.isError
							? "failed"
							: "succeeded",
				output: { kind: "text", text: block.text, truncated: false },
			},
		});
	}

	private takeResult(line: Extract<ClaudeLine, { type: "result" }>): void {
		const outcome = this.interrupting
			? "interrupted"
			: line.isError
				? "failed"
				: "completed";
		const usage: Usage = {
			...NO_USAGE,
			inputTokens: line.usage?.inputTokens,
			outputTokens: line.usage?.outputTokens,
			cachedInputTokens: line.usage?.cacheReadTokens,
			costUsd: line.costUsd,
			rateLimit: this.current.usage?.rateLimit,
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
			},
		});
		this.emit({ type: "usage", usage });
		this.emit({ type: "state", state: { phase: "ready", turn: "none" } });
		this.interrupting = false;
	}

	private takeTask(line: Extract<ClaudeLine, { type: "task" }>): void {
		const tool =
			line.toolUseId === undefined
				? undefined
				: this.tool(toolEntryId(line.toolUseId));
		if (tool?.spawns !== undefined) {
			const state: SubagentInfo["state"] =
				line.subtype !== "task_notification"
					? "running"
					: line.status === "completed"
						? "completed"
						: line.status === "failed" || line.status === "stopped"
							? "failed"
							: "unknown";
			if (state === tool.spawns.state) return;
			return this.emit({
				type: "entry",
				entry: { ...tool, spawns: { ...tool.spawns, state } },
			});
		}
		// A background task no subagent owns (a `run_in_background` command):
		// its call already shows it running, and only its end is news.
		if (line.subtype === "task_notification") {
			this.notice(
				"info",
				`Background task ${line.status ?? "ended"}: ${line.text ?? ""}`,
				line.raw,
			);
		}
	}
}

function toolEntryId(toolUseId: string): EntryId {
	return entryId(`tool:${toolUseId}`);
}

function userLine(text: string, origin: "person" | "injection"): string {
	return JSON.stringify({
		type: "user",
		message: { role: "user", content: text },
		parent_tool_use_id: null,
		session_id: "",
		[ORIGIN_KEY]: origin,
	});
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

/** `Bash: npm test` — the tool, and the one field that says what this call does. */
function toolTitle(name: string, input: JsonObject): string {
	const field = TITLE_FIELDS[name];
	const value = field === undefined ? undefined : input[field];
	if (typeof value !== "string" || value === "") return name;
	return `${name}: ${value.split("\n", 1)[0]}`;
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

function parenthesized(parts: readonly (string | undefined)[]): string {
	const present = parts.filter((part): part is string => part !== undefined);
	return present.length === 0 ? "" : ` (${present.join(", ")})`;
}
