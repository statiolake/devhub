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
import type { FormField } from "./elicitationForm.js";

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
 * An image in the conversation: one the person attached to a message, or one
 * a tool gave back (a screenshot, a picture it read).
 */
export interface ImageRef {
  /** `image/png` and the like; `image/*` when the CLI did not say. */
  readonly mediaType: string;
  readonly source: ImageSource;
  /** What the image is called, for a reader who cannot see it: a file name, or `image`. */
  readonly label: string;
}

/**
 * Where an image's pixels are. `data` and `url` the page can draw; `file` is
 * a path on the Agent's machine, which the page cannot open, so it is named
 * and not drawn.
 */
export type ImageSource =
  | { readonly kind: "data"; readonly base64: string }
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "file"; readonly path: string };

/** The kinds of image a person can send: the ones both CLIs' models take. */
export const SENDABLE_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

/**
 * Images a page says the person attached, checked: each its own bytes, of a
 * kind a model takes. Anything else is refused, with what was wrong.
 */
export function attachedImages(value: unknown): readonly ImageRef[] {
  if (!Array.isArray(value)) throw new Error("attached images are not a list");
  return value.map((each: unknown, index) => {
    const image = each as Partial<ImageRef> | null;
    const source = image?.source as Partial<ImageSource> | undefined;
    if (
      typeof image?.mediaType !== "string" ||
      !(SENDABLE_IMAGE_TYPES as readonly string[]).includes(image.mediaType) ||
      typeof image.label !== "string" ||
      source?.kind !== "data" ||
      typeof (source as { base64?: unknown }).base64 !== "string"
    ) {
      throw new Error(
        `attached image ${index} is not a PNG, JPEG, GIF or WebP image's own bytes`,
      );
    }
    return {
      mediaType: image.mediaType,
      source: { kind: "data", base64: (source as { base64: string }).base64 },
      label: image.label,
    };
  });
}

export type TranscriptEntry =
  | UserEntry
  | AnswerEntry
  | CommandEntry
  | AssistantEntry
  | ToolEntry
  | NoticeEntry
  | CompactionEntry
  | TurnEndEntry;

/**
 * Whom DevHub wrote a user message for: the person (at the composer), a
 * template (an injection), or the person again, by DevHub on their behalf,
 * once a usage limit that stopped the Agent had reset (`after-limit`, see
 * `LimitResume`). Written into the line itself, so a replay says the same.
 */
export const SENT_ORIGINS = ["person", "injection", "after-limit"] as const;
export type SentOrigin = (typeof SENT_ORIGINS)[number];

export function isSentOrigin(value: unknown): value is SentOrigin {
  return (SENT_ORIGINS as readonly unknown[]).includes(value);
}

export type UserOrigin = SentOrigin | "other";

export interface UserEntry {
  readonly kind: "user";
  readonly id: EntryId;
  readonly parent: EntryId | null;
  readonly text: string;
  readonly images: readonly ImageRef[];
  /**
   * Who made the Agent say it: the person (at the composer, or at the CLI's
   * terminal in a session read back), a template injection, DevHub for the
   * person once a usage limit reset (`after-limit`), or `other` —
   * something that reached the Agent as a user message DevHub did not send
   * (the CLI or its harness passing on another session's message, a
   * subagent's report, a plugin's prompt). The adapter says, from what DevHub
   * knows it sent.
   */
  readonly origin: UserOrigin;
  /**
   * Whether the CLI can cut the conversation right before this message, when
   * its session can take turns back at all (`SessionFacts.canRewind`). The
   * adapter says: a Codex thread is cut by turns, so only the message that
   * started a turn is a place to cut; a Claude session is cut after any
   * message it holds.
   */
  readonly rewindable: boolean;
}

/**
 * The person's answer to questions the Agent asked (Claude's AskUserQuestion,
 * Codex's requestUserInput), drawn as their message. The adapter derives it
 * from what its CLI records of the answer, so a replay and a resumed session
 * draw it from the same record the live answer came from.
 */
export interface AnswerEntry {
  readonly kind: "answer";
  readonly id: EntryId;
  readonly parent: EntryId | null;
  /** One per question, in the order they were asked. */
  readonly answers: readonly QuestionAnswer[];
}

