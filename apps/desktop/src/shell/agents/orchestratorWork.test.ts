/** The board's memos and work (`OrchestratorWork.tsx`): what is listed, and which memos an escalation shows. */

import { describe, expect, it } from "vitest";
import type { EscalationWire, OrchestratorBoardWire } from "../../ipc/contract";
import { escalationMemos, itemKeyOfUrl, workItems } from "./OrchestratorWork";

const memo = (subject: string, at: number) => ({
  subject,
  token: subject,
  updatedAt: at,
  entries: [{ at, text: `memo of ${subject}` }],
});

const stopped = {
  agentId: "a1",
  name: "128 login fix",
  profileId: "claude",
  kind: "claude",
  machine: "local",
  folder: "/src/app_128",
  live: false,
  resumable: true,
  stoppedAt: 50,
};

const board = {
  memos: [memo("item acme/app#128", 100), memo("esc 1", 20)],
  work: [
    {
      subject: "item acme/app#128",
      token: "issue=acme/app#128",
      agents: [stopped],
    },
    {
      subject: "item acme/app#9",
      token: "pr=acme/app#9",
      agents: [{ ...stopped, agentId: "b1", stoppedAt: 200 }],
    },
    {
      subject: "agent c1",
      token: "agent=c1",
      agents: [{ ...stopped, agentId: "c1", live: true, resumable: false }],
    },
  ],
} as unknown as OrchestratorBoardWire;

describe("the board's memos and work", () => {
  it("lists every subject with a memo or a resumable agent, latest first", () => {
    expect(workItems(board).map((one) => one.subject)).toEqual([
      "item acme/app#9",
      "item acme/app#128",
      "esc 1",
    ]);
    expect(workItems(board)[1]).toMatchObject({
      work: { token: "issue=acme/app#128" },
      memo: { subject: "item acme/app#128" },
    });
  });

  it("shows an escalation its own memo, its items' and its agents' work's", () => {
    const escalation = {
      id: 1,
      links: ["https://github.com/Acme/App/issues/128"],
      agents: [{ agentId: "a1" }],
    } as unknown as EscalationWire;
    expect(
      escalationMemos(escalation, board).map((one) => one.subject),
    ).toEqual(["esc 1", "item acme/app#128"]);
    expect(itemKeyOfUrl("https://github.com/a/b/pull/3/files")).toBe(
      "item a/b#3",
    );
  });
});
