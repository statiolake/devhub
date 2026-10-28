// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationActionsProvider } from "./ConversationContext";
import type { ConversationActions } from "./ConversationContext";
import { Markdown } from "./Markdown";
import { deckOf, MARP_OPTIONS, offlineCss, renderMarp } from "./marp";
import { deckName, SLIDE_MENU } from "./MarpPreview";
import {
  isMarpDeck,
  MAX_PREVIEW_DEPTH,
  PREVIEW_KINDS,
  previewKindOfFence,
  previewKindOfFile,
  previewKindsOfPath,
} from "./previewKinds";
import { fakeActions } from "./surfaceTestKit";

const png = vi.hoisted(() => ({ svgToPng: vi.fn() }));
vi.mock("./diagramCopy", async (original) => ({
  ...(await original<typeof import("./diagramCopy")>()),
  svgToPng: (...args: unknown[]) => png.svgToPng(...args),
}));

afterEach(cleanup);

function draw(source: string, actions: ConversationActions = fakeActions()) {
  const view = render(
    <ConversationActionsProvider value={actions}>
      <Markdown source={source} streaming={false} />
    </ConversationActionsProvider>,
  );
  return { ...view, actions };
}

const DECK =
  "---\nmarp: true\ntitle: Atlas pitch\n---\n\n# One\n\n---\n\n# Two\n";

