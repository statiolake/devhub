// @vitest-environment jsdom

/**
 * Naming the colour theme DevHub wears: two fields, one per appearance,
 * saved as `[appearance] theme_dark` / `theme_light`.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsApp } from "./SettingsApp";
import { testClient, testConfig } from "./testHarness";

afterEach(() => {
  cleanup();
});

async function open() {
  const { saves, client } = testClient(testConfig());
  render(<SettingsApp client={client} />);
  fireEvent.click(await screen.findByRole("tab", { name: "General" }));
  return { saves };
}

describe("the colour theme fields", () => {
  it("show the themes the settings name", async () => {
    await open();
    expect(screen.getByLabelText("Dark colour theme")).toHaveValue("Dark 2026");
    expect(screen.getByLabelText("Light colour theme")).toHaveValue(
      "Light 2026",
    );
  });

  it("save a theme named in one", async () => {
    const { saves } = await open();
    const field = screen.getByLabelText("Dark colour theme");
    fireEvent.change(field, { target: { value: "Monokai" } });
    fireEvent.blur(field);
    await vi.waitFor(() => {
      expect(saves.map((save) => save.appearance.themeDark)).toEqual([
        "Monokai",
      ]);
    });
    expect(saves[0]?.appearance.themeLight).toBe("Light 2026");
  });

  it("refuse an empty name", async () => {
    const { saves } = await open();
    const field = screen.getByLabelText("Light colour theme");
    fireEvent.change(field, { target: { value: "  " } });
    fireEvent.blur(field);
    expect(await screen.findByText("Name a colour theme.")).toBeInTheDocument();
    expect(saves).toEqual([]);
  });
});
