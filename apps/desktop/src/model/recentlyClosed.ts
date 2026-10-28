/**
 * What was closed lately, so that `Cmd+Q Shift+T` can open it again — the
 * browser's Reopen Closed Tab, for Workspaces and Agents.
 *
 * A stack, newest first and bounded (`RECENTLY_CLOSED_LIMIT`): each reopen
 * takes the newest entry, so pressing the chord again goes further back. It is
 * kept in `state.json` (`recently_closed`) beside the rest of DevHub's state,
 * so a restart does not forget it; a file written before it existed has no
 * such key and loads as the empty stack. No version bump, for the reason
 * `sidebar.collapsed` had none: an older DevHub drops the key on its next save
 * and loses only the history, never work.
 *
 * # What an entry remembers
 *
 * Exactly what opening the thing again *the same way* needs, and nothing that
 * would only be stale by then:
 *
 * - **A Workspace**: its place — the machine (`local`, or `ssh` and the host)
 *   and the canonical path — and the dev container its editor was attached
 *   to, if it was. Scratch never closes, so it is never here; yesterday's
 *   daily folder is an ordinary local folder. And the Agents that were
 *   running in it when it closed, each as an Agent entry would remember it.
 * - **An Agent**: the place of its Workspace (by place, not id — a Workspace
 *   closed and opened again is a new id for the same folder), the profile it
 *   was started from, its name and whether a person gave that name
 *   (`Agent.named`), whether it was a terminal or DevHub's conversation view,
 *   and the session id its CLI named — Claude's session, Codex's thread —
 *   which is what makes it something that can come back at all.
 *
 * # The decisions
 *
 * **An Agent comes back only as the session it was.** Reopening is resuming,
 * the way Restart Session and Continue in Terminal resume: an Agent with no
 * session id (its CLI had not said anything yet, or is a kind DevHub cannot
 * resume), or whose session is gone, is not started afresh under its old name
 * — that would be a new conversation pretending to be the closed one. The
 * reopen says why in a notice and drops the entry, so the next press goes
 * further back; `Cmd+Q C` starts a new Agent for whoever wants one.
 *
 * **A Workspace brings its Agents back.** Closing a Workspace closes its
 * Agents with it, and reopening it is undoing that close — so every Agent that
 * can be resumed is started again in it, resuming its session, with its name.
 * The ones that cannot are named in the notice and left behind.
 *
 * **A Workspace that is already open is focused, not opened twice.** Its
 * Agents are then not started again in it — somebody already opened it by hand
 * and may have resumed them already — but they are put back on the stack, so
 * the next press brings back each one deliberately.
 *
 * **A worktree deleted by its close is not remembered.** There is no folder
 * to open; remembering it would only produce a notice saying so. A folder
 * that is gone by the time it is reopened (deleted by hand, a disk not
 * mounted) is said in a notice and the entry dropped.
 *
 * **A failure that may pass leaves the entry where it was.** A host that does
 * not answer, a launch that failed: the entry is put back, so pressing again
 * tries again rather than skipping something that was never reopened.
 *
 * The record shapes are the state file's own (snake_case, `kind`-tagged), and
 * the stack is kept as records: it is main's, like `session_machines`, never
 * the model's, because nothing on screen is drawn from it but its picker.
 */

import {
  AGENT_PRESENTATIONS,
  AGENT_PROFILE_KINDS,
  type AgentPresentation,
  type AgentProfileKind,
} from "./domain.js";

/** How many closed things are remembered. The oldest is forgotten first. */
export const RECENTLY_CLOSED_LIMIT = 20;

/** Where a closed Workspace was, and how its editor was attached. */
export type ClosedPlaceRecord = (
  | { kind: "local"; path: string }
  | { kind: "ssh"; host: string; path: string }
) & {
  /** The `devcontainer.json` its editor was attached to; absent for its own machine. */
  dev_container?: string;
};

