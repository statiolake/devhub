// @vitest-environment jsdom

/**
 * The find bar's search: an exact count over a long transcript without
 * holding up the page, a new query dropping the old one, only the matches on
 * view made into ranges, and a growing conversation searched only where it
 * grew.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Box,
  type Layout,
  type Schedule,
  TranscriptSearch,
} from "./transcriptSearch";

/** Slices run by hand, each timed. */
function slices() {
  const queue: (() => void)[] = [];
  const took: number[] = [];
  return {
    schedule: (run: () => void) => {
      queue.push(run);
      return () => {
        const at = queue.indexOf(run);
        if (at >= 0) queue.splice(at, 1);
      };
    },
    pending: () => queue.length,
    /** Run slices until none is left; how many ran. */
    drain(): number {
      let ran = 0;
      while (queue.length > 0) {
        const run = queue.shift()!;
        const start = performance.now();
        run();
        took.push(performance.now() - start);
        ran += 1;
      }
      return ran;
    },
    longest: () => Math.max(0, ...took),
  };
}

/** A transcript of `sections` entries, each `text`. */
function transcript(sections: number, text: (index: number) => string) {
  const root = document.createElement("div");
  root.innerHTML = Array.from(
    { length: sections },
    (_, index) => `<div data-entry-id="e${index}"><p>${text(index)}</p></div>`,
  ).join("");
  document.body.append(root);
  return root;
}

let searches: TranscriptSearch[] = [];
/**
 * Each next slice run at once: the search is done when `setQuery` or
 * `refresh` returns, however slow the machine running the test.
 */
function atOnce(run: () => void): () => void {
  run();
  return () => {};
}

function searchIn(root: Element, schedule: Schedule = atOnce) {
  const search = new TranscriptSearch(root, () => {}, schedule);
  searches.push(search);
  return search;
}

afterEach(() => {
  for (const search of searches) search.dispose();
  searches = [];
  document.body.replaceChildren();
});

describe("a search over a long transcript", () => {
  it("counts every match exactly, a slice of a few milliseconds at a time", () => {
    // 2,000 entries of 1,000 letters: two million one-letter matches.
    const root = transcript(2_000, () => "a".repeat(1_000));
    const run = slices();
    const search = searchIn(root, run.schedule);
    search.setQuery("a", false);
    expect(search.status().complete).toBe(false);
    // The first match is current from the first slice on.
    expect(search.status().current).toBe(0);
    expect(run.drain()).toBeGreaterThan(5);
    expect(search.status()).toMatchObject({
      total: 2_000_000,
      complete: true,
      current: 0,
    });
    // jsdom is slower than the page and a timer check is not free, so
    // generous; a slice that did not stop would take hundreds.
    expect(run.longest()).toBeLessThan(60);
  });

  it("drops the old query's search when a new one starts", () => {
    const root = transcript(500, (index) => `${"a".repeat(1_000)} b${index}`);
    const run = slices();
    const search = searchIn(root, run.schedule);
    search.setQuery("a", false);
    expect(search.status().complete).toBe(false);
    search.setQuery("b1", false);
    run.drain();
    // b1, b10–b19, b100–b199: 111.
    expect(search.status()).toMatchObject({ total: 111, complete: true });
  });

  it("steps through the matches found so far while the count still grows", () => {
    const root = transcript(2_000, () => "a".repeat(1_000));
    const run = slices();
    const search = searchIn(root, run.schedule);
    search.setQuery("a", false);
    const { total } = search.status();
    expect(total).toBeGreaterThan(1);
    search.step(1);
    expect(search.status().current).toBe(1);
    search.step(-1);
    search.step(-1);
    // Around the end of what is found so far.
    expect(search.status().current).toBe(total - 1);
    run.drain();
    expect(search.status().current).toBe(total - 1);
    expect(search.status().total).toBe(2_000_000);
  });

  it("ignores case unless asked, and finds nothing for an empty query", () => {
    const root = transcript(1, () => "Parser parser PARSER");
    const search = searchIn(root);
    search.setQuery("parser", false);
    expect(search.status().total).toBe(3);
    search.setQuery("Parser", true);
    expect(search.status().total).toBe(1);
    search.setQuery("", false);
    expect(search.status()).toMatchObject({ total: 0, complete: true });
  });
});

