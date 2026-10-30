/**
 * `general.default_view`: what a Workspace with no remembered view shows
 * (`model/editorView.ts`). Given to each Workspace as it enters the model and
 * kept by it from then on.
 */

import { describe, expect, it } from "vitest";
import { AppModel } from "./appModel.js";
import { DEFAULT_EDITOR_VIEW } from "./editorView.js";
import {
  displayPath,
  Workspace,
  workspaceId,
  workspaceLocation,
} from "./domain.js";
import { localWorkspace, SCRATCH_PATH } from "./testWorkspaces.js";

const viewOf = (model: AppModel, id: Workspace["id"]) =>
  model.snapshot().workspaces.find((one) => one.id === id)?.editorView;

describe("a Workspace with no remembered view", () => {
  it("shows the terminal, DevHub's default, when nothing says otherwise", () => {
    expect(DEFAULT_EDITOR_VIEW).toBe("terminal");
    const scratch = localWorkspace(SCRATCH_PATH);
    const model = new AppModel(scratch);
    const added = localWorkspace("/work/a");
    model.addWorkspace(added);
    expect(viewOf(model, scratch.id)).toBe("terminal");
    expect(viewOf(model, added.id)).toBe("terminal");
  });

  it("shows the editor when the default is the editor: Scratch and every new one", () => {
    const scratch = localWorkspace(SCRATCH_PATH);
    const model = new AppModel(scratch, "editor");
    const added = localWorkspace("/work/a");
    model.addWorkspace(added);
    expect(viewOf(model, scratch.id)).toBe("editor");
    expect(viewOf(model, added.id)).toBe("editor");
    // Cmd+Q E still switches it, and that is what it remembers.
    expect(model.setEditorView(added.id, "terminal")).toBe(true);
    expect(viewOf(model, added.id)).toBe("terminal");
  });

  it("keeps a view it already has, whatever the default", () => {
    const chosen = localWorkspace("/work/a");
    chosen.setEditorView("terminal");
    const model = new AppModel(localWorkspace(SCRATCH_PATH), "editor");
    model.addWorkspace(chosen);
    expect(viewOf(model, chosen.id)).toBe("terminal");
  });

  it("a changed default applies to the Workspaces made after it, at once, and leaves the others", () => {
    const scratch = localWorkspace(SCRATCH_PATH);
    const model = new AppModel(scratch);
    const before = model.snapshot().revision;
    model.setDefaultEditorView("editor");
    expect(model.defaultEditorView).toBe("editor");
    // Nothing on screen changed.
    expect(model.snapshot().revision).toBe(before);
    expect(viewOf(model, scratch.id)).toBe("terminal");
    const added = localWorkspace("/work/b");
    model.addWorkspace(added);
    expect(viewOf(model, added.id)).toBe("editor");
    model.setDefaultEditorView("terminal");
    expect(viewOf(model, added.id)).toBe("editor");
  });

  it("an SSH Workspace shows its editor whatever the default", () => {
    const model = new AppModel(localWorkspace(SCRATCH_PATH), "terminal");
    const ssh = new Workspace(
      workspaceId("550e8400-e29b-41d4-a716-446655440077"),
      workspaceLocation({ kind: "ssh", host: "build", path: "/srv/api" }),
      displayPath("/srv/api"),
    );
    model.addWorkspace(ssh);
    expect(viewOf(model, ssh.id)).toBe("editor");
  });
});
