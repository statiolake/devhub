// @vitest-environment jsdom

/**
 * The Orchestrator board: three lanes, an escalation opened in place with
 * the conversation's renderer, and the person's answer going out through the
 * one door it has (`answerEscalation`).
 */

import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSnapshot } from "../../ipc/appShell";
import { EMPTY_BOARD, type OrchestratorBoardWire } from "../../ipc/contract";
import { installHistoryButtons } from "../historyButtons";
import { AgentsContext, type AgentsValue } from "./AgentsContext";
import { NAV_MS, OrchestratorBoard, preview, span } from "./OrchestratorScreen";

const answerEscalation = vi.fn(() => Promise.resolve());
window.devhub = {
  answerEscalation,
  setOrchestratorPaused: vi.fn(() => Promise.resolve()),
  openExternalUrl: vi.fn(() => Promise.resolve()),
  conversation: { resolvePaths: () => Promise.resolve([]) },
} as unknown as typeof window.devhub;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  delete (window as { matchMedia?: unknown }).matchMedia;
});

/** Whether the person asked for less motion, as `matchMedia` answers it. */
function motion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion: reduce"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

function boardSection(): HTMLElement {
  return screen.getByRole("region", { name: "Orchestrator board" });
}

/** What of the left pane could size it: its class, style and attributes. */
function paneShape(element: HTMLElement): string {
  return [...element.attributes]
    .map((attribute) => `${attribute.name}=${attribute.value}`)
    .join(" ");
}

const NOW = Date.now();

const BOARD: OrchestratorBoardWire = {
  ...EMPTY_BOARD,
  revision: 1,
  orchestratorAgentId: "orch",
  needsAnswer: [
    {
      id: 1,
      title: "本番マイグレーションの実行承認",
      state: "needs_answer",
      entries: [
        {
          role: "orchestrator",
          markdown:
            "## 背景\n\n列を追加します。\n\n```sql\nALTER TABLE t ADD c int;\n```",
          at: NOW - 120_000,
          options: ["実行する", "保留"],
        },
      ],
      agents: [{ agentId: "a1", name: "payments-migration", status: "idle" }],
      links: ["https://github.com/acme/app/pull/7"],
      createdAt: NOW - 120_000,
      updatedAt: NOW - 120_000,
      stateSince: NOW - 120_000,
    },
  ],
  inProgress: [
    {
      id: 2,
      title: "リトライ方針",
      state: "in_progress",
      entries: [
        { role: "orchestrator", markdown: "A or B?", at: NOW - 600_000 },
        { role: "human", markdown: "A で", at: NOW - 300_000 },
      ],
      agents: [],
      links: [],
      createdAt: NOW - 600_000,
      updatedAt: NOW - 300_000,
      stateSince: NOW - 300_000,
    },
  ],
  unaccounted: [
    {
      agentId: "a9",
      name: "docs-writer",
      workspaceId: "w",
      workspaceLabel: "web",
      idleSince: NOW - 180_000,
    },
  ],
};

function mount(board: OrchestratorBoardWire = BOARD) {
  const dispatch = vi.fn().mockResolvedValue(undefined);
  render(
    <AgentsContext.Provider
      value={
        { board, dispatch, reportFailure: vi.fn() } as unknown as AgentsValue
      }
    >
      <OrchestratorBoard
        snapshot={{ workspaces: [] } as unknown as AppSnapshot}
      />
    </AgentsContext.Provider>,
  );
  return dispatch;
}

describe("the Orchestrator board", () => {
  it("lays out 要回答, 対応中 and 不明, with ages", () => {
    mount();
    const ask = screen.getByRole("region", { name: "要回答" });
    expect(
      within(ask).getByText("本番マイグレーションの実行承認"),
    ).toBeVisible();
    expect(within(ask).getByText("列を追加します。")).toBeVisible();
    const progress = screen.getByRole("region", { name: "対応中" });
    expect(within(progress).getByText("answered 5m ago")).toBeVisible();
    const unaccounted = screen.getByRole("region", { name: "不明" });
    expect(within(unaccounted).getByText("idle 3m")).toBeVisible();
  });

  it("shows an agent in 不明 when it is clicked", () => {
    const dispatch = mount();
    fireEvent.click(screen.getByRole("button", { name: /docs-writer/u }));
    expect(dispatch).toHaveBeenCalledWith({
      type: "select_context",
      context: { kind: "agent", agentId: "a9" },
      reason: "explicit",
    });
  });

  it("jumps to an escalation's agent as a deliberate move, for Back and Forward", () => {
    motion(true);
    const dispatch = mount();
    fireEvent.click(
      screen.getByRole("button", { name: /本番マイグレーション/u }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /payments-migration/u }),
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "select_context",
      context: { kind: "agent", agentId: "a1" },
      reason: "explicit",
    });
  });

  it("opens an escalation in place, and answers it through the bridge", async () => {
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: /本番マイグレーション/u }),
    );
    expect(
      document.querySelector(
        ".orchestrator-thread pre, .orchestrator-thread code",
      ),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "保留" }));
    expect(answerEscalation).toHaveBeenCalledWith(1, "保留");
    await act(async () => {
      await Promise.resolve();
    });
    // Answered: back on the board.
    expect(document.querySelector(".orchestrator-reading")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /リトライ方針/u }));
    const field = screen.getByRole("textbox", { name: "Your answer to #2" });
    fireEvent.change(field, { target: { value: "やはり B で" } });
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    expect(answerEscalation).toHaveBeenLastCalledWith(2, "やはり B で");
  });
});

