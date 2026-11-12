/**
 * Tasks: the orchestrator's pieces of work, as DevHub keeps them.
 *
 * A task is an internal ticket — no thread, no body — that says what the
 * work is (a title), what it is about (0..n links: Issues and pull
 * requests by URL, or anything else), which agents work on it (bound, with
 * the CLI sessions they ran, so `agent resume <task>` brings the same
 * agent back), one memo of what is next, a priority, and whether it is
 * done. The orchestrator creates, edits and completes tasks freely
 * (`devhub --tell task …`); the person makes one with the board's +.
 * DevHub's nudges and events are about tasks (`main/orchestrator/`), and
 * the person's decisions are escalations on a task (`model/escalations.ts`).
 * See `docs/orchestrator.md`, "Tasks".
 *
 * **Its status** is one of 待機, 処理中, 回答待ち, or done:
 *
 * - `done` once completed (`task done`);
 * - `answer` (回答待ち) **derived**: not done and an escalation on it is
 *   open — the stored status cannot disagree with the questions it has;
 * - else the stored one: `in_progress` (処理中) or `waiting` (待機, parked
 *   on purpose, with what it waits for in words and maybe a time to look
 *   again: `waitNote`, `checkAt`).
 *
 * The person's answer sets the stored status to `in_progress` (the answer
 * is work to carry out); a bound agent going to work moves a `waiting` one
 * to `in_progress` (`main/orchestrator/taskStore.ts`). Neither a deadline
 * nor `checkAt` ever decides anything: `checkAt` only wakes the
 * orchestrator to look.
 *
 * Pure: no clock (every operation is handed `now`), no I/O.
 */

import {
  EscalationError,
  checkLink,
  checkLinks,
  checkMarkdown,
  checkNote,
  checkTitle,
  escalationFrom,
  finiteTime,
  isOpen,
  isRecord,
  labelsFrom,
  strings,
  type Escalation,
} from "./escalations.js";

export type StoredTaskStatus = "waiting" | "in_progress";

/** What the board and the CLI say a task is. */
export type TaskStatus = "answer" | "in_progress" | "waiting" | "done";

export const TASK_STATUSES: readonly TaskStatus[] = [
  "answer",
  "in_progress",
  "waiting",
  "done",
];

/** The board's word for each. */
export const TASK_STATUS_WORDS: Readonly<Record<TaskStatus, string>> = {
  answer: "回答待ち",
  in_progress: "処理中",
  waiting: "待機",
  done: "完了",
};

export type TaskPriority = "high" | "normal" | "low";

export const TASK_PRIORITIES: readonly TaskPriority[] = [
  "high",
  "normal",
  "low",
];

export function isTaskPriority(value: unknown): value is TaskPriority {
  return value === "high" || value === "normal" || value === "low";
}

/**
 * An agent bound to the task, and what it takes to bring it back: kept
 * after it stops and across restarts. The same conversation is the same
 * agent: one that goes on with a recorded session takes its entry's place.
 */
export interface TaskAgent {
  readonly agentId: string;
  readonly name: string;
  /** The name was given by a person or the orchestrator (`--name`). */
  readonly named?: boolean;
  readonly profileId?: string;
  /** The CLI: only Claude's and Codex's sessions are resumed. */
  readonly kind?: string;
  /** The model it ran on over its profile's own (`agentModel.ts`). */
  readonly model?: string;
  readonly presentation?: "gui" | "tui";
  /** `local`, or `ssh:<host>`. */
  readonly machine?: string;
  /** The Workspace's folder it ran in. */
  readonly folder?: string;
  readonly branch?: string;
  /** The CLI sessions it ran, oldest first: the last is the one to resume. */
  readonly sessions: readonly string[];
  readonly boundAt: number;
  readonly seenAt?: number;
  /** Gone from the window (stopped, closed, its CLI ended) since. */
  readonly stoppedAt?: number;
}

