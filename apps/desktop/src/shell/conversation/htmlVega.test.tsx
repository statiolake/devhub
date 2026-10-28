// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ConversationActionsProvider } from "./ConversationContext";
import { pictureForCopy } from "./Diagram";
import { COPY_THEME } from "./diagramTheme";
import { HTML_CSP, HTML_SANDBOX, htmlDocument } from "./HtmlPreview";
import { Markdown } from "./Markdown";
import { previewKindOfFence, previewKindOfFile } from "./previewKinds";
import { fakeActions } from "./surfaceTestKit";
import { parseSpec, renderVegaLite, vegaConfig } from "./vegaLite";

beforeAll(() => {
  // jsdom has no canvas; Vega measures text without one.
  HTMLCanvasElement.prototype.getContext = () => null;
});

afterEach(cleanup);

function draw(source: string) {
  return render(
    <ConversationActionsProvider value={fakeActions()}>
      <Markdown source={source} streaming={false} />
    </ConversationActionsProvider>,
  );
}

const PAGE =
  '<h1>Report</h1><img src="https://example.com/t.png"><script>parent.pwned = 1</script>';

describe("an html block", () => {
  it("is known by its fence and its file", () => {
    expect(previewKindOfFence("html", PAGE)?.id).toBe("html");
    expect(previewKindOfFile("out/report.htm", PAGE)?.id).toBe("html");
  });

  it("is a frame with no permission, under a policy that loads nothing", () => {
    const { container } = draw("```html\n" + PAGE + "\n```\n");
    const frame = container.querySelector("iframe")!;
    expect(frame).not.toBeNull();
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(HTML_SANDBOX).toBe("");
    expect(frame.getAttribute("csp")).toBe(HTML_CSP);
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("srcdoc")).toBe(htmlDocument(PAGE));
    // Nothing of the page is in this one.
    expect(container.querySelector("h1, script")).toBeNull();
    expect((window as { pwned?: number }).pwned).toBeUndefined();
  });

  it("puts the policy before anything the page says", () => {
    expect(HTML_CSP).toMatch(/^default-src 'none'/);
    expect(HTML_CSP).toMatch(/script-src 'none'/);
    expect(HTML_CSP).not.toMatch(/https?:|\*|'self'/);
    for (const page of [
      PAGE,
      "<!DOCTYPE html><html><head><link rel=stylesheet href=//x/y.css></head></html>",
      "<html><body>x</body></html>",
    ]) {
      const document = htmlDocument(page);
      const policy = document.indexOf("Content-Security-Policy");
      expect(policy).toBeGreaterThan(0);
      expect(policy).toBeLessThan(document.indexOf("<", policy + 60) + 1);
      expect(document.slice(0, policy)).not.toMatch(
        /<(?:link|img|script|style)/i,
      );
    }
    expect(htmlDocument("<!doctype html><p>a")).toMatch(
      /^<!doctype html><meta http-equiv="Content-Security-Policy"/,
    );
  });
});

const SPEC = JSON.stringify({
  data: {
    values: [
      { a: "x", b: 1 },
      { a: "y", b: 3 },
    ],
  },
  mark: "bar",
  encoding: {
    x: { field: "a", type: "nominal" },
    y: { field: "b", type: "quantitative" },
  },
});

describe("a vega-lite block", () => {
  it("is known by its fence and its file", () => {
    expect(previewKindOfFence("vega-lite", SPEC)?.id).toBe("vega-lite");
    expect(previewKindOfFence("vegalite", SPEC)?.id).toBe("vega-lite");
    expect(previewKindOfFile("charts/sales.vl.json", SPEC)?.id).toBe(
      "vega-lite",
    );
    expect(previewKindOfFile("sales.vega-lite.json", SPEC)?.id).toBe(
      "vega-lite",
    );
    expect(previewKindOfFile("package.json", SPEC)).toBeUndefined();
    expect(previewKindOfFile(".vl.json", SPEC)).toBeUndefined();
  });

  it("is drawn as an image of an SVG, in the theme's colours", async () => {
    draw("```vega-lite\n" + SPEC + "\n```\n");
    const chart = await screen.findByRole("img", { name: "Vega-Lite chart" });
    expect(chart.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(document.querySelector(".marks, canvas")).toBeNull();
  });

  it("loads nothing: data from a URL is refused, with why", async () => {
    const result = await renderVegaLite(
      JSON.stringify({
        data: { url: "https://example.com/d.csv" },
        mark: "point",
      }),
      COPY_THEME,
    );
    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/loads nothing: put the data in `values`/),
    });
  });

  it("says what is wrong with a spec that is not one", async () => {
    expect(parseSpec("{")).toMatchObject({ ok: false });
    expect(parseSpec("[1]")).toEqual({
      ok: false,
      error: "The spec is not a JSON object.",
    });
    draw("```vega-lite\nnot json\n```\n");
    expect(
      await screen.findByText(/Chart not drawn: The spec is not JSON/),
    ).toBeInTheDocument();
  });

  it("is copied in the light palette, whatever the screen's", async () => {
    const copy = await pictureForCopy("vega-lite", SPEC);
    expect(copy.svg).toContain(COPY_THEME.accent.toLowerCase());
    expect(vegaConfig(COPY_THEME)).toMatchObject({
      background: "transparent",
      mark: { color: COPY_THEME.accent },
    });
  });
});
