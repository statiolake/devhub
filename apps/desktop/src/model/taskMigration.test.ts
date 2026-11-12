import { describe, expect, it } from "vitest";
import { migrateOldFiles } from "./taskMigration.js";
import { taskStatus, tasksFromJson } from "./tasks.js";

const PR = "https://github.com/acme/pay/pull/1234";
const ISSUE = "https://github.com/acme/app/issues/128";
const WORKER = "a1b2c3d4-0000-4000-8000-000000000001";
const RESEARCH = "b2c3d4e5-0000-4000-8000-000000000002";
const DOCS = "c3d4e5f6-0000-4000-8000-000000000003";
const question = (markdown: string, at: number, options?: string[]) => ({
  role: "orchestrator",
  markdown,
  at,
  ...(options === undefined ? {} : { options }),
});
const answer = (markdown: string, at: number) => ({
  role: "human",
  markdown,
  at,
});

/** The files a DevHub before tasks kept: every old state there was. */
const OLD = {
  escalations: {
    version: 1,
    next: 6,
    orchestratorAgentId: "orch-1",
    escalations: [
      {
        // 要回答, asked again after an answer: its latest question.
        id: 1,
        title: "決済のタイムアウトを延ばす修正をマージしてよいか",
        entries: [
          question("最初の質問", 10, ["はい", "いいえ"]),
          answer("staging で確かめて", 20),
          question("staging で確かめた。マージしてよいか", 30, [
            "マージする",
            "見送る",
          ]),
        ],
        agents: [WORKER],
        links: [PR],
        linkLabels: { [PR]: "タイムアウト延長の PR" },
        createdAt: 10,
        updatedAt: 30,
        priority: "high",
        effort: "quick",
        rankNote: "2 人が止まっている",
      },
      {
        // 対応中: answered, being carried out.
        id: 2,
        title: "ログイン 500 の直し方",
        entries: [
          question("案 A か案 B か", 40, ["案 A", "案 B"]),
          answer("案 A", 50),
        ],
        agents: [],
        links: [ISSUE],
        createdAt: 40,
        updatedAt: 50,
      },
      {
        // 待機中: parked on a trigger and a time.
        id: 3,
        title: "リリース日をいつにするか",
        entries: [
          question("リリースはいつか", 60),
          {
            role: "orchestrator",
            kind: "wait",
            markdown: "Bob から Slack で返事が来たら",
            at: 70,
            dueAt: 999,
          },
        ],
        agents: [RESEARCH],
        links: [],
        createdAt: 60,
        updatedAt: 70,
      },
      {
        // 対応中 by a hold: nobody answered.
        id: 4,
        title: "調査の範囲を広げてよいか",
        entries: [
          question("広げてよいか", 80),
          {
            role: "orchestrator",
            kind: "held",
            markdown: "先に調べる",
            at: 90,
          },
        ],
        agents: [],
        links: [],
        createdAt: 80,
        updatedAt: 90,
      },
      {
        // Closed with an answer.
        id: 5,
        title: "ログの保存期間",
        entries: [question("30 日でよいか", 100), answer("90 日に", 110)],
        agents: [],
        links: [],
        createdAt: 100,
        updatedAt: 120,
        closed: { at: 120, note: "90 日で設定した" },
      },
    ],
  },
  work: {
    version: 1,
    work: [
      {
        // The item escalation 2 links: its agents join that task.
        subject: "item acme/app#128",
        url: ISSUE,
        itemKind: "issue",
        agents: [
          {
            agentId: DOCS,
            name: "login-fix",
            profileId: "claude",
            kind: "claude",
            presentation: "gui",
            machine: "local",
            folder: "/w/app_128",
            sessions: ["s-128"],
            startedAt: 45,
            seenAt: 55,
            stoppedAt: 56,
          },
        ],
      },
      {
        // An item no escalation is about: a task of its own.
        subject: "item acme/web#7",
        url: "https://github.com/acme/web/pull/7",
        itemKind: "pr",
        agents: [
          {
            agentId: "d4e5f6a7-0000",
            name: "PR 7 review",
            profileId: "claude",
            kind: "claude",
            presentation: "gui",
            machine: "local",
            folder: "/w/web",
            sessions: ["s-7"],
            startedAt: 5,
            seenAt: 130,
          },
        ],
      },
      {
        // issue=pending work: the task its agent is bound to (escalation 3).
        subject: `agent ${RESEARCH}`,
        agents: [
          {
            agentId: RESEARCH,
            name: "調査",
            profileId: "claude",
            kind: "claude",
            presentation: "tui",
            machine: "ssh:box",
            folder: "/srv/app",
            sessions: ["s-r"],
            startedAt: 55,
            seenAt: 75,
          },
        ],
      },
    ],
  },
  memos: {
    version: 2,
    memos: [
      { subject: "esc 1", text: "マージされたらリリース告知", at: 35 },
      {
        subject: "item acme/app#128",
        text: "CI が通ったらレビュー依頼",
        at: 57,
      },
      { subject: "item acme/ops#3", text: "まだ誰も見ていない", at: 58 },
      { subject: "req 2", text: "Issue を起票させる", at: 140 },
    ],
  },
  priorities: {
    version: 1,
    priorities: {
      "item acme/web#7": { priority: "low", at: 131, note: "急がない" },
      "req 2": { priority: "high", at: 141 },
      "item acme/none#1": { priority: "high", at: 1 },
    },
  },
  requests: {
    version: 1,
    requests: [
      {
        id: 1,
        text: "ダッシュボードの数字を確認して",
        at: 125,
        state: "filed",
        sentAt: 126,
        filed: { at: 127, note: "https://github.com/acme/app/issues/140" },
      },
      {
        id: 2,
        text: "請求書 CSV の文字化けを直す\n取引先から報告",
        at: 135,
        state: "sent",
        sentAt: 136,
      },
    ],
  },
};

