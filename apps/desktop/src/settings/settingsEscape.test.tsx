// @vitest-environment jsdom

/**
 * Escape in the Settings window.
 *
 * The window used to have no keyboard way out at all: nothing in the menu bar
 * carries an accelerator, `Cmd+W` is not claimed, and the page answered no key.
 * So Escape is answered here, and it means what Escape means everywhere on a
 * Mac — *back out of what I am in* — which is a ladder rather than a shortcut:
 * a sheet first, then the field that has the keyboard, then the window.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsClient } from "./client";
import { SettingsApp } from "./SettingsApp";
import { testClient, testConfig } from "./testHarness";

Element.prototype.scrollIntoView = vi.fn();

afterEach(cleanup);

async function settings() {
  const harness = testClient(testConfig());
  const close = vi.fn(() => Promise.resolve());
  const client: SettingsClient = { ...harness.client, close };
  render(<SettingsApp client={client} />);
  await screen.findByRole("tablist", { name: "Settings sections" });
  return { close };
}

function escape() {
  fireEvent.keyDown(document, { key: "Escape" });
}

describe("Escape in Settings", () => {
  it("closes the window when nothing is holding the keyboard", async () => {
    const { close } = await settings();
    escape();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes it from a control that is not a field", async () => {
    const { close } = await settings();
    screen.getByRole("tab", { name: "Terminal" }).focus();
    escape();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("leaves the field first, and closes on the second press", async () => {
    const { close } = await settings();
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    const field = await screen.findByRole("textbox", { name: /socket/iu });
    field.focus();
    expect(document.activeElement).toBe(field);

    escape();
    // Out of the field, and the window is still up: one press, one step.
    expect(document.activeElement).not.toBe(field);
    expect(close).not.toHaveBeenCalled();

    escape();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps what was typed: leaving a field is not undoing it", async () => {
    const { close } = await settings();
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    const field = await screen.findByRole("textbox", { name: /socket/iu });
    field.focus();
    fireEvent.change(field, { target: { value: "devhub-other" } });
    escape();
    expect(field).toHaveValue("devhub-other");
    expect(close).not.toHaveBeenCalled();
  });

  it("is the sheet's, while a sheet is up", async () => {
    const { close } = await settings();
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    const field = await screen.findByRole("textbox", { name: /socket/iu });
    fireEvent.change(field, { target: { value: "devhub-other" } });
    fireEvent.blur(field);
    fireEvent.click(await screen.findByRole("button", { name: "Change…" }));
    const sheet = await screen.findByRole("dialog");

    fireEvent.keyDown(sheet, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    // The sheet went and the window stayed: one press, one step, again.
    expect(close).not.toHaveBeenCalled();
  });
});
