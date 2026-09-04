// @vitest-environment jsdom

/**
 * The one question the Settings window asks.
 *
 * Moving DevHub's terminals to another tmux socket closes every session that is
 * running now, so it is a decision rather than a value — and a decision is
 * asked the way every decision in DevHub is asked: a picker with as many rows
 * as there are answers and the safe one first (see `Picker`'s docstring). It
 * was an alert with the destructive button under Return, which is the opposite
 * arrangement, and the one place in this window where Return meant something
 * else than it means everywhere else.
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
import type { SettingsClient } from "./client";
import { SettingsApp } from "./SettingsApp";
import { testClient, testConfig } from "./testHarness";

// jsdom implements no layout, so it has no `scrollIntoView`. Keeping the
// selected row visible is the picker's job, not this file's subject.
Element.prototype.scrollIntoView = vi.fn();

afterEach(cleanup);

/** Settings, on the Terminal screen, with the socket field asking to move. */
async function askToMove() {
  const harness = testClient(testConfig());
  const applied: string[] = [];
  const client: SettingsClient = {
    ...harness.client,
    socketApply: (socketName) => {
      applied.push(socketName);
      return harness.client.socketApply(socketName);
    },
  };
  render(<SettingsApp client={client} />);
  fireEvent.click(await screen.findByRole("tab", { name: "Terminal" }));
  const field = await screen.findByRole("textbox", { name: /socket/iu });
  fireEvent.change(field, { target: { value: "devhub-other" } });
  // The field commits on blur, not on every keystroke: what leaves this window
  // is a name somebody finished typing.
  fireEvent.blur(field);
  fireEvent.click(await screen.findByRole("button", { name: "Change…" }));
  await screen.findByRole("dialog");
  return { applied };
}

/** The rows, in the order the arrows and Return walk them. */
function rows(): string[] {
  return screen
    .getAllByRole("option")
    .map((row) => row.querySelector(".mac-list-title")?.textContent ?? "");
}

describe("changing the tmux socket", () => {
  it("offers two rows, with the one that changes nothing first", async () => {
    await askToMove();
    expect(rows()).toEqual(["Keep the current socket", "Move the terminals"]);
    expect(screen.getAllByRole("option")[0]).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("says what moving costs, on the row that costs it", async () => {
    await askToMove();
    expect(
      screen.getByText(
        "Your current sessions are closed and recreated there, so what is running in them stops.",
      ),
    ).toBeInTheDocument();
    // And what is already on the socket, which is the other half of the fact.
    expect(screen.getByText("DevHub sessions there")).toBeInTheDocument();
    expect(screen.getByText("Other sessions there")).toBeInTheDocument();
  });

  it("moves nothing on Return, because keeping is the row it lands on", async () => {
    const { applied } = await askToMove();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(applied).toEqual([]);
  });

  it("moves nothing on Escape, which means what keeping means", async () => {
    const { applied } = await askToMove();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(applied).toEqual([]);
  });

  it("moves the terminals on the second row", async () => {
    const { applied } = await askToMove();
    fireEvent.click(screen.getByText("Move the terminals"));
    await waitFor(() => {
      expect(applied).toEqual(["devhub-other"]);
    });
  });
});
