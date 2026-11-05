import { describe, expect, it } from "vitest";
import {
  EscalationError,
  answerEscalation,
  askAgain,
  board,
  closeEscalation,
  createEscalation,
  currentWait,
  dueWords,
  resumeEscalation,
  waitEscalation,
  effortOf,
  escalationState,
  escalationsFromJson,
  lastAnswer,
  linkAgent,
  noteWorking,
  openOptions,
  holdEscalation,
  parseEscalationId,
  priorityOf,
  rankEscalation,
  stateSince,
} from "./escalations.js";

const raised = () =>
  createEscalation(
    1,
    {
      title: "本番DBのマイグレーションを実行してよいか",
      markdown:
        "## 背景\n\n…\n\n```sql\nALTER TABLE users ADD COLUMN x int;\n```",
      options: ["実行してよい", "待って"],
      agents: ["a1"],
      links: ["https://github.com/acme/app/pull/12"],
    },
    1000,
  );

describe("the state is the thread", () => {
  it("is needs_answer when the orchestrator spoke last, in_progress when the person did", () => {
    const born = raised();
    expect(escalationState(born)).toBe("needs_answer");
    expect(openOptions(born)).toEqual(["実行してよい", "待って"]);
    const answered = answerEscalation(born, "実行してよい", 2000);
    expect(escalationState(answered)).toBe("in_progress");
    expect(openOptions(answered)).toEqual([]);
    expect(stateSince(answered)).toBe(2000);
    const asked = askAgain(answered, "対象は staging も?", ["はい"], 3000);
    expect(escalationState(asked)).toBe("needs_answer");
    expect(asked.entries.map((one) => one.role)).toEqual([
      "orchestrator",
      "human",
      "orchestrator",
    ]);
    const closed = closeEscalation(asked, "完了", 4000);
    expect(escalationState(closed)).toBe("closed");
    expect(closed.closed).toEqual({ at: 4000, note: "完了" });
  });

  it("refuses to write on a closed ticket, or to close it twice", () => {
    const closed = closeEscalation(raised(), undefined, 2000);
    expect(() => answerEscalation(closed, "x", 3000)).toThrow(EscalationError);
    expect(() => askAgain(closed, "x", undefined, 3000)).toThrow(
      EscalationError,
    );
    expect(() => closeEscalation(closed, undefined, 3000)).toThrow(
      EscalationError,
    );
  });

  it("checks what it is given", () => {
    expect(() => createEscalation(1, { title: " ", markdown: "x" }, 0)).toThrow(
      /title/u,
    );
    expect(() =>
      createEscalation(1, { title: "t", markdown: "  " }, 0),
    ).toThrow(/empty/u);
    expect(() =>
      createEscalation(
        1,
        { title: "t", markdown: "x", links: ["file:///x"] },
        0,
      ),
    ).toThrow(/http/u);
    expect(() =>
      createEscalation(
        1,
        { title: "t", markdown: "x", options: ["a", "a"] },
        0,
      ),
    ).toThrow(/twice/u);
  });

  it("keeps a devhub: link canonically, refuses a broken one, and adds an ask's", () => {
    const made = createEscalation(
      1,
      {
        title: "t",
        markdown: "x",
        links: ["DEVHUB:escalation/%237", "https://x.test/a"],
      },
      0,
    );
    expect(made.links).toEqual(["devhub:escalation/7", "https://x.test/a"]);
    expect(() =>
      createEscalation(
        1,
        { title: "t", markdown: "x", links: ["devhub:robot/1"] },
        0,
      ),
    ).toThrow(/not a devhub: link/u);
    const asked = askAgain(made, "more", undefined, 5, [
      "devhub:orchestrator",
      "devhub:escalation/7",
    ]);
    expect(asked.links).toEqual([
      "devhub:escalation/7",
      "https://x.test/a",
      "devhub:orchestrator",
    ]);
    expect(askAgain(made, "more", undefined, 5).links).toBe(made.links);
  });

  it("links an agent once", () => {
    const linked = linkAgent(linkAgent(raised(), "a2", 5), "a2", 6);
    expect(linked.agents).toEqual(["a1", "a2"]);
  });

  it("reads #12, 12 and E12 as ids", () => {
    expect(parseEscalationId("#12")).toBe(12);
    expect(parseEscalationId("12")).toBe(12);
    expect(parseEscalationId("E12")).toBe(12);
    expect(parseEscalationId("x")).toBeUndefined();
    expect(parseEscalationId("0")).toBeUndefined();
  });
});

