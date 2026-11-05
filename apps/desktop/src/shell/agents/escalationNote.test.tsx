// @vitest-environment jsdom

/**
 * DevHub's note in an escalation's thread that an agent went back to work: a
 * system line with a chip to the agent, not an answer body.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentsContext, type AgentsValue } from "./AgentsContext";
import { EscalationNote, noteTime, TakeEscalation } from "./EscalationNote";

const takeEscalation = vi.fn(() => Promise.resolve());
window.devhub = { takeEscalation } as unknown as typeof window.devhub;

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

  it("says who moved it to 対応中, with the note", () => {
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
    expect(taken).toHaveTextContent(
      "人が対応中にしました（14:05）: 自分で見る",
    );
    expect(held).toHaveTextContent(
      "オーケストレーターが対応中にしました（14:05）",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("対応中にする", () => {
  it("takes it with an optional note", async () => {
    render(
      <AgentsContext.Provider
        value={{ reportFailure: vi.fn() } as unknown as AgentsValue}
      >
        <TakeEscalation id={7} />
      </AgentsContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "対応中にする" }));
    fireEvent.change(screen.getByRole("textbox", { name: "メモ (任意)" }), {
      target: { value: " 自分で確認 " },
    });
    fireEvent.click(screen.getByRole("button", { name: "対応中にする" }));
    expect(takeEscalation).toHaveBeenCalledWith(7, "自分で確認");
    await screen.findByRole("button", { name: "対応中にする" });
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
