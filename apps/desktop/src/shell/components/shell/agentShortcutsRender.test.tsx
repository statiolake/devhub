// @vitest-environment jsdom

/**
 * The shortcuts as a person meets them: what is on screen, what pressing one
 * does, and what the pane says afterwards.
 *
 * Pressing a shortcut does not run git and does not talk to GitHub. It asks
 * main to say a sentence to the agent, and the sentence waits for the agent's
 * screen to settle — so what this pins is that the button *queues* and that the
 * pane says the message is waiting rather than claiming it was sent.
 */

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSnapshot } from "../../../ipc/appShell";
import type { WorkspaceRepositoryWire } from "../../../ipc/contract";
import type { AppShellContextValue } from "../../useAppShell";
import { AppShellContext } from "../../useAppShell";
import { AgentShortcuts } from "./AgentShortcuts";

afterEach(cleanup);

const ACTIONS = [
  {
    id: "issue_assignment",
    displayName: "Work on the Issue",
    trigger: "issue",
  },
  {
    id: "commit_changes",
    displayName: "Commit the changes",
    trigger: "commit",
  },
  { id: "push_commits", displayName: "Push the commits", trigger: "push" },
  {
    id: "open_pull_request",
    displayName: "Open a pull request",
    trigger: "pull_request",
  },
] as const;

function agent(over: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id: "a-1",
    displayName: "Claude 1",
    workspaceId: "w-1",
    status: "idle",
    injection: {
      queued: 0,
      waitingFor: "nothing_queued",
      lastResult: undefined,
    },
    ...over,
  } as unknown as AgentSnapshot;
}

function mount(
  repository: WorkspaceRepositoryWire | undefined,
  over: Partial<AgentSnapshot> = {},
) {
  const runAgentAction = vi.fn(() => Promise.resolve({}));
  const reportFailure = vi.fn();
  const value = {
    agentActions: () => Promise.resolve(ACTIONS),
    subscribeAgentActions: () => () => undefined,
    runAgentAction,
    reportFailure,
  } as unknown as AppShellContextValue;
  render(
    <AppShellContext.Provider value={value}>
      <AgentShortcuts agent={agent(over)} repository={repository} />
    </AppShellContext.Provider>,
  );
  return { runAgentAction, reportFailure };
}

const DIRTY: WorkspaceRepositoryWire = {
  workspaceId: "w-1",
  branch: "feature/128-tidy",
  defaultBranch: "main",
  dirty: true,
  ahead: 0,
};

