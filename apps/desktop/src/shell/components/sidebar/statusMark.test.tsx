// @vitest-environment jsdom

/**
 * The Agent status mark.
 *
 * Two things are worth holding still here. The first is that the four statuses
 * are four *silhouettes*, not one silhouette in four colours: a reader with no
 * colour, or a screenshot in greyscale, still has to be able to tell working
 * from waiting. The second is that the vocabulary is the one the sibling
 * extension already uses (`vscode-herdr-switcher`, `src/agentPresentation.ts`),
 * because the same Agent is shown in both places and two vocabularies for one
 * Agent is a vocabulary nobody can rely on.
 */

import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentStatus } from "../../../ipc/appShell";
import { StatusMark } from "./StatusMark";

const STATUSES: readonly AgentStatus[] = [
  "working",
  "background",
  "waiting",
  "idle",
  "error",
  "unknown",
];

// Motion is the stylesheet's, and jsdom does not run it, so the rules are
// read as written.
const shellCss = readFileSync("src/shell/styles/shell.css", "utf8");

interface Rule {
  readonly selectors: string[];
  readonly body: string;
}

/** Every rule in `css` as its selector list and its body, flattened. */
function rulesOf(css: string): Rule[] {
  const rules: Rule[] = [];
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push({
      selectors: match[1].split(",").map((selector) => selector.trim()),
      body: match[2],
    });
  }
  return rules;
}

/** The rules inside every media block whose query is `query`. */
function rulesUnder(css: string, query: string): Rule[] {
  const opening = `@media ${query} {`;
  const rules: Rule[] = [];
  for (
    let start = css.indexOf(opening);
    start >= 0;
    start = css.indexOf(opening, start + 1)
  ) {
    let depth = 0;
    let end = -1;
    for (let i = start + opening.length - 1; i < css.length && end < 0; i++) {
      if (css[i] === "{") depth++;
      if (css[i] === "}" && --depth === 0) end = i;
    }
    if (end < 0) throw new Error(`unterminated @media ${query}`);
    rules.push(...rulesOf(css.slice(start + opening.length, end)));
  }
  return rules;
}

/** What `selector` sets `property` to, from the one rule that sets it. */
function declaredOn(selector: string, property: string): string {
  const values = rulesOf(shellCss)
    .filter((rule) => rule.selectors.includes(selector))
    .map((rule) => new RegExp(`${property}:\\s*([^;]+);`).exec(rule.body))
    .filter((match) => match !== null)
    .map((match) => match[1].trim());
  expect(values).toHaveLength(1);
  return values[0];
}

function seconds(duration: string): number {
  const match = /^([\d.]+)s$/.exec(duration);
  if (match === null) throw new Error(`not a duration in seconds: ${duration}`);
  return Number(match[1]);
}

function pathOf(status: AgentStatus): string {
  const { container } = render(<StatusMark status={status} />);
  const path = container.querySelector("path");
  expect(path).not.toBeNull();
  return path?.getAttribute("d") ?? "";
}

describe("the Agent status mark", () => {
  afterEach(cleanup);

  it("names every status for a reader and for hover", () => {
    for (const status of STATUSES) {
      cleanup();
      render(<StatusMark status={status} />);
      const mark = screen.getByRole("img");
      const label = {
        working: "Working",
        background: "Background",
        waiting: "Waiting",
        idle: "Idle",
        error: "Error",
        unknown: "Unknown",
      }[status];
      expect(mark).toHaveAccessibleName(label);
      expect(mark).toHaveAttribute("data-tooltip", label);
    }
  });

  it("draws a different shape for each status, so colour is never the only telling", () => {
    const shapes = new Set<string>();
    for (const status of STATUSES) {
      cleanup();
      shapes.add(pathOf(status));
    }
    expect(shapes.size).toBe(STATUSES.length);
  });

  it("carries the status on the element, so the stylesheet colours it in one place", () => {
    for (const status of STATUSES) {
      cleanup();
      render(<StatusMark status={status} />);
      expect(screen.getByRole("img")).toHaveAttribute("data-status", status);
      expect(screen.getByRole("img")).toHaveClass(`status-mark-${status}`);
    }
  });

  it("draws every status on the Sidebar's own grid, so the column is one column", () => {
    // The marks used to be codicon outlines on a 16-unit box, next to stroked
    // 14-unit glyphs, next to filled Octicons — three conventions inside two
    // hundred pixels, which is what made the column unreadable. There is one
    // convention now and it is `sidebar-glyph`; a mark that stopped carrying
    // it would be a mark drawing itself its own way again.
    for (const status of STATUSES) {
      cleanup();
      const { container } = render(<StatusMark status={status} />);
      const svg = container.querySelector("svg");
      expect(svg).toHaveClass("sidebar-glyph");
      expect(svg).toHaveClass("status-glyph");
      expect(svg).toHaveAttribute("viewBox", "0 0 16 16");
    }
  });

  it("keeps the unread dot's silhouette to the unread dot", () => {
    // `waiting` was a filled disc and the unread mark in the same row's rail
    // is a filled disc, sixteen pixels apart in the same blue: one drawing,
    // two meanings, on one row. Whatever `waiting` becomes, it is not a disc.
    cleanup();
    const { container } = render(<StatusMark status="waiting" />);
    expect(container.querySelector("circle")).toBeNull();
  });

  it("turns the two statuses in which something is still going, on one spin at two paces", () => {
    // Working and background both mean something is still running, so both
    // turn — and by one definition, so the two can never drift into two
    // different motions. They stay apart by pace: background is what the
    // turn left running, and goes round at well under half working's speed.
    expect(shellCss.match(/@keyframes\s+status-spin\b/g)).toHaveLength(1);
    const spinning = rulesOf(shellCss).filter((rule) =>
      /animation:[^;]*\bstatus-spin\b/.test(rule.body),
    );
    expect(spinning).toHaveLength(1);
    expect(spinning[0].selectors).toEqual([
      ".status-mark-working .status-glyph",
      ".status-mark-background .status-glyph",
    ]);
    expect(spinning[0].body).toMatch(
      /animation:\s*status-spin var\(--status-spin-period\) linear infinite;/,
    );

    const working = seconds(
      declaredOn(".status-mark-working", "--status-spin-period"),
    );
    const background = seconds(
      declaredOn(".status-mark-background", "--status-spin-period"),
    );
    expect(background).toBeGreaterThanOrEqual(working * 2);
  });

  it("holds both spinning marks still for a reader who asked for less motion", () => {
    const reduced = rulesUnder(shellCss, "(prefers-reduced-motion: reduce)");
    for (const status of ["working", "background"]) {
      const rule = reduced.find((candidate) =>
        candidate.selectors.includes(`.status-mark-${status} .status-glyph`),
      );
      expect(rule?.body).toMatch(/animation:\s*none;/);
    }
  });
});
