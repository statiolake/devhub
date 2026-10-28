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
import type { EmbedFileWire } from "../../ipc/conversation";
import { ConversationActionsProvider } from "./ConversationContext";
import type { ConversationActions } from "./ConversationContext";
import { EMBED_POLL_MS, isLocalSource } from "./FileEmbed";
import { Markdown } from "./Markdown";
import { fakeActions } from "./surfaceTestKit";

const SVG = (word: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><text>${word}</text></svg>`;

function file(text: string | Uint8Array, signature = "1"): EmbedFileWire {
  return {
    mediaType: "",
    bytes: typeof text === "string" ? new TextEncoder().encode(text) : text,
    signature,
  };
}

/** Every element is on screen: jsdom lays nothing out. */
class Observer {
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
  globalThis.IntersectionObserver =
    Observer as unknown as typeof IntersectionObserver;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function draw(source: string, actions: ConversationActions) {
  return render(
    <ConversationActionsProvider value={actions}>
      <Markdown source={source} streaming={false} />
    </ConversationActionsProvider>,
  );
}

function filesAt(files: Record<string, EmbedFileWire>) {
  return fakeActions({
    resolvePaths: vi.fn((_cwd: string | undefined, paths: readonly string[]) =>
      Promise.resolve(
        paths.map((path) =>
          `/w/${path}` in files ? `/w/${path}` : path in files ? path : null,
        ),
      ),
    ),
    readEmbedFile: vi.fn((path: string) =>
      Promise.resolve(files[path] ?? null),
    ),
    embedSignature: vi.fn((path: string) =>
      Promise.resolve(files[path]?.signature ?? null),
    ),
  });
}

describe("a file an answer embeds", () => {
  it("is a paragraph that is one image of a local path", () => {
    expect(isLocalSource("out/a.png")).toBe(true);
    expect(isLocalSource("/abs/a.png")).toBe(true);
    expect(isLocalSource("https://example.com/a.png")).toBe(false);
    expect(isLocalSource("data:image/png;base64,AA")).toBe(false);
    expect(isLocalSource("//cdn/a.png")).toBe(false);
  });

  it("draws a picture from its bytes", async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    const actions = filesAt({ "/w/out/plot.png": file(png) });
    draw("![the plot](out/plot.png)\n", actions);
    const image = await screen.findByRole("img", { name: "the plot" });
    expect(image.getAttribute("src")).toBe("data:image/png;base64,iVBORw==");
    expect(actions.readEmbedFile).toHaveBeenCalledWith("/w/out/plot.png");
    // A picture has no source to toggle to.
    expect(screen.queryByRole("button", { name: "Show source" })).toBeNull();
  });

  it("draws a text file as its kind, the path in the header opening it", async () => {
    const actions = filesAt({
      "/w/deck.md": file("---\nmarp: true\n---\n# One\n"),
      "/w/arch.svg": file(SVG("A")),
      "/w/notes.md": file("# Notes\n\nSee ![](arch.svg)\n"),
    });
    draw("![](deck.md)\n\n![](arch.svg)\n\n![](notes.md)\n", actions);
    expect(
      await screen.findByRole("img", { name: "Slide 1 of 1" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("img", { name: "SVG image" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Notes" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "arch.svg" }));
    expect(actions.openFile).toHaveBeenCalledWith("/w/arch.svg", undefined);
    // The source of an embedded file is a toggle away, as a fence's is.
    expect(screen.getAllByRole("button", { name: "Show source" }).length).toBe(
      3,
    );
  });

  it("says, quietly, when it is not there or not a kind DevHub draws", async () => {
    const actions = filesAt({});
    draw("![](out/gone.png)\n\n![](data.csv)\n", actions);
    expect(await screen.findByText(/there is no file/)).toHaveTextContent(
      "Not embedded: there is no file out/gone.png.",
    );
    expect(
      screen.getByText(/is not a kind of file DevHub draws/),
    ).toHaveTextContent("data.csv");
    // A kind it does not draw is not even asked for.
    expect(actions.readEmbedFile).not.toHaveBeenCalledWith(
      expect.stringContaining("data.csv"),
    );
  });

  it("is drawn again when the file changes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const files = { "/w/arch.svg": file(SVG("before"), "1") };
    const actions = filesAt(files);
    draw("![](arch.svg)\n", actions);
    const first = await screen.findByRole("img", { name: "SVG image" });
    expect(decodeURIComponent(first.getAttribute("src")!)).toContain("before");
    files["/w/arch.svg"] = file(SVG("after"), "2");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EMBED_POLL_MS + 10);
    });
    await waitFor(() =>
      expect(
        decodeURIComponent(
          screen.getByRole("img", { name: "SVG image" }).getAttribute("src")!,
        ),
      ).toContain("after"),
    );
  });

  it("is a link to the file inside a line of text", () => {
    draw("See ![the plot](out/plot.png) here.\n", filesAt({}));
    expect(screen.getByRole("link", { name: "the plot" })).toBeInTheDocument();
  });
});
