// @vitest-environment jsdom

/**
 * A confirmation in a short window: its words give way, never its answers.
 *
 * A picker is a column of bands under a height cap, and an ordinary one lets
 * its list shrink and scroll, because the list is the long part. A
 * confirmation (`cancelRow`) is the other way round: two or three rows that
 * are the answers, and a question and a note that can be long — voice input's
 * download states the model, size, host, folder and a promise. With the list
 * shrinking, a window under ~450px showed キャンセル and clipped ダウンロード,
 * and the sheet could only be cancelled.
 *
 * jsdom has no layout, so what is pinned is the contract between the two
 * halves: the picker marks a confirmation (`is-confirmation`), and the shared
 * sheet stylesheet keeps that sheet's rows at their full height and lets its
 * header and note shrink and scroll instead. Every confirmation gets it — the
 * socket change, a worktree's close, voice input — from `Picker` alone.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceConsentPicker } from "../../voice/VoiceConsent";
import { Picker } from "./Picker";

Element.prototype.scrollIntoView = vi.fn();

afterEach(() => {
  cleanup();
});

/** The body of the rule for exactly `selector` in macos.css, comments dropped. */
function rule(selector: string): string {
  const css = readFileSync(
    // jsdom gives `import.meta.url` no file scheme; vitest runs from apps/desktop.
    resolve(process.cwd(), "src/shell/styles/macos.css"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (
      selectors!
        .split(",")
        .map((each) => each.replace(/\s+/g, " ").trim())
        .includes(selector)
    )
      return body!.replace(/\s+/g, " ");
  }
  throw new Error(`no rule for ${selector}`);
}

describe("a confirmation in a short window", () => {
  it("is marked as one, and an ordinary picker is not", () => {
    render(
      <Picker
        title="Delete it?"
        question="It goes."
        cancelRow={{ detail: "Keep it." }}
        items={[{ id: "delete", label: "Delete" }]}
        onChoose={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(screen.getByRole("dialog")).toHaveClass("picker", "is-confirmation");
    cleanup();
    render(
      <Picker
        title="Which one?"
        question="Choose."
        items={[{ id: "a", label: "A" }]}
        onChoose={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(screen.getByRole("dialog")).not.toHaveClass("is-confirmation");
  });

  it("keeps its rows at their full height, and lets its question and note scroll", () => {
    expect(rule(".picker.is-confirmation > .picker-body")).toContain(
      "flex: none",
    );
    expect(rule(".picker.is-confirmation .picker-results")).toContain(
      "overflow-y: visible",
    );
    expect(rule(".picker.is-confirmation > .picker-search")).toContain(
      "flex: none",
    );
    for (const band of [
      ".picker.is-confirmation > .picker-header",
      ".picker.is-confirmation > .picker-footer",
    ]) {
      const body = rule(band);
      expect(body).toContain("flex: 0 1 auto");
      expect(body).toContain("min-height: 0");
      expect(body).toContain("overflow-y: auto");
    }
  });

  it("puts voice input's two answers in the band that does not give way", () => {
    render(
      <VoiceConsentPicker
        consent={{
          model: "small",
          label: "Whisper small",
          file: "ggml-small.bin",
          size: "466 MiB",
          host: "huggingface.co",
          directory:
            "~/Library/Application Support/DevHub/editor/devhub/whisper",
        }}
        onDownload={() => undefined}
        onCancel={() => undefined}
      />,
    );
    const sheet = screen.getByRole("dialog");
    expect(sheet).toHaveClass("is-confirmation");
    const rows = screen.getAllByRole("option");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("キャンセル"),
      expect.stringContaining("ダウンロード"),
    ]);
    for (const row of rows)
      expect(row.closest(".picker-body")?.parentElement).toBe(sheet);
    // The facts are in the note, which is what scrolls.
    expect(sheet.querySelector(".picker-footer")).toHaveTextContent(
      "huggingface.co",
    );
  });
});
