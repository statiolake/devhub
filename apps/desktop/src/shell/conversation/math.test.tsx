// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { fakeActions } from "./surfaceTestKit";
import { ConversationActionsProvider } from "./ConversationContext";
import { Markdown } from "./Markdown";
import { normalizeMath } from "./mathDelimiters";

afterEach(cleanup);

function html(source: string, streaming = false): HTMLElement {
  const { container } = render(
    <ConversationActionsProvider value={fakeActions()}>
      <Markdown source={source} streaming={streaming} />
    </ConversationActionsProvider>,
  );
  return container;
}

describe("normalizeMath", () => {
  it("leaves currency as text", () => {
    expect(normalizeMath("$5 and $10")).toBe("\\$5 and \\$10");
  });
  it("keeps real inline math", () => {
    expect(normalizeMath("let $x$ be")).toBe("let $x$ be");
  });
  it("converts bracket delimiters", () => {
    expect(normalizeMath("a \\(x+1\\) b")).toBe("a $x+1$ b");
    expect(normalizeMath("\\[ x^2 \\]")).toBe("$$\nx^2\n$$");
  });
  it("leaves code alone", () => {
    expect(normalizeMath("`$a$ \\(b\\)`")).toBe("`$a$ \\(b\\)`");
    expect(normalizeMath("```\n$5 \\(x\\)\n```")).toBe("```\n$5 \\(x\\)\n```");
  });
});

describe("math rendering", () => {
  it("renders every delimiter", () => {
    for (const src of [
      "$x^2$",
      "$$x^2$$",
      "\\(x^2\\)",
      "\\[x^2\\]",
      "```math\nx^2\n```",
    ]) {
      expect(html(src).querySelector(".katex")).not.toBeNull();
      cleanup();
    }
  });
  it("draws display math as a block", () => {
    expect(html("$$x^2$$").querySelector(".katex-display")).not.toBeNull();
  });
  it("does not typeset currency or code", () => {
    expect(html("costs $5 and $10 total").querySelector(".katex")).toBeNull();
    cleanup();
    expect(
      html("`$a$` and\n\n```\n$b$\n```").querySelector(".katex"),
    ).toBeNull();
  });
  it("shows the source of a formula that does not parse", () => {
    const c = html("$\\frac{1$", true);
    expect(c.textContent).toContain("\\frac");
  });
});
