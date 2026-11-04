// @vitest-environment jsdom

/**
 * The Orchestrator board: three lanes, an escalation opened in place with
 * the conversation's renderer, and the person's answer going out through the
 * one door it has (`answerEscalation`).
 */

import "@testing-library/jest-dom/vitest";
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
import { AgentsContext, type AgentsValue } from "./AgentsContext";
import { OrchestratorBoard, preview, span } from "./OrchestratorScreen";

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
});

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
    const field = screen.getByRole("textbox", { name: "Your answer to #1" });
    fireEvent.change(field, { target: { value: "実行して、ただし夜に" } });
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    expect(answerEscalation).toHaveBeenLastCalledWith(
      1,
      "実行して、ただし夜に",
    );
    fireEvent.keyDown(
      screen.getByRole("button", { name: "Back to the board" }),
      { key: "Escape" },
    );
    expect(screen.getByRole("region", { name: "要回答" })).toBeVisible();
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
