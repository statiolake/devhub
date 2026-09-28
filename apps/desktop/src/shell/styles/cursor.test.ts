/*
 * The pointer on every page DevHub draws, as on the Mac: the pointing hand
 * over a link, the I-beam over text that can be selected, and the arrow over
 * the rest — a button, a fold, a tab, a menu, a toggle and a row of a list
 * (a sidebar's) included.
 *
 * It is written once, in `styles/tokens.css`, which every page imports, by
 * what an element is — its element or its role — and nowhere else, so a new
 * control has it without asking. Text that can be selected sets `auto` where
 * it starts and lets it be inherited, so a link inside a GUI Agent's
 * transcript keeps the hand for its words, and a control there the arrow.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../", import.meta.url));

const read = (path: string): string => readFileSync(join(SRC, path), "utf8");

function stylesheets(directory: string): readonly string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return stylesheets(path);
    return name.endsWith(".css") ? [path] : [];
  });
}

/** Every innermost rule in a stylesheet, comments dropped: its selector and its body. */
function rules(css: string): readonly { selector: string; body: string }[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
    ([, selector, body]) => ({
      selector: selector!.replace(/\s+/g, " ").trim(),
      body: body!,
    }),
  );
}

function cursorOf(body: string): string | undefined {
  return /(?:^|;|\s)cursor:\s*([\w-]+)/.exec(body)?.[1];
}

const TOKENS = "shell/styles/tokens.css";

/** The controls the arrow rule names, as it names them. */
const CONTROLS = [
  "button",
  "summary",
  "select",
  'label:has(> input:is([type="checkbox"], [type="radio"]))',
  '[role="button"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
];

describe("the pointer", () => {
  it("is the hand over a link only, in one rule of tokens.css, and not over one that is disabled", () => {
    const css = rules(read(TOKENS));
    const hands = css.filter((rule) => cursorOf(rule.body) === "pointer");
    expect(hands.map((rule) => rule.selector)).toEqual([
      ':where(a[href], [role="link"]):not(:disabled, [aria-disabled="true"])',
    ]);
    const disabled = css.filter(
      (rule) => rule.selector === ':is(:disabled, [aria-disabled="true"])',
    );
    expect(disabled.map((rule) => cursorOf(rule.body))).toEqual(["default"]);
  });

  it("is the arrow over every control, even inside selectable text, in one rule of tokens.css", () => {
    const arrows = rules(read(TOKENS)).filter(
      (rule) =>
        cursorOf(rule.body) === "default" &&
        rule.selector.startsWith(":where("),
    );
    expect(arrows).toHaveLength(1);
    const { selector } = arrows[0]!;
    for (const control of CONTROLS) expect(selector).toContain(control);
    expect(selector).not.toContain("a[href]");
    expect(selector).not.toContain('[role="link"]');
    expect(selector).toMatch(/\)$/);
  });

  it("is set by no component: every hand or arrow is one of tokens.css's", () => {
    const others: string[] = [];
    for (const path of stylesheets(SRC)) {
      if (path === join(SRC, TOKENS)) continue;
      for (const rule of rules(readFileSync(path, "utf8"))) {
        const cursor = cursorOf(rule.body);
        if (cursor === "pointer" || cursor === "default")
          others.push(`${relative(SRC, path)}: ${rule.selector}`);
      }
    }
    expect(others).toEqual([]);
  });

  it("is the I-beam over selectable text by inheritance, so a link inside it keeps the hand for what it holds", () => {
    const css = read(TOKENS);
    const auto = rules(css).filter((rule) => cursorOf(rule.body) === "auto");
    expect(auto).toHaveLength(1);
    const roots = auto[0]!.selector.split(", ");
    expect(roots).toContain(".conversation-selectable");
    expect(roots).not.toContain(".conversation-selectable *");
    // Every element inherits the pointer it is not given (`*`), and the
    // root of the page is the arrow.
    expect(
      rules(css).find((rule) => rule.selector === "*, *::before, *::after")
        ?.body,
    ).toMatch(/cursor:\s*inherit;/);
    expect(
      rules(css)
        .filter((rule) => rule.selector === ":root")
        .map((rule) => cursorOf(rule.body))
        .filter((cursor) => cursor !== undefined),
    ).toEqual(["default"]);
  });
});