export interface Task {
  /** A small number, shown as `#12` and said `task=12`; never reused. */
  readonly id: number;
  readonly title: string;
  readonly status: StoredTaskStatus;
  /** `waiting`: what it waits for, in words. */
  readonly waitNote?: string;
  /** `waiting`: when to look again (ms since the epoch). Never decides. */
  readonly checkAt?: number;
  /** Issues, pull requests, anything: `https://` or `devhub:` links. */
  readonly links: readonly string[];
  readonly linkLabels?: Readonly<Record<string, string>>;
  /** Oldest first; the last is the one `agent resume <task>` brings back. */
  readonly agents: readonly TaskAgent[];
  /** The one note: what the orchestrator means to do next with it. */
  readonly memo?: { readonly text: string; readonly at: number };
  /** Absent is `normal`. */
  readonly priority?: Exclude<TaskPriority, "normal">;
  readonly priorityNote?: string;
  /** Made from the person's request (the board's +): their words. */
  readonly request?: {
    readonly text: string;
    readonly at: number;
    /** Delivered to the orchestrator; absent while held (off, or none running). */
    readonly sentAt?: number;
  };
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly done?: { readonly at: number; readonly note?: string };
}

export const MEMO_LIMIT = 500;
export const WAIT_NOTE_LIMIT = 500;
export const PRIORITY_NOTE_LIMIT = 160;
export const REQUEST_LIMIT = 20_000;
export const TASK_AGENTS_MAX = 8;
export const TASK_SESSIONS_MAX = 10;

function refuse(message: string): never {
  throw new EscalationError(message);
}

/** The status the board files it under (see the module's doc). */
export function taskStatus(
  task: Task,
  escalations: readonly Escalation[],
): TaskStatus {
  if (task.done !== undefined) return "done";
  if (escalations.some((one) => one.taskId === task.id && isOpen(one)))
    return "answer";
  return task.status;
}

export function priorityOf(task: Task): TaskPriority {
  return task.priority ?? "normal";
}

// --- checking ---------------------------------------------------------------

export function checkMemo(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) refuse("the memo is empty.");
  if (trimmed.length > MEMO_LIMIT)
    refuse(
      `the memo is ${String(trimmed.length)} characters; keep it to ${String(MEMO_LIMIT)}: what you will do next with this task, in a line or a few. The details belong to the agent, the Issue or an escalation.`,
    );
  return trimmed;
}

function checkWaitNote(note: string | undefined): string | undefined {
  const trimmed = (note ?? "").trim();
  if (trimmed === "") return undefined;
  if (trimmed.length > WAIT_NOTE_LIMIT)
    refuse(`a wait's note is at most ${String(WAIT_NOTE_LIMIT)} characters.`);
  return trimmed;
}

function checkPriorityNote(note: string): string | undefined {
  const trimmed = note.trim();
  if (trimmed === "") return undefined;
  if ([...trimmed].length > PRIORITY_NOTE_LIMIT)
    refuse(
      `a priority note is at most ${String(PRIORITY_NOTE_LIMIT)} characters.`,
    );
  // eslint-disable-next-line no-control-regex -- control characters are the point
  if (/[\u0000-\u001f\u007f]/u.test(trimmed))
    refuse("a priority note is one line of text.");
  return trimmed;
}

function checkCheckAt(at: number | undefined): number | undefined {
  if (at === undefined) return undefined;
  if (!Number.isFinite(at)) refuse("--check-at is not a time.");
  return at;
}

function openOnly(task: Task): void {
  if (task.done !== undefined)
    refuse(`task #${String(task.id)} is done: make a new task for new work.`);
}

// --- what can happen to one ---------------------------------------------------

export interface NewTask {
  readonly title: string;
  readonly links?: readonly string[];
  readonly linkLabels?: Readonly<Record<string, string>>;
  /** Absent: `waiting` — nothing is happening on it yet. */
  readonly status?: StoredTaskStatus;
  readonly waitNote?: string;
  readonly checkAt?: number;
  readonly memo?: string;
  readonly priority?: TaskPriority;
  readonly priorityNote?: string;
  readonly request?: string;
}