describe("the registry of previewable kinds", () => {
  it("has one entry per kind, each with a way back from its source", () => {
    const ids = PREVIEW_KINDS.map((kind) => kind.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const kind of PREVIEW_KINDS) {
      expect(kind.showLabel).toMatch(/^Show /u);
      expect(kind.defaultView).toBe("preview");
    }
  });

  it("knows each kind by its fence", () => {
    const of = (info: string, code: string) =>
      previewKindOfFence(info, code)?.id;
    expect(of("svg", '<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toBe(
      "svg",
    );
    expect(of("mermaid", "graph TD")).toBe("mermaid");
    expect(of("Markdown", "# Title")).toBe("markdown");
    expect(of("md", "text")).toBe("markdown");
    expect(of("marp", "# One")).toBe("marp");
    expect(of("markdown", DECK)).toBe("marp");
    expect(of("md", DECK)).toBe("marp");
  });

  it("leaves code, and an empty block, as code", () => {
    expect(previewKindOfFence("ts", "# not markdown")).toBeUndefined();
    expect(previewKindOfFence(undefined, "# Title")).toBeUndefined();
    expect(previewKindOfFence("markdown", " \n")).toBeUndefined();
    expect(previewKindOfFence("marp", "")).toBeUndefined();
  });

  it("knows each kind by its file", () => {
    expect(previewKindsOfPath("docs/a.MD").map((kind) => kind.id)).toEqual([
      "marp",
      "markdown",
    ]);
    expect(previewKindOfFile("deck.md", DECK)?.id).toBe("marp");
    expect(previewKindOfFile("notes.markdown", "# Notes")?.id).toBe("markdown");
    expect(previewKindOfFile("flow.mmd", "graph TD")?.id).toBe("mermaid");
    expect(
      previewKindOfFile(
        "a.svg",
        '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      )?.id,
    ).toBe("svg");
    expect(previewKindOfFile("a.ts", "# Title")).toBeUndefined();
    expect(previewKindOfFile(".md", "# Title")).toBeUndefined();
  });

  it("stops drawing Markdown inside itself at the depth guard", () => {
    expect(
      previewKindOfFence("markdown", "# A", MAX_PREVIEW_DEPTH - 1)?.id,
    ).toBe("markdown");
    expect(
      previewKindOfFence("markdown", "# A", MAX_PREVIEW_DEPTH),
    ).toBeUndefined();
    // Not Markdown drawn by the conversation: a deck is still a deck.
    expect(previewKindOfFence("marp", "# A", MAX_PREVIEW_DEPTH)?.id).toBe(
      "marp",
    );
  });
});

describe("a Marp deck", () => {
  it("is known by its front matter, and only there", () => {
    expect(isMarpDeck(DECK)).toBe(true);
    expect(isMarpDeck("---\nmarp:   true # slides\n---\n# A")).toBe(true);
    expect(isMarpDeck("---\nmarp: false\n---\n# A")).toBe(false);
    expect(isMarpDeck("# A\n\nmarp: true\n")).toBe(false);
    expect(isMarpDeck("---\ntitle: x\n---\nmarp: true\n")).toBe(false);
  });

  it("is named by its title when saved", () => {
    expect(deckName(DECK)).toBe("Atlas pitch");
    expect(deckName("# untitled")).toBe("slides");
  });

  it("is rendered with no HTML, no script and nothing fetched", () => {
    expect(MARP_OPTIONS.html).toBe(false);
    expect(MARP_OPTIONS.script).toBe(false);
    expect(MARP_OPTIONS.emoji.unicode).toBe(false);
    expect(
      offlineCss(
        '@charset "UTF-8";@import "https://fonts.example/css?x=1";@import url(https://a.example/b.css) screen;section{color:red}',
      ),
    ).toBe('@charset "UTF-8";section{color:red}');
  });

  it("becomes one standalone picture a slide, its CSS inside", async () => {
    const result = await renderMarp(
      `${DECK}\n---\n\n<script>alert(1)</script>\n\n![x](https://example.com/a.png)\n`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { slides, size, printHtml } = result.deck;
    expect(slides).toHaveLength(3);
    expect(size).toEqual({ width: 1280, height: 720 });
    for (const slide of slides) {
      expect(slide).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u);
      expect(slide).toContain('class="marpit"');
      expect(slide).not.toMatch(/@import/u);
    }
    // Raw HTML in the deck is its text, never an element.
    expect(slides[2]).not.toMatch(/<script/iu);
    expect(slides[2]).toContain("&lt;script&gt;");
    expect(printHtml).toMatch(/@page\{size:1280px 720px;margin:0\}/u);
    expect(printHtml).not.toMatch(/<script/iu);
  });

  it("says why when there are no slides", () => {
    expect(deckOf("<p>nothing</p>", "")).toEqual({
      ok: false,
      error: "The deck has no slides.",
    });
  });

  it("is drawn one slide at a time, flipped by button and arrow key", async () => {
    draw(`\`\`\`marp\n${DECK}\`\`\`\n`);
    const first = await screen.findByRole("img", { name: "Slide 1 of 2" });
    expect(first.getAttribute("src")).toMatch(/^data:image\/svg\+xml/u);
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Previous slide" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next slide" }));
    expect(
      screen.getByRole("img", { name: "Slide 2 of 2" }),
    ).toBeInTheDocument();
    const stage = screen.getByRole("group", { name: "Slide 2 of 2" });
    fireEvent.keyDown(stage, { key: "ArrowLeft" });
    expect(
      screen.getByRole("img", { name: "Slide 1 of 2" }),
    ).toBeInTheDocument();
    // Nothing of the deck is markup in the page.
    expect(document.querySelector("section, foreignObject")).toBeNull();
  });

  it("saves as PDF and as images, and copies the slide shown", async () => {
    png.svgToPng.mockResolvedValue(Uint8Array.from([0x89, 0x50]));
    const actions = fakeActions({
      showContextMenu: vi
        .fn()
        .mockResolvedValueOnce("save-pdf")
        .mockResolvedValueOnce("save-images"),
    });
    draw(`\`\`\`markdown\n${DECK}\`\`\`\n`, actions);
    await screen.findByRole("img", { name: "Slide 1 of 2" });
    fireEvent.click(screen.getByRole("button", { name: "Save slides" }));
    await waitFor(() => expect(actions.saveSlidesPdf).toHaveBeenCalled());
    expect(actions.saveSlidesPdf).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 1280,
        height: 720,
        name: "Atlas pitch",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save slides" }));
    await waitFor(() => expect(actions.saveSlideImages).toHaveBeenCalled());
    expect(actions.saveSlideImages).toHaveBeenCalledWith({
      images: [expect.any(Uint8Array), expect.any(Uint8Array)],
      name: "Atlas pitch",
    });
    // A slide is its own page: no margin around it.
    expect(png.svgToPng.mock.calls[0]?.[4]).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Copy slide image" }));
    await waitFor(() => expect(actions.writeClipboardImage).toHaveBeenCalled());
  });

  it("offers the slide, its source and the saves on a right-click", async () => {
    const actions = fakeActions({
      showContextMenu: vi.fn().mockResolvedValue("copy-source"),
    });
    draw(`\`\`\`marp\n${DECK}\`\`\`\n`, actions);
    const slide = await screen.findByRole("img", { name: "Slide 1 of 2" });
    fireEvent.contextMenu(slide, { clientX: 5, clientY: 6 });
    await waitFor(() =>
      expect(actions.writeClipboard).toHaveBeenCalledWith(DECK.trimEnd()),
    );
    expect(actions.showContextMenu).toHaveBeenCalledWith({
      items: SLIDE_MENU.map(({ id, label }) =>
        id === "save-pdf"
          ? { id, label, separatorBefore: true }
          : { id, label },
      ),
      at: { x: 5, y: 6 },
    });
  });
});

