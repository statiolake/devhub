/**
 * Where the notice stack is drawn, asserted against the stylesheet itself.
 *
 * A notice that takes layout room reflows the workbench every time it arrives
 * and every time it goes, which is what the owner saw as the window shaking.
 * jsdom computes no layout, so the thing to pin is the decision: the stack is
 * taken out of the flow, and it is anchored over the Sidebar's column rather
 * than inside the Surface — the pane whose rectangle main mirrors with a
 * native view.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(
    fileURLToPath(new URL(relative, import.meta.url)),
    "utf8",
  );
}

/** The declarations of one rule, as written. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `${selector} is in the sheet`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("}", start));
}

describe("the notice stack's placement", () => {
  const toast = read("./styles/toast.css");

  it("is out of the flow, so nothing moves when a notice comes or goes", () => {
    const stack = rule(toast, ".toast-stack");
    expect(stack).toContain("position: absolute");
    expect(stack).toContain("bottom: 0");
    expect(stack).toContain("left: 0");
  });

  it("is no wider than the Sidebar's column asks for, with a readable floor", () => {
    expect(rule(toast, ".toast-stack")).toContain("var(--sidebar-width)");
  });

  it("leaves the panes alone: the workbench hole is not sized around it", () => {
    const shell = read("./styles/shell.css");
    // The layer is over `.app-shell-content`, which is why it needs a
    // positioning context there and why `.surface-panes` needs nothing.
    expect(rule(shell, ".app-shell-content")).toContain("position: relative");
    expect(rule(shell, ".surface-panes")).not.toContain("toast");
  });

  it("is not drawn inside the Surface, which a native view paints over", () => {
    const surface = read("./components/shell/SurfaceViewport.tsx");
    expect(surface).not.toContain("<Toasts");
    expect(read("./AppShell.tsx")).toContain("<Toasts />");
  });
});
