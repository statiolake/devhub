// @vitest-environment jsdom

/**
 * The transcript's top-level entries in chunks (`entryChunks.tsx`): where
 * the chunks are cut, that an entry stays in its chunk and its element stays
 * the same as the transcript grows, and that what walks the drawn transcript
 * — find, the fresh marks — sees the entries through the chunks.
 */

import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
  ConversationEvent,
  EntryId,
  TranscriptEntry,
} from "../../model/conversation";
import { CHUNK_CLASS, CHUNKS_CLASS } from "./chunkElements";
import { CHUNK_SIZE, chunkEntries, type EntryChunk } from "./entryChunks";
import { draw, entry, installResizeObserver, topLevel } from "./surfaceTestKit";
import {
  assistant,
  put,
  tool,
  transcriptOf,
  turnEnd,
  user,
} from "./transcriptFixtures";

beforeAll(() => {
  installResizeObserver();
  const box = () => DOMRect.fromRect({ x: 0, y: 0, width: 10, height: 10 });
  Element.prototype.getBoundingClientRect = box;
  Range.prototype.getBoundingClientRect = box;
  Element.prototype.checkVisibility = () => true;
  globalThis.Highlight = class extends Set<Range> {
    constructor(...ranges: Range[]) {
      super(ranges);
    }
  } as unknown as typeof Highlight;
  Object.defineProperty(CSS, "highlights", {
    value: new Map(),
    configurable: true,
  });
});
afterEach(cleanup);

/** `count` answers, `a0`…, as entries (not events). */
function answers(count: number, from = 0): TranscriptEntry[] {
  return Array.from({ length: count }, (_, index) => {
    const event = put(assistant(`a${from + index}`, `answer ${from + index}`));
    if (event.type !== "entry") throw new Error("not an entry");
    return event.entry;
  });
}

function sizes(chunks: readonly EntryChunk[]): number[] {
  return chunks.map((chunk) => chunk.entries.length);
}

describe("cutting the entries into chunks", () => {
  it("cuts the last chunk at the size, and keeps the cuts as the entries grow", () => {
    const starts = new Set<EntryId>();
    const entries = answers(140);
    const first = chunkEntries(entries.slice(0, 120), starts, []);
    expect(sizes(first)).toEqual([CHUNK_SIZE, CHUNK_SIZE, 20]);
    const grown = chunkEntries(entries, starts, first);
    expect(sizes(grown)).toEqual([CHUNK_SIZE, CHUNK_SIZE, 40]);
    // The chunks that did not change are the same objects.
    expect(grown[0]).toBe(first[0]);
    expect(grown[1]).toBe(first[1]);
  });

  it("makes a chunk longer for an entry inserted in it, rather than moving any entry to the next", () => {
    const starts = new Set<EntryId>();
    const before = answers(120);
    const first = chunkEntries(before, starts, []);
    const [inserted] = answers(1, 999);
    const after = [...before.slice(0, 10), inserted!, ...before.slice(10)];
    const chunks = chunkEntries(after, starts, first);
    expect(sizes(chunks)).toEqual([CHUNK_SIZE + 1, CHUNK_SIZE, 20]);
    expect(chunks.map((chunk) => chunk.key)).toEqual(
      first.map((chunk) => chunk.key),
    );
  });

  it("says what kind was drawn last before a chunk, past entries that draw nothing", () => {
    const entries: TranscriptEntry[] = [
      ...answers(CHUNK_SIZE - 1),
      turnEnd("e1"),
      ...answers(3, 100),
    ];
    const [, second] = chunkEntries(entries, new Set(), []);
    expect(second!.after).toBe("assistant");
  });

  it("leaves the chunks before a rewind as they were, and cuts what follows it anew", () => {
    const starts = new Set<EntryId>();
    const entries = answers(120);
    const first = chunkEntries(entries, starts, []);
    const rewound = chunkEntries(entries.slice(0, 60), starts, first);
    expect(sizes(rewound)).toEqual([CHUNK_SIZE, 10]);
    expect(rewound[0]).toBe(first[0]);
    const again = [...entries.slice(0, 60), ...answers(45, 500)];
    expect(sizes(chunkEntries(again, starts, rewound))).toEqual([
      CHUNK_SIZE,
      CHUNK_SIZE,
      5,
    ]);
  });
});

