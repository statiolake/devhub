// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationActionsProvider } from "./ConversationContext";
import type { ConversationActions } from "./ConversationContext";
import {
  MAX_SVG_SOURCE,
  diagramKindOf,
  errorLine,
  prepareSvg,
  svgDataUrl,
} from "./diagramSvg";
import { rasterScale } from "./diagramCopy";
import {
  COPY_THEME,
  mixHex,
  parseCssColor,
  resolveDiagramTheme,
} from "./diagramTheme";
import { DIAGRAM_MENU } from "./Diagram";
import { Markdown } from "./Markdown";
import { fakeActions } from "./surfaceTestKit";

const mermaid = vi.hoisted(() => ({
  render: vi.fn(),
}));

vi.mock("./mermaid", () => ({
  drawnMermaid: () => undefined,
  renderMermaid: (source: string, theme: unknown) =>
    mermaid.render(source, theme),
}));

const png = vi.hoisted(() => ({ svgToPng: vi.fn() }));
vi.mock("./diagramCopy", async (original) => ({
  ...(await original<typeof import("./diagramCopy")>()),
  svgToPng: (...args: unknown[]) => png.svgToPng(...args),
}));

const PICTURE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20"/></svg>';
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

beforeEach(() => {
  mermaid.render.mockReset();
  mermaid.render.mockImplementation((source: string) =>
    Promise.resolve(
      source.includes("bad")
        ? { ok: false, error: "Parse error on line 1: bad" }
        : prepareSvg(PICTURE),
    ),
  );
  png.svgToPng.mockReset();
  png.svgToPng.mockResolvedValue(PNG_BYTES);
});

afterEach(cleanup);

function draw(
  source: string,
  streaming = false,
  actions: ConversationActions = fakeActions(),
) {
  const view = render(
    <ConversationActionsProvider value={actions}>
      <Markdown source={source} streaming={streaming} />
    </ConversationActionsProvider>,
  );
  return { ...view, actions };
}

const FLOW = "```mermaid\ngraph TD\n  A --> B\n```\n";

describe("which blocks are pictures", () => {
  it("knows a mermaid block, and an svg block", () => {
    expect(diagramKindOf("mermaid", "graph TD")).toBe("mermaid");
    expect(diagramKindOf("Mermaid title", "graph TD")).toBe("mermaid");
    expect(diagramKindOf("svg", PICTURE)).toBe("svg");
  });

  it("takes an xml block only when it is one <svg>", () => {
    expect(diagramKindOf("xml", `<?xml version="1.0"?>\n${PICTURE}`)).toBe(
      "svg",
    );
    expect(diagramKindOf("xml", "<!-- a -->\n" + PICTURE)).toBe("svg");
    expect(diagramKindOf("xml", "<project><svg/></project>")).toBeUndefined();
    expect(diagramKindOf("xml", `${PICTURE}<other/>`)).toBeUndefined();
  });

  it("leaves code, an empty mermaid block and other languages alone", () => {
    expect(diagramKindOf("ts", "const a = 1")).toBeUndefined();
    expect(diagramKindOf(undefined, PICTURE)).toBeUndefined();
    expect(diagramKindOf("html", PICTURE)).toBeUndefined();
    expect(diagramKindOf("mermaid", "  \n")).toBeUndefined();
  });
});

