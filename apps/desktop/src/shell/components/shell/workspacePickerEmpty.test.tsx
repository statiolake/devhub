// @vitest-environment jsdom

/**
 * What the workspace picker says when it has nothing to show.
 *
 * There are two ways to have no rows and they are not the same thing to tell
 * somebody. Sources that searched and found nothing is a fact about the
 * machine. *No sources at all* is a fact about the configuration — and it is
 * the state a fresh install is in, because the defaults deliberately guess
 * nothing about where a person keeps their projects. A sheet that said "no
 * workspaces found in the configured sources" to somebody who has configured
 * none would be describing a search that never happened.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppShellContextValue } from "../../useAppShell";
import { AppShellContext } from "../../useAppShell";
import { WorkspacePicker } from "./WorkspacePicker";

Element.prototype.scrollIntoView = vi.fn();
afterEach(cleanup);

function mount(pickerSourceCount: number | undefined) {
  const value = {
    pickerCandidates: [],
    pickerBusy: false,
    pickerSourceCount,
    startWorkspacePicker: vi.fn().mockResolvedValue(undefined),
    cancelWorkspacePicker: vi.fn().mockResolvedValue(undefined),
    selectWorkspacePicker: vi.fn(),
    chooseWorkspaceFolder: vi.fn(),
    reportFailure: vi.fn(),
  } as unknown as AppShellContextValue;
  render(
    <AppShellContext.Provider value={value}>
      <WorkspacePicker onDismiss={vi.fn()} />
    </AppShellContext.Provider>,
  );
}

/**
 * What the sheet says where its rows would be.
 *
 * Found by its words rather than by the live region it sits in: the footer's
 * hint about the Command key is one too, and "the only thing being announced"
 * stopped being a way to name this message the moment there were two.
 */
function emptyMessage(words: RegExp) {
  return screen.getByText(words);
}

describe("a workspace picker with nothing to show", () => {
  it("asks for a source when none is configured", () => {
    mount(0);
    expect(
      emptyMessage(/No workspace sources yet\. Add one in Settings/u),
    ).toBeInTheDocument();
  });

  it("says the search came back empty when there were sources to search", () => {
    mount(2);
    expect(
      emptyMessage(/No workspaces found in the configured sources\./u),
    ).toBeInTheDocument();
  });

  it("still offers the two things that need no configuration", () => {
    // The reason the empty sheet is not a dead end: making a project and
    // cloning one do not depend on a source existing, so they are on screen
    // exactly as they always are.
    mount(0);
    expect(
      screen.getByRole("option", { name: /New Project/u }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /Clone Project/u }),
    ).toBeInTheDocument();
  });
});
