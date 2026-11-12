import { describe, expect, it } from "vitest";
import { answerEscalation, createEscalation } from "./escalations.js";
import {
  bindAgent,
  completeTask,
  createTask,
  editTask,
  linkTask,
  observedAgent,
  parseTaskId,
  setTaskStatus,
  taskStatus,
  tasksFromJson,
  unbindAgent,
  unlinkTask,
  type Task,
} from "./tasks.js";

const ISSUE = "https://github.com/acme/app/issues/128";

function made(patch: Partial<Parameters<typeof createTask>[1]> = {}): Task {
  return createTask(1, { title: "ログイン修正", ...patch }, 100);
}

describe("a task's status", () => {
  it("is 待機 at birth, 回答待ち exactly while a question on it is open, and done once completed", () => {
    const task = made();
    expect(taskStatus(task, [])).toBe("waiting");
    const question = createEscalation(
      3,
      { taskId: 1, title: "q", markdown: "b" },
      110,
    );
    expect(taskStatus(task, [question])).toBe("answer");
    // Another task's question is not this one's.
    expect(taskStatus(task, [{ ...question, taskId: 2 }])).toBe("waiting");
    expect(taskStatus(task, [answerEscalation(question, "a", 120)])).toBe(
      "waiting",
    );
    const done = completeTask(task, "済み", 130);
    expect(taskStatus(done, [question])).toBe("done");
    expect(() => setTaskStatus(done, "in_progress", {}, 140)).toThrow(
      /is done/u,
    );
  });

  it("keeps what a 待機 waits for, and drops it when it goes 処理中", () => {
    const waiting = setTaskStatus(
      made(),
      "waiting",
      { note: "Bob の返事", checkAt: 500 },
      110,
    );
    expect(waiting).toMatchObject({ waitNote: "Bob の返事", checkAt: 500 });
    const going = setTaskStatus(waiting, "in_progress", {}, 120);
    expect(going.status).toBe("in_progress");
    expect(going.waitNote).toBeUndefined();
    expect(going.checkAt).toBeUndefined();
    expect(() =>
      setTaskStatus(made(), "in_progress", { note: "x" }, 1),
    ).toThrow(/takes none/u);
    expect(() => setTaskStatus(made(), "answer" as "waiting", {}, 1)).toThrow(
      /回答待ち is an open escalation/u,
    );
  });
});

describe("what a task holds", () => {
  it("links, labelled, each once, and unlinks", () => {
    const linked = linkTask(made(), [ISSUE, ISSUE], { [ISSUE]: "Issue" }, 110);
    expect(linked.links).toEqual([ISSUE]);
    expect(linked.linkLabels).toEqual({ [ISSUE]: "Issue" });
    const back = unlinkTask(linked, [ISSUE], 120);
    expect(back.links).toEqual([]);
    expect(back.linkLabels).toBeUndefined();
    expect(() => unlinkTask(back, [ISSUE], 130)).toThrow(/has no link/u);
  });

  it("one memo, one priority, a title: edited, and taken away by an empty one", () => {
    const edited = editTask(
      made(),
      { memo: " 次は CI ", priority: "high", priorityNote: "本番" },
      110,
    );
    expect(edited).toMatchObject({
      memo: { text: "次は CI", at: 110 },
      priority: "high",
      priorityNote: "本番",
    });
    const cleared = editTask(
      edited,
      { memo: "", priority: "normal", priorityNote: "" },
      120,
    );
    expect(cleared.memo).toBeUndefined();
    expect(cleared.priority).toBeUndefined();
    expect(cleared.priorityNote).toBeUndefined();
    expect(() => editTask(made(), { memo: "x".repeat(501) }, 1)).toThrow(
      /keep it to 500/u,
    );
    expect(() => editTask(made(), {}, 1)).toThrow(/task edit gives/u);
  });

  it("binds agents, keeps a stopped one's sessions, and lets a resumed one take its place", () => {
    const bound = bindAgent(made(), { agentId: "a1", name: "fix" }, 110);
    const live = {
      agentId: "a1",
      name: "fix",
      named: false,
      profileId: "claude",
      kind: "claude",
      presentation: "gui" as const,
      machine: "local",
      folder: "/w",
      session: "s1",
    };
    const seen = observedAgent(bound.agents[0]!, live, 120);
    expect(seen).toMatchObject({ sessions: ["s1"], seenAt: 120 });
    // Nothing moved within the hour: the same entry.
    expect(observedAgent(seen, live, 130)).toBe(seen);
    const stopped = observedAgent(seen, undefined, 140);
    expect(stopped.stoppedAt).toBe(140);
    const resumed = observedAgent(stopped, { ...live, agentId: "a2" }, 150);
    expect(resumed).toMatchObject({ agentId: "a2", sessions: ["s1"] });
    expect(resumed.stoppedAt).toBeUndefined();
    expect(unbindAgent(bound, "a1", 160).agents).toEqual([]);
    expect(() => unbindAgent(bound, "zz", 160)).toThrow(/not bound/u);
  });

  it("round-trips through the file, and refuses one whose escalation has no task", () => {
    const task = editTask(
      linkTask(
        bindAgent(made(), { agentId: "a1", name: "x" }, 1),
        [ISSUE],
        undefined,
        2,
      ),
      { memo: "m", priority: "low" },
      3,
    );
    const question = createEscalation(
      2,
      { taskId: 1, title: "q", markdown: "b" },
      4,
    );
    const file = {
      version: 1,
      nextTask: 2,
      nextEscalation: 3,
      tasks: [task],
      escalations: [question],
    };
    expect(tasksFromJson(JSON.parse(JSON.stringify(file)))).toEqual(file);
    expect(() =>
      tasksFromJson({ ...file, escalations: [{ ...question, taskId: 9 }] }),
    ).toThrow(/task #9, which is not there/u);
    expect(() => tasksFromJson({ ...file, version: 2 })).toThrow(/version 2/u);
  });

  it("reads #12, 12, T12 and task=12 as ids", () => {
    for (const text of ["#12", "12", "T12", "task=12"])
      expect(parseTaskId(text)).toBe(12);
    expect(parseTaskId("esc=12")).toBeUndefined();
  });
});
