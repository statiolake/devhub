/*
 * When the corner group over an Agent is lit.
 *
 * At rest everything in it is a suggestion at 40%; reached for — the pointer
 * over the group, or keyboard focus inside it — all of it comes up to full
 * strength so it can be read. Only that: not on focus anywhere in the pane
 * (the terminal holds the keyboard the whole time an Agent is worked in), and
 * no child with an opacity of its own against the lit state (a disabled
 * button that stayed at 0.45 was one whose label could not be read however
 * long it was pointed at).
 *
 * jsdom cannot match `:hover`, so this reads the stylesheet: the opacity of
 * everything in the group is decided by the rules below and by no others.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  fileURLToPath(new URL("shell.css", import.meta.url)),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

interface Rule {
  readonly selectors: readonly string[];
  readonly declarations: ReadonlyMap<string, string>;
}

/** The top-level rules of the sheet — the group's rules are all top-level. */
const rules: readonly Rule[] = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
  ([, selector = "", body = ""]) => ({
    selectors: selector.split(",").map((part) => part.trim()),
    declarations: new Map(
      body
        .split(";")
        .map((declaration) => declaration.split(":"))
        .filter((pair) => pair.length >= 2)
        .map(([name = "", ...value]) => [name.trim(), value.join(":").trim()]),
    ),
  }),
);

const aboutTheGroup = (selector: string): boolean =>
  /\.agent-shortcut/.test(selector);

const opacityRules = rules.filter(
  (rule) =>
    rule.declarations.has("opacity") && rule.selectors.some(aboutTheGroup),
);

describe("the corner group's strength", () => {
  it("comes up to full on the group's hover and focus, for everything in it", () => {
    const lit = opacityRules.filter((rule) =>
      rule.selectors.some((selector) => /:hover|:focus/.test(selector)),
    );
    expect(lit).toEqual([
      {
        selectors: [
          ".agent-shortcuts:hover > *",
          ".agent-shortcuts:focus-within > *",
        ],
        declarations: new Map([["opacity", "1"]]),
      },
    ]);
  });

  it("rests at 40% everywhere except a failure, which is never a suggestion", () => {
    const resting = opacityRules
      .filter(
        (rule) =>
          !rule.selectors.some((selector) => /:hover|:focus/.test(selector)),
      )
      .map((rule) => [
        rule.selectors.join(", "),
        rule.declarations.get("opacity"),
      ]);
    expect(resting).toEqual([
      [".agent-shortcut", "0.4"],
      [".agent-shortcuts-note, .agent-shortcuts-failure", "0.4"],
      [".agent-shortcuts-failure", "1"],
    ]);
  });

  it("is not lit by focus elsewhere in the pane", () => {
    const fromThePane = rules
      .flatMap((rule) => rule.selectors)
      .filter((selector) => selector.includes(".agent-pane:focus-within"));
    expect(fromThePane).toEqual([]);
  });

  it("says a disabled button in ink, so it can still be read when lit", () => {
    const disabled = rules.filter((rule) =>
      rule.selectors.some((selector) =>
        selector.includes(".agent-shortcut:disabled"),
      ),
    );
    expect(
      disabled.map((rule) => [
        rule.selectors.join(", "),
        [...rule.declarations],
      ]),
    ).toEqual([
      [".agent-shortcut:disabled", [["color", "var(--secondary)"]]],
      [".agent-shortcut:disabled svg", [["color", "var(--disabled-ink)"]]],
    ]);
  });
});
