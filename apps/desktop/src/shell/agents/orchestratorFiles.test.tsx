// @vitest-environment jsdom

/**
 * The Orchestrator screen's Files tab: the orchestrator's folder as a tree,
 * a file pushed over it, live when the folder changes, and エディタで開く
 * through the one bridge call that opens it.
 */

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSnapshot } from "../../ipc/appShell";
import {
  EMPTY_BOARD,
  type OrchestratorFileWire,
  type OrchestratorFolderWire,
} from "../../ipc/contract";
import { AgentsValueProvider, type AgentsValue } from "./AgentsContext";
import { codeBlock } from "./OrchestratorFiles";
import { OrchestratorBoard } from "./OrchestratorScreen";
import { forgetOrchestratorMemory } from "./orchestratorMemory";

const FOLDERS: Record<string, OrchestratorFolderWire> = {
  "": {
    root: "/Users/me/orchestrator",
    path: "",
    entries: [
      { name: ".claude", path: ".claude", kind: "directory" },
      { name: "decisions.md", path: "decisions.md", kind: "file" },
    ],
  },
  ".claude": {
    root: "/Users/me/orchestrator",
    path: ".claude",
    entries: [{ name: "skills", path: ".claude/skills", kind: "directory" }],
  },
};

let decisions = "# 決定\n\n- 請求の丸めは half_even\n";
let changed: ((paths: readonly string[]) => void) | undefined;
const listOrchestratorFolder = vi.fn((path: string) =>
  Promise.resolve(FOLDERS[path]!),
);
const readOrchestratorFile = vi.fn(
  (path: string): Promise<OrchestratorFileWire> =>
    Promise.resolve({
      path,
      kind: "markdown",
      size: decisions.length,
      modifiedAt: 1,
      text: decisions,
    }),
);
const openOrchestratorFile = vi.fn(() => Promise.resolve());
const reportOrchestratorView = vi.fn();

beforeEach(() => {
  decisions = "# 決定\n\n- 請求の丸めは half_even\n";
  window.devhub = {
    setOrchestratorPaused: vi.fn(() => Promise.resolve()),
    listOrchestratorFolder,
    readOrchestratorFile,
    openOrchestratorFile,
    reportOrchestratorView,
    onOrchestratorFilesChanged: (
      listener: (paths: readonly string[]) => void,
    ) => {
      changed = listener;
      return () => {
        if (changed === listener) changed = undefined;
      };
    },
    conversation: { resolvePaths: () => Promise.resolve([]) },
  } as unknown as typeof window.devhub;
});

afterEach(() => {
  cleanup();
  forgetOrchestratorMemory();
  vi.clearAllMocks();
  window.sessionStorage.clear();
});

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function mount() {
  render(
    <AgentsValueProvider
      value={
        {
          board: { ...EMPTY_BOARD, orchestratorAgentId: "orch" },
          dispatch: vi.fn().mockResolvedValue(undefined),
          reportFailure: vi.fn(),
        } as unknown as AgentsValue
      }
    >
      <OrchestratorBoard
        snapshot={{ workspaces: [] } as unknown as AppSnapshot}
      />
    </AgentsValueProvider>,
  );
}

async function openFilesTab() {
  fireEvent.click(screen.getByRole("tab", { name: /ファイル/u }));
  await settle();
}

