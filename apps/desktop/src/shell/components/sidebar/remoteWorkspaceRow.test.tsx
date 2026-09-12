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
import type { RepositoryStatusWire } from "../../client";
import type { AppShellContextValue } from "../../useAppShell";
import { AppShellContext } from "../../useAppShell";
import { Sidebar } from "./Sidebar";

window.devhub = {
  openModal: vi.fn(() => Promise.resolve("")),
  onMenuCommand: () => () => undefined,
} as unknown as typeof window.devhub;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const UNAVAILABLE =
  "Agents and terminals are not available for SSH workspaces yet.";

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
  } as unknown as AppShellContextValue;
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
    <AppShellContext.Provider value={value}>
      <Sidebar snapshot={snapshot} onDispatch={vi.fn()} />
    </AppShellContext.Provider>,
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
  canCreateAgent: false,
  localAgentsUnavailable: UNAVAILABLE,
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
  localAgentsUnavailable: undefined,
};

describe("a Workspace row whose folder is on another machine", () => {
  it("names the machine where a local row has its branch", () => {
    // The one long fact that identifies the row and is not its name. Somebody
    // with the same folder checked out on three machines is reading the row
    // for exactly this.
    mount(REMOTE);
    expect(screen.getByText("build.example.com")).toBeInTheDocument();
  });

  it("draws the branch its own machine's git reported, beside the machine", () => {
    // The whole of what changed. git runs where the folder is, so there is a
    // branch to draw for a remote checkout — and the machine stays, because a
    // row with a branch and no machine cannot be told from a local one.
    mount(REMOTE, {
      workspaceId: "w-1",
      branch: "feature/128-tidy",
    });
    expect(screen.getByText("build.example.com")).toBeInTheDocument();
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
    expect(screen.getByText("Tidy the widget")).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Issue #128, open: Tidy the widget/u),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Pull request #131, open: Tidy the widget/u),
    ).toBeInTheDocument();
  });

  it("keeps the Agents sentence off the row's own lines", () => {
    // It is about Agents and terminals, and it lives on the control it
    // disables. Drawn on the branch line as well it would be one fact said
    // twice, and the copy on the branch line would be read as a reason the
    // branch is missing — which it is not any more.
    mount(REMOTE, { workspaceId: "w-1", branch: "feature/128-tidy" });
    expect(screen.queryByText(UNAVAILABLE)).not.toBeInTheDocument();
  });

  it("keeps New Agent on the row, disabled, with the reason on it", () => {
    // Shown and disabled rather than absent: a button that is not there is
    // indistinguishable from one this build never had, and the whole point of
    // the sentence is telling "not yet" from "not a thing".
    mount(REMOTE);
    const button = screen.getByRole("button", {
      name: /Create agent in api/u,
    });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", UNAVAILABLE);
  });

  it("says the path is over there, in the tooltip that carries the whole of it", () => {
    mount(REMOTE);
    expect(screen.getByTitle("build.example.com:/srv/api")).toBeInTheDocument();
  });

  it("changes nothing about a row whose folder is on this machine", () => {
    mount(LOCAL);
    expect(screen.queryByText(UNAVAILABLE)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Create agent in widget/u }),
    ).toBeEnabled();
  });
});