describe("on disk", () => {
  it("round-trips through JSON, and numbers on from the highest id", () => {
    const one = answerEscalation(raised(), "はい", 2000);
    const file = escalationsFromJson(
      JSON.parse(
        JSON.stringify({
          version: 1,
          next: 1,
          orchestratorAgentId: "o",
          escalations: [one],
        }),
      ),
    );
    expect(file.escalations).toEqual([one]);
    expect(file.next).toBe(2);
    expect(file.orchestratorAgentId).toBe("o");
  });

  it("refuses a file that is not one", () => {
    expect(() => escalationsFromJson({ version: 9, escalations: [] })).toThrow(
      EscalationError,
    );
    expect(() =>
      escalationsFromJson({
        version: 1,
        escalations: [{ id: 1, title: "t", entries: [] }],
      }),
    ).toThrow(/entries/u);
  });
});

describe("the board", () => {
  it("lays out the lanes: oldest question first, closed hidden from both", () => {
    const first = createEscalation(1, { title: "a", markdown: "x" }, 10);
    const second = createEscalation(2, { title: "b", markdown: "x" }, 5);
    const answered = answerEscalation(
      createEscalation(3, { title: "c", markdown: "x" }, 1),
      "y",
      20,
    );
    const done = closeEscalation(
      createEscalation(4, { title: "d", markdown: "x" }, 1),
      undefined,
      2,
    );
    const lanes = board([first, second, answered, done]);
    expect(lanes.needsAnswer.map((one) => one.id)).toEqual([2, 1]);
    expect(lanes.inProgress.map((one) => one.id)).toEqual([3]);
    expect(lanes.closed.map((one) => one.id)).toEqual([4]);
  });
});

describe("DevHub's note that an agent went back to work", () => {
  it("moves needs_answer to in_progress, and a follow-up moves it back", () => {
    const noted = noteWorking(raised(), "direct", "a1", 2000);
    expect(escalationState(noted)).toBe("in_progress");
    expect(noted.entries.at(-1)).toEqual({
      role: "human",
      kind: "direct",
      agent: "a1",
      markdown: "",
      at: 2000,
    });
    // Not the person's answer.
    expect(lastAnswer(noted)).toBeUndefined();
    const asked = askAgain(noted, "まだ決まっていない点は?", undefined, 3000);
    expect(escalationState(asked)).toBe("needs_answer");
    expect(escalationState(noteWorking(asked, "resumed", "a1", 4000))).toBe(
      "in_progress",
    );
  });

  it("is written only on a needs_answer one, about one of its agents", () => {
    const answered = answerEscalation(raised(), "OK", 2000);
    expect(() => noteWorking(answered, "direct", "a1", 3000)).toThrow(
      EscalationError,
    );
    expect(() => noteWorking(raised(), "resumed", "zz", 3000)).toThrow(
      EscalationError,
    );
    const closed = closeEscalation(raised(), undefined, 2000);
    expect(() => noteWorking(closed, "direct", "a1", 3000)).toThrow(
      EscalationError,
    );
  });

  it("reads back from the file", () => {
    const noted = noteWorking(raised(), "resumed", "a1", 2000);
    const file = escalationsFromJson(
      JSON.parse(JSON.stringify({ version: 1, next: 2, escalations: [noted] })),
    );
    expect(file.escalations[0]).toEqual(noted);
    expect(() =>
      escalationsFromJson({
        version: 1,
        next: 2,
        escalations: [
          {
            ...noted,
            entries: [...noted.entries, { role: "human", kind: "x", at: 3 }],
          },
        ],
      }),
    ).toThrow(EscalationError);
  });
});