function withStatus(
  task: Task,
  status: StoredTaskStatus,
  wait: { readonly note?: string; readonly checkAt?: number },
): Task {
  const { waitNote: _note, checkAt: _at, ...rest } = task;
  if (status === "in_progress") {
    if (wait.note !== undefined && wait.note.trim() !== "")
      refuse("--note is what a 待機 task waits for; 処理中 takes none.");
    if (wait.checkAt !== undefined)
      refuse("--check-at is for a 待機 task; 処理中 takes none.");
    return { ...rest, status };
  }
  const note = checkWaitNote(wait.note);
  const checkAt = checkCheckAt(wait.checkAt);
  return {
    ...rest,
    status,
    ...(note === undefined ? {} : { waitNote: note }),
    ...(checkAt === undefined ? {} : { checkAt }),
  };
}

function withPriority(
  task: Task,
  priority: TaskPriority | undefined,
  note: string | undefined,
): Task {
  if (priority === undefined && note === undefined) return task;
  const { priority: _p, priorityNote: _n, ...rest } = task;
  const level = priority ?? priorityOf(task);
  if (!isTaskPriority(level))
    refuse(
      `a priority is high, normal or low, not ${JSON.stringify(priority)}.`,
    );
  const checked =
    note === undefined ? task.priorityNote : checkPriorityNote(note);
  return {
    ...rest,
    ...(level === "normal" ? {} : { priority: level }),
    ...(checked === undefined ? {} : { priorityNote: checked }),
  };
}

export function createTask(id: number, request: NewTask, now: number): Task {
  const base: Task = {
    id,
    title: checkTitle(request.title, "a task"),
    status: "waiting",
    ...checkLinks(request.links ?? [], request.linkLabels),
    agents: [],
    createdAt: now,
    updatedAt: now,
    ...(request.memo === undefined
      ? {}
      : { memo: { text: checkMemo(request.memo), at: now } }),
    ...(request.request === undefined
      ? {}
      : {
          request: {
            text: checkMarkdown(request.request, "the request").slice(
              0,
              REQUEST_LIMIT,
            ),
            at: now,
          },
        }),
  };
  return withPriority(
    withStatus(base, request.status ?? "waiting", {
      ...(request.waitNote === undefined ? {} : { note: request.waitNote }),
      ...(request.checkAt === undefined ? {} : { checkAt: request.checkAt }),
    }),
    request.priority,
    request.priorityNote,
  );
}

export interface TaskEdit {
  readonly title?: string;
  /** `""` takes the memo away. */
  readonly memo?: string;
  readonly priority?: TaskPriority;
  /** `""` takes the note away. */
  readonly priorityNote?: string;
}

export function editTask(task: Task, edit: TaskEdit, now: number): Task {
  if (
    edit.title === undefined &&
    edit.memo === undefined &&
    edit.priority === undefined &&
    edit.priorityNote === undefined
  )
    refuse("task edit gives --title, --memo, --priority or --priority-note.");
  let next: Task = task;
  if (edit.title !== undefined)
    next = { ...next, title: checkTitle(edit.title, "a task") };
  if (edit.memo !== undefined) {
    const { memo: _memo, ...rest } = next;
    next =
      edit.memo.trim() === ""
        ? rest
        : { ...rest, memo: { text: checkMemo(edit.memo), at: now } };
  }
  next = withPriority(next, edit.priority, edit.priorityNote);
  return { ...next, updatedAt: now };
}

/** `task status`: 待機 (with what it waits for) or 処理中. */
export function setTaskStatus(
  task: Task,
  status: StoredTaskStatus,
  wait: { readonly note?: string; readonly checkAt?: number },
  now: number,
): Task {
  openOnly(task);
  if (status !== "waiting" && status !== "in_progress")
    refuse(
      `a task's status is waiting (待機) or in_progress (処理中), not ${JSON.stringify(status)}; 回答待ち is an open escalation, and done is 'task done'.`,
    );
  return { ...withStatus(task, status, wait), updatedAt: now };
}

