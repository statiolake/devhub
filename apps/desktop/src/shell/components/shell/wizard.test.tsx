// @vitest-environment jsdom

/**
 * The wizard as the person meets it: one picker at a time, Escape going back a
 * question rather than closing everything, and a slow step saying what it is
 * doing instead of leaving an empty sheet up.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Wizard } from "./Wizard";
import type { WizardStep } from "./wizardFlow";

Element.prototype.scrollIntoView = vi.fn();
afterEach(cleanup);

function prompt(title: string, ...labels: string[]) {
  return {
    title,
    placeholder: title,
    items: labels.map((label) => ({ id: label, label })),
    emptyNoMatch: "Nothing matches.",
    emptyNoItems: "Nothing to choose.",
  };
}

describe("the wizard on screen", () => {
  it("asks each question in turn and ends when the flow does", async () => {
    const chosen: string[] = [];
    const second: WizardStep = async (input) => {
      chosen.push((await input.ask(prompt("Branch", "main"))).id);
      return undefined;
    };
    const first: WizardStep = async (input) => {
      chosen.push((await input.ask(prompt("Agent", "Claude"))).id);
      return second;
    };
    const onFinished = vi.fn();

    render(<Wizard start={first} onFinished={onFinished} />);
    expect(await screen.findByRole("dialog", { name: "Agent" })).toBeVisible();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });

    expect(await screen.findByRole("dialog", { name: "Branch" })).toBeVisible();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });

    await vi.waitFor(() => {
      expect(onFinished).toHaveBeenCalled();
    });
    expect(chosen).toEqual(["Claude", "main"]);
  });

  it("takes Escape back one question, not out of the flow", async () => {
    const second: WizardStep = async (input) => {
      await input.ask(prompt("Branch", "main"));
      return undefined;
    };
    const first: WizardStep = async (input) => {
      await input.ask(prompt("Agent", "Claude"));
      return second;
    };
    const onFinished = vi.fn();

    render(<Wizard start={first} onFinished={onFinished} />);
    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Enter" });
    fireEvent.keyDown(await screen.findByRole("dialog", { name: "Branch" }), {
      key: "Escape",
    });

    expect(await screen.findByRole("dialog", { name: "Agent" })).toBeVisible();
    expect(onFinished).not.toHaveBeenCalled();
  });

  it("ends when Escape has nowhere left to go", async () => {
    const first: WizardStep = async (input) => {
      await input.ask(prompt("Agent", "Claude"));
      return undefined;
    };
    const onFinished = vi.fn();

    render(<Wizard start={first} onFinished={onFinished} />);
    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });

    await vi.waitFor(() => {
      expect(onFinished).toHaveBeenCalled();
    });
  });

  it("says what it is doing while a slow step runs", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first: WizardStep = async (input) => {
      await input.ask(prompt("Repository", "devhub"));
      await input.working("Cloning devhub…", () => held);
      return undefined;
    };

    render(<Wizard start={first} onFinished={vi.fn()} />);
    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Enter" });

    expect(
      await screen.findByRole("dialog", { name: "Cloning devhub…" }),
    ).toBeVisible();
    release();
  });
});
