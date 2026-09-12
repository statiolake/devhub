// @vitest-environment jsdom

/**
 * A Surface that is asking for something puts the keyboard on the answer.
 *
 * These panes are the one state in which DevHub's own DOM *is* the content
 * area, and so the one state in which the keyboard has somewhere in the page
 * to be. It had nowhere: `focusMainSurface` finds no Agent pane here and blurs
 * to `body`, from which Tab walks the whole Sidebar before it reaches the
 * button the pane exists to offer. A workbench dialog already focuses its
 * default button (`ViewScopedAlert`); this is the same gesture for the panes
 * that were left out of it — Unavailable, close-failed, and the whole-app
 * error Surface.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSnapshot } from "../../../ipc/appShell";
import { Empty, Failure } from "./SurfaceState";
import { Unavailable } from "./SurfaceViewport";

afterEach(cleanup);

const RETRY_AND_MORE = [
  { label: "Retry", primary: true, run: vi.fn() },
  { label: "Locate…", run: vi.fn() },
  { label: "Close", run: vi.fn() },
] as const;

function unavailable(): WorkspaceSnapshot {
  return {
    id: "workspace-1",
    label: "example",
    root: "/example",
    state: { kind: "unavailable", reason: "close_root_missing" },
    close: { kind: "idle" },
    agents: [],
  } as unknown as WorkspaceSnapshot;
}

describe("a Surface with something to answer", () => {
  it("focuses the primary action, so Return is Retry", () => {
    render(
      <Unavailable
        workspace={unavailable()}
        actions={RETRY_AND_MORE}
        onClose={vi.fn()}
      />,
    );
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Retry" }),
    );
  });

  it("focuses the close a failed close offers", () => {
    render(
      <Unavailable
        workspace={
          {
            ...unavailable(),
            state: { kind: "available" },
            close: {
              kind: "failed",
              step: "editor",
              diagnostic: "close_editor_unresponsive",
            },
          } as unknown as WorkspaceSnapshot
        }
        actions={undefined}
        onClose={vi.fn()}
      />,
    );
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Close Workspace" }),
    );
  });

  it("does the same for an Empty pane, because it is the same question", () => {
    render(
      <Empty
        title="Nothing here"
        actions={[{ label: "Make one", primary: true, run: vi.fn() }]}
      />,
    );
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Make one" }),
    );
  });

  it("takes the keyboard from nobody when there is nothing to recommend", () => {
    const before = document.activeElement;
    render(
      <Failure
        summary="Something went wrong."
        actions={[{ label: "Locate…", run: vi.fn() }]}
      />,
    );
    expect(document.activeElement).toBe(before);
  });

  it("takes it from nobody when the pane offers nothing at all", () => {
    const before = document.activeElement;
    render(<Failure summary="Something went wrong." />);
    expect(document.activeElement).toBe(before);
  });
});