describe("after an answer", () => {
  const TWO: OrchestratorBoardWire = {
    ...BOARD,
    needsAnswer: [
      ...BOARD.needsAnswer,
      {
        ...BOARD.needsAnswer[0]!,
        id: 3,
        title: "ステージングの再作成",
        entries: [
          { role: "orchestrator", markdown: "作り直してよい?", at: NOW },
        ],
      },
    ],
  };

  async function sent() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("goes back to the board, focusing the next card in 要回答", async () => {
    motion(true);
    mount(TWO);
    const card = screen.getByRole("button", { name: /本番マイグレーション/u });
    card.focus();
    fireEvent.click(card);
    const field = screen.getByRole("textbox", { name: "Your answer to #1" });
    fireEvent.change(field, { target: { value: "実行して" } });
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    await sent();
    expect(document.querySelector(".orchestrator-reading")).toBeNull();
    expect(
      screen.getByRole("button", { name: /ステージングの再作成/u }),
    ).toHaveFocus();
  });

  it("with none left, focuses the card just answered", async () => {
    motion(false);
    vi.useFakeTimers();
    mount();
    const card = screen.getByRole("button", { name: /本番マイグレーション/u });
    card.focus();
    fireEvent.click(card);
    const field = screen.getByRole("textbox", { name: "Your answer to #1" });
    fireEvent.change(field, { target: { value: "実行して" } });
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    await sent();
    // The same slide as Esc.
    expect(document.querySelector(".orchestrator-stage")).toHaveAttribute(
      "data-nav",
      "pop",
    );
    expect(card).toHaveFocus();
    act(() => {
      vi.advanceTimersByTime(NAV_MS);
    });
    expect(document.querySelector(".orchestrator-reading")).toBeNull();
  });

  it("stays, with the error and the draft, when the send fails", async () => {
    motion(true);
    answerEscalation.mockImplementationOnce(() =>
      Promise.reject(new Error("the orchestrator is gone")),
    );
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: /本番マイグレーション/u }),
    );
    const field = screen.getByRole("textbox", { name: "Your answer to #1" });
    fireEvent.change(field, { target: { value: "実行して" } });
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    await sent();
    expect(document.querySelector(".orchestrator-reading")).not.toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "the orchestrator is gone",
    );
    expect(
      screen.getByRole("textbox", { name: "Your answer to #1" }),
    ).toHaveValue("実行して");
  });
});

describe("the orchestrator's ranking on the board", () => {
  it("marks high, low and quick, with the reason as a quiet line; normal shows nothing", () => {
    mount({
      ...BOARD,
      needsAnswer: [
        {
          ...BOARD.needsAnswer[0]!,
          priority: "high",
          effort: "quick",
          rankNote: "3 つのエージェントが止まっている",
        },
        {
          ...BOARD.needsAnswer[0]!,
          id: 4,
          title: "ログの保存期間",
          priority: "low",
          effort: "normal",
        },
      ],
    });
    const ask = screen.getByRole("region", { name: "要回答" });
    const [first, second] = [
      ...ask.querySelectorAll<HTMLElement>(".orchestrator-card"),
    ];
    expect(within(first!).getByText("優先")).toBeVisible();
    expect(within(first!).getByText("すぐ答えられる")).toBeVisible();
    expect(
      within(first!).getByText("3 つのエージェントが止まっている"),
    ).toBeVisible();
    expect(within(second!).getByText("低")).toBeVisible();
    expect(within(second!).queryByText("すぐ答えられる")).toBeNull();
    const progress = screen.getByRole("region", { name: "対応中" });
    expect(within(progress).queryByText("優先")).toBeNull();
    expect(within(progress).queryByText("低")).toBeNull();
  });
});

