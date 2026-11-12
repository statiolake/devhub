/**
 * The one-time conversion of the orchestrator's files from before tasks
 * (`docs/orchestrator.md`, "Tasks: where they came from"): the escalations
 * (threads with lanes), the work records, the memos, the priorities and
 * the person's requests become tasks and escalations (`model/tasks.ts`).
 *
 * - **Each escalation** becomes task #(its id), keeping its title, links,
 *   labels, agents and rank (its priority and rank note are the task's):
 *   - 要回答 → 処理中 with one open escalation (#same id): its latest question;
 *   - 対応中 → 処理中; 待機中 → 待機, its trigger the wait's note and its
 *     `--at` the task's check-back time; closed → done, with the close note;
 *   - for those, the latest question and the person's answer after it are
 *     an answered escalation; a question nobody answered, a withdrawn one;
 *   - an earlier question in the thread (asked again later) is a past
 *     escalation of its own on the task, numbered after every old one:
 *     answered when the person answered it before the next was asked, else
 *     withdrawn. A follow-up is a new escalation, and that is what it was.
 * - **The person's requests**: an open one is a 待機 task holding their
 *   words; a filed one a done task, its note where it was filed.
 * - **The work records**: an item's agents join the task linking that
 *   item (else a new task, linked to it, titled with its ref); an agent's
 *   (`issue=pending` work) join the task it is bound to, else a new one.
 * - **The memos** land on the same task (an escalation's on its own, a
 *   request's on its task), a new one made when none fits; **the
 *   priorities** on the task they find, and are dropped otherwise.
 *
 * An agent ends up bound to one open task at most: the newest of those it
 * was about. Done tasks keep theirs, as the work's history.
 *
 * Lenient where the files were: an entry that does not read is left out,
 * never the whole file. Pure: the files' JSON in, the new file out.
 */

import {
  checkLinks,
  isRecord,
  type Escalation,
  checkOptions,
} from "./escalations.js";
import {
  TASKS_FILE_VERSION,
  type Task,
  type TaskAgent,
  type TasksFile,
} from "./tasks.js";

export interface OldFiles {
  /** `escalations.json`, version 1. */
  readonly escalations?: unknown;
  /** `orchestrator-work.json`, version 1. */
  readonly work?: unknown;
  /** `orchestrator-memos.json`, version 1 or 2. */
  readonly memos?: unknown;
  /** `orchestrator-priorities.json`, version 1. */
  readonly priorities?: unknown;
  /** `orchestrator-requests.json`, version 1. */
  readonly requests?: unknown;
}

interface OldEntry {
  readonly role: string;
  readonly markdown: string;
  readonly at: number;
  readonly options?: readonly string[];
  readonly kind?: string;
  readonly dueAt?: number;
}

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const list = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

/** `acme/app#12` of an Issue's or pull request's URL, lower-cased. */
function itemRef(url: string): string | undefined {
  const match =
    /^https?:\/\/[^/]+\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)/iu.exec(
      url.trim(),
    );
  return match === null ? undefined : `${match[1]!}#${match[2]!}`.toLowerCase();
}

function safeLinks(
  links: readonly unknown[],
  labels: unknown,
): Pick<Task, "links" | "linkLabels"> {
  const kept: string[] = [];
  for (const one of links)
    if (typeof one === "string")
      try {
        kept.push(...checkLinks([one], undefined).links);
      } catch {
        // A link this DevHub does not take: left out.
      }
  const labelled: Record<string, string> = {};
  if (isRecord(labels))
    for (const [link, label] of Object.entries(labels))
      if (typeof label === "string")
        try {
          Object.assign(
            labelled,
            checkLinks([], { [link]: label }, { links: kept }).linkLabels,
          );
        } catch {
          // Not one of its links any more: left out.
        }
  return Object.keys(labelled).length === 0
    ? { links: kept }
    : { links: kept, linkLabels: labelled };
}