export function linkTask(
  task: Task,
  links: readonly string[],
  labels: Readonly<Record<string, string>> | undefined,
  now: number,
): Task {
  if (links.length === 0) refuse("task link names at least one URL.");
  return { ...task, ...checkLinks(links, labels, task), updatedAt: now };
}

export function unlinkTask(
  task: Task,
  links: readonly string[],
  now: number,
): Task {
  const gone = new Set(links.map(checkLink));
  for (const one of gone)
    if (!task.links.includes(one))
      refuse(`task #${String(task.id)} has no link ${one}.`);
  const kept = task.links.filter((one) => !gone.has(one));
  const labels = Object.fromEntries(
    Object.entries(task.linkLabels ?? {}).filter(([link]) => !gone.has(link)),
  );
  const { linkLabels: _labels, ...rest } = task;
  return {
    ...rest,
    links: kept,
    ...(Object.keys(labels).length === 0 ? {} : { linkLabels: labels }),
    updatedAt: now,
  };
}

/** An agent bound (or bound again: its entry is brought to the end). */
export function bindAgent(
  task: Task,
  agent: { readonly agentId: string; readonly name: string },
  now: number,
): Task {
  openOnly(task);
  const earlier = task.agents.find((one) => one.agentId === agent.agentId);
  const entry: TaskAgent = earlier ?? {
    agentId: agent.agentId,
    name: agent.name,
    sessions: [],
    boundAt: now,
  };
  const { stoppedAt: _stopped, ...live } = entry;
  return {
    ...task,
    agents: [
      ...task.agents.filter((one) => one.agentId !== agent.agentId),
      live,
    ].slice(-TASK_AGENTS_MAX),
    updatedAt: now,
  };
}

export function unbindAgent(task: Task, agentId: string, now: number): Task {
  if (!task.agents.some((one) => one.agentId === agentId))
    refuse(`agent ${agentId} is not bound to task #${String(task.id)}.`);
  return {
    ...task,
    agents: task.agents.filter((one) => one.agentId !== agentId),
    updatedAt: now,
  };
}

export function completeTask(
  task: Task,
  note: string | undefined,
  now: number,
): Task {
  openOnly(task);
  const checked = checkNote(note);
  return {
    ...task,
    done: { at: now, ...(checked === undefined ? {} : { note: checked }) },
    updatedAt: now,
  };
}

/** A managed agent open now, as the store's `observe` reads it. */
export interface LiveTaskAgent {
  readonly agentId: string;
  readonly name: string;
  readonly named: boolean;
  readonly profileId: string;
  readonly kind: string;
  /** The model it was given over its profile's own (`agentModel.ts`). */
  readonly model?: string;
  readonly presentation: "gui" | "tui";
  readonly machine: string;
  readonly folder: string;
  readonly branch?: string;
  /** The session its CLI runs, when known. */
  readonly session?: string;
}

/**
 * `entry` brought up to date with what is seen of it now (`live`, under its
 * id or continuing one of its sessions), or marked stopped when it is not
 * seen; the same entry when nothing moved.
 */
