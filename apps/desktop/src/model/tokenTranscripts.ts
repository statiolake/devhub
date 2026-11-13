/**
 * The token usage in Claude's and Codex's transcripts, line by line.
 *
 * Each CLI writes its own JSONL, and both say a request's usage more than once:
 *
 * - **Claude** (`<config>/projects/<cwd>/<session>.jsonl`, and a subagent's
 *   own file under `<session>/subagents/agent-<id>.jsonl`) writes one
 *   `assistant` line per content block of a response, every one of them with
 *   the whole response's `message.usage`. So a request is its `message.id`
 *   (else its `requestId`, else the line's `uuid`), and its usage is the
 *   largest of each count across its lines — a stream that wrote an early
 *   block with a smaller `output_tokens` is not counted twice nor short. A
 *   resumed or forked session's file copies the earlier lines with their ids,
 *   so the id is kept across files too (`tokenIndex.ts`). Lines marked
 *   `isSidechain` (a subagent's, written inline by older versions, or in its
 *   own file) are the subagent's. `<synthetic>` lines, which no request
 *   made, carry no usage.
 * - **Codex** (`<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*-<thread>.jsonl`)
 *   writes `event_msg` lines of type `token_count`, each with the thread's
 *   running total and the last request's usage — and writes it again when
 *   only the rate limits changed. So a request is the thread and the running
 *   total it brought the thread to: one key per new total, a repeat is the
 *   same key. Codex's `input_tokens` includes its `cached_input_tokens`;
 *   here input is the uncached part. Codex has no cache writes. The model is
 *   the latest `turn_context`'s.
 *
 * Pure: text in, usage out. What a file has been read up to is the caller's.
 */

import type { TokenCounts } from "./tokenPrices.js";

export type TokenCli = "claude" | "codex";

/** One request's usage, as a transcript says it. */
export interface UsageEvent {
  /** What makes it this request: duplicates share it. */
  readonly key: string;
  /** When, in ms since the epoch. */
  readonly at: number;
  readonly model: string;
  readonly counts: TokenCounts;
  /** Fast mode (`usage.speed`). */
  readonly fast?: true;
  /** A subagent's (`isSidechain`): its `agentId`, or `sidechain`. */
  readonly subagent?: string;
}

/** What a file's lines say besides usage, kept with how far it was read. */
export interface TranscriptState {
  /** The folder the CLI ran in, from the first line that says it. */
  readonly cwd?: string;
  /** Claude's `sessionId`, Codex's thread id. */
  readonly session?: string;
  /** Codex: the model of the latest `turn_context`. */
  readonly model?: string;
  /** A line longer than a read was being passed over: skip to its end. */
  readonly skipToLine?: true;
}

type Json = Record<string, unknown>;

const object = (value: unknown): Json | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const time = (value: unknown): number | undefined => {
  if (typeof value !== "string") return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
};

function parse(line: string): Json | undefined {
  if (line.length === 0 || line.charCodeAt(0) !== 123) return undefined;
  try {
    return object(JSON.parse(line));
  } catch {
    // A line cut short or not JSON says nothing about usage.
    return undefined;
  }
}

/** Claude's `message.usage`, as counts. */
export function claudeCounts(usage: Json): TokenCounts {
  const write = count(usage["cache_creation_input_tokens"]);
  const split = object(usage["cache_creation"]);
  const write1h = split ? count(split["ephemeral_1h_input_tokens"]) : 0;
  // The split, when given, says which TTL; what it does not account for is
  // the default, five minutes.
  const write5m = split
    ? Math.max(count(split["ephemeral_5m_input_tokens"]), write - write1h)
    : write;
  return {
    input: count(usage["input_tokens"]),
    output: count(usage["output_tokens"]),
    cacheRead: count(usage["cache_read_input_tokens"]),
    cacheWrite5m: write5m,
    cacheWrite1h: write1h,
  };
}

const empty = (counts: TokenCounts): boolean =>
  counts.input +
    counts.output +
    counts.cacheRead +
    counts.cacheWrite5m +
    counts.cacheWrite1h ===
  0;

