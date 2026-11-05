// @vitest-environment jsdom

/**
 * The board header, calmer: the events switch says only "Events", and
 * GitHub polling is a `GitHub` pill with a dot, whose card (on hover or
 * focus) holds the boards, the state and why, the polls and the rate limit.
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
import { clockTime, GITHUB_CARD_LINGER_MS } from "./OrchestratorGitHub";
import { OrchestratorBoard } from "./OrchestratorScreen";
import { forgetOrchestratorMemory } from "./orchestratorMemory";

const openExternalUrl = vi.fn(() => Promise.resolve());
window.devhub = {
  openExternalUrl,
  setOrchestratorPaused: vi.fn(() => Promise.resolve()),
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
    <AgentsContext.Provider
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
    </AgentsContext.Provider>,
  );
}

function pill(): HTMLElement {
  return screen.getByRole("button", { name: /^GitHub/u });
}

function card(): HTMLElement {
  fireEvent.mouseEnter(pill().parentElement!);
  return screen.getByRole("dialog", { name: "GitHub polling" });
}

const LAST = Date.UTC(2026, 10, 5, 3, 0, 0);
const NEXT = LAST + 90_000;

describe("the events switch", () => {
  it("says only Events; the switch says on or off", () => {
    mount({ paused: false, held: 2 });
    const toggle = screen.getByRole("switch");
    expect(toggle).toHaveTextContent(/^Events$/u);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("2 pending")).toBeInTheDocument();
    cleanup();
    mount({ paused: true });
    expect(screen.getByRole("switch")).toHaveTextContent(/^Events$/u);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });
});

describe("the GitHub pill", () => {
  it.each([
    [{ state: "active" } as const, "active"],
    [{ state: "suspended" } as const, "suspended"],
    [{ state: "idle" } as const, "idle"],
    [{ state: "active", problem: "HTTP 502" } as const, "backing_off"],
    [
      {
        state: "active",
        rateLimit: { remaining: 40, limit: 5000, resetAt: NEXT },
      } as const,
      "backing_off",
    ],
  ])("draws %o as %s", (github, health) => {
    mount({ github });
    // Spelled as the product is, in what the person reads.
    expect(pill()).toHaveTextContent(/^GitHub$/u);
    expect(pill()).toHaveAccessibleName(/^GitHub: /u);
    expect(pill()).toHaveAttribute("data-health", health);
    expect(pill()).not.toHaveAttribute("title");
    expect(screen.queryByText(/polling/u)).toBeNull();
  });

  it("shows, on hover, the boards as links, the state, the polls and the rate limit", () => {
    mount({
      github: {
        state: "active",
        lastAt: LAST,
        nextAt: NEXT,
        rateLimit: { remaining: 4321, limit: 5000, resetAt: NEXT },
        boards: [{ ref: "acme/7", title: "Roadmap" }, { ref: "me/2" }],
      },
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    const box = card();
    expect(box).toHaveTextContent("Active");
    const boards = within(box).getByRole("list", { name: "Boards" });
    expect(boards).toHaveTextContent("acme/7 Roadmap");
    const link = within(box).getByRole("link", { name: "acme/7" });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/orgs/acme/projects/7",
    );
    fireEvent.click(link);
    expect(openExternalUrl).toHaveBeenCalledWith(
      "https://github.com/orgs/acme/projects/7",
    );
    expect(within(box).getByRole("link", { name: "me/2" })).toBeVisible();
    expect(box).toHaveTextContent(`Last poll${clockTime(LAST)}`);
    expect(box).toHaveTextContent(`Next poll${clockTime(NEXT)}`);
    expect(box).toHaveTextContent(
      `Rate limit${(4321).toLocaleString()} / ${(5000).toLocaleString()} left`,
    );
  });

  it("counts each board's cards: items, assigned to me, unattended", () => {
    mount({
      github: {
        state: "active",
        boards: [
          { ref: "acme/7", items: 42, assigned: 5, unattended: 2 },
          { ref: "me/2" },
        ],
      },
    });
    const boards = within(card()).getByRole("list", { name: "Boards" });
    expect(boards).toHaveTextContent(
      "acme/7 · 42 items, 5 assigned to me, 2 unattended",
    );
    expect(boards).toHaveTextContent("me/2 · not read yet");
  });

  it("says why it backs off, and when it polls next", () => {
    mount({
      github: {
        state: "active",
        lastAt: LAST,
        nextAt: NEXT,
        problem: "GitHub answered 502",
      },
    });
    const box = card();
    expect(box).toHaveTextContent("Backing off: GitHub answered 502");
    expect(box).toHaveTextContent(`Next poll${clockTime(NEXT)}`);
  });

  it("says suspended, and idle with why", () => {
    mount({ github: { state: "suspended", lastAt: LAST } });
    expect(card()).toHaveTextContent("Suspended: events are paused");
    expect(card()).not.toHaveTextContent("Next poll");
    cleanup();
    mount({ github: { state: "idle" } });
    expect(card()).toHaveTextContent(
      "Idle: [orchestrator.github] projects names no board",
    );
    cleanup();
    mount({ orchestratorAgentId: undefined, github: { state: "idle" } });
    expect(card()).toHaveTextContent("Idle: no orchestrator is running");
  });

  it("stays while the pointer moves into it, and goes once it has left both", () => {
    vi.useFakeTimers();
    mount({ github: { state: "active", boards: [{ ref: "acme/7" }] } });
    const wrap = pill().parentElement!;
    fireEvent.mouseEnter(wrap);
    fireEvent.mouseLeave(pill());
    // The card is inside the same hover area: still there.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.mouseLeave(wrap);
    fireEvent.mouseEnter(wrap);
    act(() => {
      vi.advanceTimersByTime(GITHUB_CARD_LINGER_MS);
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.mouseLeave(wrap);
    act(() => {
      vi.advanceTimersByTime(GITHUB_CARD_LINGER_MS);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens from the keyboard too", () => {
    mount({ github: { state: "active" } });
    fireEvent.focus(pill());
    expect(screen.getByRole("dialog")).toHaveTextContent("Active");
  });
});
