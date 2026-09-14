// @vitest-environment jsdom

/**
 * What a Workspace whose workbench gave up shows the person looking at it.
 *
 * The bug this is about: it showed nothing there at all. A workbench that kept
 * dying published `native_unavailable` — "the native app shell is
 * unavailable", about the whole application — once per folder per projection
 * tick, which after a wake is several times a second, so what the person saw
 * was a sentence about the wrong thing, flickering. The failure belongs to one
 * Workspace, so it is drawn where that Workspace is, once, and it stays until
 * they do something about it.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSnapshot } from "../../../ipc/appShell";
import { Unavailable } from "./SurfaceViewport";

function gaveUp(): WorkspaceSnapshot {
  return {
    id: "workspace-1",
    label: "example",
    root: "/example",
    state: { kind: "unavailable", reason: "editor_restart_exhausted" },
    close: { kind: "idle" },
    agents: [],
  } as unknown as WorkspaceSnapshot;
}

describe("a workspace whose workbench kept stopping", () => {
  afterEach(cleanup);

  it("says what stopped, about this workspace and not about DevHub", () => {
    render(<Unavailable workspace={gaveUp()} actions={[]} onClose={vi.fn()} />);

    expect(
      screen.getByText(/kept stopping, so DevHub stopped restarting it/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/native app shell/)).toBeNull();
  });

  it("offers the person the retry, because nothing else will retry it", () => {
    const retry = vi.fn();
    render(
      <Unavailable
        workspace={gaveUp()}
        actions={[{ label: "Retry", primary: true, run: retry }]}
        onClose={vi.fn()}
      />,
    );

    screen.getByRole("button", { name: "Retry" }).click();
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
