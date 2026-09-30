// @vitest-environment jsdom

/**
 * The Agents page's ways to another session: the floating Continue buttons
 * over an Agent's pane, and `/resume`'s picker inside a GUI Agent — its
 * scope, its preview, and the sessions it cannot offer.
 */

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentWire } from "../../ipc/appShell";
import type { PastSessionWire } from "../../ipc/contract";
import type { ConversationActions } from "../conversation/ConversationContext";
import { ConversationPane } from "./ConversationPane";
import { ContinueElsewhere, continuesElsewhere } from "./ContinueElsewhere";

// jsdom lays nothing out, and has no scrolling for a picker to do.
Element.prototype.scrollIntoView = vi.fn();

let surfaceActions: ConversationActions | undefined;
vi.mock("../conversation/ConversationSurface", () => ({
  ConversationSurface: ({ actions }: { actions: ConversationActions }) => {
    surfaceActions = actions;
    return <div className="conversation-composer" />;
  },
}));

const reportFailure = vi.fn();
vi.mock("./AgentsContext", () => ({
  useAgents: () => ({
    reportFailure,
    repositoryStatus: { sequence: 0, workspaces: [] },
  }),
}));

const HERE: PastSessionWire = {
  id: "s-here",
  title: "Fix the build",
  updatedAt: Date.UTC(2026, 8, 20),
  cwd: "/work/project",
  resumableHere: true,
};
const ELSEWHERE: PastSessionWire = {
  id: "s-else",
  title: "Another project's work",
  cwd: "/work/other",
  resumableHere: false,
};

const bridge = {
  attach: vi.fn(() => new Promise(() => {})),
  detach: vi.fn(() => Promise.resolve()),
  listSessions: vi.fn((_agent: string, scope: string) =>
    Promise.resolve(scope === "here" ? [HERE] : [ELSEWHERE, HERE]),
  ),
  previewSession: vi.fn(() =>
    Promise.resolve([
      { role: "person", text: "Why does it fail?" },
      { role: "agent", text: "A missing import." },
    ]),
  ),
  resumeSession: vi.fn(() => Promise.resolve()),
  continueInTerminal: vi.fn(() => Promise.resolve()),
  continueInGui: vi.fn(() => Promise.resolve()),
};

beforeEach(() => {
  reportFailure.mockReset();
  for (const fn of Object.values(bridge)) fn.mockClear();
  surfaceActions = undefined;
  window.devhub = { conversation: bridge };
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete window.devhub;
});

function pane() {
  return render(
    <ConversationPane
      agentId="agent-1"
      workspaceId="workspace-1"
      label="Claude 1"
      cli="Claude"
      appearance={undefined}
      hidden={false}
    />,
  );
}

