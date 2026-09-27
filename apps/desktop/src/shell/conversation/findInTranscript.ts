/**
 * Finding words in a drawn conversation: reading its text, and showing a
 * match — what the find bar's search (`transcriptSearch.ts`) stands on.
 *
 * It reads the transcript as the page draws it — every word of it, since
 * the whole transcript is always in the document (`ConversationSurface`) and
 * nothing that folds leaves anything out: a closed tool call keeps its input
 * and output in its `<details>`, a cut readable view keeps its end under the
 * `Clip`, a long message not from the person keeps its lines past the fold
 * `hidden`. So what is found is what the conversation says, folded or not.
 *
 * Only the conversation's own words are read. The page's controls
 * (buttons: Copy, Rewind, Show all) and what is drawn for the eye only
 * (`aria-hidden`: a diff's line numbers) are not, and a match never runs
 * from one block into the next — the end of one paragraph and the start of
 * another are not one phrase.
 *
 * A match inside a fold is revealed when it becomes the current one
 * (`revealMatch`): each `<details>` around it opens, and each fold of the
 * page's own (`FIND_FOLD`) is told to open by `REVEAL_EVENT`.
 */

/** Marks an element that folds away part of what it holds, and opens on `REVEAL_EVENT`. */
export const FIND_FOLD = "data-find-fold";

/** Dispatched on a `FIND_FOLD` element holding the current match: open. */
export const REVEAL_EVENT = "conversation-find-reveal";

/**
 * What stands between two blocks' text in `SectionText.text`. A query never
 * holds one — the find field is an `<input>`, which drops line breaks — so
 * no match runs across it.
 */
export const BLOCK_BREAK = "\n";

/** Elements whose text is not the conversation's: controls, and what is drawn for the eye only. */
const SKIPPED = "button, svg, [aria-hidden='true']";

/** Elements that flow inside a block: a match may run across them. */
const INLINE = new Set([
  "A",
  "ABBR",
  "B",
  "CODE",
  "DEL",
  "EM",
  "I",
  "KBD",
  "LABEL",
  "MARK",
  "S",
  "SMALL",
  "SPAN",
  "STRONG",
  "SUB",
  "SUP",
  "U",
]);

/** The nearest element around `node`, up to `top`, that is a block of its own. */
function blockOf(node: Node, top: Node): Node {
  let element = node.parentElement;
  while (element !== null && element !== top && INLINE.has(element.tagName))
    element = element.parentElement;
  return element ?? top;
}

/**
 * The text in lower case, character for character: one whose lower case is
 * longer (`İ`) is kept as it is, so an offset in the folded text is the same
 * offset in the text.
 */
export function foldCase(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  let folded = "";
  for (const character of text) {
    const each = character.toLowerCase();
    folded += each.length === character.length ? each : character;
  }
  return folded;
}

/**
 * The words one part of the transcript draws (a child of the transcript's
 * root: an entry), read a slice at a time — a long tool output or a subagent's
 * whole record is too much to read between two frames. Its text nodes in
 * order, where each starts in the joined `text`, and the joined text, its
 * blocks apart by `BLOCK_BREAK`.
 *
 * It holds as long as the part is not drawn again; the search reads it anew
 * when it is.
 */
export class SectionText {
  readonly nodes: Text[] = [];
  /** Where each of `nodes` starts in `text`. */
  readonly starts: number[] = [];
  #text: string | undefined;
  #folded: string | undefined;
  #parts: string[] = [];
  #length = 0;
  #block: Node | undefined;
  readonly #walker: TreeWalker | undefined;