/** A question a call asked, as it was asked, and how the person answered it. */
export interface AskedQuestion {
  readonly question: Question;
  readonly answer: QuestionAnswer;
}

export interface QuestionAnswer {
  readonly header: string;
  readonly question: string;
  /** The options chosen, by label, in the order the answer gave them. */
  readonly chosen: readonly string[];
  /** What the person wrote instead of (or beside) an option, as written. */
  readonly written: string | undefined;
  /** The person's note on their choice, when they added one. */
  readonly notes: string | undefined;
  /** The question asked for a secret, whose answer is not drawn. */
  readonly secret: boolean;
}

/**
 * An answer as a question's options read it: what names an option is chosen,
 * and anything else is what the person wrote.
 */
export function answerTo(
  question: Question,
  given: readonly string[],
  notes: string | undefined,
  secret: boolean,
): QuestionAnswer {
  const labels = new Set(question.options.map((option) => option.label));
  const written = given.filter((each) => !labels.has(each) && each !== "");
  return {
    header: question.header,
    question: question.text,
    chosen: secret ? [] : given.filter((each) => labels.has(each)),
    written: secret || written.length === 0 ? undefined : written.join("\n"),
    notes: secret ? undefined : notes,
    secret,
  };
}

/**
 * A command the CLI ran itself rather than the model — a slash command
 * (`/model sonnet`), a shell-mode line (`! ls`) — and what it printed.
 */
export interface CommandEntry {
  readonly kind: "command";
  readonly id: EntryId;
  readonly parent: null;
  /** As typed: `/model sonnet`, `! ls`. Absent when only its output was recorded. */
  readonly line: string | undefined;
  /** What it printed, once it has. */
  readonly output: string | undefined;
  /** It printed an error. */
  readonly failed: boolean;
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
  /**
   * The call asked to run outside the CLI's sandbox (Claude's Bash with
   * `dangerouslyDisableSandbox`). Drawn quietly: it is an everyday thing.
   */
  readonly outsideSandbox: boolean;
  /** The plan the call set (Claude's TodoWrite), whole, as it stands after it. */
  readonly plan: readonly PlanStep[] | undefined;
  /**
   * The change the call makes to files (Claude's Edit, MultiEdit and Write;
   * Codex's file changes), as unified diffs: what its input asks for from
   * the moment it is made, and the CLI's own patch once its result gives
   * one. Drawn as the call's readable view, whatever its status.
   */
  readonly change: readonly FileDiff[] | undefined;
  /**
   * The questions the call asked the person (Claude's AskUserQuestion), each
   * with the answer it was given, once it has one: drawn in the call's fold
   * for reference, every option and preview with the chosen ones checked.
   * The answer itself is drawn once, as the person's (`AnswerEntry`).
   */
  readonly asked: readonly AskedQuestion[] | undefined;
  /**
   * The call was refused by the CLI's own permission check (a rule, auto
   * mode's classifier), not by the person: who refused it and why.
   */
  readonly denial: Denial | undefined;
}

export interface Denial {
  /** In a line: `Denied by auto mode: Modify Shared Resources`. */
  readonly summary: string;
  /** The CLI's whole account of it, when it gave one. */
  readonly detail: string | undefined;
}

/**
 * How the work a call stands for is going. A call that returned once it had
 * set something going apart from the turn — a command in the background, a
 * subagent in the background or as a teammate — stands for that work, so it
 * is running while the work runs and ends as the work ends; any other call
 * is its own status. A call that failed, was denied or was interrupted is
 * that, whatever it started.
 */
export type WorkState = ToolStatus | "idle" | "unknown";

const STARTED_WORK: Readonly<Record<SubagentInfo["state"], WorkState>> = {
  running: "running",
  idle: "idle",
  completed: "succeeded",
  failed: "failed",
  unknown: "unknown",
};

export function workState(entry: ToolEntry): WorkState {
  const started = entry.background?.state ?? entry.spawns?.state;
  // A call that failed, was denied or was stopped says so itself, whatever
  // it had started; otherwise the work it started is the news.
  if (
    started === undefined ||
    (entry.status !== "running" && entry.status !== "succeeded")
  )
    return entry.status;
  return STARTED_WORK[started];
}

