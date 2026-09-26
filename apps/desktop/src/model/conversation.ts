/**
 * The conversation of a GUI Agent, normalized: one shape for Claude and Codex.
 *
 * A protocol adapter turns what its CLI prints into `ConversationEvent`s, and
 * `applyEvent` folds them into a `Transcript`. That fold is the only one.
 * main holds the true Transcript and folds every event into it; the page takes
 * a snapshot and folds the events that follow into its copy — with this same
 * function, because a second reducer on the page would be a second path that
 * says the same thing, and one of the two would drift.
 *
 * Nothing here does I/O, and nothing here knows which CLI is on the other end.
 * The page draws what is here without asking which adapter produced it.
 *
 * # What the fold refuses
 *
 * An event is the adapter's claim about the conversation. An event that cannot
 * be true of the Transcript it lands on — a delta for an entry that does not
 * exist, an entry that changes its kind, a request about a tool call nobody
 * made — means the adapter's bookkeeping has broken, and the fold throws
 * `TranscriptInvariantError` rather than drawing something plausible. The
 * adapter's caller turns that into a broken conversation at its one root.
 *
 * What the *CLI* says that DevHub does not understand is a different thing
 * and is not refused here: the adapter reports it as a `notice` entry (an
 * unknown event) or as `state: broken` (a known event of the wrong shape).
 * Both arrive as ordinary events, and the fold records them like any other.
 *
 * # What the fold does not infer
 *
 * Every event says one thing and the fold records exactly that thing. A
 * `turn-end` entry does not end the turn in `state`; a finished tool does not
 * close the request about it. The adapter sends each fact it knows, so there
 * is one place each fact comes from.
 */

import type { AgentStatus } from "./domain.js";

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type EntryId = Brand<string, "EntryId">;
export type RequestId = Brand<string, "RequestId">;

export function entryId(raw: string): EntryId {
  return raw as EntryId;
}

export function requestId(raw: string): RequestId {
  return raw as RequestId;
}

/** JSON as it came off the wire, kept for display (tool input, raw events). */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * An image a user message carried. v1 sends no images; the type exists so the
 * user entry has the same shape once it does.
 */
export interface ImageRef {
  readonly mediaType: string;
  readonly label: string;
}

export type TranscriptEntry =
  | UserEntry
  | AssistantEntry
  | ToolEntry
  | NoticeEntry
  | TurnEndEntry;

export interface UserEntry {
  readonly kind: "user";
  readonly id: EntryId;
  readonly parent: EntryId | null;
  readonly text: string;
  readonly images: readonly ImageRef[];
  /** Who made the Agent say it: a person at the composer, or a template injection. */
  readonly origin: "person" | "injection";
  /**
   * Whether the CLI can cut the conversation right before this message, when
   * its session can take turns back at all (`SessionFacts.canRewind`). The
   * adapter says: a Codex thread is cut by turns, so only the message that
   * started a turn is a place to cut; a Claude session is cut after any
   * message it holds.
   */
  readonly rewindable: boolean;
}

export interface AssistantEntry {
  readonly kind: "assistant";
  readonly id: EntryId;
  readonly parent: EntryId | null;
  readonly blocks: readonly AssistantBlock[];
  /** Deltas land only while this is true. */
  readonly streaming: boolean;
}

export const TOOL_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "denied",
  "interrupted",
] as const;
export type ToolStatus = (typeof TOOL_STATUSES)[number];

export interface ToolEntry {
  readonly kind: "tool";
  readonly id: EntryId;
  readonly parent: EntryId | null;
  readonly tool: string;
  /** The Agent's own words for the call: `Bash: npm test`, `Edit: src/x.ts`. */
  readonly title: string;
  readonly input: JsonValue;
  readonly status: ToolStatus;
  readonly output: ToolOutput | undefined;
  /** Set on a call that starts a subagent; that subagent's entries name this one as their parent. */
  readonly spawns: SubagentInfo | undefined;
  /**
   * Set on a call that started a background task other than a subagent (a
   * command run in the background): how that task stands. A subagent's
   * stands in `spawns.state`; the same news ends either.
   */
  readonly background: BackgroundTask | undefined;
}

export interface BackgroundTask {
  readonly state: SubagentInfo["state"];
  /** The CLI's one line about how it ended, once it has. */
  readonly summary: string | undefined;
}

