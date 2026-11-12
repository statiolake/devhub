// @vitest-environment jsdom

/**
 * The header's +: a request to the orchestrator, its composer (opened by a
 * click or the keyboard command, sent with ⌘Return, closed with Esc), and
 * the 待機 task it makes on the board.
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
import { taskWire } from "./taskFixture";

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

describe("a request on the board", () => {
  it("is a 待機 task carrying the person's words: 送信待ち until it is delivered", () => {
    mount({
      waiting: [
        taskWire({
          id: 4,
          title: "ログを調べる",
          status: "waiting",
          request: { text: "ログを調べる", at: Date.now() },
        }),
        taskWire({
          id: 5,
          title: "CSV を直す",
          status: "waiting",
          request: { text: "CSV を直す", at: Date.now(), sentAt: Date.now() },
        }),
      ],
    });
    const lane = screen.getByRole("region", { name: "待機" });
    expect(within(lane).getByText("依頼 · 送信待ち")).toBeInTheDocument();
    expect(within(lane).getByText("依頼")).toBeInTheDocument();
    expect(lane.querySelector(".orchestrator-lane-count")).toHaveTextContent(
      "2",
    );
    // There is no lane of requests apart from the tasks.
    expect(screen.queryByRole("region", { name: "依頼" })).toBeNull();
  });
});