describe("opening an escalation and going back", () => {
  it("keeps the left pane's width: nothing about the pane changes", () => {
    motion(true);
    mount();
    const before = paneShape(boardSection());
    fireEvent.click(
      screen.getByRole("button", { name: /本番マイグレーション/u }),
    );
    expect(document.querySelector(".orchestrator-reading")).not.toBeNull();
    expect(paneShape(boardSection())).toBe(before);
    fireEvent.click(screen.getByRole("button", { name: "Back to the board" }));
    expect(paneShape(boardSection())).toBe(before);
  });

  it("sizes the pane in one rule, keyed on nothing it shows", () => {
    const css = readFileSync(
      "src/shell/agents/orchestrator.css",
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//gu, "");
    const sizing = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
      .filter(([, selector]) =>
        /orchestrator-board(?![\w-])/u.test(selector ?? ""),
      )
      .filter(([, , body]) =>
        /(?:^|[;\s])(?:min-|max-)?width\s*:/u.test(body ?? ""),
      )
      .map(([, selector]) => (selector ?? "").trim());
    expect(sizing).toEqual([".orchestrator-board"]);
  });

  it("slides: the view stays while it goes back, then leaves", () => {
    motion(false);
    vi.useFakeTimers();
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: /本番マイグレーション/u }),
    );
    const stage = document.querySelector(".orchestrator-stage");
    expect(stage).toHaveAttribute("data-nav", "push");
    expect(document.querySelector(".orchestrator-lanes")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    fireEvent.keyDown(
      screen.getByRole("button", { name: "Back to the board" }),
      { key: "Escape" },
    );
    expect(stage).toHaveAttribute("data-nav", "pop");
    const leaving = document.querySelector(".orchestrator-reading");
    expect(leaving).toHaveAttribute("aria-hidden", "true");
    expect(leaving).toHaveAttribute("inert");
    act(() => {
      vi.advanceTimersByTime(NAV_MS);
    });
    expect(stage).toHaveAttribute("data-nav", "idle");
    expect(document.querySelector(".orchestrator-reading")).toBeNull();
  });

  it("swaps at once under Reduce Motion", () => {
    motion(true);
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: /本番マイグレーション/u }),
    );
    fireEvent.keyDown(
      screen.getByRole("button", { name: "Back to the board" }),
      { key: "Escape" },
    );
    expect(document.querySelector(".orchestrator-stage")).toHaveAttribute(
      "data-nav",
      "idle",
    );
    expect(document.querySelector(".orchestrator-reading")).toBeNull();
    expect(document.querySelector(".orchestrator-lanes")).not.toHaveAttribute(
      "aria-hidden",
    );
  });

  it("focuses the answer on open, and the opened card on return", () => {
    motion(false);
    vi.useFakeTimers();
    mount();
    const card = screen.getByRole("button", { name: /本番マイグレーション/u });
    card.focus();
    fireEvent.click(card);
    const field = screen.getByRole("textbox", { name: "Your answer to #1" });
    expect(field).toHaveFocus();
    // Esc in the empty composer goes back.
    fireEvent.keyDown(field, { key: "Escape" });
    expect(card).toHaveFocus();
    act(() => {
      vi.advanceTimersByTime(NAV_MS);
    });
    expect(card).toHaveFocus();
  });

  it("focuses the thread when nothing is asked, and keeps a draft on Esc", () => {
    motion(true);
    mount();
    fireEvent.click(screen.getByRole("button", { name: /リトライ方針/u }));
    expect(document.querySelector(".orchestrator-thread")).toHaveFocus();
    const field = screen.getByRole("textbox", { name: "Your answer to #2" });
    fireEvent.change(field, { target: { value: "やはり B" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(document.querySelector(".orchestrator-reading")).not.toBeNull();
  });

  it("takes no focus from outside the board", () => {
    motion(true);
    const outside = document.createElement("input");
    document.body.append(outside);
    mount();
    outside.focus();
    fireEvent.click(
      screen.getByRole("button", { name: /本番マイグレーション/u }),
    );
    expect(outside).toHaveFocus();
    outside.remove();
  });
});

describe("the mouse's side buttons over the board", () => {
  function press(target: Element, button: number): MouseEvent {
    fireEvent.mouseDown(target, { button });
    const up = new MouseEvent("mouseup", {
      button,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      target.dispatchEvent(up);
    });
    return up;
  }

  it("goes back and forward between the board and an escalation, and leaves the app's history alone", () => {
    motion(true);
    const app = vi.fn();
    const uninstall = installHistoryButtons(document, app);
    try {
      mount();
      // Back on the board itself is the app's.
      press(screen.getByRole("region", { name: "要回答" }), 3);
      expect(app).toHaveBeenCalledWith("back");
      app.mockClear();
      // Forward with nothing gone back from is the app's too.
      press(boardSection(), 4);
      expect(app).toHaveBeenCalledWith("forward");
      app.mockClear();

      fireEvent.click(
        screen.getByRole("button", { name: /本番マイグレーション/u }),
      );
      const back = press(
        document.querySelector(".orchestrator-thread") as Element,
        3,
      );
      expect(back.defaultPrevented).toBe(true);
      expect(document.querySelector(".orchestrator-reading")).toBeNull();
      expect(app).not.toHaveBeenCalled();

      press(screen.getByRole("region", { name: "対応中" }), 4);
      expect(
        screen.getByRole("textbox", { name: "Your answer to #1" }),
      ).toBeVisible();
      expect(app).not.toHaveBeenCalled();
    } finally {
      uninstall();
    }
  });
});

describe("the board's words", () => {
  it("previews what a section says, not its heading", () => {
    expect(preview("## 背景\n\n| a | b |\n本文です。")).toBe("本文です。");
  });

  it("says how long in one short word", () => {
    expect(span(45_000)).toBe("45s");
    expect(span(12 * 60_000)).toBe("12m");
    expect(span(3 * 3_600_000)).toBe("3h");
  });
});
