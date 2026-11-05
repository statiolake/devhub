/**
 * Escalations: what the orchestrator asks the person, and the thread that
 * follows.
 *
 * An escalation is a request for a human decision or permission, raised when
 * work cannot go further without one. The orchestrator agent writes it after
 * reading the agents' questions and answers (`devhub --tell escalation new`);
 * the person answers it in DevHub's window, and only there; the orchestrator
 * carries the answer to the agents it is about, asks again on the same ticket
 * when something is still open, and closes it once the answer is used up.
 * See `docs/orchestrator.md`.
 *
 * # The state is the thread
 *
 * There is no stored state to drift from what was said: it is read off the
 * thread every time.
 *
 * **The one rule:** `needs_answer` (要回答) exactly when the last entry is
 * a question — the orchestrator's, with no `kind` (`escalation new`,
 * `escalation ask`); `closed` once closed; `in_progress` (対応中) otherwise.
 * Whatever comes after a question takes it out of 要回答, and only another
 * question (`askAgain`) puts it back:
 *
 * - the person's answer (role `human`, no `kind`), in the window only;
 * - the person's 対応中にする in the window (`taken`, role `human`, an
 *   optional note in `markdown`);
 * - the orchestrator's `escalation hold` (`held`, role `orchestrator`, an
 *   optional note): parked while it works on it. Never an answer;
 * - DevHub's notes that one of its agents went from idle to working while it
 *   waited (`noteWorking`): `direct` (role `human`) when the person talked to
 *   it from its own composer, `resumed` (role `orchestrator`: DevHub's, for
 *   the orchestrator's `agent send`, an event, a resume) for anything else.
 *   Empty `markdown`: what was said is in the agent's conversation.
 *
 * `role` says whose side an entry is on; only the window writes `human`
 * ones, and the person's answer is the only one with words of theirs
 * (`lastAnswer`).
 *
 * Pure: no clock (every operation is handed `now`), no I/O. The store that
 * keeps them on disk is `main/orchestrator/escalationStore.ts`.
 */

import {
  formatDevhubLink,
  isDevhubLink,
  parseDevhubLink,
} from "./devhubLink.js";

export type EscalationRole = "orchestrator" | "human";

export type EscalationState = "needs_answer" | "in_progress" | "closed";

export const ESCALATION_STATES: readonly EscalationState[] = [
  "needs_answer",
  "in_progress",
  "closed",
];

/**
 * What kind of entry: absent for a question or an answer; else a note that
 * moved it to `in_progress` without words to answer with (see the module's
 * doc): `direct` / `resumed`, an agent went working (`agent` names it);
 * `taken`, the person's 対応中にする; `held`, the orchestrator's
 * `escalation hold`.
 */
export type EscalationEntryKind = "direct" | "resumed" | "taken" | "held";

/** Each kind, and the side it is on. */
export const ESCALATION_ENTRY_KINDS: Readonly<
  Record<EscalationEntryKind, EscalationRole>
> = {
  direct: "human",
  resumed: "orchestrator",
  taken: "human",
  held: "orchestrator",
};

/** How long a `taken` or `held` note may be. */
export const NOTE_LIMIT = 2_000;

export interface EscalationEntry {
  readonly role: EscalationRole;
  /**
   * Rich Markdown, drawn by the conversation's own renderer. For a note
   * (`kind`): `taken`'s or `held`'s optional note, else empty.
   */
  readonly markdown: string;
  /** When it was written, ms since the epoch. */
  readonly at: number;
  /**
   * Quick replies the orchestrator suggests (its entries only). The person
   * may always write something else instead.
   */
  readonly options?: readonly string[];
  readonly kind?: EscalationEntryKind;
  /** `direct` / `resumed`: the agent that went working, by id. */
  readonly agent?: string;
}

/** A note (`kind`): not a question, and not anybody's answer. */
export function isNoteEntry(entry: EscalationEntry): boolean {
  return entry.kind !== undefined;
}

/**
 * How much it matters, as the orchestrator ranks it: `high` blocks several
 * agents or a deadline. Absent is `normal`.
 */
export type EscalationPriority = "high" | "normal" | "low";

/**
 * How long it takes the person to answer: `quick` is under about a minute,
 * from the escalation alone. Absent is `normal`.
 */
