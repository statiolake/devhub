// @vitest-environment jsdom

/**
 * Scratch is today's daily folder, and the Sidebar draws it as the Workspace
 * it is: the first row of the tree, under the name "Scratch" and the terminal
 * mark, with its Agents under it and its folder in its tooltip. Yesterday's
 * folder is not Scratch any more, and is drawn like any other Workspace.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSnapshot } from "../../../ipc/appShell";
import type { SidebarValue } from "../../sidebar/SidebarContext";
import { SidebarContext } from "../../sidebar/SidebarContext";
import { Sidebar } from "./Sidebar";
import { ON_SCRATCH, SCRATCH_ID, scratchWorkspace } from "./scratchFixture";

window.devhub = {
  openModal: vi.fn(() => Promise.resolve("")),
  focusSurface: vi.fn(() => Promise.resolve()),
  onMenuCommand: () => () => undefined,
  onSidebarArea: () => () => undefined,
  showTooltip: () => undefined,
  hideTooltip: () => undefined,
  releaseTooltip: () => undefined,
} as unknown as typeof window.devhub;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function agent(id: string, workspaceId: string) {
  return {
    id,
    workspaceId,
    ordinal: 0,
    displayName: id,
    profileId: "p",
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
  };
}

/** Yesterday's folder: the Workspace Scratch was until midnight. */
const YESTERDAY = {
  id: "w-yesterday",
  label: "20260922",
  location: { kind: "local" },
  root: "/home/example/junk/20260922",
  displayRoot: "~/junk/20260922",
  key: "/home/example/junk/20260922",
  selectedPath: "/home/example/junk/20260922",
  state: { kind: "available" },
  close: { kind: "idle" },
  canCreateAgent: true,
  agents: [agent("a-old", "w-yesterday")],
};

function snapshot(scratchWorkspaceId = SCRATCH_ID): AppSnapshot {
  return {
    schemaVersion: 1,
    revision: 1,
    readiness: "ready",
    editorHost: { status: "ready" },
    layout: { kind: "unavailable" },
    selection: { context: ON_SCRATCH, presentation: "full" },
    sidebar: { width: 248 },
    splitRatio: 0.55,
    scratchWorkspaceId,
    workspaces: [
      scratchWorkspace({
        agents: [agent("a-today", SCRATCH_ID)] as never,
      }),
      YESTERDAY,
    ],
  } as unknown as AppSnapshot;
}

function mount(value: AppSnapshot) {
  const context = {
    dispatch: vi.fn().mockResolvedValue(undefined),
    openExternalUrl: vi.fn(),
    closeWorkspace: vi.fn(),
    reportFailure: vi.fn(),
    retry: vi.fn(),
    agentProfiles: { sequence: 1, availability: "available", profiles: [] },
    repositoryStatus: { sequence: 1, workspaces: [] },
  } as unknown as SidebarValue;
  render(
    <SidebarContext.Provider value={context}>
      <Sidebar snapshot={value} />
    </SidebarContext.Provider>,
  );
}

function tooltipOf(button: HTMLElement): string[] {
  const lines = JSON.parse(
    button.closest(".sidebar-row")?.getAttribute("data-tooltip-lines") ?? "[]",
  ) as { text: string }[];
  return lines.map((line) => line.text);
}

const treeItems = () =>
  screen
    .getByRole("tree", { name: "Open workspaces" })
    .querySelectorAll<HTMLElement>("[role=treeitem][aria-level='1']");

describe("the Scratch row", () => {
  it("is the tree's first row, named Scratch, with the terminal mark", () => {
    mount(snapshot());
    const first = treeItems()[0];
    expect(first.querySelector(".row-label")).toHaveTextContent(/^Scratch$/);
    expect(first.querySelector(".row-head .row-glyph svg")).toHaveAttribute(
      "data-glyph",
      "terminal",
    );
    expect(
      within(first).getByRole("button", { name: /^Scratch workspace/ }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("says in its tooltip which folder Scratch is today", () => {
    mount(snapshot());
    expect(
      tooltipOf(screen.getByRole("button", { name: /^Scratch workspace/ })),
    ).toEqual(["Scratch", "~/junk/20260923"]);
  });

  it("keeps its Agents under it, like any Workspace", () => {
    mount(snapshot());
    const group = screen.getByRole("group", { name: "Scratch agents" });
    expect(
      within(group).getByRole("button", { name: /^a-today/ }),
    ).toBeVisible();
  });

  it("is neither closed nor dragged", () => {
    mount(snapshot());
    const first = treeItems()[0];
    expect(first).toHaveAttribute("draggable", "false");
    expect(
      within(first).queryByRole("button", { name: /^Close/ }),
    ).not.toBeInTheDocument();
  });

  it("refuses a snapshot whose Scratch is not among its Workspaces", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => {
      mount(snapshot("w-missing"));
    }).toThrow(/Scratch w-missing is not one of the snapshot's workspaces/);
  });
});

describe("yesterday's folder", () => {
  it("is an ordinary row, named by its folder", () => {
    mount(snapshot());
    const rows = treeItems();
    expect(rows).toHaveLength(2);
    const yesterday = rows[1];
    expect(yesterday.querySelector(".row-label")).toHaveTextContent(
      /^20260922$/,
    );
    expect(yesterday.querySelector(".row-head .row-glyph svg")).toHaveAttribute(
      "data-glyph",
      "folder",
    );
    expect(yesterday).toHaveAttribute("draggable", "true");
    expect(
      within(yesterday).getByRole("button", { name: "Close 20260922" }),
    ).toBeInTheDocument();
    expect(
      tooltipOf(
        within(yesterday).getByRole("button", { name: /^20260922 workspace/ }),
      ),
    ).toEqual(["20260922", "~/junk/20260922"]);
    expect(
      within(yesterday).getByRole("button", { name: /^a-old/ }),
    ).toBeInTheDocument();
  });

  it("stops being Scratch the moment the snapshot names another", () => {
    mount(snapshot("w-yesterday"));
    const rows = treeItems();
    // First, with the terminal, and without a close — whatever it is called.
    expect(rows[0].querySelector(".row-label")).toHaveTextContent(/^20260922$/);
    expect(rows[0].querySelector(".row-head .row-glyph svg")).toHaveAttribute(
      "data-glyph",
      "terminal",
    );
    expect(
      within(rows[0]).queryByRole("button", { name: /^Close/ }),
    ).not.toBeInTheDocument();
    expect(rows[1].querySelector(".row-head .row-glyph svg")).toHaveAttribute(
      "data-glyph",
      "folder",
    );
  });
});
