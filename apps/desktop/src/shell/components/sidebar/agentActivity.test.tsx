// @vitest-environment jsdom

/**
 * What an Agent's row says the Agent is doing.
 *
 * The word is the Agent's own — the title its program set — so the row shows
 * it and shows nothing when there is none. It never replaces the Agent's name:
 * a row that said only "Reading the reconciler" would not say which of three
 * Agents was reading it.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSnapshot } from "../../../ipc/appShell";
import type { AppShellContextValue } from "../../useAppShell";
import { AppShellContext } from "../../useAppShell";
import { Sidebar } from "./Sidebar";

window.devhub = {
  openModal: () => Promise.resolve(""),
  onMenuCommand: () => () => undefined,
} as unknown as typeof window.devhub;

afterEach(cleanup);

function snapshotWithAgent(activity: string | undefined): AppSnapshot {
  return {
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
        agents: [
          {
            id: "a-1",
            workspaceId: "w-1",
            profileId: "claude",
            displayName: "Claude 1",
            ordinal: 1,
            status: "working",
            runtimeHealth: "healthy",
            controlState: "running",
            unread: false,
            activity,
          },
        ],
      },
    ],
  } as unknown as AppSnapshot;
}

function mount(activity: string | undefined): void {
  const value = {
    dispatch: vi.fn(),
    openExternalUrl: vi.fn(),
    agentProfiles: { sequence: 1, availability: "available", profiles: [] },
    repositoryStatus: { sequence: 1, workspaces: [] },
  } as unknown as AppShellContextValue;
  render(
    <AppShellContext.Provider value={value}>
      <Sidebar snapshot={snapshotWithAgent(activity)} onDispatch={vi.fn()} />
    </AppShellContext.Provider>,
  );
}

describe("what an Agent's row says it is doing", () => {
  it("shows the Agent's own word beside its name", () => {
    mount("Reading the reconciler");
    expect(screen.getByText("Claude 1")).toBeInTheDocument();
    expect(screen.getByText("Reading the reconciler")).toBeInTheDocument();
  });

  it("says it in the row's accessible name too", () => {
    mount("Reading the reconciler");
    expect(
      screen.getByRole("button", { name: /Reading the reconciler/ }),
    ).toBeInTheDocument();
  });

  it("shows nothing where an Agent has said nothing", () => {
    mount(undefined);
    expect(screen.getByText("Claude 1")).toBeInTheDocument();
    expect(document.querySelector(".row-activity")).toBeNull();
  });
});
