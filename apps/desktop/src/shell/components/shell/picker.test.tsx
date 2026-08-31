// @vitest-environment jsdom

/**
 * The one picker, at the three points it used to go wrong.
 *
 * 1. **Return and Command-Return are different answers.** The modifier is what
 *    a caller reads to know whether the person asked for the thing beside its
 *    editor or on its own, so a picker that dropped it would silently make one
 *    of the two impossible.
 * 2. **The list does not blank.** Filtering is local, so a keystroke narrows
 *    what is already there in the same frame; a source still answering can only
 *    add. The old picker cleared its rows and re-asked, and the list vanished
 *    for a round trip on every key.
 * 3. **The field keeps the keyboard.** Clicking a row must not move focus onto
 *    it, or the sheet stops answering Return with no way back but the mouse.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Picker, type PickerItem } from "./Picker";

const ITEMS: readonly PickerItem[] = [
  { id: "claude", label: "Claude", searchText: "Claude claude" },
  { id: "codex", label: "Codex", searchText: "Codex codex" },
];

function renderPicker(overrides: Partial<React.ComponentProps<typeof Picker>>) {
  const onChoose = vi.fn();
  const onCancel = vi.fn();
  render(
    <Picker
      title="New Agent"
      placeholder="New Agent"
      items={ITEMS}
      emptyNoMatch="No agent profiles match."
      emptyNoItems="No agent profiles are enabled."
      onChoose={onChoose}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onChoose, onCancel };
}

// jsdom implements no layout, so it has no `scrollIntoView`. Keeping the row
// in view is real behaviour of the picker and stays in the component; here it
// is the environment that is missing, and it is filled in rather than guarded
// against in the code that ships.
Element.prototype.scrollIntoView = vi.fn();

afterEach(cleanup);

describe("the picker", () => {
  it("reports a plain Return as a plain choice", () => {
    const { onChoose } = renderPicker({});
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    expect(onChoose).toHaveBeenCalledWith({ id: "claude", split: false });
  });

  it("reports Command-Return as the split choice", () => {
    const { onChoose } = renderPicker({});
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Enter",
      metaKey: true,
    });
    expect(onChoose).toHaveBeenCalledWith({ id: "claude", split: true });
  });

  it("carries the modifier from a click too", () => {
    const { onChoose } = renderPicker({});
    fireEvent.click(screen.getByRole("option", { name: /Codex/ }), {
      metaKey: true,
    });
    expect(onChoose).toHaveBeenCalledWith({ id: "codex", split: true });
  });

  it("filters what it was given without asking anyone", () => {
    renderPicker({});
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "cod" },
    });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option")).toHaveTextContent("Codex");
  });

  it("keeps the rows it has while the source is asked again", () => {
    const onQueryChange = vi.fn();
    renderPicker({ onQueryChange });
    // The first query goes out at once — the sheet is empty until it answers.
    expect(onQueryChange).toHaveBeenCalledWith("");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "c" } });
    // Both still match "c", and neither waited for the source to answer.
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("says nothing matches rather than showing an empty list", () => {
    renderPicker({});
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "zzz" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByRole("status")).toHaveTextContent(
      "No agent profiles match.",
    );
  });

  it("leaves the keyboard in the field when a row is clicked", () => {
    renderPicker({});
    const field = screen.getByRole("textbox");
    expect(document.activeElement).toBe(field);
    fireEvent.mouseDown(screen.getByRole("option", { name: /Codex/ }));
    expect(document.activeElement).toBe(field);
  });

  it("takes the keyboard back when something else has it", () => {
    renderPicker({});
    const field = screen.getByRole("textbox");
    const thief = document.createElement("input");
    document.body.append(thief);
    thief.focus();
    expect(document.activeElement).toBe(thief);
    fireEvent.focus(window);
    expect(document.activeElement).toBe(field);
    thief.remove();
  });

  it("cancels on Escape", () => {
    const { onCancel } = renderPicker({});
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });
});
