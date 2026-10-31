// @vitest-environment jsdom

/**
 * Choosing what Option is in DevHub's terminals (`[terminal]
 * mac_option_is_meta`): one popup on the Terminal screen, three values, two of
 * them booleans in the file.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsApp } from "./SettingsApp";
import { testClient, testConfig } from "./testHarness";

afterEach(() => {
  cleanup();
});

async function open(macOptionIsMeta: boolean | "left") {
  const config = testConfig();
  const { saves, client } = testClient({
    ...config,
    terminal: { macOptionIsMeta },
  });
  render(<SettingsApp client={client} />);
  fireEvent.click(await screen.findByRole("tab", { name: "Terminal" }));
  return {
    popup: screen.getByLabelText("Option key"),
    saved: () => saves.map((save) => save.terminal.macOptionIsMeta),
  };
}

describe("the Option key popup", () => {
  it("shows the setting as it is", async () => {
    expect((await open(false)).popup).toHaveValue("false");
    cleanup();
    expect((await open("left")).popup).toHaveValue("left");
    cleanup();
    expect((await open(true)).popup).toHaveValue("true");
  });

  it("writes the left Option as a string and the others as booleans", async () => {
    const { popup, saved } = await open(false);
    fireEvent.change(popup, { target: { value: "left" } });
    await vi.waitFor(() => {
      expect(saved()).toEqual(["left"]);
    });
    fireEvent.change(popup, { target: { value: "true" } });
    await vi.waitFor(() => {
      expect(saved()).toEqual(["left", true]);
    });
    fireEvent.change(popup, { target: { value: "false" } });
    await vi.waitFor(() => {
      expect(saved()).toEqual(["left", true, false]);
    });
  });
});
