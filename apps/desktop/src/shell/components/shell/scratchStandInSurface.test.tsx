// @vitest-environment jsdom

/**
 * What Scratch shows while DevHub runs on no settings.
 *
 * There is no `[scratch] daily`, so there is no folder: Scratch is a stand-in
 * (`main/shell/scratchDay.ts`). Selecting it — its row, Cmd+Q 1, Cmd+Q
 * Shift+J — lands here, and this is where the person is told why and given
 * the one thing that fixes it. Retry and Locate… would be answers about a
 * folder, and there is none; today's Scratch cannot be closed.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSnapshot } from "../../../ipc/appShell";
import { Unavailable, unavailableActionsFor } from "./SurfaceViewport";

function standIn(): WorkspaceSnapshot {
  return {
    id: "workspace-1",
    label: "Scratch",
    root: "/scratch-test/settings.toml",
    displayRoot: "/scratch-test/settings.toml",
    state: { kind: "unavailable", reason: "settings_refused" },
    close: { kind: "idle" },
    agents: [],
  } as unknown as WorkspaceSnapshot;
}

describe("Scratch with no settings", () => {
  afterEach(cleanup);

  it("says the settings file is why, and offers only Settings", () => {
    const openSettings = vi.fn();
    const actions = unavailableActionsFor(standIn(), {
      retry: vi.fn(),
      locate: vi.fn(),
      close: vi.fn(),
      openSettings,
    });
    render(
      <Unavailable workspace={standIn()} actions={actions} onClose={vi.fn()} />,
    );

    expect(
      screen.getByText(/DevHub could not use its settings file/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Locate…" })).toBeNull();
    screen.getByRole("button", { name: "Open Settings" }).click();
    expect(openSettings).toHaveBeenCalledTimes(1);
  });
});