export type EscalationEffort = "quick" | "normal" | "deep";

export const ESCALATION_PRIORITIES: readonly EscalationPriority[] = [
  "high",
  "normal",
  "low",
];

export const ESCALATION_EFFORTS: readonly EscalationEffort[] = [
  "quick",
  "normal",
  "deep",
];

/**
 * The orchestrator's ranking, as it is given (`escalation new`, `escalation
 * rank`): what is left out stays as it was; a `note` of `""` takes it away.
 */
export interface EscalationRank {
  readonly priority?: EscalationPriority;
  readonly effort?: EscalationEffort;
  readonly note?: string;
}

export interface Escalation {
  /** A small number, shown as `#12`; unique per profile, never reused. */
  readonly id: number;
  readonly title: string;
  /** Never empty: an escalation is born with the orchestrator's question. */
  readonly entries: readonly EscalationEntry[];
  /** The agents it is about, by id. */
  readonly agents: readonly string[];
  /** The workspace it is about, by id, when one was named. */
  readonly workspaceId?: string;
  /** Issues, pull requests, documents: `https://` URLs. */
  readonly links: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Closed: when, and the orchestrator's last word on it. */
  readonly closed?: { readonly at: number; readonly note?: string };
  /** The orchestrator's ranking; absent is `normal`. */
  readonly priority?: EscalationPriority;
  readonly effort?: EscalationEffort;
  /** Why it is ranked so, in a line. */
  readonly rankNote?: string;
}

/** Limits, checked at every door (the CLI, the socket, the page, the file). */
export const TITLE_LIMIT = 200;
export const MARKDOWN_LIMIT = 200_000;
export const OPTION_LIMIT = 200;
export const OPTIONS_MAX = 8;
export const LINKS_MAX = 16;
export const AGENTS_MAX = 32;
export const ENTRIES_MAX = 200;
export const RANK_NOTE_LIMIT = 160;

export class EscalationError extends Error {
  override readonly name = "EscalationError";
}

function refuse(message: string): never {
  throw new EscalationError(message);
}

/** A question: the orchestrator's, not a note. */
export function isQuestion(entry: EscalationEntry | undefined): boolean {
  return entry?.role === "orchestrator" && entry.kind === undefined;
}

/** The one rule (see the module's doc): 要回答 while a question is last. */
export function escalationState(escalation: Escalation): EscalationState {
  if (escalation.closed !== undefined) return "closed";
  return isQuestion(escalation.entries.at(-1)) ? "needs_answer" : "in_progress";
}

/** Whether it is still being worked on: not closed. */
export function isOpen(escalation: Escalation): boolean {
  return escalation.closed === undefined;
}

/** Since when the state it is in has held: the last entry, or the close. */
export function stateSince(escalation: Escalation): number {
  return (
    escalation.closed?.at ??
    escalation.entries.at(-1)?.at ??
    escalation.createdAt
  );
}

export function priorityOf(escalation: Escalation): EscalationPriority {
  return escalation.priority ?? "normal";
}

export function effortOf(escalation: Escalation): EscalationEffort {
  return escalation.effort ?? "normal";
}

/** The person's last answer, when there is one. */
export function lastAnswer(
  escalation: Escalation,
): EscalationEntry | undefined {
  return [...escalation.entries]
    .reverse()
    .find((one) => one.role === "human" && !isNoteEntry(one));
}

/** The options the last question offered, when the last entry is a question. */
export function openOptions(escalation: Escalation): readonly string[] {
  const last = escalation.entries.at(-1);
  if (escalation.closed !== undefined || !isQuestion(last)) return [];
  return last?.options ?? [];
}

// --- checking ---------------------------------------------------------------

export function checkTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) refuse("an escalation needs a title.");
  if ([...trimmed].length > TITLE_LIMIT)
    refuse(`a title is at most ${String(TITLE_LIMIT)} characters.`);
  // eslint-disable-next-line no-control-regex -- control characters are the point
  if (/[\u0000-\u001f\u007f]/u.test(trimmed))
    refuse("a title is one line of text.");
  return trimmed;
}

