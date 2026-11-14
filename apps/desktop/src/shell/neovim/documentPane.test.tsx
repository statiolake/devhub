// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DocumentPane, { fileOf } from "./DocumentPane";
import type {
  DocumentActivation,
  DocumentContent,
  DocumentPlace,
  DocumentScroll,
} from "./documents";
import type { LayerHost } from "./LayerViews";

class Resize {
  observe() {}
  disconnect() {}
}
class Intersect {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe() {
    this.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  disconnect() {}
}

beforeEach(() => {
  globalThis.ResizeObserver = Resize as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver =
    Intersect as unknown as typeof IntersectionObserver;
});
afterEach(cleanup);

const SOURCE = [
  "# Notes", // 1
  "", // 2
  "See [the plan](plan.md#L4) and [the site](https://example.com).", // 3
  "", // 4
  "| a | b |", // 5
  "| - | - |", // 6
  "| 1 | 2 |", // 7
  "", // 8
  "- [x] done", // 9
  "- [ ] open", // 10
  "", // 11
  "```ts", // 12
  "const x = 1;", // 13
  "```", // 14
  "", // 15
  "![dot](img/dot.png)", // 16
  "", // 17
  "Inline ![far](https://example.com/far.png) picture and $e^{i\\pi}$.", // 18
  "", // 19
  "Back to [the top](#notes).", // 20
].join("\n");

function fakeHost() {
  const lua = vi.fn();
  const request = vi.fn((fn: string, args: readonly unknown[]) => {
    if (fn === "_document_resolve") {
      const paths = args[2] as string[];
      return Promise.resolve(
        paths.map((p) =>
          p === "img/dot.png" || p === "plan.md" ? `/notes/${p}` : null,
        ),
      );
    }
    if (fn === "_document_read")
      return Promise.resolve({
        media_type: "image/png",
        base64: "iVBORw==",
        signature: "1",
      });
    if (fn === "_document_signature") return Promise.resolve("1");
    return Promise.resolve(null);
  });
  const openExternalUrl = vi.fn(() => Promise.resolve());
  const copyText = vi.fn((_text: string) => Promise.resolve());
  const showContextMenu = vi.fn(() =>
    Promise.resolve<string | undefined>("copy"),
  );
  const refocus = vi.fn();
  const host = {
    cell: { width: 8, height: 16 },
    boxes: [],
    laidOut: () => undefined,
    caret: undefined,
    mono: "monospace",
    fontSize: 13,
    defaults: { foreground: 0xdddddd, background: 0x1e1e1e },
    lua,
    request,
    openLink: () => undefined,
    refocus,
    ride: () => undefined,
    over: () => document.body,
    bridge: { openExternalUrl, copyText, showContextMenu },
  } satisfies LayerHost;
  return {
    host,
    lua,
    request,
    openExternalUrl,
    copyText,
    showContextMenu,
    refocus,
  };
}

const PLACE: DocumentPlace = {
  id: 3,
  win: 1001,
  topline: 1,
  current: false,
  told: false,
  focus: undefined,
};

function content(remoteImages = false): DocumentContent {
  return {
    id: 3,
    format: "markdown",
    text: SOURCE,
    base: "/notes",
    remoteImages,
    title: "notes.md",
  };
}

function draw(
  host: LayerHost,
  options: {
    remote?: boolean;
    place?: DocumentPlace;
    activation?: DocumentActivation;
  } = {},
) {
  return render(
    <DocumentPane
      content={content(options.remote)}
      place={options.place ?? PLACE}
      scroll={undefined}
      activation={options.activation}
      host={host}
      width={600}
      height={400}
    />,
  );
}

describe("a document DevHub draws over a Neovim window", () => {
  it("is drawn by the conversation's renderer, each block tagged with its source line", async () => {
    const { host } = fakeHost();
    const { container } = draw(host);
    expect(screen.getByRole("heading", { name: "Notes" })).toHaveAttribute(
      "data-source-line",
      "1",
    );
    const lines = [...container.querySelectorAll("[data-source-line]")].map(
      (el) =>
        `${el.tagName.toLowerCase()}:${el.getAttribute("data-source-line") ?? ""}`,
    );
    expect(lines).toEqual(
      expect.arrayContaining([
        "h1:1",
        "p:3",
        "div:5",
        "tr:5",
        "tr:7",
        "ul:9",
        "li:10",
        "div:12",
        "div:16",
        "p:18",
      ]),
    );
    // GFM: a table, a task list; math typeset; the code is a code block.
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container.querySelector(".conversation-typeset")).not.toBeNull();
    // A picture beside it is read on the Neovim's machine, relative to the
    // document's folder.
    const image = await screen.findByRole("img", { name: "dot" });
    expect(image.getAttribute("src")).toBe("data:image/png;base64,iVBORw==");
  });

  it("reads pictures through Neovim, and draws none from the web unless asked", async () => {
    const { host, request } = fakeHost();
    draw(host);
    await screen.findByRole("img", { name: "dot" });
    expect(request).toHaveBeenCalledWith("_document_resolve", [
      3,
      "/notes",
      expect.arrayContaining(["img/dot.png"]),
    ]);
    expect(request).toHaveBeenCalledWith("_document_read", [
      3,
      "/notes/img/dot.png",
    ]);
    expect(
      screen.getByText(/far \(not loaded: example\.com\)/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "far" })).toBeNull();
    cleanup();
    draw(fakeHost().host, { remote: true });
    expect(screen.getByRole("img", { name: "far" })).toHaveAttribute(
      "src",
      "https://example.com/far.png",
    );
  });