/** A closed Agent, as reopening it needs it. */
export interface ClosedAgentRecord {
  profile_id: string;
  profile_kind: AgentProfileKind;
  display_name: string;
  /** The name is a person's word, not DevHub's label. See `Agent.named`. */
  named?: boolean;
  presentation: AgentPresentation;
  /** Claude's session id, Codex's thread id. Absent: nothing to resume. */
  session?: string;
}

export type ClosedEntryRecord =
  | {
      kind: "workspace";
      /** When it was closed, in ms since the epoch. */
      closed_at: number;
      place: ClosedPlaceRecord;
      /** The Agents that were running in it when it closed, in sidebar order. */
      agents: ClosedAgentRecord[];
    }
  | {
      kind: "agent";
      closed_at: number;
      /** Its Workspace's place. */
      place: ClosedPlaceRecord;
      agent: ClosedAgentRecord;
    };

/** What makes two places the same folder: the machine and the path. */
export function placeKey(place: ClosedPlaceRecord): string {
  return place.kind === "local"
    ? place.path
    : `ssh://${place.host}${place.path}`;
}

/** The place for a person: `host:path` when it is not this machine. */
export function placeLabel(place: ClosedPlaceRecord): string {
  return place.kind === "local" ? place.path : `${place.host}:${place.path}`;
}

/**
 * Remember one more closed thing, newest first.
 *
 * A Workspace closed again replaces the older entry for the same folder: two
 * entries for one folder would reopen it once and focus it the second time.
 * Agents are not merged — two Agents closed from one folder are two
 * conversations.
 */
export function rememberClosed(
  stack: readonly ClosedEntryRecord[],
  entry: ClosedEntryRecord,
  limit: number = RECENTLY_CLOSED_LIMIT,
): ClosedEntryRecord[] {
  const key = placeKey(entry.place);
  const rest =
    entry.kind === "workspace"
      ? stack.filter(
          (each) => each.kind !== "workspace" || placeKey(each.place) !== key,
        )
      : stack;
  return [entry, ...rest].slice(0, limit);
}

/** The stack without the entry at `index`. */
export function withoutEntry(
  stack: readonly ClosedEntryRecord[],
  index: number,
): ClosedEntryRecord[] {
  return stack.filter((_each, at) => at !== index);
}

/** The stack with `entry` put back at `index` (clamped), still bounded. */
export function restoreEntry(
  stack: readonly ClosedEntryRecord[],
  index: number,
  entry: ClosedEntryRecord,
  limit: number = RECENTLY_CLOSED_LIMIT,
): ClosedEntryRecord[] {
  const at = Math.max(0, Math.min(index, stack.length));
  return [...stack.slice(0, at), entry, ...stack.slice(at)].slice(0, limit);
}

/** A Workspace's Agents, each as an entry of its own — newest last, so the first is on top. */
export function agentEntriesOf(
  entry: Extract<ClosedEntryRecord, { kind: "workspace" }>,
): Extract<ClosedEntryRecord, { kind: "agent" }>[] {
  return entry.agents.map((agent) => ({
    kind: "agent",
    closed_at: entry.closed_at,
    place: entry.place,
    agent,
  }));
}

/**
 * The session an Agent comes back as, or why it cannot come back.
 *
 * Only Claude and Codex keep sessions DevHub can resume; an Agent of another
 * CLI, or one whose CLI had not named its session yet, has none.
 */
export function resumableSession(
  agent: ClosedAgentRecord,
): { kind: "session"; session: string } | { kind: "none"; why: string } {
  if (agent.profile_kind !== "claude" && agent.profile_kind !== "codex") {
    return {
      kind: "none",
      why: `“${agent.display_name}” ran a ${agent.profile_kind} CLI, which keeps no session DevHub can resume.`,
    };
  }
  if (agent.session === undefined) {
    return {
      kind: "none",
      why: `“${agent.display_name}” had not started a session when it was closed, so there is none to resume.`,
    };
  }
  return { kind: "session", session: agent.session };
}

/** One entry, said for a person: what the picker and the notices call it. */
export function closedEntryLabel(entry: ClosedEntryRecord): string {
  switch (entry.kind) {
    case "workspace":
      return `Workspace ${placeLabel(entry.place)}`;
    case "agent":
      return `Agent “${entry.agent.display_name}” in ${placeLabel(entry.place)}`;
  }
}

