// @vitest-environment jsdom

/**
 * What a Workspace row says about the work in it.
 *
 * The branch and the Issue live on the *Workspace* row, because the Issue is
 * recorded against the workspace: one fact, one place. The marks are links
 * rather than decoration, and the reason a look failed is drawn beside what is
 * still known rather than instead of it.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSnapshot } from "../../../ipc/appShell";
import type { RepositoryStatusWire } from "../../client";
import type { AppShellContextValue } from "../../useAppShell";
import { AppShellContext } from "../../useAppShell";
import { Sidebar } from "./Sidebar";

// The Sidebar asks main to put modals on screen and listens for menu
// commands. Neither is what these tests are about, but both are what the
// component genuinely does, so the bridge is present rather than mocked away.
window.devhub = {
  openModal: () => Promise.resolve(""),
  onMenuCommand: () => () => undefined,
} as unknown as typeof window.devhub;

afterEach(cleanup);

const SNAPSHOT = {
  schemaVersion: 1,
  revision: 1,
  readiness: "ready",
  editorHost: { status: "ready" },
  layout: { kind: "unavailable" },
  selection: { context: { kind: "global" }, presentation: "full" },
  sidebar: { width: 248 },
  splitRatio: 0.55,
  workspaces: [
    {
      id: "w-1",
      label: "widget",
      root: "/projects/widget",
      selectedPath: "/projects/widget",
      state: "available",
      canCreateAgent: true,
      agents: [],
    },
  ],
} as unknown as AppSnapshot;

function mount(repositoryStatus: RepositoryStatusWire) {
  const openExternalUrl = vi.fn();
  const value = {
    dispatch: vi.fn(),
    openExternalUrl,
    agentProfiles: { sequence: 1, availability: "available", profiles: [] },
    repositoryStatus,
  } as unknown as AppShellContextValue;
  render(
    <AppShellContext.Provider value={value}>
      <Sidebar snapshot={SNAPSHOT} onDispatch={vi.fn()} />
    </AppShellContext.Provider>,
  );
  return { openExternalUrl };
}

const WORKING_ON: RepositoryStatusWire = {
  sequence: 3,
  workspaces: [
    {
      workspaceId: "w-1",
      branch: "feature/128-tidy",
      issue: {
        url: "https://github.com/example/widget/issues/128",
        number: 128,
        title: "Tidy the picker",
        state: "open",
      },
      pullRequest: {
        number: 210,
        url: "https://github.com/example/widget/pull/210",
        state: "draft",
      },
    },
  ],
};

describe("a workspace row", () => {
  it("says which branch it is on and what that branch is for", () => {
    mount(WORKING_ON);
    expect(screen.getByText("feature/128-tidy")).toBeInTheDocument();
    expect(screen.getByText("Tidy the picker")).toBeInTheDocument();
  });

  it("puts the branch and the Issue on a line of their own, under the name", () => {
    // The whole point of the second line: the branch is not competing with the
    // workspace's name for the width of one row, so neither is ellipsised.
    mount(WORKING_ON);
    const row = document.querySelector(".workspace-row");
    expect(row?.querySelector(".row-label")?.textContent).toBe("widget");
    expect(row?.querySelector(".row-line-secondary")?.textContent).toBe(
      "feature/128-tidyTidy the picker",
    );
  });

  it("has no second line when there is nothing to put on it", () => {
    mount({ sequence: 1, workspaces: [] });
    const row = document.querySelector(".workspace-row");
    expect(row?.querySelector(".row-label")?.textContent).toBe("widget");
    expect(row?.querySelector(".row-line-secondary")).toBeNull();
  });

  it("opens the Issue and the pull request on GitHub", () => {
    const { openExternalUrl } = mount(WORKING_ON);

    fireEvent.click(screen.getByRole("button", { name: /Issue #128, open/u }));
    expect(openExternalUrl).toHaveBeenCalledWith(
      "https://github.com/example/widget/issues/128",
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Pull request #210, draft/u }),
    );
    expect(openExternalUrl).toHaveBeenCalledWith(
      "https://github.com/example/widget/pull/210",
    );
  });

  it("says nothing about an Issue when the workspace has none", () => {
    mount({
      sequence: 1,
      workspaces: [{ workspaceId: "w-1", branch: "main" }],
    });
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Issue #/u })).toBeNull();
  });

  it("says which Issue it is about, and why, when the look failed", () => {
    // A branch called feature/128-… is about Issue 128 whether or not GitHub
    // answered. Before this the row was indistinguishable from one about no
    // Issue at all, and the reason sat at the foot of the Sidebar naming none
    // of the rows it belonged to.
    mount({
      sequence: 1,
      workspaces: [
        {
          workspaceId: "w-1",
          branch: "feature/128-tidy",
          issueUnavailable: {
            number: 128,
            reason: "GitHub has no issue example/widget#128.",
          },
        },
      ],
    });
    const row = document.querySelector(".workspace-row");
    expect(row?.querySelector(".row-issue-unavailable")).toHaveTextContent(
      "#128 · GitHub has no issue example/widget#128.",
    );
    // The branch is still said; it is the fact this row is named by.
    expect(screen.getByText("feature/128-tidy")).toBeInTheDocument();
    // And no Issue mark, because DevHub does not know the state to draw.
    expect(screen.queryByRole("button", { name: /Issue #/u })).toBeNull();
  });

  it("keeps what it knows when a look fails, and says why beside it", () => {
    // A network that dropped must not read as an issue that closed.
    mount({ ...WORKING_ON, diagnostic: "GitHub answered 502." });
    expect(screen.getByText("Tidy the picker")).toBeInTheDocument();
    expect(screen.getByText("GitHub answered 502.")).toBeInTheDocument();
  });
});