  it("opens a file link in Neovim, a URL in the browser, an anchor in itself", async () => {
    const { host, lua, openExternalUrl } = fakeHost();
    draw(host);
    fireEvent.click(screen.getByRole("link", { name: "the plan" }));
    await waitFor(() => {
      expect(lua).toHaveBeenCalledWith("_document_open", [
        3,
        "/notes/plan.md",
        4,
        1,
      ]);
    });
    fireEvent.click(screen.getByRole("link", { name: "the site" }));
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com");
    openExternalUrl.mockClear();
    fireEvent.click(screen.getByRole("link", { name: "the top" }));
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("rings the link the keys are on, and follows it when they say so", () => {
    const { host, openExternalUrl } = fakeHost();
    const focus = { line: 3, href: "https://example.com" };
    const { rerender } = draw(host, { place: { ...PLACE, focus } });
    expect(screen.getByRole("link", { name: "the site" })).toHaveAttribute(
      "data-document-focus",
    );
    rerender(
      <DocumentPane
        content={content()}
        place={{ ...PLACE, focus }}
        scroll={undefined}
        activation={{ seq: 1, line: 3, href: "https://example.com" }}
        host={host}
        width={600}
        height={400}
      />,
    );
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com");
  });

  it("takes a file Lua read as bytes", () => {
    expect(
      fileOf({ media_type: "image/png", base64: "iVBORw==", signature: "s" }),
    ).toEqual({
      mediaType: "image/png",
      bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
      signature: "s",
    });
    expect(fileOf(null)).toBeNull();
  });
});

/**
 * A layout for jsdom, which has none: each block's top by its source line —
 * uneven, as a table, a code block and a picture make it — in a scroller
 * 400 px tall over a drawing 1400 px tall, its `scrollTop` kept.
 */
const TOPS: Record<number, number> = {
  1: 0,
  3: 60,
  5: 140,
  7: 190,
  9: 260,
  10: 290,
  12: 330,
  16: 560,
  18: 900,
  20: 960,
};
function withLayout() {
  const tops = new WeakMap<Element, number>();
  const scroller = (el: Element) =>
    el.classList.contains("nvim-document-scroll");
  const restore: (() => void)[] = [];
  const define = (
    name: string,
    get: (this: HTMLElement) => number,
    set?: (this: HTMLElement, v: number) => void,
  ) => {
    const was = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get,
      set,
    });
    restore.push(() => {
      if (was) Object.defineProperty(HTMLElement.prototype, name, was);
      else
        delete (HTMLElement.prototype as unknown as Record<string, unknown>)[
          name
        ];
    });
  };
  define("clientHeight", function () {
    return scroller(this) ? 400 : 0;
  });
  define("scrollHeight", function () {
    return scroller(this) ? 1400 : 0;
  });
  define(
    "scrollTop",
    function () {
      return tops.get(this) ?? 0;
    },
    function (v) {
      tops.set(this, Math.max(0, Math.min(1000, v)));
    },
  );
  const rect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      const box = this.closest(".nvim-document-scroll");
      const line = Number(this.dataset["sourceLine"]);
      const top =
        (TOPS[line] ?? 0) - (box ? ((box as HTMLElement).scrollTop ?? 0) : 0);
      return {
        top: scroller(this) ? 0 : top,
        bottom: scroller(this) ? 400 : top + 20,
        left: 0,
        right: 600,
        width: 600,
        height: 20,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    });
  restore.push(() => rect.mockRestore());
  // Reduce Motion: each move lands at once, as a frame's would at its end.
  const media = window.matchMedia;
  window.matchMedia = ((q: string) => ({
    matches: q.includes("reduce"),
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  restore.push(() => {
    window.matchMedia = media;
  });
  return () => {
    for (const undo of restore.reverse()) undo();
  };
}

function views(lua: ReturnType<typeof vi.fn>) {
  return lua.mock.calls
    .filter((c) => c[0] === "_document_view")
    .map((c) => c[1] as unknown[]);
}

describe("a document's scroll, kept with its source", () => {
  it("says the person's scrolls as theirs, and the ones it followed as followed, by the drawing's geometry", () => {
    const undo = withLayout();
    try {
      const { host, lua } = fakeHost();
      const { container, rerender } = draw(host);
      const el = container.querySelector<HTMLElement>(".nvim-document-scroll")!;
      // Drawn: where it starts is no scroll of the person's.
      expect(views(lua).every((v) => v[3] === true)).toBe(true);
      const again = (scroll?: DocumentScroll, place?: DocumentPlace) => {
        rerender(
          <DocumentPane
            content={content()}
            place={place ?? PLACE}
            scroll={scroll}
            activation={undefined}
            host={host}
            width={600}
            height={400}
          />,
        );
      };
      // The source's top (:scroll_to): line 12 is where the code block is
      // drawn, past a tall table — followed.
      again({ seq: 1, by: "to", n: 1, line: 12 });
      expect(el.scrollTop).toBe(330);
      expect(views(lua).at(-1)).toEqual([3, 12, 16, true]);
      // The wheel: the person's, pixel for pixel; the line it shows is told
      // as theirs, a fraction into the code block.
      lua.mockClear();
      fireEvent.wheel(el, { deltaY: 100, deltaMode: 0 });
      expect(el.scrollTop).toBe(430);
      expect(views(lua).at(-1)).toEqual([3, 13, 17, false]);
      // The source said back the line it was told: nothing moves (no
      // snap to the line's top, no loop).
      lua.mockClear();
      again({ seq: 2, by: "to", n: 1, line: 13 });
      expect(el.scrollTop).toBe(430);
      expect(views(lua)).toEqual([]);
      // Neovim's top the page itself said: not followed. One Neovim moved
      // (a search in its window): followed, and told as the person's.
      again(undefined, { ...PLACE, topline: 16, told: true });
      expect(el.scrollTop).toBe(430);
      again(undefined, { ...PLACE, topline: 18, told: false });
      expect(el.scrollTop).toBe(900);
      expect(views(lua).at(-1)).toEqual([3, 18, 20, false]);
      // A key in its window: the person's.
      again({ seq: 3, by: "top", n: 1, line: undefined });
      expect(el.scrollTop).toBe(0);
      expect(views(lua).at(-1)).toEqual([3, 1, 13, false]);
    } finally {
      undo();
    }
  });
});

describe("a document's text, selected with the mouse", () => {
  function select(node: Node, from: number, to: number) {
    const range = document.createRange();
    range.setStart(node, from);
    range.setEnd(node, to);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }
  const textOf = (name: string) =>
    screen.getByRole("heading", { name }).firstChild!;

  it("copies the selection with ⌘C, the Edit menu and its right-click menu, and lets it go on Esc", async () => {
    const { host, copyText, showContextMenu, refocus } = fakeHost();
    const { container } = draw(host);
    const el = container.querySelector<HTMLElement>(".nvim-document-scroll")!;
    select(textOf("Notes"), 0, 4);
    fireEvent.mouseUp(el, { button: 0 });
    // A selection keeps the keyboard here (Neovim's field would drop it).
    expect(document.activeElement).toBe(el);
    expect(refocus).not.toHaveBeenCalled();
    // (jsdom's focus drops a selection, Chromium's does not.)
    select(textOf("Notes"), 0, 4);
    fireEvent.keyDown(el, { key: "c", metaKey: true });
    expect(copyText).toHaveBeenLastCalledWith("Note");
    fireEvent.copy(el);
    expect(copyText).toHaveBeenCalledTimes(2);
    fireEvent.contextMenu(el, { clientX: 20, clientY: 30 });
    expect(showContextMenu).toHaveBeenCalledWith({
      items: [{ id: "copy", label: "Copy" }],
      at: { x: 20, y: 30 },
    });
    await waitFor(() => {
      expect(copyText).toHaveBeenCalledTimes(3);
    });
    fireEvent.keyDown(el, { key: "Escape" });
    expect(window.getSelection()!.isCollapsed).toBe(true);
    expect(refocus).toHaveBeenCalled();
    // Nothing selected: the keyboard goes back at once, ⌘C copies nothing.
    fireEvent.mouseUp(el, { button: 0 });
    expect(refocus).toHaveBeenCalledTimes(2);
  });

  it("lets the selection go on a click elsewhere, or on a key that is Neovim's", () => {
    const { host, refocus } = fakeHost();
    const { container } = draw(host);
    const el = container.querySelector<HTMLElement>(".nvim-document-scroll")!;
    select(textOf("Notes"), 0, 4);
    fireEvent.mouseDown(document.body);
    expect(window.getSelection()!.isCollapsed).toBe(true);
    select(textOf("Notes"), 0, 4);
    fireEvent.keyDown(el, { key: "j" });
    expect(window.getSelection()!.isCollapsed).toBe(true);
    expect(refocus).toHaveBeenCalled();
  });

  it("follows a link on a click, not on the click that ends a drag", () => {
    const { host, openExternalUrl, lua } = fakeHost();
    draw(host);
    const link = screen.getByRole("link", { name: "the site" });
    fireEvent.mouseDown(link, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.click(link, { button: 0, clientX: 80, clientY: 14 });
    expect(openExternalUrl).not.toHaveBeenCalled();
    fireEvent.mouseDown(link, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.click(link, { button: 0, clientX: 11, clientY: 10 });
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com");
    // A press makes its window Neovim's current one; the mouse is never
    // Neovim's here.
    expect(lua).toHaveBeenCalledWith("_document_focus", [3]);
  });

  it("takes an Alt-click to its place in the source, not to the link", () => {
    const { host, openExternalUrl, lua } = fakeHost();
    const { container } = draw(host);
    const link = screen.getByRole("link", { name: "the site" });
    const text = link.firstChild!;
    const doc = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range;
    };
    const at = (node: Node, offset: number) => {
      doc.caretRangeFromPoint = () => {
        const range = document.createRange();
        range.setStart(node, offset);
        return range;
      };
    };
    try {
      at(text, 6); // the si|te
      fireEvent.mouseDown(link, { button: 0, altKey: true });
      fireEvent.click(link, { button: 0, altKey: true });
      expect(openExternalUrl).not.toHaveBeenCalled();
      const line3 = SOURCE.split("\n")[2]!;
      expect(lua).toHaveBeenLastCalledWith("_document_source_click", [
        3,
        3,
        line3.indexOf("site") + 2,
      ]);
      // In code: past its fence, the column as drawn.
      const code = container.querySelector("pre code")!;
      const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
      const first = walker.nextNode()!;
      at(first, Math.min(3, first.textContent!.length));
      fireEvent.mouseDown(code, { button: 0, altKey: true });
      fireEvent.click(code, { button: 0, altKey: true });
      expect(lua).toHaveBeenLastCalledWith("_document_source_click", [
        3,
        13,
        Math.min(3, first.textContent!.length),
      ]);
    } finally {
      Reflect.deleteProperty(document, "caretRangeFromPoint");
    }
  });
});
