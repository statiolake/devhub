// @vitest-environment jsdom

/**
 * Opening a workspace *with an agent* in it.
 *
 * Return opens the workspace, which is what it has always done. Command —
 * Command-Return, or Command-click, which is the same gesture — puts one
 * question in front of that: which agent profile should start in the workspace
 * being opened. The tests here are the four things that make it a question
 * rather than a hidden mode.
 *
 * 1. **It is a step.** The list says Step 1 and the agent question says Step 2,
 *    so a person can see that something was added and that Escape has somewhere
 *    to go.
 * 2. **Plain Return adds nothing.** The old gesture opens the workspace with no
 *    profile at all, not with a default one.
 * 3. **Escape goes back one question**, to the list, rather than out of the
 *    sheet.
 * 4. **The profile travels with the opening**, on every kind of row — an
 *    existing folder and a project being created alike — because the agent
 *    needs a workspace and for some of these rows there is not one yet.
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
import type { AppShellContextValue } from "../../useAppShell";
import { AppShellContext } from "../../useAppShell";
import { WorkspacePicker } from "./WorkspacePicker";

Element.prototype.scrollIntoView = vi.fn();
afterEach(cleanup);

const CANDIDATE = {
  operationId: "op",
  sequence: 1,
  label: "devhub",
  searchText: "/projects/devhub",
  path: "/projects/devhub",
  score: 1,
  sourceId: "projects",
  sourceRank: 0,
  missing: false,
};

function mount() {
  const selectWorkspacePicker = vi.fn().mockResolvedValue(undefined);
  const createProject = vi.fn().mockResolvedValue(undefined);
  const projectDefaultDirectory = vi.fn().mockResolvedValue("/projects");
  const value = {
    pickerCandidates: [CANDIDATE],
    pickerBusy: false,
    pickerSourceCount: 1,
    agentProfiles: {
      availability: "available",
      profiles: [
        { id: "claude", displayName: "Claude", kind: "claude" },
        { id: "codex", displayName: "Codex", kind: "codex" },
      ],
      sequence: 1,
    },
    startWorkspacePicker: vi.fn().mockResolvedValue(undefined),
    cancelWorkspacePicker: vi.fn().mockResolvedValue(undefined),
    selectWorkspacePicker,
    createProject,
    projectDefaultDirectory,
    chooseWorkspaceFolder: vi.fn(),
    reportFailure: vi.fn(),
  } as unknown as AppShellContextValue;
  render(
    <AppShellContext.Provider value={value}>
      <WorkspacePicker onDismiss={vi.fn()} />
    </AppShellContext.Provider>,
  );
  return { selectWorkspacePicker, createProject };
}

/** The row for the workspace the fake source found. */
function workspaceRow() {
  return screen.getByRole("option", { name: /devhub/u });
}

describe("opening a workspace with an agent", () => {
  it("asks which agent, as the next step, on Command-Return", async () => {
    mount();
    expect(screen.getByText("Step 1")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Enter",
      metaKey: true,
    });
    expect(await screen.findByText("New Agent")).toBeInTheDocument();
    expect(screen.getByText("Step 2")).toBeInTheDocument();
  });

  it("asks the same question on Command-click", async () => {
    mount();
    fireEvent.click(workspaceRow(), { metaKey: true });
    expect(await screen.findByText("New Agent")).toBeInTheDocument();
  });

  it("opens the workspace on a plain choice, with no profile", async () => {
    const { selectWorkspacePicker } = mount();
    // Clicked rather than Returned: with nothing typed the pinned rows lead the
    // list, so Return is on "New Project…" — which is the picker's own rule and
    // not what this is about.
    fireEvent.click(workspaceRow());
    await waitFor(() => {
      expect(selectWorkspacePicker).toHaveBeenCalledWith(
        "/projects/devhub",
        false,
        undefined,
      );
    });
    expect(screen.queryByText("New Agent")).not.toBeInTheDocument();
  });

  it("goes back to the list when the agent question is escaped", async () => {
    const { selectWorkspacePicker } = mount();
    fireEvent.click(workspaceRow(), { metaKey: true });
    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });
    expect(await screen.findByText("Open Workspace")).toBeInTheDocument();
    expect(screen.getByText("Step 1")).toBeInTheDocument();
    // Escaping a question answers nothing: the workspace is not opened behind
    // the sheet the person just backed out of.
    expect(selectWorkspacePicker).not.toHaveBeenCalled();
  });

  it("carries the chosen profile into the opening", async () => {
    const { selectWorkspacePicker } = mount();
    fireEvent.click(workspaceRow(), { metaKey: true });
    fireEvent.click(await screen.findByRole("option", { name: /Codex/u }));
    await waitFor(() => {
      expect(selectWorkspacePicker).toHaveBeenCalledWith(
        "/projects/devhub",
        false,
        "codex",
      );
    });
  });

  it("carries it into a project that does not exist yet", async () => {
    const { createProject } = mount();
    fireEvent.click(screen.getByRole("option", { name: /New Project/u }), {
      metaKey: true,
    });
    fireEvent.click(await screen.findByRole("option", { name: /Claude/u }));
    // The folder is asked about *after* the agent, so the sheet that makes it
    // is the third question and knows the profile before it runs.
    const create = await screen.findByRole("option", {
      name: /Create and open this folder/u,
    });
    expect(screen.getByText("Step 3")).toBeInTheDocument();
    fireEvent.click(create);
    await waitFor(() => {
      expect(createProject).toHaveBeenCalledWith("/projects/", "claude");
    });
  });
});
