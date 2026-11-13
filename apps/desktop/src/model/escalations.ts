/**
 * Escalations: one question the orchestrator asks the person, and their
 * one answer.
 *
 * An escalation belongs to exactly one task (`model/tasks.ts`): the piece
 * of work the decision is about. It is raised by the orchestrator
 * (`devhub --tell escalation new --task T`), answered by the person in
 * DevHub's window and only there, or withdrawn by the orchestrator when the
 * question no longer stands. Answered or withdrawn, it is closed for good:
 * a follow-up question is a new escalation on the same task, never a
 * reopen. See `docs/orchestrator.md`, "Escalations".
 *
 * **Its state is what it holds:** `open` while it has neither an answer nor
 * a withdrawal, `answered` once the person answered, `withdrawn` once the
 * orchestrator took it back. Nothing moves on by a deadline: what the
 * person is asked waits for the person.
 *
 * Pure: no clock (every operation is handed `now`), no I/O. The store that
 * keeps them on disk, with their tasks, is `main/orchestrator/taskStore.ts`.
 */

import {
  formatDevhubLink,
  isDevhubLink,
  parseDevhubLink,
} from "./devhubLink.js";

export type EscalationState = "open" | "answered" | "withdrawn";

export const ESCALATION_STATES: readonly EscalationState[] = [
  "open",
  "answered",
  "withdrawn",
];

/** The orchestrator's question: rich Markdown, and quick replies. */
export interface EscalationQuestion {
  readonly markdown: string;
  /** When it was asked, ms since the epoch. */
  readonly at: number;
  /** Quick replies; the person may always write something else instead. */
  readonly options?: readonly string[];
}

/** The person's answer. */
export interface EscalationAnswer {
  readonly markdown: string;
  readonly at: number;
  /** The quick reply it is, when the person picked one. */
  readonly option?: string;
  /**
   * Settled by the person directly, not in the window: they told an agent
   * of the task what to do (`task.human_direct`), and the orchestrator
   * closed the question with it (`escalation resolve`). `markdown` is then
   * what they wrote to that agent, as DevHub read it; `note` is the
   * orchestrator's line on how it settles the question.
   */
  readonly direct?: EscalationDirect;
}

/** How a direct instruction settled a question (`resolveEscalation`). */
export interface EscalationDirect {
  /** The agent the person wrote to. */
  readonly agentId: string;
  /** When they wrote it (the first of a burst). */
  readonly sentAt: number;
  readonly note?: string;
}

export interface Escalation {
  /** A small number, shown as `#12`; unique per profile, never reused. */
  readonly id: number;
  /** The task it is about. */
  readonly taskId: number;
  readonly title: string;
  readonly question: EscalationQuestion;
  /** Issues, pull requests, documents: `https://` or `devhub:` links. */
  readonly links: readonly string[];
  /** What a link is, in a line (`--link URL=LABEL`), by the link as stored. */
  readonly linkLabels?: Readonly<Record<string, string>>;
  readonly createdAt: number;
  readonly answer?: EscalationAnswer;
  /** Taken back by the orchestrator: when, and why. */
  readonly withdrawn?: { readonly at: number; readonly note?: string };
}

/** Limits, checked at every door (the CLI, the socket, the page, the file). */
export const TITLE_LIMIT = 200;
export const MARKDOWN_LIMIT = 200_000;
export const OPTION_LIMIT = 200;
export const OPTIONS_MAX = 8;
export const LINKS_MAX = 16;
export const LINK_LABEL_LIMIT = 120;
export const NOTE_LIMIT = 2_000;

export class EscalationError extends Error {
  override readonly name = "EscalationError";
}

function refuse(message: string): never {
  throw new EscalationError(message);
}

export function escalationState(escalation: Escalation): EscalationState {
  if (escalation.answer !== undefined) return "answered";
  if (escalation.withdrawn !== undefined) return "withdrawn";
  return "open";
}

export function isOpen(escalation: Escalation): boolean {
  return escalationState(escalation) === "open";
}

/** When it was closed (answered or withdrawn), or undefined while open. */
export function closedAt(escalation: Escalation): number | undefined {
  return escalation.answer?.at ?? escalation.withdrawn?.at;
}

// --- checking ---------------------------------------------------------------

// eslint-disable-next-line no-control-regex -- control characters are the point
const CONTROL = /[\u0000-\u001f\u007f]/u;

export function checkTitle(title: string, what = "an escalation"): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) refuse(`${what} needs a title.`);
  if ([...trimmed].length > TITLE_LIMIT)
    refuse(`a title is at most ${String(TITLE_LIMIT)} characters.`);
  if (CONTROL.test(trimmed)) refuse("a title is one line of text.");
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
    if (CONTROL.test(trimmed)) refuse("an option is one line of text.");
    return trimmed;
  });
  if (new Set(checked).size !== checked.length)
    refuse("the same option is given twice.");
  return checked;
}

