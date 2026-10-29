/**
 * The names people gave the Agents that ran each CLI session.
 *
 * A person names an Agent (`Agent.named`) to tell it from the rest, and the
 * conversation it held outlives it: the Agent is closed, the session is still
 * in the CLI's own store, and the resume lists — New Agent's earlier
 * sessions, `/resume` — offer it again under the CLI's title or first prompt,
 * which is not the word the person scanned for. So DevHub writes down which
 * name went with which session, and the lists lead with it.
 *
 * Kept in `state.json` (`session_names`), main's like `recently_closed`, with
 * no version bump for the same reason: absent is the empty list, which is what
 * every file written before it means, an entry that does not read is left out
 * rather than refusing the file, and an older DevHub that drops the key loses
 * only these labels. Bounded (`SESSION_NAMES_LIMIT`), newest first; a session
 * named again keeps only its newest name.
 *
 * A session is named by its CLI's kind and its id together — Claude's session
 * id, Codex's thread id — because the two stores are separate and nothing
 * stops two ids being spelled the same.
 */

/** How many sessions' names are remembered. The oldest is forgotten first. */
export const SESSION_NAMES_LIMIT = 200;

export type SessionNameKind = "claude" | "codex";

export interface SessionNameRecord {
  kind: SessionNameKind;
  /** Claude's session id, Codex's thread id. */
  session: string;
  /** The name the person gave the Agent. */
  name: string;
  /** When it was written down, in ms since the epoch. */
  at: number;
}

/** The same shape a session id is checked against elsewhere in the state file. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * `names` with `record` at the head: any earlier name of the same session
 * dropped, and the oldest beyond the limit forgotten. The same list back when
 * nothing would change, so a caller can tell whether there is anything to save.
 */
export function rememberSessionName(
  names: readonly SessionNameRecord[],
  record: SessionNameRecord,
): SessionNameRecord[] {
  const head = names[0];
  if (
    head !== undefined &&
    head.kind === record.kind &&
    head.session === record.session &&
    head.name === record.name
  ) {
    return names as SessionNameRecord[];
  }
  return [
    record,
    ...names.filter(
      (each) => !(each.kind === record.kind && each.session === record.session),
    ),
  ].slice(0, SESSION_NAMES_LIMIT);
}

/** The name the Agent that ran `session` was given, if one was. */
export function sessionNameOf(
  names: readonly SessionNameRecord[],
  kind: SessionNameKind,
  session: string,
): string | undefined {
  return names.find((each) => each.kind === kind && each.session === session)
    ?.name;
}

/**
 * The state file's `session_names`, read leniently: absent is the empty
 * list, and an entry that is not a record of this shape is left out.
 */
export function decodeSessionNames(value: unknown): SessionNameRecord[] {
  if (!Array.isArray(value)) return [];
  const records: SessionNameRecord[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const { kind, session, name, at } = entry as Record<string, unknown>;
    if (kind !== "claude" && kind !== "codex") continue;
    if (typeof session !== "string" || !SESSION_ID.test(session)) continue;
    if (typeof name !== "string" || name.trim().length === 0) continue;
    if (typeof at !== "number" || !Number.isFinite(at)) continue;
    records.push({ kind, session, name, at });
  }
  return records.slice(0, SESSION_NAMES_LIMIT);
}
