// @vitest-environment jsdom

/**
 * Where a failure about one Agent is shown.
 *
 * The owner's rule: a failure is shown at its subject. A failure about one
 * Agent's pane — its session is gone, the runtime cannot be reached for it —
 * renders inside that pane, not as a banner across the whole window; and when
 * the condition clears the pane simply renders again, so there is nothing to
 * dismiss.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentFailureStateWire, AppSnapshot } from "../../../ipc/appShell";
import { AgentPane } from "./SurfaceViewport";

// The pane mounts a live terminal surface per running Agent, which wants a
// channel to main. The failure is drawn beside that, not by it, so the surface
// stands in as an empty box and what is under test stays what is under test.
vi.mock("../../terminal/TerminalSurface", () => ({
  TerminalSurface: () => <div data-testid="terminal" />,
}));
vi.mock("./AgentShortcuts", () => ({
  AgentShortcuts: () => null,
}));
vi.mock("../../useAppShell", () => ({
  useAppShell: () => ({ repositoryStatus: { workspaces: [] } }),
}));

function snapshotWith(failure: AgentFailureStateWire | undefined): AppSnapshot {
  return {
    workspaces: [
      {
        id: "workspace-1",
        label: "example",
        root: "/example",
        state: { kind: "available" },
        close: { kind: "idle" },
        agents: [
          {
            id: "agent-1",
            workspaceId: "workspace-1",
            displayName: "Codex 1",
            ordinal: 1,
            profileId: "codex",
            status: "idle",
            runtimeHealth: "healthy",
            controlState: { kind: "running" },
            unread: undefined,
            activity: undefined,
            injection: { kind: "idle" },
            ...(failure === undefined ? {} : { failure }),
          },
        ],
      },
    ],
  } as unknown as AppSnapshot;
}

function renderPane(failure: AgentFailureStateWire | undefined) {
  return render(
    <AgentPane
      snapshot={snapshotWith(failure)}
      appearance={undefined}
      activeKey="agent:agent-1"
      presentation="full"
    />,
  );
}

describe("a failure about one Agent", () => {
  afterEach(cleanup);

  it("is drawn in that Agent's own pane", () => {
    renderPane({ code: "tmux_session_conflict" });
    expect(
      screen.getByText(/session this Agent needs is not the one that is there/),
    ).toBeInTheDocument();
  });

  it("says what the runtime was allowed to say about DevHub's own setup", () => {
    renderPane({
      code: "agent_runtime_unavailable",
      detail: "tmux was not found on the configured PATH.",
    });
    expect(
      screen.getByText(/tmux was not found on the configured PATH/),
    ).toBeInTheDocument();
  });

  it("names the runtime rather than blaming it for everything", () => {
    // Every refusal used to read "the agent runtime is unavailable". A command
    // the runtime ran and refused is a different thing to go and look at.
    renderPane({ code: "tmux_command_failed" });
    expect(screen.getByText(/refused the request/)).toBeInTheDocument();
    expect(screen.queryByText(/could not be reached\./)).toBeNull();
  });

  it("is not there at all when the Agent has no failure", () => {
    // The whole of the lifetime rule as the pane sees it: the failure is a
    // fact about the Agent, so a pane rendered for an Agent that has none
    // simply does not draw one. There is nothing to dismiss and no timer.
    const { container } = renderPane(undefined);
    expect(container.querySelector(".agent-pane-failure")).toBeNull();
  });

  it("goes when the next snapshot has no failure on the Agent", () => {
    const { container, rerender } = renderPane({
      code: "agent_runtime_unavailable",
    });
    expect(container.querySelector(".agent-pane-failure")).not.toBeNull();
    rerender(
      <AgentPane
        snapshot={snapshotWith(undefined)}
        appearance={undefined}
        activeKey="agent:agent-1"
        presentation="full"
      />,
    );
    expect(container.querySelector(".agent-pane-failure")).toBeNull();
  });
});
