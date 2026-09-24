// @vitest-environment jsdom

/**
 * The pointer selects a row by moving onto it or clicking it — never because
 * rows moved under a pointer that did not.
 *
 * A sheet opens where it opens, and a list re-filters and scrolls as it is
 * typed into; either can slide a row under a pointer resting on the list.
 * The browser reports that as the pointer entering the row, and Chromium even
 * sends a `mousemove` for it at the same screen position. Neither is the
 * person pointing at anything, so neither may take the selection away from
 * what the keyboard chose.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Picker, type PickerItem } from "./Picker";

const ITEMS: readonly PickerItem[] = [
  { id: "alpha", label: "Alpha", searchText: "Alpha alpha" },
  { id: "beta", label: "Beta", searchText: "Beta beta" },
  { id: "gamma", label: "Gamma", searchText: "Gamma gamma" },
  { id: "gamut", label: "Gamut", searchText: "Gamut gamut" },
];

function renderPicker() {
  const onChoose = vi.fn();
  render(
    <Picker
      title="Go to"
      question="Which one?"
      items={ITEMS}
      emptyNoMatch="Nothing matches."
      emptyNoItems="Nothing here."
      onChoose={onChoose}
      onCancel={vi.fn()}
    />,
  );
  return { onChoose };
}

Element.prototype.scrollIntoView = vi.fn();

afterEach(cleanup);

function row(name: RegExp) {
  return screen.getByRole("option", { name });
}

function selected() {
  return screen.getByRole("option", { selected: true });
}

/** What the browser sends when a row arrives under a pointer that is still. */
function rowArrivesUnder(element: HTMLElement, at: { x: number; y: number }) {
  fireEvent.mouseOver(element, { screenX: at.x, screenY: at.y });
  fireEvent.mouseEnter(element, { screenX: at.x, screenY: at.y });
  fireEvent.mouseMove(element, { screenX: at.x, screenY: at.y });
}

describe("the picker and the pointer", () => {
  it("keeps the keyboard's row when the sheet opens under a resting pointer", () => {
    renderPicker();
    rowArrivesUnder(row(/Gamma/), { x: 200, y: 300 });
    expect(selected()).toHaveAccessibleName(/Alpha/);
  });

  it("keeps the keyboard's row when typing moves rows under a still pointer", () => {
    renderPicker();
    rowArrivesUnder(row(/Beta/), { x: 200, y: 300 });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowDown" });
    expect(selected()).toHaveAccessibleName(/Gamma/);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "gam" } });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowDown" });
    expect(selected()).toHaveAccessibleName(/Gamut/);

    // "Gamma" now sits where the pointer has been resting all along.
    rowArrivesUnder(row(/Gamma/), { x: 200, y: 300 });
    expect(selected()).toHaveAccessibleName(/Gamut/);
  });

  it("selects the row the pointer actually moves onto", () => {
    renderPicker();
    rowArrivesUnder(row(/Beta/), { x: 200, y: 300 });
    fireEvent.mouseMove(row(/Gamma/), { screenX: 200, screenY: 330 });
    expect(selected()).toHaveAccessibleName(/Gamma/);

    fireEvent.mouseMove(row(/Beta/), { screenX: 201, screenY: 330 });
    expect(selected()).toHaveAccessibleName(/Beta/);
  });

  it("still selects and takes a clicked row", () => {
    const { onChoose } = renderPicker();
    fireEvent.click(row(/Gamma/));
    expect(selected()).toHaveAccessibleName(/Gamma/);
    expect(onChoose).toHaveBeenCalledWith(
      expect.objectContaining({ id: "gamma", split: false }),
    );
  });

  it("moves with the arrows as before", () => {
    renderPicker();
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    expect(selected()).toHaveAccessibleName(/Beta/);
    fireEvent.keyDown(dialog, { key: "ArrowUp" });
    fireEvent.keyDown(dialog, { key: "ArrowUp" });
    expect(selected()).toHaveAccessibleName(/Gamut/);
  });
});