export function observedAgent(
  entry: TaskAgent,
  live: LiveTaskAgent | undefined,
  now: number,
): TaskAgent {
  if (live === undefined)
    return entry.stoppedAt !== undefined ? entry : { ...entry, stoppedAt: now };
  const sessions =
    live.session === undefined
      ? entry.sessions
      : [
          ...entry.sessions.filter((one) => one !== live.session),
          live.session,
        ].slice(-TASK_SESSIONS_MAX);
  const next: TaskAgent = {
    agentId: live.agentId,
    name: live.name,
    ...(live.named ? { named: true } : {}),
    profileId: live.profileId,
    kind: live.kind,
    ...(live.model === undefined ? {} : { model: live.model }),
    presentation: live.presentation,
    machine: live.machine,
    folder: live.folder,
    ...(live.branch === undefined ? {} : { branch: live.branch }),
    sessions,
    boundAt: entry.boundAt,
    seenAt: entry.seenAt ?? now,
  };
  const same =
    JSON.stringify({ ...entry, seenAt: 0 }) ===
      JSON.stringify({ ...next, seenAt: 0 }) &&
    entry.seenAt !== undefined &&
    now - entry.seenAt < 60 * 60_000;
  return same ? entry : { ...next, seenAt: now };
}

// --- the board ----------------------------------------------------------------

/** 回答待ち's order: priority, then the oldest open question first. */
export function byPriority(left: Task, right: Task): number {
  return (
    TASK_PRIORITIES.indexOf(priorityOf(left)) -
    TASK_PRIORITIES.indexOf(priorityOf(right))
  );
}

// --- on disk ------------------------------------------------------------------

export const TASKS_FILE_VERSION = 1;

export interface TasksFile {
  readonly version: typeof TASKS_FILE_VERSION;
  /** The numbers the next task and the next escalation get. */
  readonly nextTask: number;
  readonly nextEscalation: number;
  /** The agent assigned to the Orchestrator row, when one is. */
  readonly orchestratorAgentId?: string;
  readonly tasks: readonly Task[];
  readonly escalations: readonly Escalation[];
}

export const EMPTY_TASKS: TasksFile = {
  version: TASKS_FILE_VERSION,
  nextTask: 1,
  nextEscalation: 1,
  tasks: [],
  escalations: [],
};

function agentFrom(value: unknown, where: string): TaskAgent {
  if (!isRecord(value)) refuse(`${where} is not an agent.`);
  const agentId = value["agentId"];
  const name = value["name"];
  if (typeof agentId !== "string" || agentId === "")
    refuse(`${where} has no agent id.`);
  const text = (key: string) =>
    typeof value[key] === "string" ? { [key]: value[key] } : {};
  const presentation = value["presentation"];
  return {
    agentId,
    name: typeof name === "string" ? name : agentId,
    ...(value["named"] === true ? { named: true } : {}),
    ...text("profileId"),
    ...text("kind"),
    ...text("model"),
    ...(presentation === "gui" || presentation === "tui"
      ? { presentation }
      : {}),
    ...text("machine"),
    ...text("folder"),
    ...text("branch"),
    sessions: strings(value["sessions"], `${where}'s sessions`).slice(
      -TASK_SESSIONS_MAX,
    ),
    boundAt: finiteTime(value["boundAt"], `${where}'s binding`),
    ...(typeof value["seenAt"] === "number" ? { seenAt: value["seenAt"] } : {}),
    ...(typeof value["stoppedAt"] === "number"
      ? { stoppedAt: value["stoppedAt"] }
      : {}),
  } as TaskAgent;
}

