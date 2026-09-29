// @vitest-environment jsdom

/**
 * Where a failure about one Agent is shown.
 *
 * The owner's rule: a failure is shown at its subject. A failure about one
 * Agent's pane — its session is gone, the runtime cannot be reached for it,
 * its CLI signed out — is a sheet over that pane dimmed, not a banner across
 * the whole window; dismissed, it is a line along the top of the pane; and
 * when the condition clears the pane simply renders again.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentFailureStateWire, AppSnapshot } from "../../../ipc/appShell";
import { AgentPane } from "../../agents/AgentPane";

// The pane mounts a live terminal surface per running Agent, which wants a
// channel to main. The failure is drawn beside that, not by it, so the surface
// stands in as an empty box and what is under test stays what is under test.
vi.mock("../../terminal/TerminalSurface", () => ({
  TerminalSurface: () => <div data-testid="terminal" />,
}));
vi.mock("../../agents/SmartButtons", () => ({
  SmartButtons: () => null,
}));
vi.mock("../../agents/ContinueElsewhere", () => ({
  ContinueElsewhere: () => null,
  continuesElsewhere: () => false,
}));
vi.mock("../../agents/ConversationPane", () => ({
  ConversationPane: () => <div data-testid="conversation" />,
}));
const dispatch = vi.fn(() => Promise.resolve(undefined));
const reportFailure = vi.fn();
vi.mock("../../agents/AgentsContext", () => ({
  useAgents: () => ({
    dispatch,
    reportFailure,
    repositoryStatus: { sequence: 0, workspaces: [] },
    agentActions: [],
    runAgentAction: vi.fn(),
  }),
}));

function snapshotWith(
  failure: AgentFailureStateWire | undefined,
  presentation: "gui" | "tui" = "gui",
): AppSnapshot {
  return {
    smartButtons: {},
    workspaces: [
      {
        id: "workspace-1",
        label: "example",
        root: "/example",
        displayRoot: "/example",
        state: { kind: "available" },
        close: { kind: "idle" },
        agents: [
          {
            id: "agent-1",
            workspaceId: "workspace-1",
            displayName: "Codex 1",
            ordinal: 1,
            profileId: "codex",
            profileKind: "codex",
            presentation,
            status: "error",
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

function renderPane(
  failure: AgentFailureStateWire | undefined,
  presentation: "gui" | "tui" = "tui",
) {
  return render(
    <AgentPane
      snapshot={snapshotWith(failure, presentation)}
      appearance={undefined}
      activeKey="agent:agent-1"
    />,
  );
}

const SIGNED_OUT: AgentFailureStateWire = {
  code: "conversation_not_signed_in",
  detail:
    "claude said: “Invalid API key · Please run /login”. Sign in with `claude auth login` (or `/login` in claude) in a terminal on this Agent's machine, then try again.",
};

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
    renderPane(undefined);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("goes when the next snapshot has no failure on the Agent", () => {
    const { rerender } = renderPane({ code: "agent_runtime_unavailable" });
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    rerender(
      <AgentPane
        snapshot={snapshotWith(undefined, "tui")}
        appearance={undefined}
        activeKey="agent:agent-1"
      />,
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

/**
 * The owner's case: a GUI Agent's CLI signed out. What it said stays in view
 * behind a dimmed pane, and the sheet names the failure, gives the CLI's
 * reason and the sign-in, and offers Try again — Restart Session on the same
 * session — and Dismiss.
 */
describe("a conversation its CLI stopped", () => {
  afterEach(() => {
    cleanup();
    dispatch.mockClear();
    reportFailure.mockClear();
  });

  it("is a sheet over the pane dimmed, with the CLI's reason and how to sign in", () => {
    const { container } = renderPane(SIGNED_OUT, "gui");
    const sheet = screen.getByRole("alertdialog");
    expect(sheet).toHaveAccessibleName("Authentication failed");
    // The pane is dimmed, not replaced: the conversation stays mounted under
    // the scrim, which covers this pane and nothing outside it.
    expect(container.querySelector(".agent-failure-scrim")).toContainElement(
      sheet,
    );
    expect(container.querySelector(".agent-pane-failure")).toBeNull();
    expect(screen.getByText(/Invalid API key/)).toBeInTheDocument();
    expect(screen.getByText("claude auth login").tagName).toBe("CODE");
    expect(
      screen.getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["Open a terminal to sign in", "Dismiss", "Try again"]);
  });

  it("tries again with Restart Session, the same intent as the Sidebar's", async () => {
    renderPane(SIGNED_OUT, "gui");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(dispatch).toHaveBeenCalledWith({
      type: "restart_agent",
      agentId: "agent-1",
    });
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled(),
    );
  });

  it("is dismissed to a banner that still offers Try again", () => {
    renderPane(SIGNED_OUT, "gui");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent("Authentication failed");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(dispatch).toHaveBeenCalledWith({
      type: "restart_agent",
      agentId: "agent-1",
    });
  });

  it("is dismissed by Escape, as every sheet is", () => {
    renderPane(SIGNED_OUT, "gui");
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("asks again when the failure is a different one", () => {
    const { rerender } = renderPane(SIGNED_OUT, "gui");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    rerender(
      <AgentPane
        snapshot={snapshotWith({ code: "conversation_refused", detail: "x" })}
        appearance={undefined}
        activeKey="agent:agent-1"
      />,
    );
    expect(screen.getByRole("alertdialog")).toHaveAccessibleName(
      "CLI refused to start",
    );
  });

  it("offers a terminal from the same profile to sign in", () => {
    renderPane(SIGNED_OUT, "gui");
    fireEvent.click(
      screen.getByRole("button", { name: "Open a terminal to sign in" }),
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: "request_create_agent",
      workspaceId: "workspace-1",
      profileId: "codex",
      presentation: "tui",
    });
  });
});

/**
 * A conversation DevHub cannot follow offers the one way on: the Agent's CLI
 * in a terminal (design §6.1). A restart could not be followed either, so
 * there is no Try again.
 */
describe("a conversation DevHub cannot follow", () => {
  afterEach(() => {
    cleanup();
    dispatch.mockClear();
    reportFailure.mockClear();
  });

  it("offers to carry the conversation on in a terminal, and no Try again", () => {
    const continueInTerminal = vi.fn(() => Promise.resolve());
    window.devhub = { conversation: { continueInTerminal } };
    renderPane(
      {
        code: "conversation_protocol_mismatch",
        detail: "assistant.message.content: expected an array",
      },
      "gui",
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Continue in terminal" }),
    );
    expect(continueInTerminal).toHaveBeenCalledWith("agent-1");
  });

  it("hands a way out that failed to the page's root", async () => {
    const refused = new Error("no session yet");
    window.devhub = {
      conversation: { continueInTerminal: () => Promise.reject(refused) },
    };
    renderPane(
      { code: "conversation_host_lost", detail: "the journal stopped" },
      "gui",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Continue in terminal" }),
    );
    await vi.waitFor(() => expect(reportFailure).toHaveBeenCalledWith(refused));
  });

  it("offers only Dismiss for a terminal Agent's own failures", () => {
    renderPane({ code: "tmux_session_conflict" });
    expect(
      screen.getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["Dismiss"]);
  });
});