describe("an SVG prepared to be drawn", () => {
  it("leaves Mermaid's picture at its own size, not its page's", () => {
    const result = prepareSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" width="100%" style="max-width: 300px" viewBox="0 0 300 100"><g/></svg>`,
      { fromMermaid: true },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.svg).not.toContain("max-width");
    expect(result.svg).toContain('width="300"');
    expect(result.size).toEqual({ width: 300, height: 100 });
  });

  it("sizes a picture by its own size, else its viewBox", () => {
    const size = (markup: string) => {
      const result = prepareSvg(markup);
      return result.ok ? result.size : undefined;
    };
    const ns = 'xmlns="http://www.w3.org/2000/svg"';
    expect(size(`<svg ${ns} width="120" height="40px"/>`)).toEqual({
      width: 120,
      height: 40,
    });
    expect(size(`<svg ${ns} viewBox="0 0 50 25"/>`)).toEqual({
      width: 50,
      height: 25,
    });
    expect(size(`<svg ${ns} width="100" viewBox="0 0 50 25"/>`)).toEqual({
      width: 100,
      height: 50,
    });
    expect(size(`<svg ${ns} width="100%" viewBox="0 0 10000 100"/>`)).toEqual({
      width: 4096,
      height: 41,
    });
    expect(size(`<svg ${ns}/>`)).toEqual({ width: 300, height: 150 });
  });

  it("takes an <svg> written for a page, without its namespace", () => {
    const result = prepareSvg('<svg viewBox="0 0 4 2"><rect width="4"/></svg>');
    expect(result.ok).toBe(true);
    expect(result.ok && result.svg).toContain("<rect");
  });

  it("writes the theme's ink as currentColor, unless the picture says", () => {
    const ns = 'xmlns="http://www.w3.org/2000/svg"';
    const own = prepareSvg(`<svg ${ns} color="red"/>`, { color: "#fff" });
    const none = prepareSvg(`<svg ${ns}/>`, { color: "#ffffff" });
    expect(own.ok && own.svg).toContain('color="red"');
    expect(none.ok && none.svg).toContain('color="#ffffff"');
  });

  it("says why markup is not a picture", () => {
    const fail = (markup: string) => {
      const result = prepareSvg(markup);
      return result.ok ? undefined : result.error;
    };
    expect(fail("<svg xmlns='http://www.w3.org/2000/svg'><g></svg>")).toMatch(
      /does not parse/,
    );
    expect(fail('<svg xmlns="urn:other"><rect/></svg>')).toMatch(/xmlns/);
    expect(fail("<html xmlns='http://www.w3.org/1999/xhtml'/>")).toMatch(
      /not one <svg>/,
    );
    expect(fail(`<svg>${" ".repeat(MAX_SVG_SOURCE)}</svg>`)).toMatch(
      /too large/,
    );
  });

  it("says a Mermaid parse error on one line", () => {
    expect(
      errorLine(
        new Error(
          "Parse error on line 3:\n...A -->\n-----^\nExpecting 'NODE', got 'EOF'",
        ),
      ),
    ).toBe("Parse error on line 3: Expecting 'NODE', got 'EOF'");
    expect(errorLine("plain")).toBe("plain");
  });

  it("is drawn from a data URL, so nothing is fetched", () => {
    expect(svgDataUrl("<svg/>")).toBe(
      "data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E",
    );
  });
});

