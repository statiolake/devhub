/**
 * The find bar's search over one drawn transcript (`FindBar.tsx`).
 *
 * A one-letter query over a long session has millions of matches, and every
 * one of them counts: the count is exact. So the search never holds up the
 * page for them:
 *
 * - It runs in slices of a few milliseconds (`SLICE_MS`), one task each, so
 *   typing, scrolling and the conversation's own drawing go on between them.
 *   The count grows as it goes (`status().complete` says when it is exact),
 *   and a new query drops what is left of the old one.
 * - A match is kept as where it starts in its section's text (`Int32Array`),
 *   not as a `Range`: the page keeps every live range up to date on every
 *   change to its text, and millions of them slow every change down.
 *   `rangesWithin` makes ranges for just the matches on view, when the page
 *   paints them.
 * - The transcript is searched by section: each child of its root (an entry)
 *   has its own text and matches. When the conversation grows or an entry is
 *   drawn again, only those sections are read and searched again
 *   (`refresh`); the rest keep theirs, and the current match stays put.
 *
 * Sections are searched from the bottom up, and a new query's current match
 * is its last: the conversation's latest words are where a search usually
 * starts, going up from there. So the last match is current as soon as the
 * bottom section holding one is searched, whatever is left above it, and the
 * count grows above it (`12 of 12…` to `2,805,790 of 2,805,790`). Within a
 * section the text is searched top down, as the matches do not overlap.
 *
 * Its matches are numbered in document order, and stepping (`step`) goes
 * through the ones found so far, so it works while the count is still
 * growing.
 */

import { SectionText } from "./findInTranscript";

/** The longest a slice of searching runs before it lets the page go on. */
export const SLICE_MS = 4;

/** Where something is drawn, top to bottom, in the viewport's coordinates. */
export interface Box {
  readonly top: number;
  readonly bottom: number;
}

/**
 * How the transcript is laid out: what `rangesWithin` asks of the page. It
 * asks where things are only of what is drawn: an entry far from view is not
 * laid out at all (`content-visibility: auto`), and asking where its words
 * are would lay it out there and then.
 */
export interface Layout {
  /**
   * Whether `element` is drawn now: not inside anything hidden, a closed
   * fold, or an entry the page skips while it is far from view.
   */
  drawn(element: Element): boolean;
  /** Where drawn `target` is; nothing when it takes no room (collapsed white space). */
  box(target: Node | Range): Box | undefined;
}

let probe: Range | undefined;

/** The page's own layout. */
export const pageLayout: Layout = {
  drawn: (element) => element.checkVisibility({ contentVisibilityAuto: true }),
  box(target) {
    let rect: DOMRect;
    if (target instanceof Range || target instanceof Element)
      rect = target.getBoundingClientRect();
    else {
      probe ??= target.ownerDocument!.createRange();
      probe.selectNodeContents(target);
      rect = probe.getBoundingClientRect();
    }
    return rect.width === 0 && rect.height === 0 ? undefined : rect;
  },
};

/** Runs `run` as a task of its own, soon; the returned function cancels it. */
export type Schedule = (run: () => void) => () => void;

/** A task of its own through a message: unlike `setTimeout`, never held back to 4 ms. */
export function nextTask(run: () => void): () => void {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    channel.port1.close();
    run();
  };
  channel.port2.postMessage(null);
  return () => channel.port1.close();
}

/** What the find bar says and shows. */
export interface SearchStatus {
  /** How many matches are found: all of them once `complete`. */
  readonly total: number;
  /** Which of them is current, in document order. */
  readonly current: number | undefined;
  readonly complete: boolean;
  /** Counts the moves of the current match made on purpose, which bring it into view. */
  readonly moves: number;
}

/** One child of the transcript's root, and what the query found in it. */
interface Section {
  readonly top: Node;
  text: SectionText;
  /** Where each match starts in `text.text`; the first `count` are set. */
  matches: Int32Array;
  count: number;
  /** Where the search goes on from in the text. */
  from: number;
  complete: boolean;
}

function freshSection(top: Node): Section {
  return {
    top,
    text: new SectionText(top),
    matches: new Int32Array(16),
    count: 0,
    from: 0,
    complete: false,
  };
}