export interface NoticeEntry {
  readonly kind: "notice";
  readonly id: EntryId;
  readonly parent: EntryId | null;
  readonly level: "info" | "warning" | "error";
  readonly text: string;
  /** The event as the CLI printed it, when the notice is about an event. */
  readonly raw: JsonValue | undefined;
}

export interface TurnEndEntry {
  readonly kind: "turn-end";
  readonly id: EntryId;
  readonly outcome: TurnOutcome;
  readonly detail: string | undefined;
  readonly usage: Usage | undefined;
  readonly durationMs: number | undefined;
}

export type TurnOutcome = "completed" | "interrupted" | "failed";

export type AssistantBlock =
  | { readonly kind: "text"; readonly markdown: string }
  | { readonly kind: "thinking"; readonly text: string }
  | { readonly kind: "plan"; readonly steps: readonly PlanStep[] };

export interface PlanStep {
  readonly text: string;
  readonly status: "pending" | "in_progress" | "completed";
}

export type ToolOutput =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly truncated: boolean;
    }
  | { readonly kind: "diff"; readonly files: readonly FileDiff[] }
  | {
      readonly kind: "command";
      readonly exitCode: number | undefined;
      readonly output: string;
    };

export interface FileDiff {
  readonly path: string;
  readonly unifiedDiff: string;
}

export interface SubagentInfo {
  readonly label: string;
  readonly prompt: string;
  readonly model: string | undefined;
  readonly state: "running" | "completed" | "failed" | "unknown";
  /**
   * Whether the person can say something to this subagent directly. The
   * adapter says, from what its CLI offers: a message then goes to the
   * subagent, not to the Agent that started it.
   */
  readonly takesMessages: boolean;
}

export interface PendingRequest {
  readonly id: RequestId;
  /** The tool call the request is about, when it is about one. */
  readonly entry: EntryId | undefined;
  readonly subject: RequestSubject;
  /** What can be answered is the adapter's to decide; the page lays these out and presses one. */
  readonly choices: readonly RequestChoice[];
}

export type RequestSubject =
  | {
      readonly kind: "tool";
      readonly tool: string;
      readonly title: string;
      readonly input: JsonValue;
      readonly reason: string | undefined;
    }
  | {
      readonly kind: "command";
      readonly command: string;
      readonly cwd: string;
      readonly reason: string | undefined;
    }
  | { readonly kind: "file-change"; readonly files: readonly FileDiff[] }
  | { readonly kind: "question"; readonly questions: readonly Question[] }
  | {
      readonly kind: "elicitation";
      readonly server: string;
      readonly message: string;
      readonly schema: JsonValue;
    };

/** One question of an AskUserQuestion / requestUserInput. */
export interface Question {
  /** The key its answer is filed under in `RequestAnswer.values`. */
  readonly id: string;
  readonly header: string;
  readonly text: string;
  readonly options: readonly {
    readonly label: string;
    readonly description: string;
  }[];
  readonly multiSelect: boolean;
  /** Whether a free-text "Other" answer is accepted. */
  readonly allowsOther: boolean;
}

export interface RequestChoice {
  /** The adapter's key for building the answer. */
  readonly id: string;
  readonly label: string;
  readonly tone: "allow" | "deny" | "neutral";
  /** Whether choosing it opens a text field (a reason, a further instruction). */
  readonly takesText: boolean;
}

export type RequestAnswer =
  | {
      readonly kind: "choice";
      readonly choiceId: string;
      readonly text: string | undefined;
    }
  | {
      readonly kind: "answers";
      readonly values: Readonly<Record<string, string | readonly string[]>>;
    };

export interface SessionFacts {
  readonly agentVersion: string | undefined;
  /** Claude's session_id / Codex's threadId: what "continue in terminal" resumes. */
  readonly sessionId: string | undefined;
  readonly cwd: string | undefined;
  readonly model: Setting;
  readonly effort: Setting;
  readonly mode: Setting;
  /** The Agent's own slash commands. */
  readonly commands: readonly SlashCommand[];
  /**
   * Whether this session can take turns back, so the conversation can be
   * rewound to before one of the person's messages (`rewindTargets`). The
   * adapter says, from what the CLI told it.
   */
  readonly canRewind: boolean;
}

export interface Setting {
  readonly current: string | undefined;
  readonly choices: readonly { readonly id: string; readonly label: string }[];
}

