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
    refocus: () => undefined,
    ride: () => undefined,
    over: () => document.body,
    bridge: { openExternalUrl },
  } satisfies LayerHost;
  return { host, lua, request, openExternalUrl };
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
