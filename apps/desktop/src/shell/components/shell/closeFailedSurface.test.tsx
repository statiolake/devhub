// @vitest-environment jsdom

/**
 * What a Workspace whose close failed shows the person looking at it.
 *
 * The bug this is about: the pane stated a problem in a sentence that was not
 * true ("the editor is not running", said over a visible editor), pointed at a
 * control in another part of the window, and offered nothing itself. With the
 * close unable to finish, that panel never went away — which is what "the
 * alert cannot be dismissed and the workspace cannot be closed" was.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CloseDiagnosticWire,
  CloseStepWire,
  WorkspaceSnapshot,
} from "../../../ipc/appShell";
import { Unavailable } from "./SurfaceViewport";

function closeFailed(
  diagnostic: CloseDiagnosticWire,
  step: CloseStepWire = "editor",
): WorkspaceSnapshot {
  return {
    id: "workspace-1",
    label: "example",
    root: "/example",
    // Open, with a last-failure note. There is no third state: a Workspace is
    // either in the list or gone.
    state: { kind: "available" },
    close: { kind: "failed", step, diagnostic },
    agents: [],
  } as unknown as WorkspaceSnapshot;
}

describe("a workspace whose close failed", () => {
  afterEach(cleanup);

  it("offers the close itself rather than naming a control elsewhere", async () => {
    const close = vi.fn();
    render(
      <Unavailable
        workspace={closeFailed("close_editor_unresponsive")}
        actions={undefined}
        onClose={close}
      />,
    );
    screen.getByRole("button", { name: "Close Workspace" }).click();
    expect(close).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/from the Sidebar/)).toBeNull();
  });

  it("does not claim a workbench that did not answer is not running", () => {
    render(
      <Unavailable
        workspace={closeFailed("close_editor_unresponsive")}
        actions={undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.queryByText(/is not running/)).toBeNull();
    expect(
      screen.getByText(/did not answer the request to close/),
    ).toBeInTheDocument();
  });

  it("says a workbench that was still coming up was still coming up", () => {
    render(
      <Unavailable
        workspace={closeFailed("close_editor_starting")}
        actions={undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText(/had not finished starting/)).toBeInTheDocument();
  });

  it("names the step that stopped, not only the reason", () => {
    // Every step reports the same handful of diagnostics, so "a cleanup step
    // did not finish" on its own never said which one — and that is the half
    // a person needs to know what to do next.
    render(
      <Unavailable
        workspace={closeFailed("cleanup_failed", "worktree")}
        actions={undefined}
        onClose={() => undefined}
      />,
    );
    expect(
      screen.getByText(/removing the worktree folder/),
    ).toBeInTheDocument();
  });
});
