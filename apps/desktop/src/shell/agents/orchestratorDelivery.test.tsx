// @vitest-environment jsdom

/**
 * The Events switch's hover card: what the next delivery would send now,
 * as main composed it — the person's words, each its own message, the
 * batch, and when it goes — or that there is nothing to send.
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
import { AgentsValueProvider, type AgentsValue } from "./AgentsContext";
import { clockTime, GITHUB_CARD_LINGER_MS } from "./OrchestratorGitHub";
import { OrchestratorBoard } from "./OrchestratorScreen";
import { forgetOrchestratorMemory } from "./orchestratorMemory";

const setOrchestratorPaused = vi.fn(() => Promise.resolve());
window.devhub = {
  openExternalUrl: vi.fn(() => Promise.resolve()),
  setOrchestratorPaused,
  conversation: { resolvePaths: () => Promise.resolve([]) },
} as unknown as typeof window.devhub;

afterEach(() => {
  cleanup();
  forgetOrchestratorMemory();
  vi.clearAllMocks();
  vi.useRealTimers();
});

function mount(board: Partial<OrchestratorBoardWire>) {
  render(
    <AgentsValueProvider
      value={
        {
          board: { ...EMPTY_BOARD, orchestratorAgentId: "orch", ...board },
          dispatch: vi.fn().mockResolvedValue(undefined),
          reportFailure: vi.fn(),
        } as unknown as AgentsValue
      }
    >
      <OrchestratorBoard
        snapshot={
          {
            workspaces: [
              {
                id: "o",
                label: "orchestrator",
                root: "/o",
                agents: [{ id: "orch" }],
              },
            ],
          } as unknown as AppSnapshot
        }
      />
    </AgentsValueProvider>,
  );
}

function events(): HTMLElement {
  return screen.getByRole("switch", { name: "Events" });
}

function card(): HTMLElement {
  fireEvent.mouseEnter(events().parentElement!);
  return screen.getByRole("dialog", { name: "Next delivery" });
}

describe("the Events switch's card", () => {
  it("shows the batch as it goes, monospace, and when", () => {
    const at = Date.UTC(2026, 10, 5, 3, 5, 0);
    mount({
      held: 2,
      nextDelivery: {
        human: [],
        batch:
          "/make-progress [timer.elapsed] t\n[needs_action] issue=acme/app#1 — no_agent",
        lines: 2,
        more: 0,
        when: { kind: "at", at },
      },
    });
    const box = card();
    expect(box).toHaveTextContent(`Next delivery: at ${clockTime(at)}`);
    expect(box).toHaveTextContent("Events, one message: 2 lines");
    const text = within(box).getByText(/make-progress/u);
    expect(text.tagName).toBe("PRE");
    expect(text.textContent).toBe(
      "/make-progress [timer.elapsed] t\n[needs_action] issue=acme/app#1 — no_agent",
    );
  });

  it("shows the person's words each as its own message, paused", () => {
    mount({
      paused: true,
      held: 1,
      nextDelivery: {
        human: [
          "esc=1「t」 への人の回答:\nはい",
          "esc=2「u」 への人の回答:\nいいえ",
        ],
        lines: 0,
        more: 0,
        when: { kind: "paused" },
      },
    });
    const box = card();
    expect(box).toHaveTextContent("paused: sent when Events is turned on");
    expect(box).toHaveTextContent("message 1 of 2");
    expect(box).toHaveTextContent("message 2 of 2");
    expect(box.querySelectorAll("pre")).toHaveLength(2);
    expect(box).not.toHaveTextContent("Events, one message");
  });

  it("says when there is nothing to send, and opens from the pending count too", () => {
    mount({ nextDelivery: { human: [], lines: 0, more: 0 } });
    expect(card()).toHaveTextContent("Nothing to send");
    cleanup();
    mount({
      held: 1,
      nextDelivery: {
        human: [],
        batch: "x",
        lines: 1,
        more: 3,
        when: { kind: "now" },
      },
    });
    fireEvent.focus(screen.getByText("1 pending"));
    const box = screen.getByRole("dialog", { name: "Next delivery" });
    expect(box).toHaveTextContent("Next delivery: now");
    expect(box).toHaveTextContent("1 line, 3 more counted");
  });

  it("closes a moment after the pointer leaves, and toggles the pause", () => {
    vi.useFakeTimers();
    mount({ nextDelivery: { human: [], lines: 0, more: 0 } });
    card();
    fireEvent.mouseLeave(events().parentElement!);
    act(() => {
      vi.advanceTimersByTime(GITHUB_CARD_LINGER_MS);
    });
    expect(screen.queryByRole("dialog", { name: "Next delivery" })).toBeNull();
    fireEvent.click(events());
    expect(setOrchestratorPaused).toHaveBeenCalledWith(true);
  });
});