describe("the theme a diagram is drawn in", () => {
  it("reads colours the way the page computes them", () => {
    expect(parseCssColor("rgb(30, 30, 30)")).toEqual({
      r: 30,
      g: 30,
      b: 30,
      a: 1,
    });
    expect(parseCssColor("rgba(0, 0, 0, 0.85)")?.a).toBe(0.85);
    expect(parseCssColor("color(srgb 1 0.5 0 / 0.5)")).toEqual({
      r: 255,
      g: 127.5,
      b: 0,
      a: 0.5,
    });
    expect(parseCssColor("#abc")).toEqual({ r: 170, g: 187, b: 204, a: 1 });
    expect(parseCssColor("light-dark(#fff, #000)")).toBeUndefined();
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
  });

  it("falls back to the scheme's colours when the tokens are not there", () => {
    const theme = resolveDiagramTheme();
    expect(theme.scheme).toBe("light");
    expect(theme.background).toMatch(/^#[0-9a-f]{6}$/);
    expect(theme.ink).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("rasterises at twice the size, or the screen's ratio, within the canvas", () => {
    expect(rasterScale({ width: 100, height: 50 }, 1)).toBe(2);
    expect(rasterScale({ width: 100, height: 50 }, 3)).toBe(3);
    expect(rasterScale({ width: 8192 - 32, height: 10 }, 2)).toBe(1);
  });
});

describe("a diagram in an answer", () => {
  it("is never markup in the page: a script in an SVG stays in its image", () => {
    draw(
      '```svg\n<svg xmlns="http://www.w3.org/2000/svg" onload="x()"><script>x()</script><rect width="4" height="2"/></svg>\n```\n',
    );
    const image = screen.getByRole("img", { name: "SVG image" });
    expect(image.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("[onload]")).toBeNull();
    expect(
      document.querySelector(".conversation-diagram-picture svg"),
    ).toBeNull();
  });

  it("draws a closed mermaid block as a picture, from a data URL", async () => {
    draw(`Here:\n\n${FLOW}`);
    const image = await screen.findByRole("img", { name: "Mermaid diagram" });
    expect(image.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(image).toHaveAttribute("width", "40");
    expect(mermaid.render).toHaveBeenCalledWith(
      "graph TD\n  A --> B",
      expect.objectContaining({ scheme: "light" }),
    );
    // Not as markup: the only svg in the page would be an icon.
    expect(
      document.querySelector(".conversation-diagram-picture svg"),
    ).toBeNull();
  });

  it("draws an svg block as an image at once", () => {
    draw("```svg\n" + PICTURE + "\n```\n");
    const image = screen.getByRole("img", { name: "SVG image" });
    expect(decodeURIComponent(image.getAttribute("src")!)).toContain("<rect");
  });

  it("is code while its fence is open, and a picture once it closes", async () => {
    const open = "```mermaid\ngraph TD\n  A --> B\n";
    const { rerender, actions } = draw(open, true);
    expect(screen.queryByRole("img")).toBeNull();
    expect(document.querySelector(".conversation-code pre")?.textContent).toBe(
      "graph TD\n  A --> B",
    );
    expect(mermaid.render).not.toHaveBeenCalled();
    rerender(
      <ConversationActionsProvider value={actions}>
        <Markdown source={`${open}\`\`\`\n\nMore`} streaming />
      </ConversationActionsProvider>,
    );
    expect(
      await screen.findByRole("img", { name: "Mermaid diagram" }),
    ).toBeInTheDocument();
  });

  it("shows its code until Mermaid has drawn it", () => {
    mermaid.render.mockReturnValue(new Promise(() => {}));
    draw(FLOW);
    expect(screen.queryByRole("img")).toBeNull();
    expect(document.querySelector(".conversation-code pre")?.textContent).toBe(
      "graph TD\n  A --> B",
    );
  });

  it("draws a source that will not draw as its code, with why", async () => {
    draw("```mermaid\nbad graph\n```\n");
    expect(
      await screen.findByText("Diagram not drawn: Parse error on line 1: bad"),
    ).toBeInTheDocument();
    expect(document.querySelector(".conversation-code pre")?.textContent).toBe(
      "bad graph",
    );
    cleanup();
    draw("```svg\n<svg xmlns='http://www.w3.org/2000/svg'><g></svg>\n```\n");
    expect(
      screen.getByText(/^SVG not drawn: The SVG does not parse/),
    ).toBeInTheDocument();
  });

  it("toggles between the picture and its source, by icon", async () => {
    draw(FLOW);
    await screen.findByRole("img");
    const show = screen.getByRole("button", { name: "Show source" });
    expect(show).toHaveAttribute("title", "Show source");
    expect(show.textContent).toBe("");
    fireEvent.click(show);
    expect(screen.queryByRole("img")).toBeNull();
    expect(document.querySelector(".conversation-code pre")?.textContent).toBe(
      "graph TD\n  A --> B",
    );
    // Its source's copy is the code's.
    expect(
      screen.getByRole("button", { name: "Copy code" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show diagram" }));
    expect(screen.getByRole("img")).toBeInTheDocument();
  });

  it("copies the picture as a transparent PNG through main, and says so", async () => {
    const { actions } = draw(FLOW);
    await screen.findByRole("img");
    const copy = screen.getByRole("button", { name: "Copy image" });
    await act(async () => {
      fireEvent.click(copy);
    });
    expect(png.svgToPng).toHaveBeenCalledWith(
      expect.stringContaining("<svg"),
      { width: 40, height: 20 },
      undefined,
    );
    expect(actions.writeClipboardImage).toHaveBeenCalledWith(PNG_BYTES);
    expect(actions.writeClipboard).not.toHaveBeenCalled();
    expect(copy).toHaveAttribute("title", "Copied");
  });

  it("copies a picture drawn for a light page, whatever the screen's theme", async () => {
    document.documentElement.style.colorScheme = "dark";
    try {
      draw(FLOW);
      await screen.findByRole("img");
      expect(mermaid.render).toHaveBeenLastCalledWith(
        "graph TD\n  A --> B",
        expect.objectContaining({ scheme: "dark" }),
      );
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Copy image" }));
      });
      expect(mermaid.render).toHaveBeenLastCalledWith(
        "graph TD\n  A --> B",
        COPY_THEME,
      );
      expect(COPY_THEME.scheme).toBe("light");
      // Dark ink, for a white or light ground.
      expect(parseCssColor(COPY_THEME.ink)!.r).toBeLessThan(64);
    } finally {
      document.documentElement.style.colorScheme = "";
    }
  });

  it("copies an SVG with currentColor as the copy's dark ink", async () => {
    draw("```svg\n<svg xmlns='http://www.w3.org/2000/svg'><g/></svg>\n```\n");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy image" }));
    });
    const [svg] = png.svgToPng.mock.calls[0]!;
    expect(svg).toContain(`color="${COPY_THEME.ink}"`);
  });

  it("does not say Copied when the picture could not be made", async () => {
    png.svgToPng.mockRejectedValue(new Error("no canvas"));
    const { actions } = draw(FLOW);
    await screen.findByRole("img");
    const copy = screen.getByRole("button", { name: "Copy image" });
    await act(async () => {
      fireEvent.click(copy);
    });
    expect(actions.reportFailure).toHaveBeenCalled();
    expect(copy).toHaveAttribute("title", "Copy image");
  });

  describe("a right-click on it", () => {
    async function choose(id: string | undefined) {
      const actions = fakeActions({
        showContextMenu: vi.fn(() => Promise.resolve(id)),
      });
      draw(FLOW, false, actions);
      const image = await screen.findByRole("img");
      await act(async () => {
        fireEvent.contextMenu(image, { clientX: 12, clientY: 34 });
      });
      return actions;
    }

    it("offers the picture on two grounds, and its source, at the click", async () => {
      const actions = await choose(undefined);
      expect(actions.showContextMenu).toHaveBeenCalledWith({
        items: [
          { id: "copy-image-transparent", label: "Copy Image (Transparent)" },
          { id: "copy-image-white", label: "Copy Image (White Background)" },
          { id: "copy-source", label: "Copy Source" },
        ],
        at: { x: 12, y: 34 },
      });
      expect(DIAGRAM_MENU).toHaveLength(3);
      expect(actions.writeClipboard).not.toHaveBeenCalled();
      expect(actions.writeClipboardImage).not.toHaveBeenCalled();
    });

    it("copies the image on a transparent ground", async () => {
      const actions = await choose("copy-image-transparent");
      await waitFor(() =>
        expect(actions.writeClipboardImage).toHaveBeenCalledWith(PNG_BYTES),
      );
      expect(png.svgToPng.mock.calls[0]![2]).toBeUndefined();
      expect(mermaid.render).toHaveBeenLastCalledWith(
        expect.any(String),
        COPY_THEME,
      );
    });

    it("copies the image on white", async () => {
      const actions = await choose("copy-image-white");
      await waitFor(() =>
        expect(actions.writeClipboardImage).toHaveBeenCalledWith(PNG_BYTES),
      );
      expect(png.svgToPng.mock.calls[0]![2]).toBe("#ffffff");
    });

    it("copies the mermaid source", async () => {
      const actions = await choose("copy-source");
      await waitFor(() =>
        expect(actions.writeClipboard).toHaveBeenCalledWith(
          "graph TD\n  A --> B",
        ),
      );
    });
  });

  it("leaves a code block's right-click to the page", () => {
    const { actions } = draw("```ts\nconst a = 1\n```\n");
    fireEvent.contextMenu(document.querySelector(".conversation-code pre")!);
    expect(actions.showContextMenu).not.toHaveBeenCalled();
  });
});