describe("the orchestrator's ranking", () => {
  const one = (
    id: number,
    at: number,
    rank?: Parameters<typeof createEscalation>[1]["rank"],
  ) =>
    createEscalation(
      id,
      { title: `#${String(id)}`, markdown: "?", ...(rank ? { rank } : {}) },
      at,
    );

  it("sorts 要回答 by priority, then effort, then age; 対応中 by age alone", () => {
    const old = one(1, 1000);
    const quickLow = one(2, 2000, { priority: "low", effort: "quick" });
    const deepHigh = one(3, 3000, { priority: "high", effort: "deep" });
    const quick = one(4, 4000, { effort: "quick" });
    const quickHigh = one(5, 5000, { priority: "high", effort: "quick" });
    const lanes = board([old, quickLow, deepHigh, quick, quickHigh]);
    expect(lanes.needsAnswer.map((e) => e.id)).toEqual([5, 3, 4, 1, 2]);
    const answered = [
      answerEscalation(quickHigh, "a", 7000),
      answerEscalation(old, "a", 6000),
    ];
    expect(board(answered).inProgress.map((e) => e.id)).toEqual([1, 5]);
  });

  it("re-ranks only what is given, stores normal as nothing, and an empty note clears", () => {
    const made = one(1, 1000, {
      priority: "high",
      effort: "quick",
      note: "リリースを止めている",
    });
    expect(made).toMatchObject({
      priority: "high",
      effort: "quick",
      rankNote: "リリースを止めている",
    });
    const lower = rankEscalation(made, { priority: "normal" }, 2000);
    expect(lower.priority).toBeUndefined();
    expect(lower.effort).toBe("quick");
    expect(lower.updatedAt).toBe(2000);
    expect(lower.entries).toEqual(made.entries);
    expect(rankEscalation(lower, { note: "" }, 3000).rankNote).toBeUndefined();
    expect(() => rankEscalation(made, {}, 2000)).toThrow(EscalationError);
    expect(() =>
      rankEscalation(
        closeEscalation(made, undefined, 2000),
        { effort: "deep" },
        3000,
      ),
    ).toThrow(/closed/u);
    expect(() =>
      rankEscalation(made, { priority: "urgent" as "high" }, 2000),
    ).toThrow(/a priority is/u);
  });

  it("is kept on disk, and an older file reads as normal", () => {
    const ranked = one(1, 1000, {
      priority: "low",
      effort: "deep",
      note: "急がない",
    });
    const back = escalationsFromJson(
      JSON.parse(
        JSON.stringify({ version: 1, next: 2, escalations: [ranked] }),
      ),
    );
    expect(back.escalations[0]).toEqual(ranked);
    const older = escalationsFromJson({
      version: 1,
      next: 2,
      escalations: [
        {
          id: 1,
          title: "t",
          entries: [{ role: "orchestrator", markdown: "?", at: 1 }],
          agents: [],
          links: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }).escalations[0]!;
    expect(priorityOf(older)).toBe("normal");
    expect(effortOf(older)).toBe("normal");
    expect(older.rankNote).toBeUndefined();
    expect(() =>
      escalationsFromJson({
        version: 1,
        escalations: [{ ...ranked, effort: "slow" }],
      }),
    ).toThrow(EscalationError);
  });
});

describe("to in_progress without an answer", () => {
  it("is the orchestrator's held (or an old taken, read), until a follow-up", () => {
    // Nothing writes `taken` any more; a stored one still reads as 対応中.
    const taken = escalationsFromJson({
      version: 1,
      next: 2,
      escalations: [
        {
          ...raised(),
          entries: [
            ...raised().entries,
            { role: "human", kind: "taken", markdown: "自分で見る", at: 2000 },
          ],
        },
      ],
    }).escalations[0]!;
    expect(escalationState(taken)).toBe("in_progress");
    expect(lastAnswer(taken)).toBeUndefined();
    expect(openOptions(taken)).toEqual([]);
    const held = holdEscalation({ ...raised(), id: 2 }, "  B に依頼 ", 2000);
    expect(held.entries.at(-1)).toEqual({
      role: "orchestrator",
      kind: "held",
      markdown: "B に依頼",
      at: 2000,
    });
    expect(
      holdEscalation({ ...raised(), id: 2 }, undefined, 2000).entries.at(-1),
    ).toEqual({
      role: "orchestrator",
      kind: "held",
      markdown: "",
      at: 2000,
    });
    // An orchestrator-side entry, and still not 要回答: only a question is.
    expect(escalationState(held)).toBe("in_progress");
    expect(escalationState(askAgain(held, "?", undefined, 3000))).toBe(
      "needs_answer",
    );
    expect(() => holdEscalation(held, undefined, 3000)).toThrow(
      EscalationError,
    );
    const back = escalationsFromJson(
      JSON.parse(
        JSON.stringify({ version: 1, next: 3, escalations: [taken, held] }),
      ),
    );
    expect(back.escalations).toEqual([taken, held]);
  });

  it("refuses a file whose note claims the other side", () => {
    const held = holdEscalation(raised(), "x", 2000);
    const forged = {
      ...held,
      entries: [
        ...held.entries.slice(0, -1),
        { ...held.entries.at(-1), role: "human" },
      ],
    };
    expect(() =>
      escalationsFromJson({ version: 1, next: 2, escalations: [forged] }),
    ).toThrow(EscalationError);
  });
});

describe("待機中: parked on an outside condition", () => {
  it("is waiting exactly while the orchestrator's wait is last, with its trigger and time", () => {
    const waiting = waitEscalation(
      raised(),
      { trigger: "  Bob から Slack で返事が来たら ", dueAt: 9_000 },
      2000,
    );
    expect(escalationState(waiting)).toBe("waiting");
    expect(waiting.entries.at(-1)).toEqual({
      role: "orchestrator",
      kind: "wait",
      markdown: "Bob から Slack で返事が来たら",
      at: 2000,
      dueAt: 9_000,
    });
    expect(currentWait(waiting)?.markdown).toBe(
      "Bob から Slack で返事が来たら",
    );
    expect(lastAnswer(waiting)).toBeUndefined();
    expect(openOptions(waiting)).toEqual([]);
    // And reads back the same.
    expect(
      escalationsFromJson(
        JSON.parse(
          JSON.stringify({ version: 1, next: 2, escalations: [waiting] }),
        ),
      ).escalations,
    ).toEqual([waiting]);
  });

  it("leaves on a question, an answer, a resume, an agent going working, or a close", () => {
    const waiting = waitEscalation(raised(), { trigger: "11/10 以降" }, 2000);
    expect(escalationState(askAgain(waiting, "?", undefined, 3000))).toBe(
      "needs_answer",
    );
    expect(escalationState(answerEscalation(waiting, "もう進めて", 3000))).toBe(
      "in_progress",
    );
    const resumed = resumeEscalation(waiting, "条件を満たした", 3000);
    expect(escalationState(resumed)).toBe("in_progress");
    expect(resumed.entries.at(-1)).toMatchObject({
      role: "orchestrator",
      kind: "held",
      markdown: "条件を満たした",
    });
    expect(() => resumeEscalation(resumed, undefined, 4000)).toThrow(
      /not waiting on a condition/u,
    );
    expect(escalationState(noteWorking(waiting, "resumed", "a1", 3000))).toBe(
      "in_progress",
    );
    expect(escalationState(closeEscalation(waiting, undefined, 3000))).toBe(
      "closed",
    );
    // A second wait replaces what the first said.
    const again = waitEscalation(waiting, { trigger: "11/12 以降" }, 3000);
    expect(currentWait(again)?.markdown).toBe("11/12 以降");
  });

  it("refuses a wait without its trigger in words, and a closed one", () => {
    expect(() => waitEscalation(raised(), { trigger: "  " }, 2000)).toThrow(
      /trigger/u,
    );
    expect(() =>
      waitEscalation(
        closeEscalation(raised(), undefined, 1500),
        { trigger: "x" },
        2000,
      ),
    ).toThrow(/closed/u);
    expect(() =>
      escalationsFromJson({
        version: 1,
        escalations: [
          {
            ...raised(),
            entries: [
              ...raised().entries,
              { role: "orchestrator", kind: "wait", markdown: "", at: 2 },
            ],
          },
        ],
      }),
    ).toThrow(EscalationError);
  });

  it("is born waiting with --wait: nothing asked of the person yet", () => {
    const born = createEscalation(
      2,
      {
        title: "t",
        markdown: "about",
        wait: { trigger: "staging の deploy 完了後" },
      },
      1000,
    );
    expect(escalationState(born)).toBe("waiting");
    expect(born.entries).toHaveLength(2);
  });

  it("lays 待機中 out soonest time first, untimed after, then the oldest wait", () => {
    const at = (id: number, since: number, dueAt?: number) =>
      waitEscalation(
        { ...raised(), id },
        {
          trigger: `t${String(id)}`,
          ...(dueAt === undefined ? {} : { dueAt }),
        },
        since,
      );
    const lanes = board([
      at(1, 5000),
      at(2, 3000, 90_000),
      at(3, 4000),
      at(4, 6000, 50_000),
      raised(),
    ]);
    expect(lanes.waiting.map((one) => one.id)).toEqual([4, 2, 3, 1]);
    expect(lanes.needsAnswer.map((one) => one.id)).toEqual([1]);
    expect(lanes.inProgress).toEqual([]);
  });

  it("says how far off a time is", () => {
    const now = 1_000_000;
    expect(dueWords(now + 20 * 60_000, now)).toBe("あと 20m");
    expect(dueWords(now + 5 * 3_600_000, now)).toBe("あと 5h");
    expect(dueWords(now + 3 * 86_400_000, now)).toBe("あと 3日");
    expect(dueWords(now - 1, now)).toBe("時刻を過ぎました");
  });
});
