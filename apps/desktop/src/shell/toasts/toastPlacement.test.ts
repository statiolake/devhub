/**
 * Where the notice stack is drawn, asserted against the stylesheet itself.
 *
 * jsdom computes no layout, so what is pinned here is the decision rather than
 * the result. The decision has two parts and they are about two different
 * things.
 *
 * The stack is **out of the flow and sized by its content**. That is not a
 * layout preference: main sizes this page's view to what the page measures, so
 * a stack measured inside the rectangle it caused would be a function of its
 * own last answer, and it would ratchet itself narrower one notice at a time.
 *
 * And it is **anchored to nothing**. The two placements this replaces both had
 * a limit written into the sheet — in the flow meant the workbench reflowed on
 * every arrival, over the Sidebar's column meant the workbench painted over
 * the overhang whenever the Sidebar was collapsed or dragged narrow. Both
 * limits came from the stack being inside a page that a native view is laid
 * over. It is its own page now, so there is nothing to stay inside, and the
 * assertion is that no rule here mentions the Sidebar at all.
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
  const toast = read("../styles/toast.css");

  it("is out of the flow, so nothing moves when a notice comes or goes", () => {
    const stack = rule(toast, ".toast-stack");
    expect(stack).toContain("position: absolute");
    expect(stack).toContain("top: 0");
    expect(stack).toContain("left: 0");
  });

  it("is sized by what it says, so the measurement is of the notices", () => {
    expect(rule(toast, ".toast-stack")).toContain("width: max-content");
  });

  it("is anchored to nothing in the App Shell page, because it is not in it", () => {
    expect(toast).not.toContain("--sidebar-width");
    expect(toast).not.toContain(".sidebar");
  });

  it("is drawn on its own page and on no other", () => {
    expect(read("../AppShell.tsx")).not.toContain("<Toasts");
    expect(read("../components/shell/SurfaceViewport.tsx")).not.toContain(
      "<Toasts",
    );
    expect(read("./ToastsApp.tsx")).toContain("<ToastStack");
  });
});
