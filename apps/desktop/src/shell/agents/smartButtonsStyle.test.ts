import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * The row's strength is read from the stylesheet: it is at full strength
 * whenever it is there. Nothing in it is translucent at rest and solid when
 * reached for — the ghost it used to be — and nothing in it blurs what is
 * under it.
 */
describe("the row's strength", () => {
  const css = readFileSync(
    fileURLToPath(new URL("smartButtons.css", import.meta.url)),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Enter and exit fades are motion, not strength.
    .replace(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*\s*\}/g, "");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
    ([, selector = "", body = ""]) => ({ selector: selector.trim(), body }),
  );

  it("has no opacity outside its enter and exit motion", () => {
    expect(
      rules.filter((rule) => /(?:^|;)\s*opacity:/u.test(rule.body)),
    ).toEqual([]);
  });

  it("is no box: the row has no ground, edge or blur of its own", () => {
    const row = rules.filter((rule) =>
      /^\.smart-buttons(?:\[[^\]]+\])*$/u.test(rule.selector),
    );
    expect(row.length).toBeGreaterThan(0);
    for (const rule of row) {
      expect(rule.body).not.toMatch(/background|box-shadow|backdrop-filter/u);
    }
    expect(css).not.toMatch(/backdrop-filter/u);
  });
});
