// @vitest-environment jsdom

/**
 * Switching Agents is unhiding a pane: every running Agent's surface stays
 * mounted, the same component and the same element, whichever is selected.
 * What used to look like a pane drawn afresh — its entries rising in again —
 * was the browser restarting animations on a pane leaving `display: none`
 * (`useNoReplayOnShow` in `conversation/freshEntries.ts`), not a remount.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentWire, AppSnapshot } from "../../ipc/appShell";
import { AgentPane } from "./AgentPane";

const mounts: string[] = [];
const unmounts: string[] = [];
function Counted({ id, hidden }: { id: string; hidden: boolean }) {
  useEffect(() => {
    mounts.push(id);
    return () => void unmounts.push(id);
  }, [id]);
  return <div data-testid={id} data-hidden={hidden ? "" : undefined} />;
}

vi.mock("./ConversationPane", () => ({
  ConversationPane: ({
    agentId,
    hidden,
  }: {
    agentId: string;
    hidden: boolean;
  }) => <Counted id={agentId} hidden={hidden} />,
}));
vi.mock("../terminal/TerminalSurface", () => ({
  TerminalSurface: ({
    surfaceKey,
    hidden,
  }: {
    surfaceKey: string;
    hidden: boolean;
  }) => <Counted id={surfaceKey} hidden={hidden} />,
}));
// What floats over the pane is the selected Agent's and is drawn afresh for
// each; it is not what is under test.
vi.mock("./SmartButtons", () => ({ SmartButtons: () => null }));
vi.mock("../components/shell/InjectionStatus", () => ({
  InjectionStatus: () => null,
}));

afterEach(() => {
  cleanup();
  mounts.length = 0;
  unmounts.length = 0;
});

function agent(id: string, presentation: "gui" | "tui"): AgentWire {
  return {
    id,
    displayName: id,
    workspaceId: "w-1",
    presentation,
    controlState: { kind: "running" },
    injection: { queued: 0, waitingFor: "nothing_queued" },
  } as unknown as AgentWire;
}

function snapshot(): AppSnapshot {
  return {
    smartButtons: {},
    workspaces: [
      {
        id: "w-1",
        label: "example",
        state: { kind: "available" },
        agents: [
          agent("gui-1", "gui"),
          agent("gui-2", "gui"),
          agent("tui-1", "tui"),
        ],
      },
    ],
  } as unknown as AppSnapshot;
}

describe("switching Agents", () => {
  it("mounts each running Agent's surface once, and only unhides it", () => {
    const pane = (activeKey: string | undefined) => (
      <AgentPane
        snapshot={snapshot()}
        appearance={undefined}
        activeKey={activeKey}
      />
    );
    const { rerender, getByTestId } = render(pane("agent:gui-1"));
    const first = getByTestId("gui-1");
    for (const key of [
      "agent:gui-2",
      "agent:tui-1",
      undefined,
      "agent:gui-1",
      "agent:gui-2",
    ]) {
      rerender(pane(key));
    }
    expect([...mounts].sort()).toEqual(["agent:tui-1", "gui-1", "gui-2"]);
    expect(unmounts).toEqual([]);
    expect(getByTestId("gui-1")).toBe(first);
    expect(first).toHaveAttribute("data-hidden");
    expect(getByTestId("gui-2")).not.toHaveAttribute("data-hidden");
  });
});
