// @vitest-environment jsdom

/**
 * What a Workspace row says when its folder is on another machine.
 *
 * The rule this is holding is that nothing goes quiet, and what falls under it
 * has shrunk. git, the HEAD watcher and the Issue lookup run through the
 * folder's own machine now, so a remote row draws a branch, an Issue and a
 * pull request exactly like a local one — and it still names the machine,
 * because that is the fact that tells three checkouts of one repository apart.
 *
 * What is still not there is a process with a terminal on it: tmux, and the
 * PTY an Agent pane attaches to. That refusal is on the New Agent button,
 * disabled with the reason in its tooltip, in the sentence the wire sends —
 * one sentence, so the button and the terminal pane cannot drift apart. It is
 * not on the row's own lines any more, because it is not a fact about the
 * branch.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSnapshot } from "../../../ipc/appShell";
import type { RepositoryStatusWire } from "../../../ipc/contract";
import type { SidebarValue } from "../../sidebar/SidebarContext";
import { SidebarContext } from "../../sidebar/SidebarContext";
import { Sidebar } from "./Sidebar";

window.devhub = {
  openModal: vi.fn(() => Promise.resolve("")),
  onMenuCommand: () => () => undefined,
  // The Sidebar asks main for its tooltips now rather than drawing them
  // (`RowTooltip.tsx`), so every render of it reaches these three.
  onSidebarArea: () => () => undefined,
  showTooltip: () => undefined,
  hideTooltip: () => undefined,
} as unknown as typeof window.devhub;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount(
  workspace: Record<string, unknown>,
  repository?: Record<string, unknown>,
) {
  const value = {
    dispatch: vi.fn(),
    openExternalUrl: vi.fn(),
    answerWorktreeClose: vi.fn(() => Promise.resolve({})),
    closeWorkspace: vi.fn(),
    reportFailure: vi.fn(),
    agentProfiles: {
      sequence: 1,
      availability: "available",
      profiles: [{ id: "codex", displayName: "Codex" }],
    },
    repositoryStatus: {
      sequence: 1,
      workspaces: repository ? [repository] : [],
    } as unknown as RepositoryStatusWire,
  } as unknown as SidebarValue;
  const snapshot = {
    schemaVersion: 1,
    revision: 1,
    readiness: "ready",
    editorHost: { status: "ready" },
    layout: { kind: "unavailable" },
    selection: { context: { kind: "global" }, presentation: "full" },
    sidebar: { width: 248 },
    splitRatio: 0.55,
    workspaces: [workspace],
  } as unknown as AppSnapshot;
  render(
    <SidebarContext.Provider value={value}>
      <Sidebar snapshot={snapshot} onDispatch={vi.fn()} />
    </SidebarContext.Provider>,
  );
}

const REMOTE = {
  id: "w-1",
  label: "api",
  location: { kind: "ssh", host: "build.example.com" },
  root: "/srv/api",
  key: "ssh://build.example.com/srv/api",
  selectedPath: "/srv/api",
  state: { kind: "available" },
  close: { kind: "idle" },
  canCreateAgent: true,
  agents: [],
};

const LOCAL = {
  ...REMOTE,
  label: "widget",
  location: { kind: "local" },
  root: "/projects/widget",
  key: "/projects/widget",
  selectedPath: "/projects/widget",
  canCreateAgent: true,
};

describe("a Workspace row whose folder is on another machine", () => {
  it("says it is on another machine with the row's own leading mark", () => {
    // The fact that decides whether what you are about to do happens here or
    // over there, and it is the first thing on the row rather than words on the
    // line: this column is scanned, and a fact you have to read for is a fact
    // you do not have while scanning. Which machine is the tooltip's business —
    // there is one silhouette for "not here", and the host is a name.
    mount(REMOTE);
    expect(
      document.querySelector(".workspace-row .row-glyph svg"),
    ).toHaveAttribute("data-glyph", "remote");
    // And not a second copy of the same drawing in the trailing group.
    expect(document.querySelectorAll('[data-glyph="remote"]')).toHaveLength(1);
  });

  it("draws the branch its own machine's git reported, beside the name", () => {
    // The whole of what changed. git runs where the folder is, so there is a
    // branch to draw for a remote checkout — and the machine mark stays,
    // because a row with a branch and no machine cannot be told from a local
    // one.
    mount(REMOTE, {
      workspaceId: "w-1",
      branch: "feature/128-tidy",
    });
    expect(
      document.querySelector(".workspace-row .row-glyph svg"),
    ).toHaveAttribute("data-glyph", "remote");
    expect(screen.getByText("feature/128-tidy")).toBeInTheDocument();
  });

  it("draws the Issue and the pull request the branch is about", () => {
    mount(REMOTE, {
      workspaceId: "w-1",
      branch: "feature/128-tidy",
      issue: {
        number: 128,
        title: "Tidy the widget",
        state: "open",
        url: "https://github.com/example/widget/issues/128",
      },
      pullRequest: {
        number: 131,
        title: "Tidy the widget",
        state: "open",
        url: "https://github.com/example/widget/pull/131",
      },
    });
    // The marks, and only the marks: the number and the title are what the
    // Issue's own hover says, and the row's words are its name and its branch.
    expect(screen.queryByText("Tidy the widget")).toBeNull();
    expect(
      document.querySelector(".row-link-button.is-issue-open"),
    ).toHaveAttribute("aria-label", "Issue #128, open: Tidy the widget");
    expect(
      document.querySelector(".row-link-button.is-pr-open"),
    ).toHaveAttribute("aria-label", "Pull request #131, open: Tidy the widget");
  });

  it("offers New Agent on the row, exactly as a local one does", () => {
    // An Agent runs on the Workspace's machine now, so the row offers it. A
    // host DevHub cannot reach says so as a failure naming the host, which is
    // a sentence a person can act on — unlike a button that was never there.
    mount(REMOTE);
    const button = screen.getByRole("button", {
      name: /Create agent in api/u,
    });
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("data-tooltip", "Create agent");
  });

  it("says the path and the machine in the row's own facts", () => {
    mount(REMOTE);
    const lines = JSON.parse(
      document
        .querySelector("[data-tree-item-id='workspace:w-1']")
        ?.getAttribute("data-tooltip-lines") ?? "[]",
    ) as { icon?: string; text: string }[];
    expect(lines).toContainEqual({ text: "/srv/api", style: "muted" });
    expect(lines).toContainEqual({
      icon: "remote",
      text: "ssh:build.example.com",
      style: "muted",
    });
  });

  it("changes nothing about a row whose folder is on this machine", () => {
    mount(LOCAL);
    expect(
      screen.getByRole("button", { name: /Create agent in widget/u }),
    ).toBeEnabled();
  });
});