function taskFrom(value: unknown, index: number): Task {
  const where = `task ${String(index + 1)}`;
  if (!isRecord(value)) refuse(`${where} is not a task.`);
  const id = value["id"];
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1)
    refuse(`${where}'s id is not a positive whole number.`);
  if (typeof value["title"] !== "string") refuse(`${where} has no title.`);
  const status = value["status"];
  if (status !== "waiting" && status !== "in_progress")
    refuse(`${where}'s status is not waiting or in_progress.`);
  const agents = Array.isArray(value["agents"]) ? value["agents"] : [];
  const memo = value["memo"];
  const request = value["request"];
  const done = value["done"];
  const priority = value["priority"];
  return {
    id,
    title: checkTitle(value["title"], "a task"),
    status,
    ...(typeof value["waitNote"] === "string" && status === "waiting"
      ? { waitNote: value["waitNote"] }
      : {}),
    ...(typeof value["checkAt"] === "number" && status === "waiting"
      ? { checkAt: value["checkAt"] }
      : {}),
    ...checkLinks(
      strings(value["links"], `${where}'s links`),
      labelsFrom(value["linkLabels"], where),
    ),
    agents: agents.map((one: unknown, at: number) =>
      agentFrom(one, `${where}'s agent ${String(at + 1)}`),
    ),
    ...(isRecord(memo) && typeof memo["text"] === "string"
      ? {
          memo: {
            text: memo["text"],
            at: finiteTime(memo["at"], `${where}'s memo time`),
          },
        }
      : {}),
    ...(priority === "high" || priority === "low" ? { priority } : {}),
    ...(typeof value["priorityNote"] === "string" &&
    value["priorityNote"] !== ""
      ? { priorityNote: value["priorityNote"] }
      : {}),
    ...(isRecord(request) && typeof request["text"] === "string"
      ? {
          request: {
            text: request["text"],
            at: finiteTime(request["at"], `${where}'s request time`),
            ...(typeof request["sentAt"] === "number"
              ? { sentAt: request["sentAt"] }
              : {}),
          },
        }
      : {}),
    createdAt: finiteTime(value["createdAt"], `${where}'s creation`),
    updatedAt: finiteTime(value["updatedAt"], `${where}'s update`),
    ...(isRecord(done)
      ? {
          done: {
            at: finiteTime(done["at"], `${where}'s completion`),
            ...(typeof done["note"] === "string" && done["note"] !== ""
              ? { note: done["note"] }
              : {}),
          },
        }
      : {}),
  };
}

function nextNumber(value: unknown, highest: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > highest
    ? value
    : highest + 1;
}

/** A file read back: refused whole, as the corrupt file it is, or accepted whole. */
export function tasksFromJson(value: unknown): TasksFile {
  if (!isRecord(value)) refuse("the tasks file is not a JSON object.");
  if (value["version"] !== TASKS_FILE_VERSION)
    refuse(
      `the tasks file is version ${String(value["version"])}, and this DevHub reads ${String(TASKS_FILE_VERSION)}.`,
    );
  if (!Array.isArray(value["tasks"]) || !Array.isArray(value["escalations"]))
    refuse("the tasks file has no list of tasks and escalations.");
  const tasks = value["tasks"].map(taskFrom);
  const escalations = value["escalations"].map((one: unknown, at: number) =>
    escalationFrom(one, `escalation ${String(at + 1)}`),
  );
  const taskIds = new Set(tasks.map((one) => one.id));
  if (taskIds.size !== tasks.length)
    refuse("the tasks file has two tasks with one id.");
  const escalationIds = new Set(escalations.map((one) => one.id));
  if (escalationIds.size !== escalations.length)
    refuse("the tasks file has two escalations with one id.");
  for (const one of escalations)
    if (!taskIds.has(one.taskId))
      refuse(
        `escalation #${String(one.id)} belongs to task #${String(one.taskId)}, which is not there.`,
      );
  const orchestrator = value["orchestratorAgentId"];
  if (orchestrator !== undefined && typeof orchestrator !== "string")
    refuse("the tasks file's orchestrator is not an agent id.");
  return {
    version: TASKS_FILE_VERSION,
    nextTask: nextNumber(value["nextTask"], Math.max(0, ...taskIds)),
    nextEscalation: nextNumber(
      value["nextEscalation"],
      Math.max(0, ...escalationIds),
    ),
    ...(orchestrator === undefined
      ? {}
      : { orchestratorAgentId: orchestrator }),
    tasks,
    escalations,
  };
}

/** `#12`, `12`, `T12` or `task=12`: the id it names, or undefined. */
export function parseTaskId(text: string): number | undefined {
  const match = /^(?:#|t|T|task=)?(\d{1,9})$/u.exec(text.trim());
  if (match === null) return undefined;
  const id = Number(match[1]);
  return id >= 1 ? id : undefined;
}
