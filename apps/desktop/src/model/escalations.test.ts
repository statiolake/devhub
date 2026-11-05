import { describe, expect, it } from "vitest";
import {
  EscalationError,
  answerEscalation,
  askAgain,
  board,
  closeEscalation,
  createEscalation,
  effortOf,
  escalationState,
  escalationsFromJson,
  linkAgent,
  openOptions,
  parseEscalationId,
  priorityOf,
  rankEscalation,
  stateSince,
  unaccountedAgents,
  UNACCOUNTED_GRACE_MS,
  type BoardAgent,
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

describe("不明", () => {
  const agent = (over: Partial<BoardAgent>): BoardAgent => ({
    id: "a1",
    name: "Claude",
    workspaceId: "w",
    workspaceLabel: "app",
    status: "idle",
    stopping: false,
    idleSince: 0,
    ...over,
  });
  const now = UNACCOUNTED_GRACE_MS + 10;

  it("lists idle agents past the grace that no open escalation names", () => {
    const agents = [
      agent({ id: "a1" }),
      agent({ id: "a2", status: "working", idleSince: undefined }),
      agent({ id: "a3", idleSince: now - 1000 }),
      agent({ id: "orch" }),
      agent({ id: "a4", stopping: true }),
      agent({ id: "a5" }),
    ];
    const open = createEscalation(
      1,
      { title: "t", markdown: "x", agents: ["a5"] },
      0,
    );
    const listed = unaccountedAgents(agents, [open], "orch", now);
    expect(listed.map((one) => one.agentId)).toEqual(["a1"]);
  });

  it("counts an agent again once the escalation naming it is closed", () => {
    const closed = closeEscalation(
      createEscalation(1, { title: "t", markdown: "x", agents: ["a1"] }, 0),
      undefined,
      1,
    );
    expect(
      unaccountedAgents([agent({})], [closed], undefined, now),
    ).toHaveLength(1);
  });

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
    const lanes = board([first, second, answered, done], [], undefined, now);
    expect(lanes.needsAnswer.map((one) => one.id)).toEqual([2, 1]);
    expect(lanes.inProgress.map((one) => one.id)).toEqual([3]);
    expect(lanes.closed.map((one) => one.id)).toEqual([4]);
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
    const lanes = board(
      [old, quickLow, deepHigh, quick, quickHigh],
      [],
      undefined,
      9000,
    );
    expect(lanes.needsAnswer.map((e) => e.id)).toEqual([5, 3, 4, 1, 2]);
    const answered = [
      answerEscalation(quickHigh, "a", 7000),
      answerEscalation(old, "a", 6000),
    ];
    expect(
      board(answered, [], undefined, 9000).inProgress.map((e) => e.id),
    ).toEqual([1, 5]);
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