export function checkMarkdown(markdown: string, what = "the body"): string {
  if (markdown.trim().length === 0) refuse(`${what} is empty.`);
  if (markdown.length > MARKDOWN_LIMIT)
    refuse(`${what} is longer than ${String(MARKDOWN_LIMIT)} characters.`);
  return markdown.replace(/\s+$/u, "");
}

export function checkOptions(
  options: readonly string[] | undefined,
): readonly string[] | undefined {
  if (options === undefined || options.length === 0) return undefined;
  if (options.length > OPTIONS_MAX)
    refuse(`at most ${String(OPTIONS_MAX)} options.`);
  const checked = options.map((option) => {
    const trimmed = option.trim();
    if (trimmed.length === 0) refuse("an option is empty.");
    if ([...trimmed].length > OPTION_LIMIT)
      refuse(`an option is at most ${String(OPTION_LIMIT)} characters.`);
    // eslint-disable-next-line no-control-regex -- control characters are the point
    if (/[\u0000-\u001f\u007f]/u.test(trimmed))
      refuse("an option is one line of text.");
    return trimmed;
  });
  if (new Set(checked).size !== checked.length)
    refuse("the same option is given twice.");
  return checked;
}

export function checkPriority(value: unknown): EscalationPriority {
  if (!ESCALATION_PRIORITIES.includes(value as EscalationPriority))
    refuse(
      `a priority is ${ESCALATION_PRIORITIES.join(", ")}, not ${JSON.stringify(value)}.`,
    );
  return value as EscalationPriority;
}

export function checkEffort(value: unknown): EscalationEffort {
  if (!ESCALATION_EFFORTS.includes(value as EscalationEffort))
    refuse(
      `an effort is ${ESCALATION_EFFORTS.join(", ")}, not ${JSON.stringify(value)}.`,
    );
  return value as EscalationEffort;
}

export function checkRankNote(note: string): string {
  const trimmed = note.trim();
  if ([...trimmed].length > RANK_NOTE_LIMIT)
    refuse(`a rank note is at most ${String(RANK_NOTE_LIMIT)} characters.`);
  // eslint-disable-next-line no-control-regex -- control characters are the point
  if (/[\u0000-\u001f\u007f]/u.test(trimmed))
    refuse("a rank note is one line of text.");
  return trimmed;
}

/**
 * `rank` laid over `escalation`'s own: `normal` is stored as nothing, and
 * an empty note takes the note away.
 */
function withRank(escalation: Escalation, rank: EscalationRank): Escalation {
  const {
    priority: _priority,
    effort: _effort,
    rankNote: _note,
    ...rest
  } = escalation;
  const priority =
    rank.priority === undefined
      ? escalation.priority
      : checkPriority(rank.priority);
  const effort =
    rank.effort === undefined ? escalation.effort : checkEffort(rank.effort);
  const note =
    rank.note === undefined ? escalation.rankNote : checkRankNote(rank.note);
  return {
    ...rest,
    ...(priority === undefined || priority === "normal" ? {} : { priority }),
    ...(effort === undefined || effort === "normal" ? {} : { effort }),
    ...(note === undefined || note === "" ? {} : { rankNote: note }),
  };
}

/**
 * An escalation's link: an http(s) URL, or a place inside DevHub
 * (`model/devhubLink.ts`), kept in its canonical spelling. Whether a
 * `devhub:` link's target exists is the command line's to check
 * (`tell/service.ts`); a stored one whose target has gone is drawn as
 * 見つかりません, never followed.
 */