export interface BackgroundTask {
  readonly state: SubagentInfo["state"];
  /** The CLI's one line about how it ended, once it has. */
  readonly summary: string | undefined;
}

/**
 * Something the Agent set going that runs on its own, apart from its turn: a
 * command run in the background, a subagent started in the background, a
 * teammate at work, a watcher. It stays in `Transcript.backgroundTasks` while
 * it works and leaves when it ends (or, for a subagent that can be told
 * something again, when it goes idle).
 */
export interface RunningTask {
  /** The CLI's own name for the task; unique among those running. */
  readonly id: string;
  /**
   * What kind of task it is, in a word: `shell`, `subagent`, or the CLI's own
   * name for a kind DevHub has no word for.
   */
  readonly kind: string;
  /** The CLI's words for it: the command's description, the subagent's errand. */
  readonly title: string;
  /** The call that started it, once the CLI has said which. */
  readonly call: EntryId | undefined;
  /**
   * When it started, in ms since the epoch, by the CLI's own clock: the time
   * the CLI wrote on the call that started it. Undefined until that call is
   * known, or when the CLI wrote none.
   */
  readonly startedAt: number | undefined;
  /**
   * Whether DevHub can ask the CLI to stop it (the `stop-task` command), or,
   * when it cannot, why not, in words for the person.
   */
  readonly stoppable: true | { readonly reason: string };
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

/**
 * The CLI compacted the conversation here: what came before is, to the
 * model, a summary of it from now on.
 */
export interface CompactionEntry {
  readonly kind: "compaction";
  readonly id: EntryId;
  /** A subagent's own context can be compacted too (Codex). */
  readonly parent: EntryId | null;
  /** `manual` (the person asked) or `auto`, as the CLI says. */
  readonly trigger: string | undefined;
  /** How many tokens the conversation held before. */
  readonly preTokens: number | undefined;
  /** How many it holds after, when the CLI says. */
  readonly postTokens: number | undefined;
}

export interface TurnEndEntry {
  readonly kind: "turn-end";
  readonly id: EntryId;
  readonly outcome: TurnOutcome;
  readonly detail: string | undefined;
  readonly usage: Usage | undefined;
  readonly durationMs: number | undefined;
  /**
   * The turn ended because a usage or rate limit of the CLI's plan stopped
   * it, by the CLI's own documented signals (the adapter says which). Set
   * only on a turn that did not complete.
   */
  readonly limit: LimitStop | undefined;
}

/** What stopped a turn at a usage limit. */
export interface LimitStop {
  /**
   * When the window that stopped it resets, in epoch ms, as the CLI reported
   * it; undefined while it has not said. An adapter fills it in on the same
   * entry when the CLI says it after the turn ended.
   */
  readonly resetsAt: number | undefined;
}

/**
 * The reset of the window a usage limit stopped the CLI at, from the windows
 * it reports: one that is used up (100%). With more than one, the latest
 * reset, since the CLI cannot go on before every one of them has reset.
 */
export function usedUpReset(
  windows: readonly RateLimit[] | undefined,
): number | undefined {
  let latest: number | undefined;
  for (const window of windows ?? []) {
    if ((window.usedPercent ?? 0) < 100 || window.resetsAt === undefined)
      continue;
    if (latest === undefined || window.resetsAt > latest)
      latest = window.resetsAt;
  }
  return latest;
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

/**
 * What a tool call gave back: its parts in the order the tool gave them — a
 * screenshot tool's words and its picture, a command's output and how it
 * ended, an edit's diff.
 */
export type ToolOutput = readonly ToolOutputPart[];

export type ToolOutputPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image"; readonly image: ImageRef }
  /** A tool the call made available (a tool search's find), by name. */
  | { readonly kind: "reference"; readonly name: string }
  | {
      readonly kind: "command";
      /** Absent when the CLI did not say; never assumed to be 0. */
      readonly exitCode: number | undefined;
      /** What the command printed: stdout alone when `stderr` is apart, else both. */
      readonly output: string;
      /** What it printed on stderr, when the CLI keeps it apart. */
      readonly stderr: string | undefined;
      /** The command was stopped before it ended on its own. */
      readonly interrupted: boolean;
    }
  /**
   * Output too large for the conversation, which the CLI saved to a file and
   * gave the model only the start of.
   */
  | {
      readonly kind: "persisted";
      /** The CLI's own sentence about it: how large, and where. */
      readonly note: string;
      readonly path: string | undefined;
      /** The start of the output that the conversation holds. */
      readonly preview: string;
    };

export interface FileDiff {
  readonly path: string;
  readonly unifiedDiff: string;
}

export interface SubagentInfo {
  readonly label: string;
  readonly prompt: string;
  readonly model: string | undefined;
  /**
   * `idle`: alive and waiting to be told something (a Claude teammate
   * between tasks). `unknown`: nothing says how it stands, which is what a
   * subagent whose CLI has ended is unless its end was recorded.
   */
  readonly state: "running" | "idle" | "completed" | "failed" | "unknown";
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
  /**
   * An MCP server asking the person something through the Agent. It is
   * always answered by accepting its form — no fields at all for a plain
   * confirmation, or for a page to visit (`url`) — or by the adapter's other
   * choices: accepting and remembering it, when the CLI offers that, then
   * decline and cancel. Both CLIs' follow one rule
   * (`main/agent/conversation/elicitation.ts`).
   */
  | {
      readonly kind: "elicitation";
      readonly server: string;
      readonly message: string;
      /** The page the server asks the person to visit, for a URL elicitation. */
      readonly url: string | undefined;
      readonly fields: readonly FormField[];
    };

/** One question of an AskUserQuestion / requestUserInput. */
export interface Question {
  /** The key its answer is filed under in `RequestAnswer.values`. */
  readonly id: string;
  readonly header: string;
  readonly text: string;
  readonly options: readonly QuestionOption[];
  readonly multiSelect: boolean;
  /** Whether a free-text "Other" answer is accepted. */
  readonly allowsOther: boolean;
}

export interface QuestionOption {
  readonly label: string;
  readonly description: string;
  /**
   * What choosing it would look like — a mockup, a snippet — as Markdown the
   * card draws in a monospace box beside the options. Only a single-select
   * question's options are shown with theirs, as the CLI does.
   */
  readonly preview: string | undefined;
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
  /**
   * What can be chosen: `label` is how a choice reads, in the list and as the
   * current value alike; `detail` is the Agent's own words for it, if any.
   */
  readonly choices: readonly {
    readonly id: string;
    readonly label: string;
    readonly detail?: string;
    /**
     * A model choice's full model name, as a session reports its model
     * (`opus` resolves to `claude-opus-…`): what Claude Code saves an effort
     * for, and what decides the model's own default effort.
     */
    readonly resolved?: string;
  }[];
  /**
   * Why the setting can't be changed here, when the Agent listed nothing to
   * choose from for it (its models could not be listed, or its list does not
   * name the session's model). Shown beside the value, so a setting with no
   * choices is never a control that silently does nothing.
   */
  readonly unchangeable?: string;
}

export interface SlashCommand {
  /**
   * The character the composer offers it after, which is typed before its
   * name: `/` for a command, only as the message's first word, as both CLIs
   * read one; `$` for a Codex skill, mentioned anywhere in the message, as
   * Codex's own terminal UI offers one.
   */
  readonly trigger: "/" | "$";
  readonly name: string;
  readonly description: string;
  readonly argumentHint: string | undefined;
  /**
   * `message`: sent as the text of a user message. `resume`: DevHub's picker
   * of the Workspace's earlier sessions, one of which this Agent then goes on
   * with (`/resume`). `restart`: DevHub's Restart session, which stops the
   * Agent's CLI and starts it again on the same session (`/restart`).
   * `mcp`: DevHub's MCP panel, the Agent's MCP servers and what can be done
   * about each (`/mcp`). Otherwise the header picker for that setting, which
   * DevHub opens instead of sending (`/model`).
   */
  readonly route:
    | "message"
    | "resume"
    | "restart"
    | "mcp"
    | "model"
    | "effort"
    | "mode";
}

/**
 * How an MCP server stands, in one vocabulary for both CLIs. `unknown` is a
 * word of the CLI's DevHub does not know (`McpServer.said` has it), shown
 * rather than refused.
 */
export type McpServerStatus =
  | "connected"
  | "needs-sign-in"
  | "failed"
  | "connecting"
  | "disabled"
  | "unknown";

/**
 * What can be done about one MCP server from the panel, each the CLI's own
 * documented request: `reconnect` (Claude's `mcp_reconnect`, Codex's
 * `config/mcpServer/reload`, which reloads them all), `enable` and `disable`
 * (Claude's `mcp_toggle`), and `sign-in` (the CLI's own `mcp login`, run by
 * DevHub on the Agent's machine).
 */
export type McpAction = "reconnect" | "enable" | "disable" | "sign-in";

export interface McpServer {
  readonly name: string;
  readonly status: McpServerStatus;
  /** The CLI's own word for the status (`needs-auth`, `authenticationRequired`). */
  readonly said: string;
  /** Why it failed, when the CLI says. */
  readonly error: string | undefined;
  /**
   * Where it is configured, in the CLI's words (`user`, `project`, `local`,
   * `claudeai`, `plugin: …`); undefined when the CLI does not say.
   */
  readonly source: string | undefined;
  /** The actions the adapter offers for it now, in the order they are drawn. */
  readonly actions: readonly McpAction[];
}

/**
 * The Agent's MCP servers as its CLI last reported them, and DevHub's
 * requests about them. The adapter's, replaced whole (`mcp` events).
 */
export interface McpState {
  /** Undefined until the CLI has said which servers it has. */
  readonly servers: readonly McpServer[] | undefined;
  /** Plugins the CLI said did not load, and why. */
  readonly pluginErrors: readonly {
    readonly plugin: string;
    readonly message: string;
  }[];
  /** The person's MCP requests the CLI has not answered yet. */
  readonly working: readonly {
    readonly server: string;
    readonly action: Exclude<McpAction, "sign-in">;
  }[];
  /**
   * The last of the person's MCP requests the CLI refused, in its words. It
   * stands until the person makes the next one, whose own outcome replaces it.
   */
  readonly failure: string | undefined;
}

export const NO_MCP: McpState = {
  servers: undefined,
  pluginErrors: [],
  working: [],
  failure: undefined,
};

/**
 * An MCP sign-in DevHub is running for the Agent, or ran last: the CLI's own
 * `mcp login <server>` on the Agent's machine. DevHub's own, like `pending`,
 * not an adapter's; it stands until the next sign-in starts or the person
 * dismisses it.
 */
export interface McpSignIn {
  readonly server: string;
  readonly phase: "running" | "succeeded" | "failed";
  /** What the command printed so far, as text (terminal escapes taken out). */
  readonly output: string;
  /**
   * The browser's way back to the command, when it needed one made: the
   * forward of the authorization URL's `localhost` callback port to the
   * Agent's machine, or why it could not be made.
   */
  readonly callback:
    | { readonly kind: "forwarded"; readonly port: number; readonly to: string }
    | {
        readonly kind: "unforwarded";
        readonly port: number;
        readonly why: string;
      }
    | undefined;
  /** Why it failed, when it did. */
  readonly failure: string | undefined;
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
  /**
   * Which window, in words: `5-hour`, `7-day`, or the CLI's own name for it.
   * A label and the window's identity, never read for its length.
   */
  readonly window: string;
  /**
   * How long the window is, in minutes, as the CLI says it where it is
   * decoded (Codex's `windowDurationMins`, the documented length of Claude's
   * `five_hour` and `seven_day`); `undefined` when the CLI does not say.
   */
  readonly durationMinutes: number | undefined;
  /** 0–100. */
  readonly usedPercent: number | undefined;
  /** Epoch milliseconds. */
  readonly resetsAt: number | undefined;
}

/**
 * What a CLI's account said of its plan's limits when DevHub asked it
 * (`main/shell/usageReaders.ts`): the windows it has, or that the sign-in has
 * none — an API key, Bedrock — which is an answer, not a failure.
 */
export type UsageReading =
  | { readonly kind: "windows"; readonly windows: readonly RateLimit[] }
  | { readonly kind: "no_plan_limits" };

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
  /**
   * The messages written to the CLI that it has not taken yet (not echoed
   * back), oldest first. They are drawn where they will land, at the end of
   * the conversation, as sending; the CLI's echo makes each an entry, and
   * so does the end of the turn that answers one the CLI never echoed. The
   * adapter's, from what was written (`in.log`), so a replay says the same.
   */
  readonly sending: readonly SendingMessage[];
  /**
   * What the Agent set going that is still working apart from its turn,
   * oldest first. The adapter's, from what its CLI says runs in the
   * background: the conversation's one account of it.
   */
  readonly backgroundTasks: readonly RunningTask[];
  /** The Agent's MCP servers (the adapter's). */
  readonly mcp: McpState;
  /** The MCP sign-in running or run last (DevHub's). */
  readonly mcpSignIn: McpSignIn | undefined;
  /**
   * What DevHub will do about the usage limit the last turn stopped at, while
   * that turn's end is the last thing in the conversation (`limitStop`).
   * DevHub's own, like `pending`.
   */
  readonly limitResume: LimitResume | undefined;
  /**
   * The CLI is compacting the conversation now, as part of the turn running
   * (auto, or the person's `/compact`). The adapter's; it ends with the
   * compaction's divider, or with the turn. Only ever true while a turn runs.
   */
  readonly compacting: boolean;
}

/**
 * DevHub going on with a conversation a usage limit stopped, once the limit
 * has reset: by writing a fixed message (`[agents]
 * resume_after_limit_message`) for the person, at `at`. `unscheduled` is a
 * limit whose reset the CLI did not say, so nothing is written; `failed` is a
 * write that did not happen, and why. Each is one quiet line at the end of
 * the conversation.
 */
export type LimitResume =
  | { readonly kind: "scheduled"; readonly at: number }
  | { readonly kind: "unscheduled"; readonly reason: string }
  | { readonly kind: "failed"; readonly failure: string };

/** What a GUI Agent is told, for the person, once a usage limit it stopped at has reset. */
export const DEFAULT_RESUME_MESSAGE = "続けて";

/** Whether `text` cannot be the message written after a usage limit: empty, or with a null character. */
export function resumeMessageProblem(text: string): boolean {
  return text.trim().length === 0 || text.includes("\0");
}

export interface SendingMessage {
  /** Unique among the messages sending; not the entry id the echo will have. */
  readonly id: string;
  readonly text: string;
  readonly images: readonly ImageRef[];
  readonly origin: SentOrigin;
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
  /** The images attached to it, sent with its words. */
  readonly images: readonly ImageRef[];
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
  /** Replaces the messages written and not yet taken whole. The adapter's. */
  | { readonly type: "sending"; readonly sending: readonly SendingMessage[] }
  /** Replaces the tasks working in the background whole. The adapter's. */
  | {
      readonly type: "background-tasks";
      readonly tasks: readonly RunningTask[];
    }
  /** Replaces the MCP servers' state whole. The adapter's. */
  | { readonly type: "mcp"; readonly mcp: McpState }
  /** Replaces the MCP sign-in whole. DevHub's own, not an adapter's. */
  | { readonly type: "mcp-sign-in"; readonly signIn: McpSignIn | undefined }
  /** Replaces what DevHub will do about a usage limit whole. DevHub's own. */
  | { readonly type: "limit-resume"; readonly resume: LimitResume | undefined }
  /** Whether the CLI is compacting the conversation now. The adapter's. */
  | { readonly type: "compacting"; readonly compacting: boolean }
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
  | { readonly type: "session-switched"; readonly session: string }
  /**
   * The CLI was stopped and started again on the same session (Restart
   * session): the entries stay, and nothing the CLI that was stopped had
   * going goes on. Each request it asked closes, each call still running was
   * interrupted, each message still streaming ends where it got to, each
   * subagent or background task it started ends nobody knows how, and a
   * message written to it and not yet taken never reached it.
   */
  | { readonly type: "restarted" };

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
  sending: [],
  backgroundTasks: [],
  mcp: NO_MCP,
  mcpSignIn: undefined,
  limitResume: undefined,
  compacting: false,
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
      // A compaction is part of a turn: no turn running, none going on.
      return {
        ...transcript,
        state: event.state,
        compacting:
          event.state.phase === "ready" && event.state.turn === "running"
            ? transcript.compacting
            : false,
      };
    case "usage":
      return { ...transcript, usage: event.usage };
    case "pending":
      return { ...transcript, pending: event.pending };
    case "sending":
      return { ...transcript, sending: event.sending };
    case "background-tasks":
      return {
        ...transcript,
        backgroundTasks: backgroundTasks(transcript, event.tasks),
      };
    case "mcp":
      return { ...transcript, mcp: event.mcp };
    case "mcp-sign-in":
      return { ...transcript, mcpSignIn: event.signIn };
    case "limit-resume":
      return { ...transcript, limitResume: event.resume };
    case "compacting": {
      const { state } = transcript;
      if (
        event.compacting &&
        (state.phase !== "ready" || state.turn !== "running")
      ) {
        throw new TranscriptInvariantError(
          "a compaction started while no turn is running",
        );
      }
      return { ...transcript, compacting: event.compacting };
    }
    case "rewound":
      return { ...transcript, entries: rewind(transcript, event.from) };
    case "session-switched": {
      const open = transcript.requests[0];
      if (open !== undefined) {
        throw new TranscriptInvariantError(
          `a switch to session ${event.session} while request ${open.id} is open`,
        );
      }
      const running = transcript.backgroundTasks[0];
      if (running !== undefined) {
        throw new TranscriptInvariantError(
          `a switch to session ${event.session} while background task ${running.id} is running`,
        );
      }
      return {
        ...transcript,
        entries: [],
        usage: undefined,
        session: { ...transcript.session, sessionId: event.session },
      };
    }
    case "restarted":
      return {
        ...transcript,
        entries: transcript.entries.map(withProcessEnded),
        requests: [],
        sending: [],
        backgroundTasks: [],
        compacting: false,
      };
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

/**
 * `entry` once the CLI process that was running it has ended (it was
 * replaced, or the entry is read back from a session file): a call still
 * running was interrupted, a message still streaming ends where it got to,
 * and a subagent or background task it started cannot run now, though how it
 * ended nobody recorded. Anything else is as it was.
 */
export function withProcessEnded(entry: TranscriptEntry): TranscriptEntry {
  switch (entry.kind) {
    case "assistant":
      return entry.streaming ? { ...entry, streaming: false } : entry;
    case "tool": {
      const status = entry.status === "running" ? "interrupted" : entry.status;
      const spawns =
        entry.spawns?.state === "running" || entry.spawns?.state === "idle"
          ? { ...entry.spawns, state: "unknown" as const }
          : entry.spawns;
      const background =
        entry.background?.state === "running"
          ? { state: "unknown" as const, summary: undefined }
          : entry.background;
      return status === entry.status &&
        spawns === entry.spawns &&
        background === entry.background
        ? entry
        : { ...entry, status, spawns, background };
    }
    default:
      return entry;
  }
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

function backgroundTasks(
  transcript: Transcript,
  tasks: readonly RunningTask[],
): readonly RunningTask[] {
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) {
      throw new TranscriptInvariantError(
        `background task ${task.id} is listed twice`,
      );
    }
    seen.add(task.id);
    if (task.call !== undefined)
      requireToolEntry(
        transcript.entries,
        task.call,
        `call of background task ${task.id}`,
      );
  }
  return tasks;
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
  const kept = transcript.entries.slice(0, index);
  const orphan = transcript.backgroundTasks.find(
    (task) => task.call !== undefined && indexOfEntry(kept, task.call) < 0,
  );
  if (orphan !== undefined) {
    throw new TranscriptInvariantError(
      `a rewind to ${from} takes back ${orphan.call}, which started background task ${orphan.id}, still running`,
    );
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Readings. Pure derivations the reconcile round and the page both take from
// a Transcript, so neither works them out a second time.

/** Whether two lists of background tasks say the same, task for task. */
export function sameRunningTasks(
  one: readonly RunningTask[],
  other: readonly RunningTask[],
): boolean {
  return (
    one.length === other.length &&
    one.every(
      (task, index) =>
        task.id === other[index]!.id &&
        task.kind === other[index]!.kind &&
        task.title === other[index]!.title &&
        task.call === other[index]!.call &&
        task.startedAt === other[index]!.startedAt &&
        sameStoppable(task.stoppable, other[index]!.stoppable),
    )
  );
}

function sameStoppable(
  one: RunningTask["stoppable"],
  other: RunningTask["stoppable"],
): boolean {
  return one === true || other === true
    ? one === other
    : one.reason === other.reason;
}

/** The entries directly under `parent` (`null` for the top level), in display order. */
export function childrenOf(
  transcript: Transcript,
  parent: EntryId | null,
): readonly TranscriptEntry[] {
  return transcript.entries.filter((entry) => parentOf(entry) === parent);
}

/**
 * The usage limit the conversation stands stopped at, if it does: its last
 * top-level entry is the end of a turn a limit stopped (`TurnEndEntry.limit`),
 * and nothing has happened since — no turn running, nothing written and not
 * taken, nothing held, no question open. Anything that moves the
 * conversation on — the person's words, a turn the Agent starts, a restart,
 * a rewind, another session — ends it, which is the one rule that ends a
 * `LimitResume`.
 */
export function limitStop(
  transcript: Transcript,
):
  | { readonly entry: EntryId; readonly resetsAt: number | undefined }
  | undefined {
  const { state, requests, pending, sending, entries } = transcript;
  if (state.phase !== "ready" || state.turn !== "none") return undefined;
  if (requests.length > 0 || pending.length > 0 || sending.length > 0)
    return undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (parentOf(entry) !== null) continue;
    return entry.kind === "turn-end" && entry.limit !== undefined
      ? { entry: entry.id, resetsAt: entry.limit.resetsAt }
      : undefined;
  }
  return undefined;
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
 *
 * Working is the turn's alone: the adapter says a turn runs from the moment
 * a message is written to the CLI until the CLI's own end of the turn that
 * answers it (Claude's `result`, Codex's `turn/completed`), whatever the CLI
 * printed or did not print in between. What is drawn as sending plays no
 * part in it. DevHub's hold on the person's words counts too, because
 * stopping the CLI (a stop, a continue) loses them: one DevHub holds at the
 * prompt — open to change, or its write failed — waits on the person
 * (`waiting`).
 *
 * With no turn running, what the Agent set going apart from its turn — a
 * command, a subagent, a teammate still at work — is `background`: it is not
 * idle, because stopping it stops them, and it is not working, because it
 * takes the person's next message as an idle Agent does. A failed last turn
 * still says `error` first: that is the one the person has to read.
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
      if (transcript.pending.length > 0) return "waiting";
      if (lastTurnFailed(transcript)) return "error";
      return transcript.backgroundTasks.length > 0 ? "background" : "idle";
  }
}

/**
 * What the Agent is doing, in its own words: the title of the latest running
 * tool call, else the in-progress step of the latest plan. Outside a turn,
 * what works in the background: the one task's title, or how many there are.
 */
export function conversationActivity(
  transcript: Transcript,
): string | undefined {
  const { state, entries, backgroundTasks } = transcript;
  if (state.phase !== "ready") return undefined;
  if (state.turn !== "running") {
    if (state.turn !== "none" || backgroundTasks.length === 0) return undefined;
    return backgroundTasks.length === 1
      ? backgroundTasks[0]!.title
      : `${String(backgroundTasks.length)} background tasks`;
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind === "tool" && entry.status === "running") return entry.title;
  }
  const plan = latestPlan(transcript)?.steps;
  return plan?.find((step) => step.status === "in_progress")?.text;
}

/**
 * The Agent's plan as it last stood: the latest plan block of an answer
 * (Codex) or plan a call set (Claude's TodoWrite), and the entry it is on.
 */
export function latestPlan(
  transcript: Transcript,
):
  | { readonly entry: EntryId; readonly steps: readonly PlanStep[] }
  | undefined {
  const { entries } = transcript;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind === "tool" && entry.plan !== undefined)
      return { entry: entry.id, steps: entry.plan };
    if (entry.kind !== "assistant") continue;
    for (let block = entry.blocks.length - 1; block >= 0; block -= 1) {
      const candidate = entry.blocks[block]!;
      if (candidate.kind === "plan")
        return { entry: entry.id, steps: candidate.steps };
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
 * top-level messages, those DevHub sent for them after a usage limit
 * included, that the CLI can cut before, when the session can take turns
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
      (entry.origin === "person" || entry.origin === "after-limit") &&
      entry.rewindable
        ? [entry.id]
        : [],
    ),
  );
}

const NO_TARGETS: ReadonlySet<EntryId> = new Set();
