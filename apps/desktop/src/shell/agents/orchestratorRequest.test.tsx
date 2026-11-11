// @vitest-environment jsdom

/**
 * The header's +: a request to the orchestrator, its composer (opened by a
 * click or the keyboard command, sent with ⌘Return, closed with Esc), and
 * the board's 依頼 lane.
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
import { OrchestratorBoard } from "./OrchestratorScreen";
import { forgetOrchestratorMemory } from "./orchestratorMemory";

const setOrchestratorMode = vi.fn(() => Promise.resolve());
const sendOrchestratorRequest = vi.fn(() => Promise.resolve());
let openComposer: (() => void) | undefined;
window.devhub = {
  openExternalUrl: vi.fn(() => Promise.resolve()),
  setOrchestratorMode,
  sendOrchestratorRequest,
  onOpenOrchestratorRequest: (listener: () => void) => {
    openComposer = listener;
    return () => {
      openComposer = undefined;
    };
  },
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

describe("the header's +", () => {
  it("opens a composer that sends with ⌘Return, and gives the keyboard back to + on Esc", async () => {
    mount({});
    const plus = screen.getByRole("button", {
      name: "New request to the orchestrator",
    });
    fireEvent.click(plus);
    const field = screen.getByRole("textbox", { name: "Request" });
    expect(field).toHaveFocus();
    fireEvent.change(field, { target: { value: "  CSV を直して  " } });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter", metaKey: true });
      await Promise.resolve();
    });
    expect(sendOrchestratorRequest).toHaveBeenCalledWith("CSV を直して");
    expect(screen.queryByRole("dialog", { name: "New request" })).toBeNull();
    fireEvent.click(plus);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Request" }), {
      key: "Escape",
    });
    expect(screen.queryByRole("dialog", { name: "New request" })).toBeNull();
    expect(plus).toHaveFocus();
  });

  it("opens from the keyboard command too, and sends nothing empty", () => {
    mount({});
    act(() => {
      openComposer?.();
    });
    const send = screen.getByRole("button", { name: "送信" });
    expect(send).toBeDisabled();
    fireEvent.click(send);
    expect(sendOrchestratorRequest).not.toHaveBeenCalled();
  });
});

describe("the 依頼 lane", () => {
  it("is not there with no requests", () => {
    mount({});
    expect(screen.queryByRole("region", { name: "依頼" })).toBeNull();
  });

  it("lists each request with its state, and where a filed one went", () => {
    mount({
      requests: [
        { id: 1, text: "ログを調べる", at: Date.now(), state: "held" },
        {
          id: 2,
          text: "CSV を直す",
          at: Date.now(),
          state: "sent",
          priority: "high",
        },
        {
          id: 3,
          text: "README",
          at: Date.now(),
          state: "filed",
          filed: { at: Date.now(), note: "acme/app#40" },
        },
      ],
    });
    const lane = screen.getByRole("region", { name: "依頼" });
    expect(within(lane).getByText("送信待ち")).toBeInTheDocument();
    expect(within(lane).getByText("受付待ち")).toBeInTheDocument();
    expect(within(lane).getByText("登録済み")).toBeInTheDocument();
    expect(within(lane).getByText("優先")).toBeInTheDocument();
    expect(within(lane).getByText("acme/app#40")).toBeInTheDocument();
    // The count is what is still open.
    expect(lane.querySelector(".orchestrator-lane-count")).toHaveTextContent(
      "2",
    );
  });
});
