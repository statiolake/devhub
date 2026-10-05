// @vitest-environment jsdom

/**
 * While the chord prefix is armed, a row wears the digit that selects it in
 * place of its folder: Scratch 0, the workspaces below it 1 to 9, and the rows
 * after the ninth keep their mark. Disarming puts every mark back.
 */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSnapshot } from "../../../ipc/appShell";
import type { SidebarValue } from "../../sidebar/SidebarContext";
import { SidebarContext } from "../../sidebar/SidebarContext";
import { Sidebar } from "./Sidebar";
import { ON_SCRATCH, SCRATCH_ID, scratchWorkspace } from "./scratchFixture";

let pushArmed: ((armed: boolean) => void) | undefined;

window.devhub = {
  openModal: vi.fn(() => Promise.resolve("")),
  focusSurface: vi.fn(() => Promise.resolve()),
  onMenuCommand: () => () => undefined,
  onSidebarArea: () => () => undefined,
  onChordArmed: (listener: (armed: boolean) => void) => {
    pushArmed = listener;
    return () => undefined;
  },
  showTooltip: () => undefined,
  hideTooltip: () => undefined,
  releaseTooltip: () => undefined,
} as unknown as typeof window.devhub;

afterEach(() => {
  cleanup();
  pushArmed = undefined;
});

function workspace(n: number) {
  const name = `ws${String(n).padStart(2, "0")}`;
  return {
    id: `w-${name}`,
    label: name,
    location: { kind: "local" },
    editor: { kind: "host" },
    root: `/home/example/${name}`,
    displayRoot: `~/${name}`,
    key: `/home/example/${name}`,
    selectedPath: `/home/example/${name}`,
    state: { kind: "available" },
    close: { kind: "idle" },
    canCreateAgent: true,
    agents: [],
  };
}

function mount(count: number) {
  const snapshot = {
    schemaVersion: 1,
    revision: 1,
    readiness: "ready",
    editorHost: { status: "ready" },
    layout: { kind: "unavailable" },
    selection: { context: ON_SCRATCH, presentation: "full" },
    sidebar: { width: 248 },
    splitRatio: 0.55,
    smartButtons: {},
    scratchWorkspaceId: SCRATCH_ID,
    workspaces: [
      scratchWorkspace({}),
      ...Array.from({ length: count }, (_u, i) => workspace(i + 1)),
    ],
  } as unknown as AppSnapshot;
  const context = {
    dispatch: vi.fn().mockResolvedValue(undefined),
    openExternalUrl: vi.fn(),
    closeWorkspace: vi.fn(),
    reportFailure: vi.fn(),
    retry: vi.fn(),
    agentProfiles: { sequence: 1, availability: "available", profiles: [] },
    usageLimits: { clis: [] },
    repositoryStatus: { sequence: 1, workspaces: [] },
  } as unknown as SidebarValue;
  return render(
    <SidebarContext.Provider value={context}>
      <Sidebar snapshot={snapshot} />
    </SidebarContext.Provider>,
  );
}

/** Each top-level row's mark: its digit, or "glyph" for a drawn one. */
function marks(container: HTMLElement): string[] {
  return [
    ...container.querySelectorAll<HTMLElement>(
      "[role=treeitem][aria-level='1'] .row-head > .row-glyph",
    ),
  ].map(
    (slot) =>
      slot.querySelector<HTMLElement>("[data-chord-digit]")?.textContent ??
      (slot.querySelector("svg") ? "glyph" : "none"),
  );
}

describe("the digits the armed prefix puts on the rows", () => {
  it("shows no digits until the prefix is armed", () => {
    const { container } = mount(3);
    expect(marks(container)).toEqual(["glyph", "glyph", "glyph", "glyph"]);
  });

  it("numbers Scratch 0 and the workspaces from 1, then reverts", () => {
    const { container } = mount(3);
    act(() => pushArmed?.(true));
    expect(marks(container)).toEqual(["0", "1", "2", "3"]);
    act(() => pushArmed?.(false));
    expect(marks(container)).toEqual(["glyph", "glyph", "glyph", "glyph"]);
  });

  it("stops at 9 and leaves later rows with their folder", () => {
    const { container } = mount(11);
    act(() => pushArmed?.(true));
    const armed = marks(container);
    expect(armed.slice(0, 10)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
    ]);
    expect(armed.slice(10)).toEqual(["glyph", "glyph"]);
  });
});