describe("a Markdown block", () => {
  const README =
    "````markdown\n# Atlas\n\nA **small** tool.\n\n```js\nconst a = 1;\n```\n````\n";

  it("is drawn by the conversation's own renderer, in a frame", () => {
    const { container } = draw(README);
    const figure = container.querySelector(
      'figure[data-kind="markdown"]',
    ) as HTMLElement;
    expect(figure).not.toBeNull();
    expect(
      within(figure).getByRole("heading", { name: "Atlas" }),
    ).toBeInTheDocument();
    expect(within(figure).getByText("small").tagName).toBe("STRONG");
    // The code inside it is a code block of its own.
    expect(figure.querySelector(".conversation-code code")?.textContent).toBe(
      "const a = 1;",
    );
  });

  it("toggles to its source and back", () => {
    draw(README);
    fireEvent.click(screen.getByRole("button", { name: "Show source" }));
    expect(screen.getByText(/# Atlas/u)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Atlas" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show preview" }));
    expect(screen.getByRole("heading", { name: "Atlas" })).toBeInTheDocument();
  });

  it("copies its source, with the drawn document as HTML beside it", async () => {
    const { actions } = draw(README);
    fireEvent.click(screen.getByRole("button", { name: "Copy Markdown" }));
    await waitFor(() => expect(actions.writeClipboardRich).toHaveBeenCalled());
    const [content] = vi.mocked(actions.writeClipboardRich).mock.calls[0]!;
    expect(content.text).toBe(
      "# Atlas\n\nA **small** tool.\n\n```js\nconst a = 1;\n```",
    );
    expect(content.html).toContain("<strong>small</strong>");
    // What the conversation draws around a block is not part of the copy.
    expect(content.html).not.toContain("<button");
    expect(content.html).not.toContain("conversation-code-header");
  });

  it("offers its source on a right-click", async () => {
    const actions = fakeActions({
      showContextMenu: vi.fn().mockResolvedValue("copy-source"),
    });
    draw(README, actions);
    fireEvent.contextMenu(screen.getByRole("heading", { name: "Atlas" }));
    await waitFor(() => expect(actions.writeClipboard).toHaveBeenCalled());
    expect(actions.showContextMenu).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [{ id: "copy-source", label: "Copy Source" }],
      }),
    );
  });

  it("nests, but not forever", () => {
    const nest = (depth: number): string => {
      const fence = "`".repeat(3 + depth);
      return depth === 0
        ? "# Innermost"
        : `${fence}markdown\n# Level ${depth}\n\n${nest(depth - 1)}\n${fence}`;
    };
    const { container } = draw(`${nest(4)}\n`);
    expect(
      container.querySelectorAll('figure[data-kind="markdown"]'),
    ).toHaveLength(MAX_PREVIEW_DEPTH);
    // The level past the guard is its source, as code.
    expect(screen.getByText(/# Level 2/u).closest("pre")).not.toBeNull();
  });

  it("is code while its fence is still open", () => {
    render(
      <ConversationActionsProvider value={fakeActions()}>
        <Markdown source={"```markdown\n# Atlas\n"} streaming />
      </ConversationActionsProvider>,
    );
    expect(screen.queryByRole("heading", { name: "Atlas" })).toBeNull();
    expect(screen.getByText("# Atlas")).toBeInTheDocument();
  });
});