describe("the shortcut buttons", () => {
  it("draws the wording the person configured, not DevHub's own", async () => {
    // The whole extension point: DevHub decides there is a commit shortcut,
    // the configuration decides what it is called and what it says.
    mount(DIRTY);
    expect(
      await screen.findByRole("button", { name: /Commit the changes/u }),
    ).toBeInTheDocument();
  });

  it("draws nothing when no condition holds", async () => {
    mount({ ...DIRTY, dirty: false, defaultBranch: "feature/128-tidy" });
    await waitFor(() => {
      expect(document.querySelector(".agent-shortcuts")).toBeNull();
    });
  });

  it("queues the action rather than running anything", async () => {
    const { runAgentAction } = mount(DIRTY);
    fireEvent.click(
      await screen.findByRole("button", { name: /Commit the changes/u }),
    );
    expect(runAgentAction).toHaveBeenCalledWith("a-1", "commit_changes");
  });

  it("reports a refusal instead of doing nothing visible", async () => {
    // A button that silently fails is the worst of the three things it could
    // do, so the failure goes to the one place the shell shows them.
    //
    // The rejection is made *when the mock is called*, not when it is set up.
    // `mockReturnValue(Promise.reject(…))` builds a rejected promise here and
    // now, and the `await` below then yields several times before anything
    // attaches a handler to it — which is an unhandled rejection, reported
    // against a test that passed. Building it inside the implementation keeps
    // the handler in the same tick as the promise.
    //
    // That is also what keeps this test honest: the component attaches its
    // `.catch` synchronously to whatever the call returns, so if it ever
    // stopped doing so the unhandled rejection would come back and fail the
    // run rather than the failure quietly going nowhere.
    const refusal = new Error("That agent is not running.");
    const { runAgentAction, reportFailure } = mount(DIRTY);
    const button = await screen.findByRole("button", {
      name: /Commit the changes/u,
    });
    runAgentAction.mockImplementation(() => Promise.reject(refusal));
    fireEvent.click(button);
    await waitFor(() => {
      expect(reportFailure).toHaveBeenCalledWith(refusal);
    });
  });

  it("is offered but disabled for an agent whose screen nothing can read", async () => {
    // Cursor, and anything else with no manifest. There is no idle to wait for,
    // so a message queued for it would never go — and a button that vanished
    // for that reason would take the explanation with it.
    mount(DIRTY, { status: "unknown" });
    const button = await screen.findByRole("button", {
      name: /Commit the changes/u,
    });
    expect(button).toBeDisabled();
    expect(button.getAttribute("title")).toMatch(/cannot read this agent/u);
  });

  it("says a message is waiting rather than that it was sent", async () => {
    // It is queued for a settled idle screen. Claiming it was sent would be a
    // claim about where the text is that the queue can contradict.
    mount(DIRTY, {
      injection: {
        queued: 1,
        waitingFor: "agent_busy",
        lastResult: undefined,
      },
    } as Partial<AgentSnapshot>);
    expect(await screen.findByRole("status")).toHaveTextContent(
      /Waiting for the agent to finish/u,
    );
  });

  /**
   * The four endings are four different sentences, and the one that is not a
   * failure is the one most easily lost: a message nobody agreed to looks
   * exactly like a message waiting for a busy agent if the row only knows the
   * queue is not empty.
   */
  it("distinguishes waiting for the person from waiting for the agent", async () => {
    mount(DIRTY, {
      injection: {
        queued: 1,
        waitingFor: "awaiting_review",
        lastResult: undefined,
      },
    } as Partial<AgentSnapshot>);
    expect(await screen.findByRole("status")).toHaveTextContent(
      /confirm the wording/u,
    );
  });

  it("says a message was cancelled rather than dropping it in silence", async () => {
    mount(DIRTY, {
      injection: {
        queued: 0,
        waitingFor: "nothing_queued",
        lastResult: { kind: "cancelled" as const },
      },
    } as Partial<AgentSnapshot>);
    expect(await screen.findByRole("status")).toHaveTextContent(/Cancelled/u);
  });

  it("says a message went, which an empty queue alone does not", async () => {
    mount(DIRTY, {
      injection: {
        queued: 0,
        waitingFor: "nothing_queued",
        lastResult: { kind: "sent" as const },
      },
    } as Partial<AgentSnapshot>);
    expect(await screen.findByRole("status")).toHaveTextContent(/Sent/u);
  });

  it("keeps a failed send on screen", async () => {
    mount(DIRTY, {
      injection: {
        queued: 0,
        waitingFor: "nothing_queued",
        lastResult: {
          kind: "failed" as const,
          reason: "The pane closed before the text could be typed.",
        },
      },
    } as Partial<AgentSnapshot>);
    expect(await screen.findByRole("alert")).toHaveTextContent(/pane closed/u);
  });

  /**
   * A row of buttons stands for as long as its pane does, so it cannot read the
   * actions once. Renaming one in Settings used to leave the old name on the
   * button until the window was reloaded, with nothing on screen to say so.
   */
  it("follows a change to the actions while the pane stands", async () => {
    let publish: ((actions: typeof ACTIONS) => void) | undefined;
    const value = {
      agentActions: () => Promise.resolve(ACTIONS),
      subscribeAgentActions: (listener: (actions: typeof ACTIONS) => void) => {
        publish = listener;
        return () => undefined;
      },
      runAgentAction: vi.fn(),
      reportFailure: vi.fn(),
    } as unknown as AppShellContextValue;
    render(
      <AppShellContext.Provider value={value}>
        <AgentShortcuts agent={agent()} repository={DIRTY} />
      </AppShellContext.Provider>,
    );
    expect(await screen.findByText("Commit the changes")).toBeInTheDocument();
    publish?.([
      {
        id: "commit_changes",
        displayName: "Commit in pieces",
        trigger: "commit",
      },
    ] as unknown as typeof ACTIONS);
    expect(await screen.findByText("Commit in pieces")).toBeInTheDocument();
    expect(screen.queryByText("Commit the changes")).toBeNull();
  });

  it("offers no shortcut the configuration has no wording for", async () => {
    // A person who deleted the commit action has decided DevHub should not
    // offer it. A button with nothing to say would fail when pressed.
    const value = {
      agentActions: () =>
        Promise.resolve(ACTIONS.filter((a) => a.trigger !== "commit")),
      subscribeAgentActions: () => () => undefined,
      runAgentAction: vi.fn(),
      reportFailure: vi.fn(),
    } as unknown as AppShellContextValue;
    render(
      <AppShellContext.Provider value={value}>
        <AgentShortcuts agent={agent()} repository={DIRTY} />
      </AppShellContext.Provider>,
    );
    await waitFor(() => {
      expect(document.querySelector(".agent-shortcuts")).toBeNull();
    });
  });
});
