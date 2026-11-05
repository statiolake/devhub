// @vitest-environment jsdom

/**
 * DevHub's note in an escalation's thread that an agent went back to work: a
 * system line with a chip to the agent, not an answer body.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EscalationNote,
  inProgressBefore,
  noteTime,
  noteWords,
} from "./EscalationNote";

afterEach(cleanup);

const AT = new Date(2026, 10, 5, 14, 5).getTime();
const AGENTS = [
  { agentId: "a1b2c3d4-0000", name: "API fix", status: "working" },
];

describe("an escalation's note", () => {
  it("says the person talked to the agent directly, with a chip to it", () => {
    const focus = vi.fn();
    render(
      <EscalationNote
        entry={{
          role: "human",
          kind: "direct",
          agent: "a1b2c3d4-0000",
          markdown: "",
          at: AT,
        }}
        agents={AGENTS}
        onFocusAgent={focus}
      />,
    );
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent(
      "人が API fix と直接やりとりしました（14:05）— 内容はエージェントの会話を参照",
    );
    expect(note).toHaveAttribute("data-kind", "direct");
    fireEvent.click(screen.getByRole("button", { name: "API fix" }));
    expect(focus).toHaveBeenCalledWith("a1b2c3d4-0000");
  });

  it("says an agent resumed, and names a gone one by its id", () => {
    render(
      <EscalationNote
        entry={{
          role: "human",
          kind: "resumed",
          agent: "e5f6a7b8-0000",
          markdown: "",
          at: AT,
        }}
        agents={[]}
        onFocusAgent={() => undefined}
      />,
    );
    expect(screen.getByRole("note")).toHaveTextContent(
      "e5f6a7b8 が作業を再開しました（14:05）— 回答待ちは一旦解除",
    );
    expect(screen.getByRole("button", { name: "e5f6a7b8" })).toBeDisabled();
    expect(noteTime(AT)).toBe("14:05");
  });

  it("says it moved to 対応中, with the note: an old taken neutrally, the orchestrator's hold by name", () => {
    render(
      <>
        <EscalationNote
          entry={{
            role: "human",
            kind: "taken",
            markdown: "自分で見る",
            at: AT,
          }}
          agents={[]}
          onFocusAgent={() => undefined}
        />
        <EscalationNote
          entry={{ role: "orchestrator", kind: "held", markdown: "", at: AT }}
          agents={[]}
          onFocusAgent={() => undefined}
        />
      </>,
    );
    const [taken, held] = screen.getAllByRole("note");
    expect(taken).toHaveTextContent("対応中になりました（14:05）: 自分で見る");
    expect(held).toHaveTextContent(
      "オーケストレーターが対応中にしました（14:05）",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("calls a hold on a thread already in 対応中 the orchestrator's note", () => {
    expect(
      noteWords("held", AT, "B から返事待ち", undefined, true).before,
    ).toBe("オーケストレーターのメモ（14:05）: B から返事待ち");
    const question = { role: "orchestrator", markdown: "?", at: AT } as const;
    const answer = { role: "human", markdown: "A", at: AT } as const;
    const held = {
      role: "orchestrator",
      kind: "held",
      markdown: "",
      at: AT,
    } as const;
    expect(inProgressBefore([question, held], 1)).toBe(false);
    expect(inProgressBefore([question, answer, held], 2)).toBe(true);
    expect(inProgressBefore([question, held, held], 2)).toBe(true);
    expect(
      inProgressBefore(
        [
          question,
          { role: "orchestrator", kind: "wait", markdown: "t", at: AT },
          held,
        ],
        2,
      ),
    ).toBe(false);
  });

  it("says the orchestrator parked it waiting, with the trigger and its time", () => {
    render(
      <EscalationNote
        entry={{
          role: "orchestrator",
          kind: "wait",
          markdown: "11/10 以降に再開",
          at: AT,
          dueAt: new Date(2026, 10, 10, 9, 0).getTime(),
        }}
        agents={[]}
        onFocusAgent={() => undefined}
      />,
    );
    expect(screen.getByRole("note")).toHaveTextContent(
      "オーケストレーターが待機中にしました（14:05）: 11/10 以降に再開（11/10 09:00 まで）",
    );
  });
});
