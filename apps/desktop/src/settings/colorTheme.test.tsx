// @vitest-environment jsdom

/**
 * Naming the colour theme DevHub wears: one field, saved as
 * `[appearance] theme` — a name, or `light:<name>,dark:<name>`.
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

describe("the colour theme field", () => {
  it("shows the theme the settings name", async () => {
    await open();
    expect(screen.getByLabelText("Colour theme")).toHaveValue(
      "light:DevHub Light,dark:DevHub Dark",
    );
  });

  it("saves a theme named in it", async () => {
    const { saves } = await open();
    const field = screen.getByLabelText("Colour theme");
    fireEvent.change(field, {
      target: { value: "light:Catppuccin Latte,dark:Catppuccin Mocha" },
    });
    fireEvent.blur(field);
    await vi.waitFor(() => {
      expect(saves.map((save) => save.appearance.theme)).toEqual([
        "light:Catppuccin Latte,dark:Catppuccin Mocha",
      ]);
    });
  });

  it("refuses what is neither a name nor a light/dark pair", async () => {
    const { saves } = await open();
    const field = screen.getByLabelText("Colour theme");
    fireEvent.change(field, { target: { value: "light:Nord" } });
    fireEvent.blur(field);
    expect(
      await screen.findByText(/Name a theme, or light:<name>,dark:<name>/),
    ).toBeInTheDocument();
    expect(saves).toEqual([]);
  });
});