export interface SlashCommand {
  readonly name: string;
  readonly description: string;
  readonly argumentHint: string | undefined;
  /**
   * `message`: sent as the text of a user message. `resume`: DevHub's picker
   * of the Workspace's earlier sessions, one of which this Agent then goes on
   * with (`/resume`). Otherwise the header picker for that setting, which
   * DevHub opens instead of sending (`/model`).
   */
  readonly route: "message" | "resume" | "model" | "effort" | "mode";
}

/**
 * Tokens and money, as far as the CLI reports them. Every field is optional
 * because neither CLI reports all of them; an absent field is "not reported",
 * never zero.
 */
export interface Usage {
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly cachedInputTokens: number | undefined;
  /** How much of the context window the conversation fills now. */
  readonly contextTokens: number | undefined;
  readonly contextWindow: number | undefined;
  readonly costUsd: number | undefined;
  /**
   * Every rate-limit window the CLI has reported — Claude's five-hour and
   * seven-day, Codex's primary and secondary — one entry per window, each
   * as last reported.
   */
  readonly rateLimits: readonly RateLimit[] | undefined;
}

export interface RateLimit {
  /** Which window, in words: `5-hour`, `7-day`, or the CLI's own name for it. */
  readonly window: string;
  /** 0–100. */
  readonly usedPercent: number | undefined;
  /** Epoch milliseconds. */
  readonly resetsAt: number | undefined;
}

/** A window's name from its length: `5-hour`, `7-day`, `90-minute`. */
export function rateLimitWindowName(minutes: number): string {
  if (minutes % 1440 === 0) return `${String(minutes / 1440)}-day`;
  if (minutes % 60 === 0) return `${String(minutes / 60)}-hour`;
  return `${String(minutes)}-minute`;
}

/**
 * The windows known after a report: each window the report names replaces
 * the one of the same name, and a window it does not name stays as last seen
 * — a report that leaves a window out has not said it cleared.
 */
export function withRateLimits(
  known: readonly RateLimit[] | undefined,
  reported: readonly RateLimit[],
): readonly RateLimit[] {
  const byName = new Map((known ?? []).map((one) => [one.window, one]));
  for (const one of reported) byName.set(one.window, one);
  return [...byName.values()];
}

/** The window nearest its limit, which is the one that stops the CLI first. */
export function mostUsedRateLimit<
  W extends { readonly usedPercent?: number | undefined },
>(windows: readonly W[]): W | undefined {
  return windows.reduce<W | undefined>(
    (most, one) =>
      most === undefined || (one.usedPercent ?? -1) > (most.usedPercent ?? -1)
        ? one
        : most,
    undefined,
  );
}

export const CONVERSATION_FAILURE_CODES = [
  /** A known event did not have the shape its decoder expects, or a line was not JSON. */
  "protocol_mismatch",
  /** The CLI is not signed in. */
  "not_signed_in",
  /** The CLI refused to start (bad arguments and the like). */
  "refused",
] as const;
export type ConversationFailureCode =
  (typeof CONVERSATION_FAILURE_CODES)[number];

export interface ConversationFailure {
  readonly code: ConversationFailureCode;
  /** The failing side's own words: the decoder path and CLI version, the CLI's stderr. */
  readonly detail: string;
}

export type ConversationState =
  /** Attaching to the host, handshaking, or replaying the journal. */
  | { readonly phase: "connecting" }
  /**
   * `rewinding`: turns are being taken back (the person rewound the
   * conversation). It takes no input until the CLI says it is done.
   */
  | {
      readonly phase: "ready";
      readonly turn: "none" | "running" | "rewinding";
    }
  /** Takes no more input. The Transcript up to here stays readable. */
  | { readonly phase: "broken"; readonly failure: ConversationFailure };

export interface Transcript {
  /** Display order. Subagent entries are here too; `parent` makes the tree. */
  readonly entries: readonly TranscriptEntry[];
  /** Unanswered requests only. */
  readonly requests: readonly PendingRequest[];
  readonly session: SessionFacts;
  readonly state: ConversationState;
  readonly usage: Usage | undefined;
  /**
   * The person's messages DevHub holds because the Agent could not take them
   * when they were sent (a turn running, still connecting), oldest first.
   * They are not part of the conversation yet: the CLI has not seen them.
   */
  readonly pending: readonly PendingMessage[];
}