describe("the conversion from before tasks", () => {
  const file = migrateOldFiles(OLD, 1_000);
  const byTitle = (title: string) =>
    file.tasks.find((one) => one.title === title)!;
  const status = (title: string) =>
    taskStatus(byTitle(title), file.escalations);

  it("makes each escalation a task under its own number, in the matching status", () => {
    expect(file.tasks.slice(0, 5).map((one) => [one.id, one.title])).toEqual([
      [1, "決済のタイムアウトを延ばす修正をマージしてよいか"],
      [2, "ログイン 500 の直し方"],
      [3, "リリース日をいつにするか"],
      [4, "調査の範囲を広げてよいか"],
      [5, "ログの保存期間"],
    ]);
    expect(
      file.tasks.slice(0, 5).map((one) => taskStatus(one, file.escalations)),
    ).toEqual(["answer", "in_progress", "waiting", "in_progress", "done"]);
    expect(byTitle("リリース日をいつにするか")).toMatchObject({
      waitNote: "Bob から Slack で返事が来たら",
      checkAt: 999,
    });
    expect(byTitle("ログの保存期間").done).toEqual({
      at: 120,
      note: "90 日で設定した",
    });
    // Its rank is the task's priority.
    expect(
      byTitle("決済のタイムアウトを延ばす修正をマージしてよいか"),
    ).toMatchObject({
      priority: "high",
      priorityNote: "2 人が止まっている",
      links: [PR],
      linkLabels: { [PR]: "タイムアウト延長の PR" },
      memo: { text: "マージされたらリリース告知", at: 35 },
    });
  });

  it("keeps one question each: the open one's latest ask, the person's answer, or withdrawn; an earlier ask is a past one", () => {
    expect(
      file.escalations.map((one) => [
        one.id,
        one.taskId,
        one.question.markdown,
        one.answer?.markdown ?? null,
        one.withdrawn === undefined ? null : "withdrawn",
      ]),
    ).toEqual([
      // Asked, answered, then asked again: the first is past, numbered on.
      [6, 1, "最初の質問", "staging で確かめて", null],
      [1, 1, "staging で確かめた。マージしてよいか", null, null],
      [2, 2, "案 A か案 B か", "案 A", null],
      [3, 3, "リリースはいつか", null, "withdrawn"],
      [4, 4, "広げてよいか", null, "withdrawn"],
      [5, 5, "30 日でよいか", "90 日に", null],
    ]);
    const esc = (id: number) => file.escalations.find((one) => one.id === id)!;
    expect(esc(1).question.options).toEqual(["マージする", "見送る"]);
    expect(esc(6).question.options).toEqual(["はい", "いいえ"]);
    expect(esc(2).answer?.option).toBe("案 A");
  });

  it("puts the work records' agents on their tasks, with their sessions, one open task each", () => {
    expect(byTitle("ログイン 500 の直し方").agents).toMatchObject([
      {
        agentId: DOCS,
        sessions: ["s-128"],
        folder: "/w/app_128",
        stoppedAt: 56,
      },
    ]);
    expect(byTitle("リリース日をいつにするか").agents).toMatchObject([
      { agentId: RESEARCH, machine: "ssh:box", sessions: ["s-r"] },
    ]);
    expect(byTitle("acme/web#7")).toMatchObject({
      status: "in_progress",
      links: ["https://github.com/acme/web/pull/7"],
      agents: [{ agentId: "d4e5f6a7-0000", sessions: ["s-7"] }],
      priority: "low",
      priorityNote: "急がない",
    });
    const open = file.tasks.filter((one) => one.done === undefined);
    const bound = open.flatMap((one) =>
      one.agents.map((agent) => agent.agentId),
    );
    expect(new Set(bound).size).toBe(bound.length);
  });

  it("lands the memos and priorities on their tasks, a memo with none on a new one", () => {
    expect(byTitle("ログイン 500 の直し方").memo?.text).toBe(
      "CI が通ったらレビュー依頼",
    );
    expect(byTitle("acme/ops#3")).toMatchObject({
      status: "waiting",
      links: ["https://github.com/acme/ops/issues/3"],
      memo: { text: "まだ誰も見ていない" },
    });
    // A priority with no task is dropped, not made a task.
    expect(file.tasks.some((one) => one.title.includes("acme/none"))).toBe(
      false,
    );
  });

  it("makes the person's requests tasks: an open one 待機 with their words, a filed one done", () => {
    expect(status("ダッシュボードの数字を確認して")).toBe("done");
    expect(byTitle("ダッシュボードの数字を確認して").done?.note).toBe(
      "https://github.com/acme/app/issues/140",
    );
    expect(byTitle("請求書 CSV の文字化けを直す")).toMatchObject({
      status: "waiting",
      request: {
        text: "請求書 CSV の文字化けを直す\n取引先から報告",
        sentAt: 136,
      },
      memo: { text: "Issue を起票させる" },
      priority: "high",
    });
  });

  it("is a file this DevHub reads, numbering on past everything", () => {
    expect(tasksFromJson(JSON.parse(JSON.stringify(file)))).toEqual(file);
    expect(file.nextEscalation).toBe(7);
    expect(file.nextTask).toBe(
      Math.max(...file.tasks.map((one) => one.id)) + 1,
    );
    expect(file.orchestratorAgentId).toBe("orch-1");
  });

  it("leaves out what does not read, never the rest", () => {
    const partial = migrateOldFiles(
      {
        escalations: {
          version: 1,
          escalations: [{ id: "x" }, OLD.escalations.escalations[1]],
        },
        memos: "nonsense",
      },
      1_000,
    );
    expect(partial.tasks.map((one) => one.title)).toEqual([
      "ログイン 500 の直し方",
    ]);
  });
});