describe("what a search reaches", () => {
  it("is the words drawn, not the page's controls, and no match runs from one block into the next", () => {
    const root = document.createElement("div");
    root.innerHTML =
      "<div><p>alpha <strong>be</strong>ta</p><p>gamma</p><button>alpha</button><span aria-hidden='true'>alpha</span></div>";
    document.body.append(root);
    const search = searchIn(root);
    search.setQuery("alpha beta", false);
    expect(search.status().total).toBe(1);
    expect(String(search.currentRange())).toBe("alpha beta");
    search.setQuery("alpha", false);
    expect(search.status().total).toBe(1);
    search.setQuery("betagamma", false);
    expect(search.status().total).toBe(0);
  });
});

describe("the matches on view", () => {
  /** Each entry one 20px row, top to bottom; what `hidden` holds draws nothing. */
  const rows: Layout = {
    drawn: (element) => element.closest("[hidden]") === null,
    box(target) {
      const node = target instanceof Range ? target.startContainer : target;
      const element = node instanceof Element ? node : node.parentElement!;
      const entry = element.closest("[data-entry-id]")!;
      const index = Number(entry.getAttribute("data-entry-id")!.slice(1));
      return { top: index * 20, bottom: index * 20 + 20 } satisfies Box;
    },
  };

  it("are all that become ranges, however many there are in all", () => {
    const root = transcript(20_000, () => "a".repeat(100));
    const run = slices();
    const search = searchIn(root, run.schedule);
    search.setQuery("a", false);
    run.drain();
    expect(search.status().total).toBe(2_000_000);
    // Rows 50 to 60 (their tops 1000–1200).
    const ranges = search.rangesWithin(1_005, 1_200, rows);
    expect(ranges).toHaveLength(11 * 100);
    const entries = new Set(
      ranges.map((range) =>
        range.startContainer
          .parentElement!.closest("[data-entry-id]")!
          .getAttribute("data-entry-id"),
      ),
    );
    expect([...entries]).toEqual(
      Array.from({ length: 11 }, (_, at) => `e${50 + at}`),
    );
  });

  it("leave out what a fold hides", () => {
    const root = transcript(3, (index) =>
      index === 1 ? "a <span hidden>a a a</span> a" : "a",
    );
    const search = searchIn(root);
    search.setQuery("a", false);
    expect(search.status().total).toBe(7);
    expect(search.rangesWithin(0, 100, rows)).toHaveLength(4);
  });
});

describe("a conversation that grows while the bar is open", () => {
  it("searches only the new entry, and the current match stays put", () => {
    const root = transcript(1_000, (index) => `step ${index} parser`);
    const search = searchIn(root);
    search.setQuery("parser", false);
    expect(search.status().total).toBe(1_000);
    search.step(1);
    search.step(1);
    const current = search.currentRange()!;
    const reads = vi.spyOn(document, "createTreeWalker");
    const added = document.createElement("div");
    added.innerHTML = "<p>one more parser note</p>";
    root.append(added);
    search.refresh();
    expect(reads).toHaveBeenCalledTimes(1);
    expect(search.status()).toMatchObject({
      total: 1_001,
      current: 2,
      complete: true,
    });
    expect(search.currentRange()!.startContainer).toBe(current.startContainer);
    reads.mockRestore();
  });

  it("keeps the current match at its place when its own entry is drawn again", () => {
    const root = transcript(3, (index) => `parser ${index} parser`);
    const search = searchIn(root);
    search.setQuery("parser", false);
    search.step(1);
    search.step(1);
    search.step(1);
    expect(search.status().current).toBe(3);
    // Entry 1 streams on: its text node is written again, longer.
    const text = root.children[1]!.querySelector("p")!.firstChild as Text;
    text.data = `${text.data} and parser`;
    search.refresh();
    expect(search.status()).toMatchObject({ total: 7, current: 3 });
    expect(search.currentRange()!.startContainer).toBe(text);
  });

  it("moves to the match at the current one's place when its entry goes", () => {
    const root = transcript(3, () => "parser");
    const search = searchIn(root);
    search.setQuery("parser", false);
    search.step(1);
    root.children[1]!.remove();
    search.refresh();
    expect(search.status()).toMatchObject({ total: 2, current: 1 });
  });
});