export type PendingId = Brand<string, "PendingId">;

export function pendingId(raw: string): PendingId {
  return raw as PendingId;
}

/**
 * A message the person sent that DevHub has not written to the CLI yet. It
 * is written when the turn running ends, or at once if the person says so
 * (which a running turn takes in as it goes). Until then it can be changed
 * or taken back.
 */
export interface PendingMessage {
  readonly id: PendingId;
  readonly text: string;
  /** Why the last try to write it failed, if it did. It is held until the person tries again. */
  readonly failure: string | undefined;
  /**
   * The person has it open to change it: it is not written until they save
   * the change or give it up, or the page that had it open goes away. A
   * message behind it waits too, so the order they were sent in holds.
   */
  readonly editing: boolean;
}

export type ConversationEvent =
  /** Adds the entry, or replaces the entry with the same id whole, in place. */
  | { readonly type: "entry"; readonly entry: TranscriptEntry }
  /** Appends to one text or thinking block of a streaming assistant entry. */
  | {
      readonly type: "text-delta";
      readonly entry: EntryId;
      readonly block: number;
      readonly text: string;
    }
  | { readonly type: "request-opened"; readonly request: PendingRequest }
  | { readonly type: "request-closed"; readonly request: RequestId }
  /** Replaces the session facts whole. */
  | { readonly type: "session"; readonly session: SessionFacts }
  | { readonly type: "state"; readonly state: ConversationState }
  /** Replaces the conversation's usage whole. */
  | { readonly type: "usage"; readonly usage: Usage }
  /** Replaces the messages DevHub holds whole. DevHub's own, not an adapter's. */
  | { readonly type: "pending"; readonly pending: readonly PendingMessage[] }
  /**
   * The CLI took back the turns from a message of the person's on: that
   * message and every entry after it are no longer part of the conversation.
   */
  | { readonly type: "rewound"; readonly from: EntryId }
  /**
   * The Agent went on with another session of its CLI (`/resume`): every
   * entry, and the usage, belonged to the one it left. What the other session
   * holds follows as entries.
   */
  | { readonly type: "session-switched"; readonly session: string };

/**
 * An event that cannot be true of the Transcript it was applied to. It is the
 * adapter's bookkeeping that broke, never the CLI's output, so nothing
 * recovers from it in place.
 */
export class TranscriptInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptInvariantError";
  }
}

const NO_SETTING: Setting = { current: undefined, choices: [] };

export const EMPTY_SESSION: SessionFacts = {
  agentVersion: undefined,
  sessionId: undefined,
  cwd: undefined,
  model: NO_SETTING,
  effort: NO_SETTING,
  mode: NO_SETTING,
  commands: [],
  canRewind: false,
};

/** The Transcript before the first event: nothing said, still connecting. */
export const EMPTY_TRANSCRIPT: Transcript = {
  entries: [],
  requests: [],
  session: EMPTY_SESSION,
  state: { phase: "connecting" },
  usage: undefined,
  pending: [],
};

/** The one fold. Returns a new Transcript; the one passed in is not touched. */
export function applyEvent(
  transcript: Transcript,
  event: ConversationEvent,
): Transcript {
  switch (event.type) {
    case "entry":
      return {
        ...transcript,
        entries: putEntry(transcript.entries, event.entry),
      };
    case "text-delta":
      return {
        ...transcript,
        entries: appendDelta(
          transcript.entries,
          event.entry,
          event.block,
          event.text,
        ),
      };
    case "request-opened":
      return {
        ...transcript,
        requests: openRequest(transcript, event.request),
      };
    case "request-closed":
      return {
        ...transcript,
        requests: closeRequest(transcript.requests, event.request),
      };
    case "session":
      return { ...transcript, session: event.session };
    case "state":
      return { ...transcript, state: event.state };
    case "usage":
      return { ...transcript, usage: event.usage };
    case "pending":
      return { ...transcript, pending: event.pending };
    case "rewound":
      return { ...transcript, entries: rewind(transcript, event.from) };
    case "session-switched": {
      const open = transcript.requests[0];
      if (open !== undefined) {
        throw new TranscriptInvariantError(
          `a switch to session ${event.session} while request ${open.id} is open`,
        );
      }
      return {
        ...transcript,
        entries: [],
        usage: undefined,
        session: { ...transcript.session, sessionId: event.session },
      };
    }
    default:
      return unknownEvent(event);
  }
}

