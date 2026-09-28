/*
 * The pointer on every page DevHub draws: the hand over whatever does
 * something when it is clicked, the I-beam over text that can be selected,
 * the arrow over the rest.
 *
 * The hand is written once, in `styles/tokens.css`, which every page imports,
 * by what an element is — its element or its role — and nowhere else, so a
 * new control has it without asking and no component can take it away. Text
 * that can be selected sets `auto` where it starts and lets it be inherited,
 * so a link inside a GUI Agent's transcript keeps the hand for its words too
 * (it used to show the I-beam: the transcript set `auto` on every element in
 * it, the link's own included).
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

/** The clickable things the one rule names, as it names them. */
const CLICKABLE = [
  "a[href]",
  "button",
  "summary",
  "select",
  'label:has(> input:is([type="checkbox"], [type="radio"]):enabled)',
  '[type="checkbox"]',
  '[type="radio"]',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
];

describe("the pointer", () => {
  it("is the hand over every clickable thing, in one rule of tokens.css, and not over one that is disabled", () => {
    const hands = rules(read(TOKENS)).filter(
      (rule) => cursorOf(rule.body) === "pointer",
    );
    expect(hands).toHaveLength(1);
    const { selector } = hands[0]!;
    expect(selector).toMatch(/^:where\(/);
    for (const clickable of CLICKABLE) expect(selector).toContain(clickable);
    expect(selector).toMatch(/\):not\(:disabled, \[aria-disabled="true"\]\)$/);
    const disabled = rules(read(TOKENS)).filter(
      (rule) => rule.selector === ':is(:disabled, [aria-disabled="true"])',
    );
    expect(disabled.map((rule) => cursorOf(rule.body))).toEqual(["default"]);
  });

  it("is set by no component: every other hand or arrow is the one rule's", () => {
    const others: string[] = [];
    for (const path of stylesheets(SRC)) {
      if (path === join(SRC, TOKENS)) continue;
      for (const rule of rules(readFileSync(path, "utf8"))) {
        const cursor = cursorOf(rule.body);
        if (cursor === "pointer" || cursor === "default")
          others.push(`${relative(SRC, path)}: ${rule.selector}`);
      }
    }
    // A subagent's header folds its pane only while the pane sits beside
    // the conversation: clickable in one place, and said so there.
    expect(others).toEqual([
      'shell/conversation/conversation.css: .conversation-subagent-pane[data-place="beside"] .conversation-subagent-pane-header',
    ]);
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
