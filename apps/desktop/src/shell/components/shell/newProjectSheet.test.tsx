// @vitest-environment jsdom

/**
 * New Project: a question with nothing to pick from, asked as a picker anyway.
 *
 * It was an alert with a text field, which is a second kind of sheet with its
 * own keyboard rules for no reason but history. What is checked here is that it
 * behaves like every other question DevHub asks — Return takes the pinned row,
 * Escape leaves, a refusal keeps the sheet with what was typed — and that the
 * field starts where the person had already got to.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppShellContextValue } from "../../useAppShell";
import { AppShellContext } from "../../useAppShell";
import { NewProjectSheet } from "./ProjectSheets";

Element.prototype.scrollIntoView = vi.fn();
afterEach(cleanup);

function mount(initialQuery?: string, createProject = vi.fn()) {
  const value = {
    createProject,
    projectDefaultDirectory: vi.fn().mockResolvedValue("/projects"),
    reportFailure: vi.fn(),
  } as unknown as AppShellContextValue;
  render(
    <AppShellContext.Provider value={value}>
      <NewProjectSheet initialQuery={initialQuery} onDismiss={vi.fn()} />
    </AppShellContext.Provider>,
  );
  return { createProject };
}

function field() {
  return screen.getByRole("textbox", { name: "New Project" });
}

describe("the new project sheet", () => {
  it("starts in the folder projects go in", async () => {
    mount();
    await vi.waitFor(() => {
      expect(field()).toHaveValue("/projects/");
    });
  });

  it("keeps the name typed in the picker that asked for this sheet", async () => {
    // Somebody typed a name, found no workspace by it, and took "New
    // Project…". The name is the one thing they have already said.
    mount("widget");
    await vi.waitFor(() => {
      expect(field()).toHaveValue("/projects/widget");
    });
  });

  it("creates what the field says when the row is taken", async () => {
    const createProject = vi.fn().mockResolvedValue(undefined);
    mount("widget", createProject);
    await vi.waitFor(() => {
      expect(field()).toHaveValue("/projects/widget");
    });

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    expect(createProject).toHaveBeenCalledWith("/projects/widget");
  });

  it("keeps the sheet, the reason and the typing when the folder is refused", async () => {
    const createProject = vi.fn().mockRejectedValue(
      Object.assign(new Error("exists"), {
        code: "workspace_failed",
        summary: "/projects/widget already exists.",
        module: "app",
        actions: [],
      }),
    );
    mount("widget", createProject);
    await vi.waitFor(() => {
      expect(field()).toHaveValue("/projects/widget");
    });

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });

    expect(
      await screen.findByText("/projects/widget already exists."),
    ).toBeVisible();
    // And the sheet answers the keyboard again, with the path still there to
    // be edited — a picker locks itself on the row it took, so re-asking is
    // what unlocks it.
    expect(field()).toHaveValue("/projects/widget");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    expect(createProject).toHaveBeenCalledTimes(2);
  });

  it("offers nothing to take while the field is empty", async () => {
    mount();
    await vi.waitFor(() => {
      expect(field()).toHaveValue("/projects/");
    });
    fireEvent.change(field(), { target: { value: "" } });
    expect(screen.queryByRole("option")).toBeNull();
  });
});
