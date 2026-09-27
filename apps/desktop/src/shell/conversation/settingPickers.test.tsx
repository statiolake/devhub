// @vitest-environment jsdom

/**
 * The settings in the composer's toolbar before and after the session names
 * them: a value the Agent has not named yet is said in words, never blank.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EMPTY_SESSION, type SessionFacts } from "../../model/conversation";
import { UNKNOWN_VALUE } from "./SettingPickers";
import { draw, installResizeObserver } from "./surfaceTestKit";
import { transcriptOf } from "./transcriptFixtures";

beforeAll(installResizeObserver);
afterEach(cleanup);

const MODELS = [
  { id: "large", label: "Large" },
  { id: "small", label: "Small" },
];

function withSession(session: SessionFacts) {
  return transcriptOf([{ type: "session", session }]);
}

function picked(name: string): string | undefined {
  const picker = screen.getByRole<HTMLSelectElement>("combobox", { name });
  return picker.selectedOptions[0]?.textContent ?? undefined;
}

describe("a session that has not named its settings yet", () => {
  it("says the model and permissions are not known yet, and the effort is the Agent's default", () => {
    // Claude before its first turn: the handshake listed the choices, and
    // nothing has named the current ones.
    draw(
      withSession({
        ...EMPTY_SESSION,
        model: { current: undefined, choices: MODELS },
        mode: { current: undefined, choices: [{ id: "ask", label: "Ask" }] },
      }),
    );
    expect(picked("Model")).toBe(UNKNOWN_VALUE.model);
    expect(picked("Permissions")).toBe(UNKNOWN_VALUE.mode);
    const effort = document.querySelector('[data-setting="effort"]');
    expect(effort).toHaveTextContent(`Effort${UNKNOWN_VALUE.effort}`);
    expect(effort).toHaveAttribute("data-unknown");
  });

  it("names the effort's choices once the model is known, the default standing until one is chosen", () => {
    draw(
      withSession({
        ...EMPTY_SESSION,
        model: { current: "large", choices: MODELS },
        effort: {
          current: undefined,
          choices: [
            { id: "low", label: "low" },
            { id: "high", label: "high" },
          ],
        },
      }),
    );
    expect(picked("Model")).toBe("Large");
    expect(picked("Effort")).toBe(UNKNOWN_VALUE.effort);
  });

  it("shows no effort for a known model that takes none", () => {
    draw(
      withSession({
        ...EMPTY_SESSION,
        model: { current: "small", choices: MODELS },
      }),
    );
    expect(document.querySelector('[data-setting="effort"]')).toBeNull();
  });

  it("says why the effort can't be changed when the Agent listed nothing for the session's model", () => {
    const why = "the model list does not name old-model";
    draw(
      withSession({
        ...EMPTY_SESSION,
        model: {
          current: "old-model",
          choices: [{ id: "old-model", label: "old-model" }, ...MODELS],
        },
        effort: { current: undefined, choices: [], unchangeable: why },
      }),
    );
    expect(picked("Model")).toBe("old-model");
    const effort = document.querySelector('[data-setting="effort"]');
    expect(effort).toHaveTextContent(`Effort${UNKNOWN_VALUE.effort}${why}`);
    expect(screen.queryByRole("combobox", { name: "Effort" })).toBeNull();
  });

  it("says an effort nothing named is the CLI's default, not a level", () => {
    draw(
      withSession({
        ...EMPTY_SESSION,
        model: { current: "large", choices: MODELS },
        effort: {
          current: undefined,
          choices: [{ id: "high", label: "high" }],
        },
      }),
    );
    expect(picked("Effort")).toBe("CLI's default");
    expect(
      document.querySelector('[data-setting="effort"]')?.getAttribute("title"),
    ).toMatch(/does not report/);
  });

  it("reads the current model as its option reads, with the Agent's own words for it beside", () => {
    draw(
      withSession({
        ...EMPTY_SESSION,
        model: {
          current: "opus",
          choices: [
            { id: "opus", label: "full-opus (opus)", detail: "Opus" },
            { id: "sonnet", label: "full-sonnet (sonnet)", detail: "Sonnet" },
          ],
        },
      }),
    );
    expect(picked("Model")).toBe("full-opus (opus)");
    const model = document.querySelector('[data-setting="model"]');
    expect(model).toHaveAttribute("title", "Opus");
    expect(
      [...(model?.querySelectorAll("option") ?? [])].map((option) => [
        option.textContent,
        option.title,
      ]),
    ).toEqual([
      ["full-opus (opus)", "Opus"],
      ["full-sonnet (sonnet)", "Sonnet"],
    ]);
  });

  it("shows the values once the session names them", () => {
    draw(
      withSession({
        ...EMPTY_SESSION,
        model: { current: "small", choices: MODELS },
        effort: { current: "high", choices: [{ id: "high", label: "high" }] },
        mode: { current: "ask", choices: [{ id: "ask", label: "Ask" }] },
      }),
    );
    expect(picked("Model")).toBe("Small");
    expect(picked("Effort")).toBe("high");
    expect(picked("Permissions")).toBe("Ask");
    expect(document.querySelector("[data-unknown]")).toBeNull();
  });
});
