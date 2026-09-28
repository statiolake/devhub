// @vitest-environment jsdom

/**
 * The settings in the composer's toolbar before and after the session names
 * them: a value the Agent has not named yet is said in words, never blank.
 * A picker is DevHub's own list, not a `<select>` whose menu macOS draws: the
 * closed picker is a line of the composer's words centred in its box, and the
 * open one is DevHub's list rows with a check the size of their words.
 */

import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EMPTY_SESSION, type SessionFacts } from "../../model/conversation";
import { UNKNOWN_VALUE } from "./SettingPickers";
import {
  draw,
  installResizeObserver,
  openSetting,
  settingPicker,
  settingValue,
} from "./surfaceTestKit";
import { transcriptOf } from "./transcriptFixtures";

beforeAll(() => {
  installResizeObserver();
  // jsdom lays nothing out to scroll.
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

const MODELS = [
  { id: "large", label: "Large" },
  { id: "small", label: "Small" },
];

function withSession(session: SessionFacts) {
  return transcriptOf([{ type: "session", session }]);
}

const picked = settingValue;

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
    expect(settingPicker("Effort").getAttribute("title")).toMatch(
      /does not report/,
    );
    // Nothing is checked: no level is known to be the current one.
    expect(
      openSetting("Effort").map((row) => row.getAttribute("aria-checked")),
    ).toEqual(["false"]);
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
    expect(settingPicker("Model")).toHaveAttribute("title", "Opus");
    expect(
      openSetting("Model").map((row) => [row.textContent, row.title]),
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

const THREE = {
  ...EMPTY_SESSION,
  model: { current: "large", choices: MODELS },
  effort: {
    current: "medium",
    choices: ["low", "medium", "high"].map((id) => ({ id, label: id })),
  },
};

function key(name: string, keyName: string) {
  fireEvent.keyDown(settingPicker(name), { key: keyName });
}

function highlighted(name: string): string | null {
  const id = settingPicker(name).getAttribute("aria-activedescendant");
  return id === null ? null : document.getElementById(id)!.textContent;
}

describe("an open picker", () => {
  it("opens on the current value, walks with the arrows, and asks for the row Return is pressed on", () => {
    const { actions } = draw(withSession(THREE));
    settingPicker("Effort").focus();
    key("Effort", "ArrowDown");
    expect(settingPicker("Effort")).toHaveAttribute("aria-expanded", "true");
    expect(highlighted("Effort")).toBe("medium");
    key("Effort", "ArrowDown");
    expect(highlighted("Effort")).toBe("high");
    key("Effort", "ArrowDown");
    expect(highlighted("Effort")).toBe("low");
    key("Effort", "Enter");
    expect(actions.setSetting).toHaveBeenCalledWith("effort", "low");
    expect(screen.queryByRole("listbox")).toBeNull();
    // The keyboard stays on the picker, as it did on the platform's.
    expect(settingPicker("Effort")).toHaveFocus();
  });

  it("closes on Esc without stopping the running turn", () => {
    const { actions } = draw(
      transcriptOf([
        { type: "session", session: THREE },
        { type: "state", state: { phase: "ready", turn: "running" } },
      ]),
    );
    openSetting("Effort");
    key("Effort", "Escape");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(actions.interrupt).not.toHaveBeenCalled();
    // Closed, Esc is the pane's again.
    key("Effort", "Escape");
    expect(actions.interrupt).toHaveBeenCalled();
  });

  it("asks for nothing when the current value is chosen again", () => {
    const { actions } = draw(withSession(THREE));
    fireEvent.click(openSetting("Effort")[1]!);
    expect(actions.setSetting).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes when it can no longer take a change, and stays closed when it can again", () => {
    const { redraw } = draw(withSession(THREE));
    openSetting("Model");
    const at = (turn: "rewinding" | "none") =>
      transcriptOf([
        { type: "session", session: THREE },
        { type: "state", state: { phase: "ready", turn } },
      ]);
    redraw(at("rewinding"));
    expect(screen.queryByRole("listbox")).toBeNull();
    redraw(at("none"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes when the keyboard leaves it", () => {
    draw(withSession(THREE));
    openSetting("Model");
    fireEvent.blur(settingPicker("Model"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("marks the current value with a check drawn in the row's glyph column, and the pointer's row as the highlighted one", () => {
    draw(withSession(THREE));
    const rows = openSetting("Effort");
    expect(rows.map((row) => row.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    for (const row of rows) {
      expect(row).toHaveClass("mac-list-row");
      expect(row.firstElementChild).toHaveClass("mac-list-glyph");
    }
    expect(rows[1]!.querySelector(".mac-list-glyph svg")).not.toBeNull();
    expect(rows[0]!.querySelector(".mac-list-glyph svg")).toBeNull();
    fireEvent.mouseMove(rows[2]!);
    expect(rows[2]).toHaveAttribute("aria-selected", "true");
    // The panel is DevHub's list type (`.mac`), as the `/` list's is.
    expect(rows[0]!.closest(".conversation-setting-menu")).toHaveClass("mac");
  });
});

/** Every innermost rule of a stylesheet, comments dropped. */
function rules(path: string): readonly { selector: string; body: string }[] {
  const css = readFileSync(new URL(path, import.meta.url), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
    ([, selector, body]) => ({
      selector: selector!.replace(/\s+/g, " ").trim(),
      body: body!,
    }),
  );
}

describe("how a picker is drawn", () => {
  const css = rules("./conversation.css");
  const of = (selector: string) =>
    css.filter((rule) => rule.selector.includes(selector));

  it("is no <select>: the platform's menu can't be set to DevHub's size", () => {
    draw(withSession(THREE));
    expect(document.querySelector(".conversation-settings select")).toBeNull();
    expect(settingPicker("Model").tagName).toBe("BUTTON");
  });

  it("centres the closed picker's words and arrow on one line, at the composer's size", () => {
    const face = css.find(
      (rule) => rule.selector === ".conversation-setting-face",
    );
    expect(face?.body).toMatch(/display:\s*inline-flex/);
    expect(face?.body).toMatch(/align-items:\s*center/);
    expect(face?.body).toMatch(/font:\s*inherit/);
    // Label and value take the footer's size: no rule sizes them.
    for (const part of [
      ".conversation-setting-face",
      ".conversation-setting-label",
      ".conversation-setting-value",
    ]) {
      for (const rule of of(part)) {
        expect(rule.body, rule.selector).not.toMatch(/font-size/);
      }
    }
    // The arrow is drawn, centred by the box, not a text glyph on the baseline.
    draw(withSession(THREE));
    expect(
      settingPicker("Model").querySelector(".conversation-setting-chevron svg"),
    ).not.toBeNull();
  });

  it("sizes the open list's rows as DevHub's list rows, never on its own", () => {
    for (const part of [
      ".conversation-setting-menu",
      ".conversation-setting-list",
      ".conversation-setting-choice",
    ]) {
      for (const rule of of(part)) {
        expect(rule.body, rule.selector).not.toMatch(/font-size/);
      }
    }
    // One panel for the composer's popups.
    const panel = css.find(
      (rule) =>
        rule.selector.includes(".conversation-completions") &&
        rule.selector.includes(".conversation-setting-menu"),
    );
    expect(panel?.body).toMatch(/box-shadow:\s*var\(--shadow-dialog\)/);
  });
});
