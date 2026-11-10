// @vitest-environment jsdom

/**
 * A program's question in the quick pick: the heading band is the question
 * itself, an input is the field alone, and nothing under the list but what
 * the keyboard already does.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { QuickPickSheet } from "./QuickPickSheet";

beforeAll(() => {
  // jsdom lays nothing out; keeping a row in view is not this file's subject.
  Element.prototype.scrollIntoView = () => {};
});

afterEach(cleanup);

function sheet() {
  return screen.getByRole("dialog");
}

describe("vim.ui.select", () => {
  it("is headed by its question, not by who asks, with no button under the list", () => {
    const onDismiss = vi.fn();
    render(
      <QuickPickSheet
        request={{
          title: "Neovim",
          question: "ブランチを選ぶ",
          rows: [{ label: "main" }, { label: "release/2.4" }],
        }}
        onDismiss={onDismiss}
      />,
    );
    expect(sheet()).toHaveAccessibleName("ブランチを選ぶ");
    expect(screen.getByRole("heading")).toHaveTextContent("ブランチを選ぶ");
    expect(screen.queryByText("Neovim")).toBeNull();
    expect(document.querySelector(".picker-question")).toBeNull();
    expect(document.querySelector(".picker-footer")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    fireEvent.keyDown(sheet(), { key: "ArrowDown" });
    fireEvent.keyDown(sheet(), { key: "Enter" });
    expect(onDismiss).toHaveBeenCalledWith(1);
  });

  it("is headed by who asks only when the program asked nothing in words", () => {
    render(
      <QuickPickSheet
        request={{ title: "Neovim", question: "", rows: [{ label: "a" }] }}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByRole("heading")).toHaveTextContent("Neovim");
  });
});

describe("vim.ui.input", () => {
  it("is the field alone, and Return answers with what is in it", () => {
    const onDismiss = vi.fn();
    render(
      <QuickPickSheet
        request={{
          title: "Neovim",
          question: "新しい名前",
          rows: [],
          input: { default: "describe" },
        }}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByRole("option")).toBeNull();
    expect(screen.queryByText("Use what is typed")).toBeNull();
    const field = screen.getByRole("textbox", { name: "新しい名前" });
    expect(field).toHaveValue("describe");
    fireEvent.change(field, { target: { value: "describe2" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onDismiss).toHaveBeenCalledWith("describe2");
    // Answered: a second Return asks nothing more.
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("is cancelled by Escape, with nothing", () => {
    const onDismiss = vi.fn();
    render(
      <QuickPickSheet
        request={{
          title: "Neovim",
          question: "Name",
          rows: [],
          input: { default: "" },
        }}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.keyDown(sheet(), { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledWith();
  });
});
