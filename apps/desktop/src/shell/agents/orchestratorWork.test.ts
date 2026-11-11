/** The board's memos and work (`OrchestratorWork.tsx`): what is listed, and which note an escalation shows. */

import { describe, expect, it } from "vitest";
import type { EscalationWire, OrchestratorBoardWire } from "../../ipc/contract";
import { escalationMemo, itemKeyOfUrl, workItems } from "./OrchestratorWork";

const memo = (subject: string, at: number) => ({
  subject,
  token: subject,
  text: `note of ${subject}`,
  at,
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
  it("lists every subject with a note or a resumable agent, latest first", () => {
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

  it("shows an escalation one note: its own, else its items', else its agents' work's", () => {
    const escalation = {
      id: 1,
      links: ["https://github.com/Acme/App/issues/128"],
      agents: [{ agentId: "a1" }],
    } as unknown as EscalationWire;
    expect(escalationMemo(escalation, board)).toMatchObject({
      subject: "esc 1",
      text: "note of esc 1",
    });
    expect(escalationMemo({ ...escalation, id: 2 }, board)?.subject).toBe(
      "item acme/app#128",
    );
    expect(
      escalationMemo({ ...escalation, id: 2, links: [] }, board)?.subject,
    ).toBe("item acme/app#128");
    expect(
      escalationMemo({ ...escalation, id: 2, links: [], agents: [] }, board),
    ).toBeUndefined();
    expect(itemKeyOfUrl("https://github.com/a/b/pull/3/files")).toBe(
      "item a/b#3",
    );
  });
});
