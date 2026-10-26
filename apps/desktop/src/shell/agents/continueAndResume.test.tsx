// @vitest-environment jsdom

/**
 * The Agents page's way to another session: `/resume`'s picker inside a GUI
 * Agent — its scope, its preview, and the sessions it cannot offer. (Continue
 * in Terminal / GUI is the Sidebar's row menu now: `rowMenu.test.tsx`.)
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
import type { PastSessionWire } from "../../ipc/contract";
import type { ConversationActions } from "../conversation/ConversationContext";
import { ConversationPane } from "./ConversationPane";

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
