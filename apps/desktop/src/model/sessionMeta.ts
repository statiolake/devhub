/**
 * The metadata (`model/agentMeta.ts`) of the Agents that ran each CLI session,
 * kept after the Agent is stopped or closed.
 *
 * An orchestrating agent tags the agents it starts (`parent=<id>`,
 * `issue=123`) and later wants the work back: the Agent was stopped or
 * closed, its conversation is still in the CLI's own store, and
 * `devhub --tell sessions --meta parent=<id>` finds it there. So DevHub
 * writes down, per session, the pairs and the name the Agent last had, and a
 * new Agent that goes on with the session (`agent resume`, New Agent's
 * earlier sessions, Reopen Closed, `/resume`) is given them back.
 *
 * Kept in a file of its own beside `state.json` (`session-meta.json`,
 * `main/agent/conversation/sessionMetaFile.ts`): versioned, replaced whole
 * by a rename, and an entry that does not read is left out rather than
 * refusing the file. A session is named by its CLI's kind and its id
 * together, as `sessionNames.ts` names one.
 *
 * Bounded: at most `SESSION_META_LIMIT` sessions, the most recently written
 * kept; and a session nothing has written for `SESSION_META_MAX_AGE_MS` is
 * forgotten. A session with no pairs left has no entry.
 */

import { checkedMeta, type AgentMeta } from "./agentMeta.js";
import type { SessionNameKind } from "./sessionNames.js";

/** How many sessions' metadata is remembered. The least recently written goes first. */
export const SESSION_META_LIMIT = 500;
/** A session's entry nothing has written for this long is forgotten: 180 days. */
export const SESSION_META_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
/** The file's version. */
export const SESSION_META_VERSION = 1;

export interface SessionMetaRecord {
  readonly kind: SessionNameKind;
  /** Claude's session id, Codex's thread id. */
  readonly session: string;
  /** The pairs the Agent had, never empty. */
  readonly meta: AgentMeta;
  /** The name the Agent had when this was written. */
  readonly name?: string;
  /** That name was given by a person (`Agent.named`), not DevHub's label. */
  readonly named?: boolean;
  /** When it was written, in ms since the epoch. */
  readonly at: number;
}

/** The same shape a session id is checked against elsewhere in the state file. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** Whether `session` can be a session id of the index. */
export function isSessionId(session: string): boolean {
  return SESSION_ID.test(session);
}

/** The records kept: none older than the age limit, at most the limit, newest first. */
export function boundedSessionMeta(
  records: readonly SessionMetaRecord[],
  now: number,
): SessionMetaRecord[] {
  return records
    .filter((record) => now - record.at <= SESSION_META_MAX_AGE_MS)
    .toSorted((a, b) => b.at - a.at)
    .slice(0, SESSION_META_LIMIT);
}

/**
 * `records` with `record` in place of the session's earlier entry (or with
 * none, when its meta is empty), bounded. The same list back when nothing
 * would change but the time, so a caller can tell whether to save.
 */
export function rememberSessionMeta(
  records: readonly SessionMetaRecord[],
  record: SessionMetaRecord,
): readonly SessionMetaRecord[] {
  const earlier = sessionMetaOf(records, record.kind, record.session);
  const empty = Object.keys(record.meta).length === 0;
  if (earlier === undefined && empty) return records;
  if (
    earlier !== undefined &&
    !empty &&
    sameMeta(earlier.meta, record.meta) &&
    earlier.name === record.name &&
    (earlier.named ?? false) === (record.named ?? false)
  )
    return records;
  const rest = records.filter(
    (each) => !(each.kind === record.kind && each.session === record.session),
  );
  return boundedSessionMeta(empty ? rest : [record, ...rest], record.at);
}

/** The entry of `session`, if it has one. */
export function sessionMetaOf(
  records: readonly SessionMetaRecord[],
  kind: SessionNameKind,
  session: string,
): SessionMetaRecord | undefined {
  return records.find((each) => each.kind === kind && each.session === session);
}

/** Whether two sets of pairs are the same pairs. */
export function sameMeta(a: AgentMeta, b: AgentMeta): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => b[key] === a[key])
  );
}

/** The file's text for `records`. */
export function encodeSessionMeta(
  records: readonly SessionMetaRecord[],
): string {
  return `${JSON.stringify({
    version: SESSION_META_VERSION,
    sessions: records.map((record) => ({
      kind: record.kind,
      session: record.session,
      meta: record.meta,
      ...(record.name === undefined ? {} : { name: record.name }),
      ...(record.named === true ? { named: true } : {}),
      at: record.at,
    })),
  })}\n`;
}

/** What is wrong with the file as a whole (not with one entry of it). */
export class SessionMetaRefused extends Error {}

/**
 * The file's records, bounded at `now`. Throws `SessionMetaRefused` for a
 * file that is not this kind of file (or another version of it); an entry
 * that does not read is left out.
 */
export function decodeSessionMeta(
  value: unknown,
  now: number,
): SessionMetaRecord[] {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new SessionMetaRefused("it is not an object");
  const { version, sessions } = value as Record<string, unknown>;
  if (version !== SESSION_META_VERSION)
    throw new SessionMetaRefused(`its version is ${JSON.stringify(version)}`);
  if (!Array.isArray(sessions))
    throw new SessionMetaRefused("its sessions are not a list");
  const records: SessionMetaRecord[] = [];
  const seen = new Set<string>();
  for (const entry of sessions as unknown[]) {
    const record = decodeRecord(entry);
    if (record === undefined) continue;
    const key = `${record.kind}\u0000${record.session}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(record);
  }
  return boundedSessionMeta(records, now);
}

function decodeRecord(entry: unknown): SessionMetaRecord | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const { kind, session, meta, name, named, at } = entry as Record<
    string,
    unknown
  >;
  if (kind !== "claude" && kind !== "codex") return undefined;
  if (typeof session !== "string" || !SESSION_ID.test(session))
    return undefined;
  if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
  if (name !== undefined && (typeof name !== "string" || name.trim() === ""))
    return undefined;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta))
    return undefined;
  const pairs = meta as Record<string, unknown>;
  if (Object.values(pairs).some((value) => typeof value !== "string"))
    return undefined;
  let checked: AgentMeta;
  try {
    checked = checkedMeta(pairs as Record<string, string>);
  } catch {
    // Not a swallow: an entry that does not read is left out, as the doc says.
    return undefined;
  }
  if (Object.keys(checked).length === 0) return undefined;
  return {
    kind,
    session,
    meta: checked,
    ...(name === undefined ? {} : { name }),
    ...(named === true ? { named: true } : {}),
    at,
  };
}
