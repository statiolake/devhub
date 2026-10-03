import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * jsdom cannot match `:hover`, so the strength rule is read from the
 * stylesheet: the box is the one thing in it with an opacity, translucent at
 * rest and full while pointed at, focused inside, or dragged.
 */
describe("the box's strength", () => {
  const css = readFileSync(
    fileURLToPath(new URL("smartButtons.css", import.meta.url)),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Enter and exit fades are motion, not strength.
    .replace(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*\s*\}/g, "");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
    ([, selector = "", body = ""]) => ({
      selectors: selector.split(",").map((part) => part.trim()),
      opacity: /(?:^|;)\s*opacity:\s*([^;]+)/u.exec(body)?.[1]?.trim(),
    }),
  );
  const withOpacity = rules.filter((rule) => rule.opacity !== undefined);

  it("is translucent at rest and full when reached for or dragged, and nothing else says otherwise", () => {
    expect(withOpacity).toEqual([
      { selectors: [".smart-buttons"], opacity: "0.4" },
      {
        selectors: [
          ".smart-buttons:hover",
          ".smart-buttons:focus-within",
          ".smart-buttons[data-dragging]",
        ],
        opacity: "1",
      },
    ]);
  });
});