function oldEntries(value: unknown): OldEntry[] {
  return list(value).flatMap((one) => {
    if (!isRecord(one)) return [];
    const at = num(one["at"]);
    const role = str(one["role"]);
    if (at === undefined || role === undefined) return [];
    const options = list(one["options"]).filter(
      (option): option is string => typeof option === "string",
    );
    return [
      {
        role,
        markdown: str(one["markdown"]) ?? "",
        at,
        ...(options.length === 0 ? {} : { options }),
        ...(str(one["kind"]) === undefined ? {} : { kind: str(one["kind"])! }),
        ...(num(one["dueAt"]) === undefined
          ? {}
          : { dueAt: num(one["dueAt"])! }),
      },
    ];
  });
}

const isQuestion = (entry: OldEntry) =>
  entry.role === "orchestrator" && entry.kind === undefined;
const isAnswer = (entry: OldEntry) =>
  entry.role === "human" && entry.kind === undefined;

function workAgent(value: unknown): TaskAgent | undefined {
  if (!isRecord(value)) return undefined;
  const agentId = str(value["agentId"]);
  if (agentId === undefined || agentId === "") return undefined;
  const presentation = value["presentation"];
  const text = (key: string) =>
    str(value[key]) === undefined ? {} : { [key]: str(value[key])! };
  return {
    agentId,
    name: str(value["name"]) ?? agentId.slice(0, 8),
    ...(value["named"] === true ? { named: true } : {}),
    ...text("profileId"),
    ...text("kind"),
    ...(presentation === "gui" || presentation === "tui"
      ? { presentation }
      : {}),
    ...text("machine"),
    ...text("folder"),
    ...text("branch"),
    sessions: list(value["sessions"]).filter(
      (one): one is string => typeof one === "string",
    ),
    boundAt: num(value["startedAt"]) ?? num(value["seenAt"]) ?? 0,
    ...(num(value["seenAt"]) === undefined
      ? {}
      : { seenAt: num(value["seenAt"])! }),
    ...(num(value["stoppedAt"]) === undefined
      ? {}
      : { stoppedAt: num(value["stoppedAt"])! }),
  } as TaskAgent;
}