/** The usage in a chunk of Claude's lines (whole lines only). */
export function claudeUsage(
  lines: string,
  state: TranscriptState,
): { readonly events: UsageEvent[]; readonly state: TranscriptState } {
  const events: UsageEvent[] = [];
  let next = state;
  for (const line of lines.split("\n")) {
    if (!line.includes('"usage"') && next.cwd !== undefined) continue;
    const entry = parse(line);
    if (entry === undefined) continue;
    if (next.cwd === undefined && text(entry["cwd"]) !== undefined)
      next = { ...next, cwd: text(entry["cwd"]) };
    if (next.session === undefined && text(entry["sessionId"]) !== undefined)
      next = { ...next, session: text(entry["sessionId"]) };
    if (entry["type"] !== "assistant") continue;
    const message = object(entry["message"]);
    const usage = message ? object(message["usage"]) : undefined;
    if (!message || !usage) continue;
    const model = text(message["model"]) ?? "unknown";
    if (model === "<synthetic>") continue;
    const counts = claudeCounts(usage);
    if (empty(counts)) continue;
    const key =
      text(message["id"]) ?? text(entry["requestId"]) ?? text(entry["uuid"]);
    const at = time(entry["timestamp"]);
    if (key === undefined || at === undefined) continue;
    events.push({
      key,
      at,
      model,
      counts,
      ...(usage["speed"] === "fast" ? { fast: true as const } : {}),
      ...(entry["isSidechain"] === true
        ? { subagent: text(entry["agentId"]) ?? "sidechain" }
        : {}),
    });
  }
  return { events, state: next };
}

/** The usage in a chunk of a Codex rollout's lines (whole lines only). */
export function codexUsage(
  lines: string,
  state: TranscriptState,
): { readonly events: UsageEvent[]; readonly state: TranscriptState } {
  const events: UsageEvent[] = [];
  let next = state;
  for (const line of lines.split("\n")) {
    const entry = parse(line);
    if (entry === undefined) continue;
    const payload = object(entry["payload"]);
    if (!payload) continue;
    switch (entry["type"]) {
      case "session_meta":
        next = {
          ...next,
          ...(text(payload["id"]) === undefined
            ? {}
            : { session: text(payload["id"]) }),
          ...(text(payload["cwd"]) === undefined
            ? {}
            : { cwd: text(payload["cwd"]) }),
        };
        continue;
      case "turn_context":
        if (text(payload["model"]) !== undefined)
          next = { ...next, model: text(payload["model"]) };
        continue;
      case "event_msg": {
        if (payload["type"] !== "token_count") continue;
        const info = object(payload["info"]);
        const total = info ? object(info["total_token_usage"]) : undefined;
        const last = info ? object(info["last_token_usage"]) : undefined;
        const at = time(entry["timestamp"]);
        if (!total || !last || at === undefined) continue;
        const cached = count(last["cached_input_tokens"]);
        const counts: TokenCounts = {
          input: Math.max(0, count(last["input_tokens"]) - cached),
          output: count(last["output_tokens"]),
          cacheRead: cached,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
        };
        if (empty(counts)) continue;
        const running =
          count(total["total_tokens"]) ||
          count(total["input_tokens"]) + count(total["output_tokens"]);
        events.push({
          key: `${next.session ?? "thread"}:${String(running)}`,
          at,
          model: next.model ?? "codex",
          counts,
        });
        continue;
      }
      default:
        continue;
    }
  }
  return { events, state: next };
}

/**
 * The whole lines of a chunk read from a file, and how many of its bytes
 * they are: a last line not yet ended is left for the next read.
 */
export function wholeLines(chunk: Uint8Array): {
  readonly text: string;
  readonly bytes: number;
} {
  const end = chunk.lastIndexOf(10);
  if (end < 0) return { text: "", bytes: 0 };
  return {
    text: new TextDecoder().decode(chunk.subarray(0, end)),
    bytes: end + 1,
  };
}
