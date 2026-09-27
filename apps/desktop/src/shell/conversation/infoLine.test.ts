/**
 * What the CLI reports beside the conversation is one quiet line, by one rule
 * on the notice's level and not one per event: the page cannot lay anything
 * out in a test, so the rule is read from the stylesheet itself.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(
  fileURLToPath(new URL("./conversation.css", import.meta.url)),
  "utf8",
);

/** The declarations of the rule whose selector is exactly `selector`. */
function declarations(selector: string): Readonly<Record<string, string>> {
  const rules = [...CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(
    ([, head]) =>
      head!
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\s+/g, " ")
        .trim() === selector,
  );
  expect(rules, `one rule for ${selector}`).toHaveLength(1);
  return Object.fromEntries(
    rules[0]![2]!
      .split(";")
      .map((each) => each.split(":").map((part) => part.trim()))
      .filter(([property]) => property)
      .map(([property, ...value]) => [property, value.join(":")]),
  );
}

describe("an information notice", () => {
  it("is a quiet line: no box, the faintest ink, smaller than a tool row", () => {
    expect(declarations('.conversation-notice[data-level="info"]')).toEqual({
      padding: "0",
      "border-radius": "0",
      background: "none",
      color: "var(--tertiary)",
      "font-size": "0.8em",
    });
    const tool = declarations(".conversation-tool-title");
    expect(parseFloat(tool["font-size"]!)).toBeGreaterThan(0.8);
  });

  it("sits close to what comes before it", () => {
    expect(
      declarations(
        '.conversation-entry + .conversation-entry:has(> .conversation-notice[data-level="info"])',
      ),
    ).toEqual({ "margin-top": "var(--space-1)" });
  });

  it("leaves warnings and errors their weight", () => {
    for (const level of ["warning", "error"])
      expect(
        declarations(`.conversation-notice[data-level="${level}"]`),
      ).toHaveProperty("background");
  });
});
