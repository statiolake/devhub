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
import { AgentsContext, type AgentsValue } from "./AgentsContext";
import { codeBlock } from "./OrchestratorFiles";
import { OrchestratorBoard } from "./OrchestratorScreen";

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

beforeEach(() => {
  decisions = "# 決定\n\n- 請求の丸めは half_even\n";
  window.devhub = {
    setOrchestratorPaused: vi.fn(() => Promise.resolve()),
    listOrchestratorFolder,
    readOrchestratorFile,
    openOrchestratorFile,
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
    <AgentsContext.Provider
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
    </AgentsContext.Provider>,
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

  it("goes back and forward with the mouse's side buttons", async () => {
    mount();
    await openFilesTab();
    fireEvent.click(screen.getByRole("button", { name: "decisions.md" }));
    await settle();
    const body = document.querySelector(".orchestrator-file-body")!;
    fireEvent.mouseUp(body, { button: 3 });
    expect(document.querySelector(".orchestrator-file-view")).toBeNull();
    fireEvent.mouseUp(screen.getByRole("tree"), { button: 4 });
    await settle();
    expect(document.querySelector(".orchestrator-file-view")).not.toBeNull();
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