/**
 * A link: an http(s) URL, or a place inside DevHub (`model/devhubLink.ts`),
 * kept in its canonical spelling. Whether a `devhub:` link's target exists
 * is the command line's to check (`tell/service.ts`).
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

export function checkLinkLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed === "") refuse("a link's label is empty.");
  if ([...trimmed].length > LINK_LABEL_LIMIT)
    refuse(`a link's label is at most ${String(LINK_LABEL_LIMIT)} characters.`);
  if (CONTROL.test(trimmed)) refuse("a link's label is one line of text.");
  return trimmed;
}

export function checkNote(note: string | undefined): string | undefined {
  const trimmed = (note ?? "").trim();
  if (trimmed === "") return undefined;
  if (trimmed.length > NOTE_LIMIT)
    refuse(`a note is at most ${String(NOTE_LIMIT)} characters.`);
  return trimmed;
}

/**
 * `links` (checked, kept once each, at most `LINKS_MAX`) and their labels,
 * keyed by the stored spelling; only labels of links in the list are kept.
 */
export function checkLinks(
  links: readonly string[],
  labels: Readonly<Record<string, string>> | undefined,
  before: {
    readonly links: readonly string[];
    readonly linkLabels?: Readonly<Record<string, string>>;
  } = { links: [] },
): {
  readonly links: readonly string[];
  readonly linkLabels?: Readonly<Record<string, string>>;
} {
  const all = [...before.links];
  for (const one of links.map(checkLink)) if (!all.includes(one)) all.push(one);
  if (all.length > LINKS_MAX) refuse(`at most ${String(LINKS_MAX)} links.`);
  const next: Record<string, string> = { ...before.linkLabels };
  for (const [link, label] of Object.entries(labels ?? {})) {
    const stored = checkLink(link);
    if (!all.includes(stored))
      refuse(`${JSON.stringify(link)} is labelled and not one of its links.`);
    next[stored] = checkLinkLabel(label);
  }
  return Object.keys(next).length === 0
    ? { links: all }
    : { links: all, linkLabels: next };
}

// --- what can happen to one ---------------------------------------------------

export interface NewEscalation {
  readonly taskId: number;
  readonly title: string;
  readonly markdown: string;
  readonly options?: readonly string[];
  readonly links?: readonly string[];
  /** What each link is (`--link URL=LABEL`), by the link as given. */
  readonly linkLabels?: Readonly<Record<string, string>>;
}

/** The orchestrator asks: born `open`. */
export function createEscalation(
  id: number,
  request: NewEscalation,
  now: number,
): Escalation {
  const options = checkOptions(request.options);
  return {
    id,
    taskId: request.taskId,
    title: checkTitle(request.title),
    question: {
      markdown: checkMarkdown(request.markdown),
      at: now,
      ...(options === undefined ? {} : { options }),
    },
    ...checkLinks(request.links ?? [], request.linkLabels),
    createdAt: now,
  };
}

/**
 * The person's answer: closes it. **The window's only.** No command line
 * path reaches this (`tell/service.ts` has no port that can).
 */
export function answerEscalation(
  escalation: Escalation,
  markdown: string,
  now: number,
): Escalation {
  if (!isOpen(escalation))
    refuse(
      `#${String(escalation.id)} is ${escalationState(escalation)}: a follow-up is a new escalation.`,
    );
  const text = checkMarkdown(markdown, "the answer");
  const option = escalation.question.options?.find(
    (one) => one === text.trim(),
  );
  return {
    ...escalation,
    answer: {
      markdown: text,
      at: now,
      ...(option === undefined ? {} : { option }),
    },
  };
}

/**
 * The person settled it directly: what they told an agent of its task
 * (`words`, as DevHub read it off that agent's conversation) answers or
 * overrides the question. Closes it as answered — by the person, with their
 * own words — never as withdrawn. Reached by `escalation resolve`, and only
 * for an instruction DevHub saw the person give (`OrchestratorService`
 * checks); the orchestrator writes the note, never the words.
 */
export function resolveEscalation(
  escalation: Escalation,
  direct: {
    readonly words: string;
    readonly agentId: string;
    readonly sentAt: number;
    readonly note?: string;
  },
  now: number,
): Escalation {
  if (!isOpen(escalation))
    refuse(
      `#${String(escalation.id)} is ${escalationState(escalation)} already.`,
    );
  const note = checkNote(direct.note);
  return {
    ...escalation,
    answer: {
      markdown: checkMarkdown(direct.words, "the person's instruction"),
      at: now,
      direct: {
        agentId: direct.agentId,
        sentAt: direct.sentAt,
        ...(note === undefined ? {} : { note }),
      },
    },
  };
}

