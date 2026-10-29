// @vitest-environment jsdom

/**
 * The workspace picker's branch rows: the branches of the repository the
 * selection is in, beside the folders, searched by name in the same field,
 * drawn with a branch glyph, and each saying what choosing it does.
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
import type { PickerValue } from "../../picker/PickerContext";
import { PickerContext } from "../../picker/PickerContext";
import type { BranchListWire } from "../../../ipc/contract";
import { branchItems, WorkspacePicker } from "./WorkspacePicker";

Element.prototype.scrollIntoView = vi.fn();
afterEach(cleanup);

const PLACE = { kind: "local", path: "/projects/widget" } as const;
const NOW = Date.parse("2026-10-29T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const LIST: BranchListWire = {
  place: PLACE,
  repository: "widget",
  branches: [
    {
      name: "feature/128-login",
      committedAt: NOW - DAY,
      worktree: "/projects/widget_128",
      open: true,
    },
    {
      name: "main",
      committedAt: NOW - 2 * DAY,
      worktree: "/projects/widget",
      open: false,
    },
    { name: "release/2.0", committedAt: NOW - 3 * DAY, open: false },
    {
      name: "alice/review",
      remote: "origin",
      committedAt: NOW - 4 * DAY,
      open: false,
    },
  ],
};

function mount(list: BranchListWire | undefined = LIST) {
  const openBranchWorkspace = vi.fn().mockResolvedValue(undefined);
  const onDismiss = vi.fn();
  const value = {
    pickerCandidates: [],
    pickerBusy: false,
    pickerSourceCount: 1,
    startWorkspacePicker: vi.fn().mockResolvedValue(undefined),
    cancelWorkspacePicker: vi.fn().mockResolvedValue(undefined),
    selectWorkspacePicker: vi.fn(),
    chooseWorkspaceFolder: vi.fn(),
    listSshHosts: vi.fn().mockResolvedValue([]),
    openSshWorkspace: vi.fn(),
    listSelectionBranches: vi.fn().mockResolvedValue(list),
    openBranchWorkspace,
    reportFailure: vi.fn(),
  } as unknown as PickerValue;
  render(
    <PickerContext.Provider value={value}>
      <WorkspacePicker onDismiss={onDismiss} />
    </PickerContext.Provider>,
  );
  return { openBranchWorkspace, onDismiss };
}

describe("the workspace picker's branches", () => {
  it("are rows of their own, newest commit first, each saying what choosing it does", () => {
    const items = branchItems(LIST, NOW);
    expect(items.map((item) => [item.label, item.accessory?.(false)])).toEqual([
      ["feature/128-login", "Open"],
      ["main", "Worktree"],
      ["release/2.0", "Branch"],
      ["alice/review", "origin"],
    ]);
    expect(items.every((item) => item.id.startsWith("devhub:branch:"))).toBe(
      true,
    );
    expect(items.map((item) => item.searchText)).toEqual(
      LIST.branches.map((branch) => branch.name),
    );
    expect(branchItems(undefined, NOW)).toEqual([]);
  });

  it("are listed beside the folders and found by the branch's name", async () => {
    mount();
    await screen.findByRole("option", { name: /release\/2\.0/u });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "review" },
    });
    const review = screen.getAllByRole("option")[0]!;
    expect(review).toHaveTextContent("alice/review");
    expect(review).toHaveTextContent(/on origin only/u);
  });

  it("opens the branch's worktree — or has it made — when one is chosen", async () => {
    const { openBranchWorkspace, onDismiss } = mount();
    fireEvent.click(
      await screen.findByRole("option", { name: /release\/2\.0/u }),
    );
    await waitFor(() => {
      expect(openBranchWorkspace).toHaveBeenCalledWith(
        PLACE,
        "release/2.0",
        undefined,
      );
    });
    await waitFor(() => {
      expect(onDismiss).toHaveBeenCalled();
    });
  });

  it("is a sheet of folders when the selection is in no repository", async () => {
    mount(undefined);
    await waitFor(() => {
      expect(
        screen.queryByRole("option", { name: /release/u }),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByRole("option", { name: /New Project/u }),
    ).toBeInTheDocument();
  });
});
