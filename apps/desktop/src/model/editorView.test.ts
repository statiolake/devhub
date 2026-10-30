import { describe, expect, it } from "vitest";
import {
  effectiveEditorView,
  hasTerminalView,
  opensInNeovim,
} from "./editorView.js";

describe("which Workspaces have a terminal view", () => {
  it("a folder on this Mac has one", () => {
    expect(hasTerminalView({ location: { kind: "local" } })).toBe(true);
  });

  it("a folder whose editor is in a dev container has one: the local folder", () => {
    const container = {
      location: { kind: "local" },
      editor: { kind: "devContainer" },
    };
    expect(hasTerminalView(container)).toBe(true);
  });

  it("an SSH Workspace has none, and always shows its editor", () => {
    const ssh = { location: { kind: "ssh" } };
    expect(hasTerminalView(ssh)).toBe(false);
    expect(effectiveEditorView(ssh, "terminal")).toBe("editor");
    expect(
      effectiveEditorView({ location: { kind: "local" } }, "terminal"),
    ).toBe("terminal");
  });
});

describe("where a file open goes", () => {
  const local = { location: { kind: "local" } };

  it("to the managed Neovim while the terminal is shown", () => {
    expect(opensInNeovim({ ...local, editorView: "terminal" }, "local")).toBe(
      true,
    );
  });

  it("to the workbench while the VS Code editor is shown", () => {
    expect(opensInNeovim({ ...local, editorView: "editor" }, "local")).toBe(
      false,
    );
  });

  it("to the workbench for an SSH Workspace or a path on another machine", () => {
    expect(
      opensInNeovim(
        { location: { kind: "ssh" }, editorView: "terminal" },
        "ssh:build",
      ),
    ).toBe(false);
    expect(
      opensInNeovim({ ...local, editorView: "terminal" }, "ssh:build"),
    ).toBe(false);
  });
});
