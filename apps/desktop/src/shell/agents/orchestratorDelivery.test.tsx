// @vitest-environment jsdom

/**
 * The mode control (full · saving · off), and its hover card: what the next delivery would send now,
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

const setOrchestratorMode = vi.fn(() => Promise.resolve());
window.devhub = {
  openExternalUrl: vi.fn(() => Promise.resolve()),
  setOrchestratorMode,
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
  return screen.getByRole("radiogroup", { name: "Orchestrator mode" });
}

function card(): HTMLElement {
  fireEvent.mouseEnter(events().parentElement!);
  return screen.getByRole("dialog", { name: "Next delivery" });
}

describe("the mode control's card", () => {
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
        human: ["esc=1 「はい」", "esc=2 「いいえ」"],
        lines: 0,
        more: 0,
        when: { kind: "paused" },
      },
    });
    const box = card();
    expect(box).toHaveTextContent(
      "off: sent when the mode is turned to full or saving",
    );
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

  it("says when saving holds every line for the next triage", () => {
    mount({
      mode: "saving",
      nextDelivery: {
        human: [],
        lines: 0,
        more: 0,
        when: { kind: "saving_held", lines: 3 },
      },
    });
    expect(card()).toHaveTextContent(
      "saving: 3 reminders wait for the next triage",
    );
  });

  it("closes a moment after the pointer leaves, and chooses a mode", () => {
    vi.useFakeTimers();
    mount({ nextDelivery: { human: [], lines: 0, more: 0 } });
    card();
    fireEvent.mouseLeave(events().parentElement!);
    act(() => {
      vi.advanceTimersByTime(GITHUB_CARD_LINGER_MS);
    });
    expect(screen.queryByRole("dialog", { name: "Next delivery" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Saving" }));
    expect(setOrchestratorMode).toHaveBeenCalledWith("saving");
  });
});

describe("the mode control", () => {
  it("shows the three modes, the current one checked; off when the board says nothing", () => {
    mount({});
    const radios = screen.getAllByRole("radio");
    expect(radios.map((one) => one.textContent)).toEqual([
      "Full",
      "Saving",
      "Off",
    ]);
    expect(screen.getByRole("radio", { name: "Off" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    cleanup();
    mount({ mode: "full" });
    expect(screen.getByRole("radio", { name: "Full" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("is one tab stop the arrows move, choosing as they go: nothing mouse-only", () => {
    mount({ mode: "full" });
    const full = screen.getByRole("radio", { name: "Full" });
    expect(full).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: "Off" })).toHaveAttribute(
      "tabindex",
      "-1",
    );
    fireEvent.keyDown(full, { key: "ArrowRight" });
    expect(setOrchestratorMode).toHaveBeenLastCalledWith("saving");
    fireEvent.keyDown(full, { key: "ArrowLeft" });
    expect(setOrchestratorMode).toHaveBeenLastCalledWith("off");
    fireEvent.keyDown(full, { key: "End" });
    expect(setOrchestratorMode).toHaveBeenLastCalledWith("off");
  });

  it("says, quietly, when saving came by itself, and why in the card", () => {
    const resetsAt = Date.UTC(2026, 10, 5, 8, 0, 0);
    mount({
      mode: "saving",
      autoSaving: {
        cli: "claude",
        window: "5-hour",
        usedPercent: 82.4,
        threshold: 80,
        resetsAt,
      },
      nextDelivery: { human: [], lines: 0, more: 0 },
    });
    expect(screen.getByText("auto")).toBeInTheDocument();
    expect(card()).toHaveTextContent(
      `Saving by itself: Claude 5-hour at 82% (80% or more). Back to full when it resets at ${clockTime(resetsAt)}.`,
    );
  });
});