describe("the Files tab", () => {
  it("is not the default, and is remembered for the session", async () => {
    mount();
    expect(screen.getByRole("tab", { name: "ボード" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await openFilesTab();
    expect(window.sessionStorage.getItem("devhub.orchestrator.tab")).toBe(
      "files",
    );
    cleanup();
    mount();
    await settle();
    expect(screen.getByRole("tab", { name: /ファイル/u })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("lists the root, dot-folders included, and opens a folder in place", async () => {
    mount();
    await openFilesTab();
    expect(listOrchestratorFolder).toHaveBeenCalledWith("");
    fireEvent.click(screen.getByRole("button", { name: ".claude" }));
    await settle();
    expect(listOrchestratorFolder).toHaveBeenCalledWith(".claude");
    expect(screen.getByRole("button", { name: "skills" })).toBeVisible();
  });

  it("draws a Markdown file with the conversation's renderer, and goes back", async () => {
    mount();
    await openFilesTab();
    const row = screen.getByRole("button", { name: "decisions.md" });
    row.focus();
    fireEvent.click(row);
    await settle();
    expect(readOrchestratorFile).toHaveBeenCalledWith("decisions.md");
    expect(
      document.querySelector(".orchestrator-file-body h1"),
    ).toHaveTextContent("決定");
    fireEvent.click(screen.getByRole("button", { name: "Back to the files" }));
    expect(document.querySelector(".orchestrator-file-view")).toBeNull();
    expect(row).toHaveFocus();
  });

  it("follows the folder: a change re-reads the open file and the tree", async () => {
    mount();
    await openFilesTab();
    fireEvent.click(screen.getByRole("button", { name: "decisions.md" }));
    await settle();
    listOrchestratorFolder.mockClear();
    decisions = "# 決定\n\n- リトライは指数バックオフ\n";
    act(() => {
      changed?.(["decisions.md"]);
    });
    await settle();
    expect(listOrchestratorFolder).toHaveBeenCalledWith("");
    expect(readOrchestratorFile).toHaveBeenCalledTimes(2);
    expect(screen.getByText("リトライは指数バックオフ")).toBeVisible();
  });

  it("opens the file in its Workspace's editor through the bridge", async () => {
    mount();
    await openFilesTab();
    fireEvent.click(screen.getByRole("button", { name: "decisions.md" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "エディタで開く" }));
    expect(openOrchestratorFile).toHaveBeenCalledWith("decisions.md");
  });

  it("opens a file as a place in Back and Forward, and follows the model back and forward", async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    let state: NonNullable<AppSnapshot["orchestratorView"]> = {
      view: { kind: "files" },
      seq: 0,
      arrived: "open",
    };
    const view = () => (
      <AgentsValueProvider
        value={
          {
            board: { ...EMPTY_BOARD, orchestratorAgentId: "orch" },
            dispatch,
            reportFailure: vi.fn(),
          } as unknown as AgentsValue
        }
      >
        <OrchestratorBoard
          snapshot={
            {
              workspaces: [],
              orchestratorView: state,
            } as unknown as AppSnapshot
          }
        />
      </AgentsValueProvider>
    );
    const { rerender } = render(view());
    await settle();
    // The model's view puts the screen on the Files tab.
    expect(screen.getByRole("tab", { name: /ファイル/u })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "decisions.md" }));
    await settle();
    expect(dispatch).toHaveBeenCalledWith({
      type: "show_orchestrator_view",
      view: { kind: "file", path: "decisions.md" },
      reason: "explicit",
      drawn: true,
    });
    const move = async (
      next: NonNullable<AppSnapshot["orchestratorView"]>["view"],
      arrived: "back" | "forward",
    ) => {
      state = { view: next, seq: state.seq + 1, arrived };
      rerender(view());
      await settle();
    };
    await move({ kind: "files" }, "back");
    expect(document.querySelector(".orchestrator-file-view")).toBeNull();
    await move({ kind: "file", path: "decisions.md" }, "forward");
    expect(document.querySelector(".orchestrator-file-view")).not.toBeNull();
    // Back onto an escalation's board: the board tab.
    await move({ kind: "board" }, "back");
    expect(screen.getByRole("tab", { name: "ボード" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("marks the tab when the folder changed while the board was shown", async () => {
    mount();
    await settle();
    expect(document.querySelector(".orchestrator-tab-dot")).toBeNull();
    act(() => {
      changed?.(["decisions.md"]);
    });
    expect(document.querySelector(".orchestrator-tab-dot")).not.toBeNull();
    await openFilesTab();
    expect(document.querySelector(".orchestrator-tab-dot")).toBeNull();
  });

  it("fences text longer than any run of backticks in it", () => {
    expect(codeBlock("a ```` b", "ts")).toBe("`````ts\na ```` b\n`````");
    expect(codeBlock("x\n", undefined)).toBe("```\nx\n```");
  });
});

describe("leaving the Files tab and coming back", () => {
  it("is back on the open file, scrolled as it was, the folders as they were", async () => {
    mount();
    await openFilesTab();
    fireEvent.click(screen.getByRole("button", { name: /\.claude/u }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /decisions\.md/u }));
    await settle();
    const body = () =>
      document.querySelector<HTMLElement>(".orchestrator-file-body")!;
    body().scrollTop = 40;
    fireEvent.scroll(body());
    cleanup();
    mount();
    await settle();
    expect(screen.getByRole("tab", { name: /ファイル/u })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(document.querySelector(".orchestrator-file-view")).not.toBeNull();
    expect(screen.getByText("請求の丸めは half_even")).toBeInTheDocument();
    expect(body().scrollTop).toBe(40);
    expect(listOrchestratorFolder).toHaveBeenCalledWith(".claude");
  });

  it("falls back to the tree when the file is gone", async () => {
    mount();
    await openFilesTab();
    fireEvent.click(screen.getByRole("button", { name: /decisions\.md/u }));
    await settle();
    cleanup();
    readOrchestratorFile.mockImplementationOnce(() =>
      Promise.reject(new Error("gone")),
    );
    mount();
    await settle();
    await settle();
    expect(document.querySelector(".orchestrator-stage")).not.toHaveAttribute(
      "data-nav",
      "push",
    );
  });
});

describe("what the Files tab tells main, for the window's title", () => {
  it("says the file open over the tree by its path, the tree on Back, and the file again on return", async () => {
    mount();
    await openFilesTab();
    expect(reportOrchestratorView).toHaveBeenLastCalledWith({ kind: "board" });
    fireEvent.click(screen.getByRole("button", { name: "decisions.md" }));
    await settle();
    expect(reportOrchestratorView).toHaveBeenLastCalledWith({
      kind: "file",
      path: "decisions.md",
    });
    fireEvent.click(screen.getByRole("button", { name: "Back to the files" }));
    expect(reportOrchestratorView).toHaveBeenLastCalledWith({ kind: "board" });
    fireEvent.click(screen.getByRole("button", { name: "decisions.md" }));
    await settle();
    cleanup();
    reportOrchestratorView.mockClear();
    mount();
    await settle();
    expect(reportOrchestratorView).toHaveBeenLastCalledWith({
      kind: "file",
      path: "decisions.md",
    });
    // The board tab: what is read there, not the file left on the other tab.
    fireEvent.click(screen.getByRole("tab", { name: "ボード" }));
    expect(reportOrchestratorView).toHaveBeenLastCalledWith({ kind: "board" });
  });
});