describe("/resume inside a GUI Agent", () => {
  it("lists this project's sessions first, and every project's when asked, with another directory's said and not offered", async () => {
    pane();
    act(() => surfaceActions!.openResume());
    expect(
      await screen.findByRole("option", { name: /Fix the build/ }),
    ).toBeInTheDocument();
    expect(bridge.listSessions).toHaveBeenLastCalledWith("agent-1", "here");

    fireEvent.click(screen.getByRole("button", { name: "All projects" }));
    const other = await screen.findByRole("option", {
      name: /Another project's work/,
    });
    expect(bridge.listSessions).toHaveBeenLastCalledWith(
      "agent-1",
      "everywhere",
    );
    expect(other).toHaveAttribute("aria-disabled", "true");
    expect(other).toHaveTextContent(
      "Claude goes on with it only in /work/other.",
    );
    fireEvent.click(other);
    expect(bridge.resumeSession).not.toHaveBeenCalled();
  });

  it("previews the last exchanges of the session it rests on", async () => {
    pane();
    act(() => surfaceActions!.openResume());
    await screen.findByRole("option", { name: /Fix the build/ });
    expect(
      await screen.findByText("A missing import.", {}, { timeout: 2000 }),
    ).toBeInTheDocument();
    expect(bridge.previewSession).toHaveBeenCalledWith(
      "agent-1",
      "s-here",
      "/work/project",
    );
  });

  it("goes on with the chosen session, and closes once the Agent has it", async () => {
    pane();
    act(() => surfaceActions!.openResume());
    fireEvent.click(
      await screen.findByRole("option", { name: /Fix the build/ }),
    );
    expect(bridge.resumeSession).toHaveBeenCalledWith("agent-1", "s-here");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("hands a refusal to the page's root, and a listing that failed says so in the sheet", async () => {
    const busy = new Error("The Agent is in the middle of a turn.");
    bridge.resumeSession.mockImplementationOnce(() => Promise.reject(busy));
    pane();
    act(() => surfaceActions!.openResume());
    fireEvent.click(
      await screen.findByRole("option", { name: /Fix the build/ }),
    );
    await waitFor(() => expect(reportFailure).toHaveBeenCalledWith(busy));

    bridge.listSessions.mockImplementationOnce(() =>
      Promise.reject(new Error("no such directory")),
    );
    act(() => surfaceActions!.openResume());
    expect(
      await screen.findByText("The sessions could not be listed."),
    ).toBeInTheDocument();
  });
});

function agent(extra: Partial<AgentWire>): AgentWire {
  return {
    id: "agent-1",
    workspaceId: "workspace-1",
    displayName: "Claude 1",
    ordinal: 1,
    profileId: "claude",
    profileKind: "claude",
    presentation: "tui",
    status: "idle",
    runtimeHealth: "healthy",
    controlState: { kind: "running" },
    unread: undefined,
    activity: undefined,
    injection: {
      queued: 0,
      waitingFor: "nothing_queued",
      lastResult: undefined,
    },
    ...extra,
  } as AgentWire;
}

/** A terminal Agent's pane, as `AgentPane` draws it, with its Continue button. */
function terminalPane(of: AgentWire) {
  return (
    <div>
      <div data-surface-key={`agent:${of.id}`} data-agent-column="" />
      <ContinueElsewhere agent={of} />
    </div>
  );
}

describe("the floating Continue buttons", () => {
  it("offers a terminal Claude or Codex Agent the GUI, and no other kind anything", () => {
    expect(continuesElsewhere(agent({ profileKind: "codex" }))).toBe(true);
    expect(continuesElsewhere(agent({ profileKind: "cursor" }))).toBe(false);
    render(terminalPane(agent({})));
    fireEvent.click(screen.getByRole("button", { name: "Continue in GUI" }));
    expect(bridge.continueInGui).toHaveBeenCalledWith("agent-1");
  });

  // The two buttons are one control in one place: the top right corner of
  // the Agent's own column, the same distance in from its edges, and the same
  // size whichever it says. A terminal is its own column; a conversation's is
  // the one beside the subagents, so the button never sits over them.
  it("sits in the top right corner of the Agent's own column, a terminal's or a conversation's, by one rule", () => {
    const observed: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(changed: () => void) {
          observed.push(changed);
        }
        observe() {}
        disconnect() {}
      },
    );
    const { container } = render(
      <div>
        <div data-surface-key="agent:agent-1">
          <div className="conversation-main" data-agent-column="" />
          <div className="conversation-subagent-column" />
        </div>
        <div data-surface-key="agent:agent-2" data-agent-column="" />
        <ContinueElsewhere agent={agent({ presentation: "gui" })} />
        <ContinueElsewhere
          agent={agent({ id: "agent-2", presentation: "tui" })}
        />
      </div>,
    );
    const toTerminal = screen.getByRole("button", {
      name: "Continue in terminal",
    });
    const toGui = screen.getByRole("button", { name: "Continue in GUI" });
    // jsdom lays nothing out: the pane is 1000 × 800, the conversation's
    // column its left 640 px and the rest the subagents', the terminal the
    // whole pane.
    const place = (element: Element, rect: Partial<DOMRect>) => {
      element.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 0, bottom: 0, ...rect }) as DOMRect;
    };
    place(container.firstElementChild!, { right: 1000, bottom: 800 });
    place(container.querySelector(".conversation-main")!, { right: 640 });
    place(container.querySelector('[data-surface-key="agent:agent-2"]')!, {
      right: 1000,
    });
    act(() => observed.forEach((changed) => changed()));
    for (const [button, beside] of [
      [toTerminal, "360px"],
      [toGui, "0px"],
    ] as const) {
      expect(button.parentElement!.className).toBe("agent-continue");
      expect(
        button.parentElement!.style.getPropertyValue("--agent-continue-beside"),
      ).toBe(beside);
      // Both words are laid out in both buttons, one of them unseen, so the
      // button is the size of the longer one whichever it says.
      expect(
        [...button.querySelectorAll(".agent-continue-label")].map(
          (label) => label.textContent,
        ),
      ).toEqual(["Continue in terminal", "Continue in GUI"]);
    }
    fireEvent.click(toTerminal);
    expect(bridge.continueInTerminal).toHaveBeenCalledWith("agent-1");
  });

  it("hands a refusal to the page's root", async () => {
    const unknown = new Error(
      "The Codex of this terminal Agent has no thread open yet",
    );
    bridge.continueInGui.mockImplementationOnce(() => Promise.reject(unknown));
    render(terminalPane(agent({ profileKind: "codex" })));
    fireEvent.click(screen.getByRole("button", { name: "Continue in GUI" }));
    await waitFor(() => expect(reportFailure).toHaveBeenCalledWith(unknown));
  });
});