  constructor(readonly top: Node) {
    if (top instanceof Text) {
      if (top.data !== "") this.#add(top, top);
      this.#finish();
      return;
    }
    if (top instanceof Element && top.matches(SKIPPED)) {
      this.#finish();
      return;
    }
    this.#walker = top.ownerDocument!.createTreeWalker(
      top,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) =>
          node instanceof Text
            ? NodeFilter.FILTER_ACCEPT
            : (node as Element).matches(SKIPPED)
              ? NodeFilter.FILTER_REJECT
              : NodeFilter.FILTER_SKIP,
      },
    );
  }

  /** Whether it is read to the end. */
  get read(): boolean {
    return this.#text !== undefined;
  }

  /** The joined text; only once `read`. */
  get text(): string {
    if (this.#text === undefined)
      throw new Error(
        "a part of the transcript was searched before it was read",
      );
    return this.#text;
  }

  /** The joined text in lower case, offset for offset (`foldCase`). */
  get folded(): string {
    this.#folded ??= foldCase(this.text);
    return this.#folded;
  }

  /** Read on until the end or until `over` says the slice is spent; whether it is read. */
  readOn(over: () => boolean): boolean {
    if (this.#text !== undefined) return true;
    const walker = this.#walker!;
    let since = 0;
    for (
      let node = walker.nextNode();
      node !== null;
      node = walker.nextNode()
    ) {
      const text = node as Text;
      if (text.data !== "") this.#add(text, blockOf(text, this.top));
      since += 1;
      if (since >= 256) {
        since = 0;
        if (over()) return false;
      }
    }
    this.#finish();
    return true;
  }

  #add(text: Text, block: Node): void {
    if (this.nodes.length > 0 && block !== this.#block) {
      this.#parts.push(BLOCK_BREAK);
      this.#length += BLOCK_BREAK.length;
    }
    this.#block = block;
    this.nodes.push(text);
    this.starts.push(this.#length);
    this.#parts.push(text.data);
    this.#length += text.data.length;
  }

  #finish(): void {
    this.#text = this.#parts.join("");
    this.#parts = [];
  }

  /** Which of `nodes` holds the character at `offset` (an `end` closes the node before it, not opens the next). */
  nodeAt(offset: number, end = false): number {
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      const start = this.starts[middle]!;
      if (end ? start < offset : start <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  /** The characters `offset` to `offset + length` of `text`, as a range of the document. */
  range(offset: number, length: number): Range {
    const range = this.top.ownerDocument!.createRange();
    const first = this.nodeAt(offset);
    const last = this.nodeAt(offset + length, true);
    // Placed on its first node before its ends are set: a new range sits at
    // the top of the document, and moving an end from there to the match
    // compares the two across the whole document (in jsdom, node by node).
    range.selectNodeContents(this.nodes[first]!);
    range.setEnd(this.nodes[last]!, offset + length - this.starts[last]!);
    range.setStart(this.nodes[first]!, offset - this.starts[first]!);
    return range;
  }
}

/**
 * Open everything folded around a match, from the outside in, so it is on
 * view: each `<details>` (a subagent's records the opening as the person's
 * own choice through its `toggle`), and each fold of the page's own.
 */
export function revealMatch(match: Range, root: Element): void {
  const folds: Element[] = [];
  for (
    let element = match.startContainer.parentElement;
    element !== null && element !== root;
    element = element.parentElement
  ) {
    folds.unshift(element);
  }
  for (const element of folds) {
    if (element instanceof HTMLDetailsElement && !element.open)
      element.open = true;
    if (element.hasAttribute(FIND_FOLD))
      element.dispatchEvent(new Event(REVEAL_EVENT));
  }
}

/**
 * Scroll a match to the middle of everything that scrolls around it, from the
 * inside out: a code block's own sideways scroll, then the transcript's.
 * Centred on the match itself, not on the element it is in — a tool output
 * can be many screens tall.
 */
export function scrollMatchIntoView(match: Range): void {
  for (
    let element = match.startContainer.parentElement;
    element !== null;
    element = element.parentElement
  ) {
    const style = getComputedStyle(element);
    const down =
      /auto|scroll/.test(style.overflowY) &&
      element.scrollHeight > element.clientHeight;
    const across =
      /auto|scroll/.test(style.overflowX) &&
      element.scrollWidth > element.clientWidth;
    if (!down && !across) continue;
    const box = match.getBoundingClientRect();
    const view = element.getBoundingClientRect();
    if (down)
      element.scrollTop +=
        box.top + box.height / 2 - (view.top + view.height / 2);
    if (across)
      element.scrollLeft +=
        box.left + box.width / 2 - (view.left + view.width / 2);
  }
}
