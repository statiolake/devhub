// @vitest-environment jsdom

/**
 * What a Workspace row says when its folder is on another machine.
 *
 * The rule this is holding is that nothing goes quiet. Everything DevHub reads
 * itself — git, the HEAD watcher, tmux, Agents — runs where the folder is, and
 * for a remote folder that is a machine DevHub does not run on yet. A row that
 * simply left those places blank would look exactly like a repository whose
 * branch is about no Issue, and a New Agent button that was simply absent
 * would look exactly like a build that never had one. Both are the "it just
 * does not work and nothing says why" shape.
 *
 * So the row says it, in the sentence the wire sends — one sentence, so the
 * row, the button and the terminal pane cannot drift apart.
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

const UNAVAILABLE = "Not available for SSH workspaces yet.";

function mount(workspace: Record<string, unknown>) {
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
    repositoryStatus: { sequence: 1, workspaces: [] } as RepositoryStatusWire,
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
  localToolingUnavailable: UNAVAILABLE,
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
  localToolingUnavailable: undefined,
};

describe("a Workspace row whose folder is on another machine", () => {
  it("names the machine where a local row has its branch", () => {
    // The one long fact that identifies the row and is not its name. Somebody
    // with the same folder checked out on three machines is reading the row
    // for exactly this.
    mount(REMOTE);
    expect(screen.getByText("build.example.com")).toBeInTheDocument();
  });

  it("says why there is no branch or pull request, rather than leaving it blank", () => {
    mount(REMOTE);
    expect(screen.getByText(UNAVAILABLE)).toBeInTheDocument();
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