export function checkLink(link: string): string {
  if (isDevhubLink(link)) {
    const parsed = parseDevhubLink(link);
    if (!parsed.ok)
      refuse(
        `${JSON.stringify(link)} is not a devhub: link: ${parsed.problem}`,
      );
    return formatDevhubLink(parsed.link);
  }
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    refuse(`${JSON.stringify(link)} is not a URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    refuse(
      `a link is an http(s) URL or a devhub: link, not ${JSON.stringify(link)}.`,
    );
  return url.toString();
}

function union(
  before: readonly string[],
  added: readonly string[],
  max: number,
  what: string,
): readonly string[] {
  const all = [...before];
  for (const one of added) if (!all.includes(one)) all.push(one);
  if (all.length > max) refuse(`at most ${String(max)} ${what}.`);
  return all;
}

function entry(
  role: EscalationRole,
  markdown: string,
  at: number,
  options?: readonly string[],
): EscalationEntry {
  const checked = checkOptions(options);
  return {
    role,
    markdown: checkMarkdown(markdown),
    at,
    ...(checked === undefined ? {} : { options: checked }),
  };
}

function appended(escalation: Escalation, next: EscalationEntry): Escalation {
  if (escalation.closed !== undefined)
    refuse(`#${String(escalation.id)} is closed.`);
  if (escalation.entries.length >= ENTRIES_MAX)
    refuse(
      `#${String(escalation.id)} has ${String(ENTRIES_MAX)} entries: close it and raise a new one.`,
    );
  return {
    ...escalation,
    entries: [...escalation.entries, next],
    updatedAt: next.at,
  };
}

// --- what can happen to one ---------------------------------------------------

export interface NewEscalation {
  readonly title: string;
  readonly markdown: string;
  readonly options?: readonly string[];
  readonly agents?: readonly string[];
  readonly workspaceId?: string;
  readonly links?: readonly string[];
  readonly rank?: EscalationRank;
}

/** The orchestrator raises one: born `needs_answer`. */
export function createEscalation(
  id: number,
  request: NewEscalation,
  now: number,
): Escalation {
  const links = union(
    [],
    (request.links ?? []).map(checkLink),
    LINKS_MAX,
    "links",
  );
  return withRank(
    {
      id,
      title: checkTitle(request.title),
      entries: [entry("orchestrator", request.markdown, now, request.options)],
      agents: union([], request.agents ?? [], AGENTS_MAX, "agents"),
      ...(request.workspaceId === undefined
        ? {}
        : { workspaceId: request.workspaceId }),
      links,
      createdAt: now,
      updatedAt: now,
    },
    request.rank ?? {},
  );
}

/**
 * The orchestrator ranks it again, as things change. Only what is given
 * moves; an open one only, since a closed one is on nobody's list.
 */
export function rankEscalation(
  escalation: Escalation,
  rank: EscalationRank,
  now: number,
): Escalation {
  if (escalation.closed !== undefined)
    refuse(`#${String(escalation.id)} is closed.`);
  if (
    rank.priority === undefined &&
    rank.effort === undefined &&
    rank.note === undefined
  )
    refuse("a rank gives a priority, an effort or a note.");
  return { ...withRank(escalation, rank), updatedAt: now };
}

/** A follow-up question on the same ticket: back to `needs_answer`. */
export function askAgain(
  escalation: Escalation,
  markdown: string,
  options: readonly string[] | undefined,
  now: number,
  /** More links it is about (`escalation ask --link`), kept once each. */
  links: readonly string[] = [],
): Escalation {
  const asked = appended(
    escalation,
    entry("orchestrator", markdown, now, options),
  );
  if (links.length === 0) return asked;
  return {
    ...asked,
    links: union(escalation.links, links.map(checkLink), LINKS_MAX, "links"),
  };
}

/**
 * The person's answer: to `in_progress`. **The window's only.** No command
 * line path reaches this (`tell/service.ts` has no port that can).
 */
export function answerEscalation(
  escalation: Escalation,
  markdown: string,
  now: number,
): Escalation {
  return appended(escalation, entry("human", markdown, now));
}

/**
 * `agentId`, one of the agents it is about, went back to work while it
 * waited: DevHub's note of it (`kind`), human-side, so a `needs_answer` one
 * moves to `in_progress`. **DevHub's only** — the orchestrator service
 * writes it when it sees that happen; no command line path reaches it. Only
 * on a `needs_answer` one: an `in_progress` or a closed one is left as it is.
 */
export function noteWorking(
  escalation: Escalation,
  kind: "direct" | "resumed",
  agentId: string,
  now: number,
): Escalation {
  if (escalationState(escalation) !== "needs_answer")
    refuse(`#${String(escalation.id)} is not waiting for an answer.`);
  if (!escalation.agents.includes(agentId))
    refuse(`#${String(escalation.id)} is not about ${agentId}.`);
  return appended(escalation, {
    role: ESCALATION_ENTRY_KINDS[kind],
    kind,
    agent: agentId,
    markdown: "",
    at: now,
  });
}

function checkNote(note: string | undefined): string {
  const trimmed = (note ?? "").trim();
  if (trimmed.length > NOTE_LIMIT)
    refuse(`a note is at most ${String(NOTE_LIMIT)} characters.`);
  return trimmed;
}

/**
 * Moved to `in_progress` without an answer: the person's 対応中にする
 * (`taken`, **the window's only**) or the orchestrator's `escalation hold`
 * (`held`, never a human entry). Only on a `needs_answer` one.
 */
export function takeEscalation(
  escalation: Escalation,
  kind: "taken" | "held",
  note: string | undefined,
  now: number,
): Escalation {
  if (escalationState(escalation) !== "needs_answer")
    refuse(
      `#${String(escalation.id)} is not waiting for an answer (${escalationState(escalation)}).`,
    );
  return appended(escalation, {
    role: ESCALATION_ENTRY_KINDS[kind],
    kind,
    markdown: checkNote(note),
    at: now,
  });
}

/** The answer has been used up: closed, with the orchestrator's note. */
export function closeEscalation(
  escalation: Escalation,
  note: string | undefined,
  now: number,
): Escalation {
  if (escalation.closed !== undefined)
    refuse(`#${String(escalation.id)} is already closed.`);
  const trimmed = note?.trim();
  return {
    ...escalation,
    closed: {
      at: now,
      ...(trimmed === undefined || trimmed === ""
        ? {}
        : { note: checkMarkdown(trimmed, "the note") }),
    },
    updatedAt: now,
  };
}

/** Another agent it is about. */
export function linkAgent(
  escalation: Escalation,
  agentId: string,
  now: number,
): Escalation {
  if (escalation.agents.includes(agentId)) return escalation;
  return {
    ...escalation,
    agents: union(escalation.agents, [agentId], AGENTS_MAX, "agents"),
    updatedAt: now,
  };
}

// --- the board ----------------------------------------------------------------

/**
 * How long an idle agent may go unaccounted for before the board lists it:
 * a minute. An agent that has just finished (or just started) is idle for a
 * moment before the orchestrator reads it and gives it its next task, and a
 * lane that blinked with every turn's end would be noise nobody reads.
 */
export const UNACCOUNTED_GRACE_MS = 60_000;

/** One agent, as much of it as the 不明 rule reads. */
export interface BoardAgent {
  readonly id: string;
  readonly name: string;
  readonly workspaceId: string;
  readonly workspaceLabel: string;
  /** `working`, `idle`, `waiting`, …: the Sidebar's status. */
  readonly status: string;
  /** Not `running`: stopping, or a stop that failed. */
  readonly stopping: boolean;
  /** Since when it has been `idle`, as main saw it; undefined when it is not. */
  readonly idleSince: number | undefined;
}

export interface UnaccountedAgent {
  readonly agentId: string;
  readonly name: string;
  readonly workspaceId: string;
  readonly workspaceLabel: string;
  readonly idleSince: number;
}

/**
 * 不明: the agents nobody is accounting for — idle for longer than the grace,
 * not the orchestrator, not stopping, and not named by any open escalation
 * (needs_answer or in_progress). Longest idle first.
 *
 * Computed from live state on every reading; it is never stored, so it can
 * never be stale or be "cleared" by anybody. It empties itself when the agent
 * is given work, or an escalation names it.
 */
export function unaccountedAgents(
  agents: readonly BoardAgent[],
  escalations: readonly Escalation[],
  orchestratorAgentId: string | undefined,
  now: number,
  graceMs: number = UNACCOUNTED_GRACE_MS,
): readonly UnaccountedAgent[] {
  const accounted = new Set(
    escalations.filter(isOpen).flatMap((escalation) => escalation.agents),
  );
  return agents
    .filter(
      (agent) =>
        agent.id !== orchestratorAgentId &&
        agent.status === "idle" &&
        !agent.stopping &&
        agent.idleSince !== undefined &&
        now - agent.idleSince >= graceMs &&
        !accounted.has(agent.id),
    )
    .map((agent) => ({
      agentId: agent.id,
      name: agent.name,
      workspaceId: agent.workspaceId,
      workspaceLabel: agent.workspaceLabel,
      idleSince: agent.idleSince!,
    }))
    .sort((left, right) => left.idleSince - right.idleSince);
}

/**
 * 要回答's order before age: priority (high first), then effort (quick
 * first) — so the person takes what matters, and what is quick, first.
 */
export function byRank(left: Escalation, right: Escalation): number {
  return (
    ESCALATION_PRIORITIES.indexOf(priorityOf(left)) -
      ESCALATION_PRIORITIES.indexOf(priorityOf(right)) ||
    ESCALATION_EFFORTS.indexOf(effortOf(left)) -
      ESCALATION_EFFORTS.indexOf(effortOf(right))
  );
}

export interface Board {
  /**
   * Ranked (`byRank`), then oldest question first: among equals, the one
   * waiting longest leads.
   */
  readonly needsAnswer: readonly Escalation[];
  /** Answered longest ago first: the one the agents have waited on longest. */
  readonly inProgress: readonly Escalation[];
  /** Most recently closed first. */
  readonly closed: readonly Escalation[];
  readonly unaccounted: readonly UnaccountedAgent[];
}

export function board(
  escalations: readonly Escalation[],
  agents: readonly BoardAgent[],
  orchestratorAgentId: string | undefined,
  now: number,
  graceMs: number = UNACCOUNTED_GRACE_MS,
): Board {
  const bySince = (left: Escalation, right: Escalation) =>
    stateSince(left) - stateSince(right) || left.id - right.id;
  return {
    needsAnswer: escalations
      .filter((one) => escalationState(one) === "needs_answer")
      .sort((left, right) => byRank(left, right) || bySince(left, right)),
    inProgress: escalations
      .filter((one) => escalationState(one) === "in_progress")
      .sort(bySince),
    closed: escalations
      .filter((one) => escalationState(one) === "closed")
      .sort((left, right) => bySince(right, left)),
    unaccounted: unaccountedAgents(
      agents,
      escalations,
      orchestratorAgentId,
      now,
      graceMs,
    ),
  };
}

// --- on disk ------------------------------------------------------------------

export const ESCALATIONS_FILE_VERSION = 1;

export interface EscalationsFile {
  readonly version: typeof ESCALATIONS_FILE_VERSION;
  /** The number the next escalation gets. */
  readonly next: number;
  /** The agent assigned to the Orchestrator row, when one is. */
  readonly orchestratorAgentId?: string;
  readonly escalations: readonly Escalation[];
}

export const EMPTY_ESCALATIONS: EscalationsFile = {
  version: ESCALATIONS_FILE_VERSION,
  next: 1,
  escalations: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteTime(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    refuse(`${what} is not a time.`);
  return value;
}

function strings(value: unknown, what: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((one) => typeof one !== "string"))
    refuse(`${what} is not a list of strings.`);
  return value as string[];
}

function entryFrom(value: unknown, where: string): EscalationEntry {
  if (!isRecord(value)) refuse(`${where} is not an entry.`);
  const role = value["role"];
  if (role !== "orchestrator" && role !== "human")
    refuse(`${where}'s role is not orchestrator or human.`);
  if (value["kind"] !== undefined) {
    const kind = value["kind"];
    if (
      typeof kind !== "string" ||
      !Object.hasOwn(ESCALATION_ENTRY_KINDS, kind) ||
      ESCALATION_ENTRY_KINDS[kind as EscalationEntryKind] !== role
    )
      refuse(`${where}'s kind is not one this DevHub reads.`);
    const at = finiteTime(value["at"], `${where}'s time`);
    if (kind === "taken" || kind === "held")
      return {
        role,
        kind,
        markdown: checkNote(
          typeof value["markdown"] === "string" ? value["markdown"] : "",
        ),
        at,
      };
    if (typeof value["agent"] !== "string" || value["agent"] === "")
      refuse(`${where} names no agent.`);
    return {
      role,
      kind: kind as EscalationEntryKind,
      agent: value["agent"],
      markdown: "",
      at,
    };
  }
  if (typeof value["markdown"] !== "string")
    refuse(`${where} has no markdown.`);
  const options =
    value["options"] === undefined
      ? undefined
      : checkOptions(strings(value["options"], `${where}'s options`));
  return {
    role,
    markdown: checkMarkdown(value["markdown"]),
    at: finiteTime(value["at"], `${where}'s time`),
    ...(options === undefined || role !== "orchestrator" ? {} : { options }),
  };
}

function escalationFrom(value: unknown, at: number): Escalation {
  const where = `escalation ${String(at + 1)}`;
  if (!isRecord(value)) refuse(`${where} is not an escalation.`);
  const id = value["id"];
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1)
    refuse(`${where}'s id is not a positive whole number.`);
  if (typeof value["title"] !== "string") refuse(`${where} has no title.`);
  if (!Array.isArray(value["entries"]) || value["entries"].length === 0)
    refuse(`${where} has no entries.`);
  const entries = value["entries"].map((one: unknown, index: number) =>
    entryFrom(one, `${where}'s entry ${String(index + 1)}`),
  );
  const closed = value["closed"];
  if (closed !== undefined && !isRecord(closed))
    refuse(`${where}'s close is not a record.`);
  const workspaceId = value["workspaceId"];
  if (workspaceId !== undefined && typeof workspaceId !== "string")
    refuse(`${where}'s workspace is not an id.`);
  const rankNote = value["rankNote"];
  if (rankNote !== undefined && typeof rankNote !== "string")
    refuse(`${where}'s rank note is not text.`);
  // Written before there was a ranking: normal, normal, no note.
  const priority =
    value["priority"] === undefined
      ? undefined
      : checkPriority(value["priority"]);
  const effort =
    value["effort"] === undefined ? undefined : checkEffort(value["effort"]);
  return {
    id,
    title: checkTitle(value["title"]),
    entries,
    agents: strings(value["agents"], `${where}'s agents`),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    links: strings(value["links"], `${where}'s links`).map(checkLink),
    createdAt: finiteTime(value["createdAt"], `${where}'s creation`),
    updatedAt: finiteTime(value["updatedAt"], `${where}'s update`),
    ...(closed === undefined
      ? {}
      : {
          closed: {
            at: finiteTime(closed["at"], `${where}'s close time`),
            ...(typeof closed["note"] === "string" && closed["note"] !== ""
              ? { note: closed["note"] }
              : {}),
          },
        }),
    ...(priority === undefined || priority === "normal" ? {} : { priority }),
    ...(effort === undefined || effort === "normal" ? {} : { effort }),
    ...(rankNote === undefined || rankNote === ""
      ? {}
      : { rankNote: checkRankNote(rankNote) }),
  };
}

