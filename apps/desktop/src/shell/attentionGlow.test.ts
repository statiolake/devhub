/**
 * The window's own way of saying "over here".
 *
 * An Agent that has said something the person has not read lights the whole
 * window frame, not a banner. The affordance is only worth having if it is
 * seen from across a desk: a hairline that merely tinted the frame was the bug
 * this test exists to keep fixed. So the shape of the rule is the assertion —
 * a thick inset edge, a halo of the same blue spilling inward behind it, and a
 * peak bright enough to be unmistakable — and both alphas come from tokens
 * named once, so neither theme can drift from the other.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Vitest runs from the package root, and the stylesheets are files, not
// modules a test can import.
const shell = readFileSync("src/shell/styles/shell.css", "utf8");
const tokens = readFileSync("src/shell/styles/tokens.css", "utf8");

describe("the attention glow", () => {
  it("names its alphas once, in the waiting blue both themes already carry", () => {
    expect(tokens).toContain(
      "--attention-halo: color-mix(in srgb, var(--status-waiting) 35%, transparent);",
    );
    expect(tokens).toContain("--attention-peak: 0.9;");
  });

  it("draws a thick edge and a halo behind it, over the workbench view", () => {
    expect(shell).toContain(`.attention-glow {
  position: fixed;
  inset: 0;
  z-index: 40;
  pointer-events: none;
  border-radius: inherit;
  opacity: 0;
  box-shadow:
    inset 0 0 0 3.5px var(--status-waiting),
    inset 0 0 24px var(--attention-halo);
}`);
  });

  it("breathes up to the peak, over the same 2.4 seconds", () => {
    expect(shell).toContain(
      `.app-shell[data-attention="true"] .attention-glow {
  animation: attention-breathe 2.4s ease-in-out infinite;
}`,
    );
    expect(shell).toContain(`@keyframes attention-breathe {
  0%,
  100% {
    opacity: 0.15;
  }
  50% {
    opacity: var(--attention-peak);
  }
}`);
  });

  it("holds just under the peak when motion is turned down", () => {
    // Reduce Motion takes away the pulse, never the message.
    expect(shell).toContain("opacity: calc(var(--attention-peak) - 0.2);");
  });
});