/** The first index in `[low, high)` of `values` at or past `value`. */
function lowerBound(
  values: Int32Array,
  low: number,
  high: number,
  value: number,
): number {
  while (low < high) {
    const middle = (low + high) >> 1;
    if (values[middle]! < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** What `at` says of one of a run of things: where it is drawn, or past which index it draws nothing. */
type Placed = { readonly box: Box } | { readonly skipTo: number };

/**
 * The first index in `[low, high)` whose box reaches down to `top`, things
 * that draw nothing passed over (`at` says where the next drawn one is).
 */
function firstReaching(
  low: number,
  high: number,
  top: number,
  at: (index: number) => Placed,
): number {
  while (low < high) {
    const middle = (low + high) >> 1;
    let probeAt = middle;
    let box: Box | undefined;
    while (probeAt < high) {
      const placed = at(probeAt);
      if ("box" in placed) {
        box = placed.box;
        break;
      }
      probeAt = placed.skipTo;
    }
    if (box === undefined || box.bottom >= top) high = middle;
    else low = probeAt + 1;
  }
  return low;
}

export class TranscriptSearch {
  #sections: Section[] = [];
  #query = "";
  #caseSensitive = false;
  /** The last section not searched to its end; -1 when all are. */
  #next = -1;
  /** The current match: where it starts in which section. */
  #current: { section: Section; offset: number } | undefined;
  /** Its place when last counted: kept by it when its section goes away. */
  #currentIndex = 0;
  /** A section of the current match was drawn again: its match is found again. */
  #resettle = false;
  /** A new query's last match is to become current, and brought into view. */
  #awaitingLast = false;
  #moves = 0;
  #cancel: (() => void) | undefined;
  readonly #observer: MutationObserver;

  constructor(
    readonly root: Element,
    private readonly onChange: () => void,
    private readonly schedule: Schedule = nextTask,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.#sections = Array.from(root.childNodes, freshSection);
    this.#observer = new MutationObserver((records) => this.#changed(records));
    this.#observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-hidden"],
    });
  }

  /** Stop searching and watching. */
  dispose(): void {
    this.#cancel?.();
    this.#cancel = undefined;
    this.#observer.disconnect();
  }

  /**
   * Search for `query` anew: what was found for the old one is dropped, and
   * the last match becomes current. Case is ignored unless `caseSensitive`.
   * An empty query finds nothing.
   */
  setQuery(query: string, caseSensitive: boolean): void {
    if (query.includes("\n"))
      throw new Error(
        "a find query holds a line break, which the find field cannot give",
      );
    this.#query = caseSensitive ? query : query.toLowerCase();
    this.#caseSensitive = caseSensitive;
    for (const section of this.#sections) this.#restart(section);
    this.#next = this.#sections.length - 1;
    this.#current = undefined;
    this.#currentIndex = 0;
    this.#resettle = false;
    this.#awaitingLast = true;
    this.#run();
  }

  /**
   * Take in what was drawn since the last look — the page calls this after it
   * draws the transcript again; drawing the page also brings it here by
   * itself, a moment later.
   */
  refresh(): void {
    this.#changed(this.#observer.takeRecords());
  }

  status(): SearchStatus {
    return {
      total: this.#total(),
      current: this.#current === undefined ? undefined : this.#indexOfCurrent(),
      complete: this.#next < 0,
      moves: this.#moves,
    };
  }

  /** Make the next match (1) or the previous (-1) current, around the ends of what is found. */
  step(delta: 1 | -1): void {
    const total = this.#total();
    if (total === 0) return;
    const index =
      this.#current === undefined
        ? delta === 1
          ? -1
          : 0
        : this.#indexOfCurrent();
    this.#currentIndex = (index + delta + total) % total;
    this.#current = this.#locate(this.#currentIndex);
    this.#moves += 1;
    this.onChange();
  }

  /** The current match as a range of the document. */
  currentRange(): Range | undefined {
    const current = this.#current;
    if (current === undefined) return undefined;
    return current.section.text.range(current.offset, this.#query.length);
  }

  /**
   * The matches drawn between `top` and `bottom`, as ranges: what is on view
   * (and a margin), whatever the count. Matches folded away draw nothing and
   * are left out.
   */
  rangesWithin(
    top: number,
    bottom: number,
    layout: Layout = pageLayout,
  ): Range[] {
    const ranges: Range[] = [];
    const sections = this.#sections;
    const sectionAt = (index: number): Placed => {
      const top = sections[index]!.top;
      const box =
        top instanceof Element && !layout.drawn(top)
          ? undefined
          : layout.box(top);
      return box === undefined ? { skipTo: index + 1 } : { box };
    };
    for (
      let index = firstReaching(0, sections.length, top, sectionAt);
      index < sections.length;
      index += 1
    ) {
      const section = sections[index]!;
      if (section.count === 0 || !section.text.read) continue;
      const placed = sectionAt(index);
      if (!("box" in placed)) continue;
      if (placed.box.top > bottom) break;
      this.#rangesIn(section, top, bottom, layout, ranges);
    }
    return ranges;
  }

  #rangesIn(
    section: Section,
    top: number,
    bottom: number,
    layout: Layout,
    ranges: Range[],
  ): void {
    const { nodes, starts } = section.text;
    const length = this.#query.length;
    const nodeAt = (index: number): Placed => {
      const node = nodes[index]!;
      // The outermost element around it that is not drawn: all it holds is
      // passed over at once — a closed tool call's whole output.
      let outer: Node | undefined;
      for (
        let element = node.parentElement;
        element !== null && element !== section.top;
        element = element.parentElement
      ) {
        if (layout.drawn(element)) break;
        outer = element;
      }
      if (outer === undefined) {
        const box = layout.box(node);
        return box === undefined ? { skipTo: index + 1 } : { box };
      }
      let low = index + 1;
      let high = nodes.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (outer.contains(nodes[middle]!)) low = middle + 1;
        else high = middle;
      }
      return { skipTo: low };
    };
    const matchAt = (index: number): Range =>
      section.text.range(section.matches[index]!, length);
    let match = lowerBound(
      section.matches,
      0,
      section.count,
      starts[firstReaching(0, nodes.length, top, nodeAt)] ?? Infinity,
    );
    while (match < section.count) {
      const node = section.text.nodeAt(section.matches[match]!);
      const placed = nodeAt(node);
      if (!("box" in placed)) {
        match = lowerBound(
          section.matches,
          match,
          section.count,
          starts[placed.skipTo] ?? Infinity,
        );
        continue;
      }
      if (placed.box.top > bottom) return;
      const end = lowerBound(
        section.matches,
        match,
        section.count,
        starts[node + 1] ?? Infinity,
      );
      if (placed.box.top >= top && placed.box.bottom <= bottom) {
        for (; match < end; match += 1) ranges.push(matchAt(match));
        continue;
      }
      // A node that runs past the edge — a long output's one text node —
      // from its first match on view to its last.
      const boxOf = (index: number): Placed => {
        const box = layout.box(matchAt(index));
        return box === undefined ? { skipTo: index + 1 } : { box };
      };
      for (
        match = firstReaching(match, end, top, boxOf);
        match < end;
        match += 1
      ) {
        const range = matchAt(match);
        const box = layout.box(range);
        if (box === undefined) continue;
        if (box.top > bottom) return;
        ranges.push(range);
      }
    }
  }

  #total(): number {
    let total = 0;
    for (const section of this.#sections) total += section.count;
    return total;
  }

  #indexOfCurrent(): number {
    const current = this.#current!;
    let index = 0;
    for (const section of this.#sections) {
      if (section === current.section) break;
      index += section.count;
    }
    index += lowerBound(
      current.section.matches,
      0,
      current.section.count,
      current.offset,
    );
    this.#currentIndex = index;
    return index;
  }

  /** The match at `index` in document order; `index` is below the total. */
  #locate(index: number): { section: Section; offset: number } {
    let left = index;
    for (const section of this.#sections) {
      if (left < section.count)
        return { section, offset: section.matches[left]! };
      left -= section.count;
    }
    throw new Error(`match ${index} is past the ${this.#total()} found`);
  }

  #restart(section: Section): void {
    section.count = 0;
    section.from = 0;
    section.complete = false;
  }

  #changed(records: readonly MutationRecord[]): void {
    if (records.length === 0) return;
    // Its place in the count, should its section go.
    if (this.#current !== undefined) this.#indexOfCurrent();
    let resync = false;
    const drawn = new Set<Node>();
    for (const record of records) {
      if (record.target === this.root) {
        resync = true;
        continue;
      }
      let top: Node | null = record.target;
      while (top !== null && top.parentNode !== this.root) top = top.parentNode;
      // Not in the transcript any more: its section goes when the root's
      // children are taken in.
      if (top !== null) drawn.add(top);
    }
    if (resync) {
      const kept = new Map(
        this.#sections.map((section) => [section.top, section]),
      );
      this.#sections = Array.from(
        this.root.childNodes,
        (top) => kept.get(top) ?? freshSection(top),
      );
      const current = this.#current;
      if (current !== undefined && !current.section.top.isConnected) {
        this.#current = undefined;
        this.#resettle = true;
      }
    }
    for (const section of this.#sections) {
      if (!drawn.has(section.top)) continue;
      section.text = new SectionText(section.top);
      this.#restart(section);
      if (section === this.#current?.section) this.#resettle = true;
    }
    this.#next = this.#sections.length - 1;
    while (this.#next >= 0 && this.#sections[this.#next]!.complete)
      this.#next -= 1;
    this.#run();
  }

  /** Search on for one slice, from the bottom up, then again in a task of its own until done. */
  #run = (): void => {
    this.#cancel?.();
    this.#cancel = undefined;
    const deadline = this.now() + SLICE_MS;
    const over = () => this.now() >= deadline;
    while (this.#next >= 0) {
      const section = this.#sections[this.#next]!;
      if (section.complete || this.#searchOn(section, over)) this.#next -= 1;
      if (this.#next >= 0 && over()) {
        this.#cancel = this.schedule(this.#run);
        this.onChange();
        return;
      }
    }
    this.#settle();
    this.onChange();
  };

  /** Search on in `section` until its end or the slice is spent; whether it is searched. */
  #searchOn(section: Section, over: () => boolean): boolean {
    const wanted = this.#query;
    if (wanted === "") {
      section.complete = true;
      return true;
    }
    if (!section.text.readOn(over)) return false;
    const haystack = this.#caseSensitive
      ? section.text.text
      : section.text.folded;
    let since = 0;
    for (
      let at = haystack.indexOf(wanted, section.from);
      at >= 0;
      at = haystack.indexOf(wanted, at + wanted.length)
    ) {
      if (section.count === section.matches.length) {
        const grown = new Int32Array(section.matches.length * 2);
        grown.set(section.matches);
        section.matches = grown;
      }
      section.matches[section.count] = at;
      section.count += 1;
      section.from = at + wanted.length;
      since += 1;
      if (since >= 1024) {
        since = 0;
        if (over()) return false;
      }
    }
    section.from = haystack.length;
    section.complete = true;
    if (section.count > 0) this.#settle();
    return true;
  }

  /**
   * Make a match current once there is one to be: a new query's last — the
   * bottom section's last once it is searched, as the sections below it are
   * searched before it and hold none — or,
   * after the current one's section was drawn again, the match at its place
   * or the first after it — the next section's once its own are searched.
   */
  #settle(): void {
    if (this.#awaitingLast) {
      const total = this.#total();
      if (total === 0) return;
      this.#awaitingLast = false;
      this.#current = this.#locate(total - 1);
      this.#moves += 1;
      return;
    }
    if (!this.#resettle) return;
    const current = this.#current;
    if (current === undefined) {
      // Its section went away: the match now at its place in the count.
      const total = this.#total();
      if (total === 0) return;
      this.#resettle = false;
      this.#current = this.#locate(Math.min(this.#currentIndex, total - 1));
      return;
    }
    if (!current.section.complete) return;
    this.#resettle = false;
    const { section, offset } = current;
    const at = lowerBound(section.matches, 0, section.count, offset);
    if (at < section.count) {
      this.#current = { section, offset: section.matches[at]! };
      return;
    }
    const after = this.#sections.indexOf(section);
    const later = this.#sections.find(
      (each, index) => index > after && each.count > 0,
    );
    if (later !== undefined)
      this.#current = { section: later, offset: later.matches[0]! };
    else if (this.#total() > 0) this.#current = this.#locate(0);
    else this.#current = undefined;
  }
}