/** The new file, from whichever of the old ones there were. */
export function migrateOldFiles(old: OldFiles, now: number): TasksFile {
  const tasks = new Map<number, Task>();
  const escalations: Escalation[] = [];
  const oldEscalations = isRecord(old.escalations)
    ? list(old.escalations["escalations"])
    : [];
  const orchestrator = isRecord(old.escalations)
    ? str(old.escalations["orchestratorAgentId"])
    : undefined;
  let nextEscalation = isRecord(old.escalations)
    ? (num(old.escalations["next"]) ?? 1)
    : 1;
  // What the work records say of each agent: its name, sessions, folder.
  const recorded = new Map<string, TaskAgent>();
  const records = isRecord(old.work) ? list(old.work["work"]) : [];
  for (const record of records)
    if (isRecord(record))
      for (const one of list(record["agents"])) {
        const agent = workAgent(one);
        if (agent !== undefined) recorded.set(agent.agentId, agent);
      }
  const agentEntry = (agentId: string, at: number): TaskAgent =>
    recorded.get(agentId) ?? {
      agentId,
      name: agentId.slice(0, 8),
      sessions: [],
      boundAt: at,
    };

  // The earlier questions of a thread, numbered once every old id is known.
  const earlier: Omit<Escalation, "id">[] = [];
  // 1. The escalations: a task each, under the same number.
  for (const value of oldEscalations) {
    if (!isRecord(value)) continue;
    const id = num(value["id"]);
    const title = str(value["title"])?.trim();
    const entries = oldEntries(value["entries"]);
    if (id === undefined || id < 1 || !title || entries.length === 0) continue;
    const createdAt = num(value["createdAt"]) ?? entries[0]!.at;
    const updatedAt = num(value["updatedAt"]) ?? entries.at(-1)!.at;
    const closed = isRecord(value["closed"]) ? value["closed"] : undefined;
    const last = entries.at(-1)!;
    const state =
      closed !== undefined
        ? "closed"
        : isQuestion(last)
          ? "needs_answer"
          : last.kind === "wait"
            ? "waiting"
            : "in_progress";
    const priority = value["priority"];
    const rankNote = str(value["rankNote"]);
    const linked = safeLinks(list(value["links"]), value["linkLabels"]);
    const agents = list(value["agents"])
      .filter((one): one is string => typeof one === "string" && one !== "")
      .map((agentId) => agentEntry(agentId, createdAt));
    tasks.set(id, {
      id,
      title: title.slice(0, 200),
      status: state === "waiting" ? "waiting" : "in_progress",
      ...(state === "waiting" && last.markdown.trim() !== ""
        ? { waitNote: last.markdown.trim().slice(0, 500) }
        : {}),
      ...(state === "waiting" && last.dueAt !== undefined
        ? { checkAt: last.dueAt }
        : {}),
      ...linked,
      agents,
      ...(priority === "high" || priority === "low" ? { priority } : {}),
      ...(rankNote === undefined || rankNote === ""
        ? {}
        : { priorityNote: rankNote.slice(0, 160) }),
      createdAt,
      updatedAt,
      ...(closed === undefined
        ? {}
        : {
            done: {
              at: num(closed["at"]) ?? updatedAt,
              ...(str(closed["note"]) ? { note: str(closed["note"])! } : {}),
            },
          }),
    });
    // Its latest question, and the person's answer after it.
    const asked = entries.findLastIndex(isQuestion);
    if (asked < 0) continue;
    const question = entries[asked]!;
    const answer = entries.slice(asked + 1).findLast(isAnswer);
    const optionsOf = (one: OldEntry) => {
      try {
        return checkOptions(one.options);
      } catch {
        return undefined;
      }
    };
    const options = optionsOf(question);
    const option = options?.find((one) => one === answer?.markdown.trim());
    // The earlier questions, each with the answer given before the next.
    entries.slice(0, asked).forEach((one, index) => {
      if (!isQuestion(one) || one.markdown.trim() === "") return;
      const next = entries.findIndex(
        (later, at) => at > index && isQuestion(later),
      );
      const reply = entries.slice(index + 1, next).find(isAnswer);
      const choices = optionsOf(one);
      const chosen = choices?.find((pick) => pick === reply?.markdown.trim());
      earlier.push({
        taskId: id,
        title: title.slice(0, 200),
        question: {
          markdown: one.markdown,
          at: one.at,
          ...(choices === undefined ? {} : { options: choices }),
        },
        ...linked,
        createdAt: one.at,
        ...(reply !== undefined && reply.markdown.trim() !== ""
          ? {
              answer: {
                markdown: reply.markdown,
                at: reply.at,
                ...(chosen === undefined ? {} : { option: chosen }),
              },
            }
          : {
              withdrawn: {
                at: entries[next]!.at,
                note: "移行: 回答なしで先に進んだ質問",
              },
            }),
      });
    });
    escalations.push({
      id,
      taskId: id,
      title: title.slice(0, 200),
      question: {
        markdown: question.markdown.trim() === "" ? title : question.markdown,
        at: question.at,
        ...(options === undefined ? {} : { options }),
      },
      ...linked,
      createdAt,
      ...(answer !== undefined && answer.markdown.trim() !== ""
        ? {
            answer: {
              markdown: answer.markdown,
              at: answer.at,
              ...(option === undefined ? {} : { option }),
            },
          }
        : state === "needs_answer"
          ? {}
          : {
              withdrawn: {
                at:
                  closed === undefined
                    ? (entries.slice(asked + 1)[0]?.at ?? updatedAt)
                    : (num(closed["at"]) ?? updatedAt),
                note: "移行: 回答なしで先に進んだ質問",
              },
            }),
    });
    nextEscalation = Math.max(nextEscalation, id + 1);
  }
  for (const one of earlier.sort((a, b) => a.question.at - b.question.at))
    escalations.push({ id: nextEscalation++, ...one });

  let nextTask = Math.max(0, ...tasks.keys()) + 1;
  const made = (task: Omit<Task, "id">): Task => {
    const one = { id: nextTask, ...task } as Task;
    tasks.set(one.id, one);
    nextTask += 1;
    return one;
  };

  // 2. The person's requests.
  const requestTask = new Map<number, number>();
  const requests = isRecord(old.requests) ? list(old.requests["requests"]) : [];
  for (const value of requests) {
    if (!isRecord(value)) continue;
    const id = num(value["id"]);
    const text = str(value["text"])?.trim();
    const at = num(value["at"]);
    if (id === undefined || !text || at === undefined) continue;
    const filed = isRecord(value["filed"]) ? value["filed"] : undefined;
    const sentAt = num(value["sentAt"]);
    const firstLine = text.split("\n")[0]!.trim().slice(0, 200) || "依頼";
    const task = made({
      title: firstLine,
      status: "waiting",
      links: [],
      agents: [],
      request: {
        text: text.slice(0, 20_000),
        at,
        // One still held (sent while off) goes once an orchestrator is on.
        ...(value["state"] === "held" ? {} : { sentAt: sentAt ?? at }),
      },
      createdAt: at,
      updatedAt: num(filed?.["at"]) ?? at,
      ...(value["state"] === "filed"
        ? {
            done: {
              at: num(filed?.["at"]) ?? at,
              ...(str(filed?.["note"]) ? { note: str(filed?.["note"])! } : {}),
            },
          }
        : {}),
    });
    requestTask.set(id, task.id);
  }

  const openFirst = (all: Task[]) =>
    all.sort(
      (a, b) =>
        Number(a.done !== undefined) - Number(b.done !== undefined) ||
        b.id - a.id,
    );
  const taskLinking = (ref: string): Task | undefined =>
    openFirst(
      [...tasks.values()].filter((task) =>
        task.links.some((link) => itemRef(link) === ref),
      ),
    )[0];
  const taskBinding = (agentId: string): Task | undefined =>
    openFirst(
      [...tasks.values()].filter((task) =>
        task.agents.some((agent) => agent.agentId === agentId),
      ),
    )[0];
  const put = (task: Task) => tasks.set(task.id, task);
  const withAgents = (task: Task, agents: readonly TaskAgent[]): Task => ({
    ...task,
    agents: [
      ...task.agents.map(
        (one) => agents.find((agent) => agent.agentId === one.agentId) ?? one,
      ),
      ...agents.filter(
        (agent) => !task.agents.some((one) => one.agentId === agent.agentId),
      ),
    ].slice(-8),
  });

  // 3. The work records.
  for (const record of records) {
    if (!isRecord(record)) continue;
    const subject = str(record["subject"]);
    if (subject === undefined) continue;
    const agents = list(record["agents"]).flatMap((one) => {
      const agent = workAgent(one);
      return agent === undefined ? [] : [agent];
    });
    if (agents.length === 0) continue;
    const seen = Math.max(...agents.map((one) => one.seenAt ?? one.boundAt));
    const live = agents.some((one) => one.stoppedAt === undefined);
    if (subject.startsWith("item ")) {
      const ref = subject.slice(5).toLowerCase();
      const there =
        taskLinking(ref) ??
        agents.map((agent) => taskBinding(agent.agentId)).find(Boolean);
      if (there !== undefined) {
        put(withAgents(there, agents));
        continue;
      }
      const match = /^([\w.-]+\/[\w.-]+)#(\d+)$/u.exec(ref);
      const url =
        str(record["url"]) ??
        (match === null
          ? undefined
          : `https://github.com/${match[1]!}/${record["itemKind"] === "pr" ? "pull" : "issues"}/${match[2]!}`);
      const doneSince = num(record["doneSince"]);
      made({
        title: subject.slice(5),
        status: live ? "in_progress" : "waiting",
        ...(url === undefined ? { links: [] } : safeLinks([url], undefined)),
        agents,
        createdAt: Math.min(...agents.map((one) => one.boundAt)),
        updatedAt: seen,
        ...(doneSince === undefined ? {} : { done: { at: doneSince } }),
      });
      continue;
    }
    if (!subject.startsWith("agent ")) continue;
    const there = agents
      .map((agent) => taskBinding(agent.agentId))
      .find(Boolean);
    if (there !== undefined) {
      put(withAgents(there, agents));
      continue;
    }
    made({
      title: agents.at(-1)!.name,
      status: live ? "in_progress" : "waiting",
      links: [],
      agents,
      createdAt: Math.min(...agents.map((one) => one.boundAt)),
      updatedAt: seen,
    });
  }

  // 4. Where a memo or a priority lands: the task its subject became.
  const landing = (subject: string, create: boolean): Task | undefined => {
    const esc = /^esc (\d+)$/u.exec(subject);
    if (esc !== null) return tasks.get(Number(esc[1]));
    const req = /^req (\d+)$/u.exec(subject);
    if (req !== null) {
      const id = requestTask.get(Number(req[1]));
      return id === undefined ? undefined : tasks.get(id);
    }
    if (subject.startsWith("item ")) {
      const ref = subject.slice(5).toLowerCase();
      const there = taskLinking(ref);
      if (there !== undefined || !create) return there;
      const match = /^([\w.-]+\/[\w.-]+)#(\d+)$/u.exec(ref);
      return made({
        title: subject.slice(5),
        status: "waiting",
        ...(match === null
          ? { links: [] }
          : safeLinks(
              [`https://github.com/${match[1]!}/issues/${match[2]!}`],
              undefined,
            )),
        agents: [],
        createdAt: now,
        updatedAt: now,
      });
    }
    if (subject.startsWith("agent ")) {
      const agentId = subject.slice(6);
      const there = taskBinding(agentId);
      if (there !== undefined || !create) return there;
      const agent = agentEntry(agentId, now);
      return made({
        title: agent.name,
        status: "waiting",
        links: [],
        agents: [agent],
        createdAt: now,
        updatedAt: now,
      });
    }
    return undefined;
  };

  const memos = isRecord(old.memos) ? list(old.memos["memos"]) : [];
  const v1 = isRecord(old.memos) && old.memos["version"] === 1;
  for (const value of memos) {
    if (!isRecord(value)) continue;
    const subject = str(value["subject"]);
    let text = str(value["text"]);
    let at = num(value["at"]);
    if (v1) {
      const latest = list(value["entries"]).filter(isRecord).at(-1);
      text = str(latest?.["text"]);
      at = num(latest?.["at"]);
    }
    if (subject === undefined || !text?.trim() || at === undefined) continue;
    const task = landing(subject, true);
    if (task === undefined || (task.memo !== undefined && task.memo.at >= at))
      continue;
    put({ ...task, memo: { text: text.trim().slice(0, 500), at } });
  }

  const book =
    isRecord(old.priorities) && isRecord(old.priorities["priorities"])
      ? old.priorities["priorities"]
      : {};
  for (const [subject, value] of Object.entries(book)) {
    if (!isRecord(value)) continue;
    const priority = value["priority"];
    if (priority !== "high" && priority !== "normal" && priority !== "low")
      continue;
    const task = landing(subject, false);
    if (task === undefined) continue;
    const { priority: _p, priorityNote: _n, ...rest } = task;
    const note = str(value["note"])?.trim();
    put({
      ...rest,
      ...(priority === "normal" ? {} : { priority }),
      ...(note ? { priorityNote: note.slice(0, 160) } : {}),
    });
  }

  // 5. One open task per agent: the newest it is on.
  const claimed = new Set<string>();
  for (const task of [...tasks.values()].sort((a, b) => b.id - a.id)) {
    if (task.done !== undefined) continue;
    const agents = task.agents.filter((one) => !claimed.has(one.agentId));
    for (const one of agents) claimed.add(one.agentId);
    if (agents.length !== task.agents.length) put({ ...task, agents });
  }

  return {
    version: TASKS_FILE_VERSION,
    nextTask,
    nextEscalation,
    ...(orchestrator === undefined
      ? {}
      : { orchestratorAgentId: orchestrator }),
    tasks: [...tasks.values()].sort((a, b) => a.id - b.id),
    // In the order they were asked: a task's past questions read in order.
    escalations: escalations.sort(
      (a, b) => a.question.at - b.question.at || a.id - b.id,
    ),
  };
}