/** Whether it was settled by the person directly (`resolveEscalation`). */
export function settledDirectly(escalation: Escalation): boolean {
  return escalation.answer?.direct !== undefined;
}

/** The orchestrator takes it back: the question no longer stands. */
export function withdrawEscalation(
  escalation: Escalation,
  note: string | undefined,
  now: number,
): Escalation {
  if (!isOpen(escalation))
    refuse(
      `#${String(escalation.id)} is ${escalationState(escalation)} already.`,
    );
  const checked = checkNote(note);
  return {
    ...escalation,
    withdrawn: { at: now, ...(checked === undefined ? {} : { note: checked }) },
  };
}

// --- on disk ------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function finiteTime(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    refuse(`${what} is not a time.`);
  return value;
}

export function strings(value: unknown, what: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((one) => typeof one !== "string"))
    refuse(`${what} is not a list of strings.`);
  return value as string[];
}

export function labelsFrom(
  value: unknown,
  where: string,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) refuse(`${where}'s link labels are not a record.`);
  return Object.fromEntries(
    Object.entries(value).map(([link, label]) => {
      if (typeof label !== "string")
        refuse(`${where}'s label of ${link} is not text.`);
      return [link, label];
    }),
  );
}

/** One escalation read back from the file; refused when it does not read. */
export function escalationFrom(value: unknown, where: string): Escalation {
  if (!isRecord(value)) refuse(`${where} is not an escalation.`);
  const id = value["id"];
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1)
    refuse(`${where}'s id is not a positive whole number.`);
  const taskId = value["taskId"];
  if (typeof taskId !== "number" || !Number.isInteger(taskId) || taskId < 1)
    refuse(`${where} belongs to no task.`);
  if (typeof value["title"] !== "string") refuse(`${where} has no title.`);
  const question = value["question"];
  if (!isRecord(question) || typeof question["markdown"] !== "string")
    refuse(`${where} has no question.`);
  const options = checkOptions(
    strings(question["options"], `${where}'s options`),
  );
  const answer = value["answer"];
  if (answer !== undefined && !isRecord(answer))
    refuse(`${where}'s answer is not a record.`);
  const withdrawn = value["withdrawn"];
  if (withdrawn !== undefined && !isRecord(withdrawn))
    refuse(`${where}'s withdrawal is not a record.`);
  return {
    id,
    taskId,
    title: checkTitle(value["title"]),
    question: {
      markdown: checkMarkdown(question["markdown"]),
      at: finiteTime(question["at"], `${where}'s question time`),
      ...(options === undefined ? {} : { options }),
    },
    ...checkLinks(
      strings(value["links"], `${where}'s links`),
      labelsFrom(value["linkLabels"], where),
    ),
    createdAt: finiteTime(value["createdAt"], `${where}'s creation`),
    ...(answer === undefined
      ? {}
      : {
          answer: {
            markdown: checkMarkdown(
              typeof answer["markdown"] === "string" ? answer["markdown"] : "",
              `${where}'s answer`,
            ),
            at: finiteTime(answer["at"], `${where}'s answer time`),
            ...(typeof answer["option"] === "string"
              ? { option: answer["option"] }
              : {}),
            ...directFrom(answer["direct"]),
          },
        }),
    ...(withdrawn === undefined || answer !== undefined
      ? {}
      : {
          withdrawn: {
            at: finiteTime(withdrawn["at"], `${where}'s withdrawal time`),
            ...(typeof withdrawn["note"] === "string" &&
            withdrawn["note"] !== ""
              ? { note: withdrawn["note"] }
              : {}),
          },
        }),
  };
}

/** An answer's `direct`, read back; anything that does not read is left out. */
function directFrom(value: unknown): { direct?: EscalationDirect } {
  if (!isRecord(value)) return {};
  const agentId = value["agentId"];
  const sentAt = value["sentAt"];
  if (typeof agentId !== "string" || agentId === "") return {};
  if (typeof sentAt !== "number" || !Number.isFinite(sentAt)) return {};
  const note = value["note"];
  return {
    direct: {
      agentId,
      sentAt,
      ...(typeof note === "string" && note !== "" ? { note } : {}),
    },
  };
}

/** `#12`, `12`, `E12` or `esc=12`: the id it names, or undefined. */
export function parseEscalationId(text: string): number | undefined {
  const match = /^(?:#|e|E|esc=)?(\d{1,9})$/u.exec(text.trim());
  if (match === null) return undefined;
  const id = Number(match[1]);
  return id >= 1 ? id : undefined;
}