/** The surface's events for `count` turns of a question and its answer. */
function turns(count: number): ConversationEvent[] {
  return Array.from({ length: count }, (_, index) => [
    put(user(`u${index}`, `question ${index}`)),
    put(
      tool(`t${index}`, `Bash: step ${index}`, {
        input: { command: `step ${index}` },
        output: [{ kind: "text", text: `ran step ${index}` }],
      }),
    ),
    put(assistant(`a${index}`, `needle in answer ${index}`)),
  ]).flat();
}

describe("a long transcript, drawn in chunks", () => {
  it("draws every entry once, in order, inside the chunks", () => {
    draw(transcriptOf(turns(60)));
    const chunks = document.querySelectorAll(`.${CHUNK_CLASS}`);
    expect(chunks.length).toBe(Math.ceil(180 / CHUNK_SIZE));
    const ids = topLevel().map((each) => each.dataset.entryId);
    expect(ids.slice(0, 3)).toEqual(["u0", "t0", "a0"]);
    expect(ids.filter((id) => id?.startsWith("a"))).toHaveLength(60);
  });

  it("keeps every entry's element as the transcript grows past a chunk's end", () => {
    const view = draw(transcriptOf(turns(16)));
    const before = topLevel();
    view.redraw(transcriptOf(turns(20)));
    const after = topLevel();
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.length).toBe(60);
  });

  it("adds a new chunk at the end of the chunks, which stand before the transcript's last lines", () => {
    const running: ConversationEvent = {
      type: "state",
      state: { phase: "ready", turn: "running" },
    };
    const view = draw(transcriptOf([...turns(CHUNK_SIZE / 2), running]));
    const container = document.querySelector(`.${CHUNKS_CLASS}`)!;
    const chunks = () => [...container.children];
    expect(chunks()).toHaveLength(2);
    view.redraw(transcriptOf([...turns(40), running]));
    expect(chunks()).toHaveLength(3);
    expect(container.lastElementChild).toHaveClass(CHUNK_CLASS);
    expect(container.nextElementSibling).toHaveClass("conversation-activity");
  });

  it("marks an entry that arrives in a new chunk as fresh, and nothing else", () => {
    const view = draw(transcriptOf(turns(CHUNK_SIZE / 2)));
    expect(topLevel()).toHaveLength(75);
    view.redraw(
      transcriptOf([...turns(CHUNK_SIZE / 2), ...turns(26).slice(75)]),
    );
    expect(topLevel()).toHaveLength(78);
    expect(entry("a25")).toHaveAttribute("data-fresh");
    expect(entry("a24")).not.toHaveAttribute("data-fresh");
  });

  it("finds words in every chunk", async () => {
    draw(transcriptOf(turns(60)));
    const composer = screen.getByRole("textbox", { name: /message/i });
    fireEvent.keyDown(composer, { key: "f", metaKey: true });
    fireEvent.change(screen.getByRole("textbox", { name: "Find" }), {
      target: { value: "needle" },
    });
    await waitFor(() =>
      expect(
        document.querySelector(".conversation-find-count")!.textContent,
      ).toBe("60 of 60"),
    );
  });
});

describe("the spacing between entries", () => {
  const CSS_TEXT = readFileSync(
    "src/shell/conversation/conversation.css",
    "utf8",
  ).replace(/\s+/g, " ");

  it("is given across a chunk's edge by every rule that gives it inside one", () => {
    for (const [inside, across] of [
      [
        ".conversation-entry + .conversation-entry,",
        ".conversation-chunk + .conversation-chunk > .conversation-entry:first-child {",
      ],
      [
        '.conversation-entry + .conversation-entry:is([data-kind="user"], [data-kind="answer"]),',
        '.conversation-chunk + .conversation-chunk > .conversation-entry:first-child:is( [data-kind="user"], [data-kind="answer"] ) {',
      ],
      [
        '.conversation-entry[data-kind="tool"] + .conversation-entry[data-kind="tool"],',
        '.conversation-chunk[data-after="tool"] > .conversation-entry[data-kind="tool"]:first-child {',
      ],
    ] as const) {
      expect(CSS_TEXT).toContain(`${inside} ${across}`);
    }
    // No rule of the spacing is only for entries side by side.
    const sideBySide = [
      ...CSS_TEXT.matchAll(
        /\.conversation-entry[^{},]*\+ \.conversation-entry[^{},]*\{/g,
      ),
    ];
    expect(sideBySide).toEqual([]);
  });
});