/** The picker's second line: what came with it, and when it closed. */
export function closedEntryDetail(
  entry: ClosedEntryRecord,
  now: number,
): string {
  const ago = closedAgo(now - entry.closed_at);
  if (entry.kind === "agent") {
    const shown = entry.agent.presentation === "gui" ? "GUI" : "terminal";
    return `${shown} · closed ${ago}`;
  }
  const count = entry.agents.length;
  const agents =
    count === 0 ? "no Agents" : count === 1 ? "1 Agent" : `${count} Agents`;
  return `${agents} · closed ${ago}`;
}

function closedAgo(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

// ------------------------------------------------------------------ decoding

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbsolute(value: unknown): value is string {
  return (
    typeof value === "string" && value.startsWith("/") && !value.includes("\0")
  );
}

function isMember<T extends string>(
  value: unknown,
  members: readonly T[],
): value is T {
  return (
    typeof value === "string" && (members as readonly string[]).includes(value)
  );
}

function decodePlace(value: unknown): ClosedPlaceRecord | undefined {
  if (!isObject(value) || !isAbsolute(value["path"])) return undefined;
  const container = value["dev_container"];
  if (container !== undefined && !isAbsolute(container)) return undefined;
  const editor = container === undefined ? {} : { dev_container: container };
  if (value["kind"] === "local") {
    return { kind: "local", path: value["path"], ...editor };
  }
  if (
    value["kind"] === "ssh" &&
    typeof value["host"] === "string" &&
    value["host"].length > 0
  ) {
    return { kind: "ssh", host: value["host"], path: value["path"], ...editor };
  }
  return undefined;
}

function decodeAgent(value: unknown): ClosedAgentRecord | undefined {
  if (!isObject(value)) return undefined;
  const {
    profile_id: profileId,
    profile_kind: profileKind,
    display_name: displayName,
    presentation,
    session,
    named,
  } = value;
  if (
    typeof profileId !== "string" ||
    !isMember(profileKind, AGENT_PROFILE_KINDS) ||
    typeof displayName !== "string" ||
    !isMember(presentation, AGENT_PRESENTATIONS) ||
    (session !== undefined &&
      (typeof session !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(session)))
  ) {
    return undefined;
  }
  return {
    profile_id: profileId,
    profile_kind: profileKind,
    display_name: displayName,
    ...(named === true ? { named: true } : {}),
    presentation,
    ...(session === undefined ? {} : { session }),
  };
}

function decodeEntry(value: unknown): ClosedEntryRecord | undefined {
  if (!isObject(value)) return undefined;
  const closedAt = value["closed_at"];
  const place = decodePlace(value["place"]);
  if (typeof closedAt !== "number" || !Number.isFinite(closedAt) || !place) {
    return undefined;
  }
  if (value["kind"] === "agent") {
    const agent = decodeAgent(value["agent"]);
    return agent && { kind: "agent", closed_at: closedAt, place, agent };
  }
  if (value["kind"] === "workspace" && Array.isArray(value["agents"])) {
    const agents = value["agents"].map(decodeAgent);
    if (agents.some((agent) => agent === undefined)) return undefined;
    return {
      kind: "workspace",
      closed_at: closedAt,
      place,
      agents: agents as ClosedAgentRecord[],
    };
  }
  return undefined;
}

/**
 * The stack as the file has it, with every entry that does not read left out.
 *
 * Never a refusal: this is a history of what was closed, not work, and a
 * state file quarantined over one unreadable line of it would lose the
 * Workspaces that *are* open to keep a list of ones that are not. An absent
 * key is the empty stack, which is what every older file means.
 */
export function decodeRecentlyClosed(value: unknown): ClosedEntryRecord[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(decodeEntry)
    .filter((entry): entry is ClosedEntryRecord => entry !== undefined)
    .slice(0, RECENTLY_CLOSED_LIMIT);
}
