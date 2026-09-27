/*
 * A GUI Agent's conversation is typeset the way Japanese is, and a monospace
 * line is not.
 *
 * The conversation's root turns on `text-autospace` (the space between CJK
 * and Latin letters or digits) and `text-spacing-trim` (full-width punctuation
 * trimmed where two meet and at a line's start); the transcript inherits it,
 * and so does every field typed into, because the one form-control rule in
 * `tokens.css` makes controls inherit both. Wherever `--font-mono` is set, both
 * are turned off, so a code block, a diff or command output keeps its columns.
 * Nothing else in DevHub sets either.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../", import.meta.url));

const read = (relative: string): string =>
  readFileSync(join(SRC, relative), "utf8");

function stylesheets(directory: string): readonly string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return stylesheets(path);
    return name.endsWith(".css") ? [path] : [];
  });
}

/** Every rule in a stylesheet, comments dropped: its selector and its body. */
function rules(css: string): readonly { selector: string; body: string }[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
    ([, selector, body]) => ({
      selector: selector.replace(/\s+/g, " ").trim(),
      body,
    }),
  );
}

function ruleFor(css: string, selector: string): string {
  const found = rules(css).filter((rule) => rule.selector === selector);
  expect(found, selector).toHaveLength(1);
  return found[0].body;
}

const TYPESETTING =
  /text-autospace:\s*normal;[\s\S]*text-spacing-trim:\s*trim-start;/;
const MONOSPACE =
  /text-autospace:\s*no-autospace;[\s\S]*text-spacing-trim:\s*space-all;/;

describe("text spacing", () => {
  it("is turned on at the conversation's root", () => {
    const conversation = read("shell/conversation/conversation.css");
    expect(ruleFor(conversation, ".conversation-surface")).toMatch(TYPESETTING);
  });

  it("is inherited by every form control, which the browser would not do for font", () => {
    const tokens = read("shell/styles/tokens.css");
    const controls = ruleFor(tokens, "button, input, textarea, select");
    expect(controls).toMatch(/font:\s*inherit;/);
    expect(controls).toMatch(/text-autospace:\s*inherit;/);
    expect(controls).toMatch(/text-spacing-trim:\s*inherit;/);
  });

  it("is turned off by every rule that sets the monospace face", () => {
    let monospaced = 0;
    for (const path of stylesheets(SRC)) {
      for (const rule of rules(readFileSync(path, "utf8"))) {
        if (!/font-family:\s*var\(--font-mono\)/.test(rule.body)) continue;
        monospaced += 1;
        expect(rule.body, `${path}: ${rule.selector}`).toMatch(MONOSPACE);
      }
    }
    // The browser's own `code, kbd, pre, samp`, code blocks and inline code
    // among them, are one of these.
    expect(
      ruleFor(read("shell/styles/tokens.css"), "code, kbd, pre, samp"),
    ).toMatch(MONOSPACE);
    expect(monospaced).toBeGreaterThan(10);
  });

  it("is set nowhere else", () => {
    for (const path of stylesheets(SRC)) {
      for (const rule of rules(readFileSync(path, "utf8"))) {
        if (!/text-autospace|text-spacing-trim/.test(rule.body)) continue;
        const where = `${path}: ${rule.selector}`;
        const isRoot =
          path.endsWith(join("conversation", "conversation.css")) &&
          rule.selector === ".conversation-surface";
        const isControls =
          path.endsWith(join("styles", "tokens.css")) &&
          rule.selector === "button, input, textarea, select";
        const isMonospace = /font-family:\s*var\(--font-mono\)/.test(rule.body);
        expect(isRoot || isControls || isMonospace, where).toBe(true);
      }
    }
  });
});