/** `applyEvent` over a sequence, in order: a replayed journal, a batch off the wire. */
export function applyEvents(
  transcript: Transcript,
  events: Iterable<ConversationEvent>,
): Transcript {
  let folded = transcript;
  for (const event of events) folded = applyEvent(folded, event);
  return folded;
}

function unknownEvent(event: never): never {
  throw new TranscriptInvariantError(
    `unknown conversation event ${JSON.stringify((event as { type?: unknown }).type)}`,
  );
}

function replaceAt<T>(
  items: readonly T[],
  index: number,
  item: T,
): readonly T[] {
  const copy = [...items];
  copy[index] = item;
  return copy;
}

function parentOf(entry: TranscriptEntry): EntryId | null {
  return entry.kind === "turn-end" ? null : entry.parent;
}

/**
 * Searched from the end: the entries events touch — the one streaming, the
 * tool running — are almost always the last few.
 */
function indexOfEntry(
  entries: readonly TranscriptEntry[],
  id: EntryId,
): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]!.id === id) return index;
  }
  return -1;
}

function requireToolEntry(
  entries: readonly TranscriptEntry[],
  id: EntryId,
  role: string,
): void {
  const index = indexOfEntry(entries, id);
  if (index < 0) {
    throw new TranscriptInvariantError(`${role} ${id} is not an entry`);
  }
  const kind = entries[index]!.kind;
  if (kind !== "tool") {
    throw new TranscriptInvariantError(
      `${role} ${id} is a ${kind} entry, not a tool call`,
    );
  }
}

function putEntry(
  entries: readonly TranscriptEntry[],
  entry: TranscriptEntry,
): readonly TranscriptEntry[] {
  const index = indexOfEntry(entries, entry.id);
  if (index < 0) {
    const parent = parentOf(entry);
    // A child arrives after the call that started it: the parent must already
    // be here, which is also what keeps the tree free of cycles.
    if (parent !== null)
      requireToolEntry(entries, parent, `parent of ${entry.id}`);
    return [...entries, entry];
  }
  const previous = entries[index]!;
  if (previous.kind !== entry.kind) {
    throw new TranscriptInvariantError(
      `entry ${entry.id} was a ${previous.kind} and cannot become a ${entry.kind}`,
    );
  }
  if (parentOf(previous) !== parentOf(entry)) {
    throw new TranscriptInvariantError(
      `entry ${entry.id} cannot move from parent ${parentOf(previous)} to ${parentOf(entry)}`,
    );
  }
  return replaceAt(entries, index, entry);
}

function appendDelta(
  entries: readonly TranscriptEntry[],
  id: EntryId,
  block: number,
  text: string,
): readonly TranscriptEntry[] {
  const index = indexOfEntry(entries, id);
  if (index < 0) {
    throw new TranscriptInvariantError(
      `text delta for ${id}, which is not an entry`,
    );
  }
  const entry = entries[index]!;
  if (entry.kind !== "assistant") {
    throw new TranscriptInvariantError(
      `text delta for ${id}, which is a ${entry.kind} entry`,
    );
  }
  if (!entry.streaming) {
    throw new TranscriptInvariantError(
      `text delta for ${id}, which is no longer streaming`,
    );
  }
  const target = entry.blocks[block];
  if (target === undefined) {
    throw new TranscriptInvariantError(
      `text delta for block ${block} of ${id}, which has ${entry.blocks.length}`,
    );
  }
  let grown: AssistantBlock;
  switch (target.kind) {
    case "text":
      grown = { ...target, markdown: target.markdown + text };
      break;
    case "thinking":
      grown = { ...target, text: target.text + text };
      break;
    case "plan":
      throw new TranscriptInvariantError(
        `text delta for block ${block} of ${id}, which is a plan`,
      );
  }
  return replaceAt(entries, index, {
    ...entry,
    blocks: replaceAt(entry.blocks, block, grown),
  });
}

function openRequest(
  transcript: Transcript,
  request: PendingRequest,
): readonly PendingRequest[] {
  if (transcript.requests.some((pending) => pending.id === request.id)) {
    throw new TranscriptInvariantError(`request ${request.id} is already open`);
  }
  if (request.entry !== undefined) {
    requireToolEntry(
      transcript.entries,
      request.entry,
      `subject of request ${request.id}`,
    );
  }
  return [...transcript.requests, request];
}

