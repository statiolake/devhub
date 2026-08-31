// @vitest-environment jsdom

/**
 * Changing the Agent pane's font family.
 *
 * The bug this pins: the field used to apply every keystroke, so clearing
 * "SF Mono" to type "Menlo" asked DevHub to accept an empty font family, and
 * the refusal that came back was about a value nobody had chosen — while the
 * word being typed was still on screen. What is asserted here is that the
 * half-typed states never leave the window at all, and that the ones a person
 * really does type are carried through unchanged.
 *
 * Every free-text field in the window is now the same component, so this is
 * also the behaviour of the identifier, the folder and the socket name.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FONT_FAMILY_RULE } from "../model/fontFamily";
import { SettingsApp } from "./SettingsApp";
import type { SettingsClient } from "./client";
import { testClient, testConfig } from "./testHarness";

afterEach(cleanup);

function harness(terminalFontFamily = "SF Mono") {
  const config = testConfig();
  const { saves, client } = testClient({
    ...config,
    appearance: { ...config.appearance, terminalFontFamily },
  });
  return {
    client,
    families: () => saves.map((save) => save.appearance.terminalFontFamily),
  };
}

async function openFontField(client: SettingsClient) {
  render(<SettingsApp client={client} />);
  // General, not Terminal: the field styles the Agent pane, which is the one
  // text surface DevHub still draws for itself.
  fireEvent.click(await screen.findByRole("tab", { name: "General" }));
  return screen.getByLabelText("Agent pane font family");
}

const type = (field: HTMLElement, value: string) => {
  fireEvent.change(field, { target: { value } });
};

describe("the agent pane font family field", () => {
  it("carries every spelling a person types through to the save", async () => {
    for (const family of [
      "Menlo",
      "JetBrains Mono, Menlo, monospace",
      '"Fira Code"',
      "SF Mono",
    ]) {
      // Started from something else each time, so every spelling below is a
      // real change rather than the value already in effect.
      const { families, client } = harness("ui-monospace");
      const field = await openFontField(client);

      type(field, family);
      fireEvent.blur(field);

      await vi.waitFor(() => {
        expect(families()).toEqual([family]);
      });
      cleanup();
    }
  });

  it("saves nothing while the field is being typed into", async () => {
    const { families, client } = harness();
    const field = await openFontField(client);

    // The states a person passes through on the way from SF Mono to Menlo.
    // The empty one is the one that used to be sent and refused.
    for (const step of ["", "M", "Me", "Men", "Menl", "Menlo"]) {
      type(field, step);
    }

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(families()).toEqual([]);
    expect(screen.getByText(/Not applied yet/)).toBeInTheDocument();
  });

  it("states the rule for an empty family rather than sending it", async () => {
    const { families, client } = harness();
    const field = await openFontField(client);

    type(field, "");
    fireEvent.blur(field);

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(families()).toEqual([]);
    expect(screen.getByRole("alert")).toHaveTextContent(FONT_FAMILY_RULE);
    // The refusal is visible and the typing is kept — nothing is silently
    // reverted behind the person's back.
    expect(screen.getByLabelText("Agent pane font family")).toHaveValue("");
  });

  it("commits on Return without leaving the field", async () => {
    const { families, client } = harness();
    const field = await openFontField(client);

    type(field, "Menlo");
    fireEvent.keyDown(field, { key: "Enter" });

    await vi.waitFor(() => {
      expect(families()).toEqual(["Menlo"]);
    });
  });

  it("puts back what is in effect on Escape", async () => {
    const { families, client } = harness();
    const field = await openFontField(client);

    type(field, "Menl");
    fireEvent.keyDown(field, { key: "Escape" });

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(families()).toEqual([]);
    expect(screen.getByLabelText("Agent pane font family")).toHaveValue(
      "SF Mono",
    );
  });
});