/** A file read back: refused whole, as the corrupt file it is, or accepted whole. */
export function escalationsFromJson(value: unknown): EscalationsFile {
  if (!isRecord(value)) refuse("the escalations file is not a JSON object.");
  if (value["version"] !== ESCALATIONS_FILE_VERSION)
    refuse(
      `the escalations file is version ${String(value["version"])}, and this DevHub reads ${String(ESCALATIONS_FILE_VERSION)}.`,
    );
  if (!Array.isArray(value["escalations"]))
    refuse("the escalations file has no list of escalations.");
  const escalations = value["escalations"].map(escalationFrom);
  const ids = new Set(escalations.map((one) => one.id));
  if (ids.size !== escalations.length)
    refuse("the escalations file has two escalations with one id.");
  const highest = Math.max(0, ...ids);
  const next = value["next"];
  const orchestrator = value["orchestratorAgentId"];
  if (orchestrator !== undefined && typeof orchestrator !== "string")
    refuse("the escalations file's orchestrator is not an agent id.");
  return {
    version: ESCALATIONS_FILE_VERSION,
    next:
      typeof next === "number" && Number.isInteger(next) && next > highest
        ? next
        : highest + 1,
    ...(orchestrator === undefined
      ? {}
      : { orchestratorAgentId: orchestrator }),
    escalations,
  };
}

/** `#12`, `12` or `E12`: the id it names, or undefined. */
export function parseEscalationId(text: string): number | undefined {
  const match = /^(?:#|e|E)?(\d{1,9})$/u.exec(text.trim());
  if (match === null) return undefined;
  const id = Number(match[1]);
  return id >= 1 ? id : undefined;
}