function closeRequest(
  requests: readonly PendingRequest[],
  id: RequestId,
): readonly PendingRequest[] {
  const remaining = requests.filter((pending) => pending.id !== id);
  if (remaining.length === requests.length) {
    throw new TranscriptInvariantError(`request ${id} is not open`);
  }
  return remaining;
}

function rewind(
  transcript: Transcript,
  from: EntryId,
): readonly TranscriptEntry[] {
  const open = transcript.requests[0];
  if (open !== undefined) {
    throw new TranscriptInvariantError(
      `a rewind to ${from} while request ${open.id} is open`,
    );
  }
  const index = indexOfEntry(transcript.entries, from);
  if (index < 0) {
    throw new TranscriptInvariantError(
      `a rewind to ${from}, which is not an entry`,
    );
  }
  const entry = transcript.entries[index]!;
  if (entry.kind !== "user" || entry.parent !== null) {
    throw new TranscriptInvariantError(
      `a rewind to ${from}: ${from} is a ${entry.kind} entry, not a message the person sent`,
    );
  }
  return transcript.entries.slice(0, index);
}

// ---------------------------------------------------------------------------
// Readings. Pure derivations the reconcile round and the page both take from
// a Transcript, so neither works them out a second time.

/** The entries directly under `parent` (`null` for the top level), in display order. */
export function childrenOf(
  transcript: Transcript,
  parent: EntryId | null,
): readonly TranscriptEntry[] {
  return transcript.entries.filter((entry) => parentOf(entry) === parent);
}

/** Whether the most recent turn ended in failure. False before any turn has ended. */
export function lastTurnFailed(transcript: Transcript): boolean {
  for (let index = transcript.entries.length - 1; index >= 0; index -= 1) {
    const entry = transcript.entries[index]!;
    if (entry.kind === "turn-end") return entry.outcome === "failed";
  }
  return false;
}

/**
 * The Agent's status, read off its conversation. A failed turn stays `error`
 * until the next turn starts; a pending request is `waiting` even mid-turn,
 * because somebody has to answer it before the turn goes anywhere.
 */
export function conversationStatus(transcript: Transcript): AgentStatus {
  const { state } = transcript;
  switch (state.phase) {
    case "connecting":
      return "unknown";
    case "broken":
      return "error";
    case "ready":
      if (transcript.requests.length > 0) return "waiting";
      if (state.turn !== "none") return "working";
      return lastTurnFailed(transcript) ? "error" : "idle";
  }
}

/**
 * What the Agent is doing, in its own words: the title of the latest running
 * tool call, else the in-progress step of the latest plan. Nothing outside a
 * turn.
 */
export function conversationActivity(
  transcript: Transcript,
): string | undefined {
  const { state, entries } = transcript;
  if (state.phase !== "ready" || state.turn !== "running") return undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind === "tool" && entry.status === "running") return entry.title;
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind !== "assistant") continue;
    for (let block = entry.blocks.length - 1; block >= 0; block -= 1) {
      const candidate = entry.blocks[block]!;
      if (candidate.kind !== "plan") continue;
      return candidate.steps.find((step) => step.status === "in_progress")
        ?.text;
    }
  }
  return undefined;
}

/**
 * How a rewind ended: the conversation was taken back to before the message,
 * or the CLI would not take it back — the conversation has a notice saying
 * why, and nothing was dropped.
 */
export type RewindOutcome = "rewound" | "refused";

/**
 * The messages the conversation can be rewound to before now: the person's
 * top-level messages the CLI can cut before, when the session can take turns
 * back, nothing is running or waiting, and DevHub holds no message of the
 * person's. Rewinding drops the message and everything after it.
 */
export function rewindTargets(transcript: Transcript): ReadonlySet<EntryId> {
  const { state, session, requests, entries, pending } = transcript;
  if (!session.canRewind || requests.length > 0 || pending.length > 0)
    return NO_TARGETS;
  if (state.phase !== "ready" || state.turn !== "none") return NO_TARGETS;
  return new Set(
    entries.flatMap((entry) =>
      entry.kind === "user" &&
      entry.parent === null &&
      entry.origin === "person" &&
      entry.rewindable
        ? [entry.id]
        : [],
    ),
  );
}

const NO_TARGETS: ReadonlySet<EntryId> = new Set();
