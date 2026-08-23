import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderSettingsFixture } from "./settings-harness";

describe("Settings visual fixture harness", () => {
  it("renders the ready state through the real SettingsApp", async () => {
    render(renderSettingsFixture("settings-ready"));
    expect(await screen.findByText("Saved")).toBeVisible();
    const settingsWindow = document.querySelector(".settings-window");
    expect(
      Array.from(settingsWindow?.children ?? []).map(
        (child) => child.className,
      ),
    ).toEqual(["settings-header", "settings-notices", "settings-body"]);
  });

  it("drives the dirty state through the real SettingsApp", async () => {
    render(renderSettingsFixture("settings-dirty"));
    expect(await screen.findByText("Unsaved changes")).toBeVisible();
  });

  it("drives the external-conflict projection", async () => {
    render(renderSettingsFixture("settings-conflict"));
    expect(
      await screen.findByText(/configuration changed outside Settings/),
    ).toBeVisible();
  });

  it("renders the diagnostic projection", async () => {
    render(renderSettingsFixture("settings-invalid-diagnostic"));
    await waitFor(() =>
      expect(screen.getByText(/line 12, column 7/)).toBeVisible(),
    );
  });

  it("drives the socket confirmation sheet with exact fixture counts", async () => {
    render(renderSettingsFixture("settings-socket-confirmation"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("devhub-fixture");
    expect(dialog).toHaveTextContent("Scratch sessions: 2");
    expect(dialog).toHaveTextContent("Workspace sessions: 3");
    expect(dialog).toHaveTextContent("target_devhub_empty");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(document.querySelector(".settings-header")).toHaveAttribute("inert");
    expect(document.querySelector(".settings-notices")).toHaveAttribute(
      "inert",
    );
    expect(document.querySelector(".settings-body")).toHaveAttribute("inert");

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      screen.getByRole("button", { name: "Apply socket change" }),
    ).toHaveFocus();
  });
});
