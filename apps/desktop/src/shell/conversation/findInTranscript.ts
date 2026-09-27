/**
 * Finding words in a drawn conversation: the one search behind the find bar
 * (`FindBar.tsx`).
 *
 * It searches the transcript as the page draws it — every word of it, since
 * the whole transcript is always in the document (`ConversationSurface`) and
 * nothing that folds leaves anything out: a closed tool call keeps its input
 * and output in its `<details>`, a cut readable view keeps its end under the
 * `Clip`, a long message not from the person keeps its lines past the fold
 * `hidden`. So what is found is what the conversation says, folded or not,
 * and a match is a DOM `Range` the page can highlight and bring into view.
 *
 * Only the conversation's own words are searched. The page's controls
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

/** The nearest element around `node` that is a block of its own. */
function blockOf(node: Node, root: Element): Element {
  let element = node.parentElement;
  while (element !== null && element !== root && INLINE.has(element.tagName))
    element = element.parentElement;
  return element ?? root;
}

/** Each run of text that reads as one block, as its text nodes in order. */
function textRuns(root: Element): Text[][] {
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) =>
        node.parentElement?.closest(SKIPPED)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    },
  );
  const runs: Text[][] = [];
  let block: Element | undefined;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text;
    if (text.data === "") continue;
    const at = blockOf(text, root);
    if (at !== block || runs.length === 0) runs.push([]);
    block = at;
    runs.at(-1)!.push(text);
  }
  return runs;
}

/** Where in a run's text nodes the character at `offset` of their joined text is. */
function pointAt(
  nodes: readonly Text[],
  starts: readonly number[],
  offset: number,
  end: boolean,
): [Text, number] {
  // An end falls at the end of the node it closes, not the start of the next.
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const start = starts[index]!;
    if (end ? offset > start : offset >= start)
      return [nodes[index]!, offset - start];
  }
  throw new Error(`offset ${offset} is outside the text it was found in`);
}

/**
 * The text in lower case, character for character: one whose lower case is
 * longer (`İ`) is kept as it is, so an offset in the folded text is the same
 * offset in the text.
 */
function foldCase(text: string): string {
  let folded = "";
  for (const character of text) {
    const lower = character.toLowerCase();
    folded += lower.length === character.length ? lower : character;
  }
  return folded;
}

/**
 * Every place `query` occurs in what `root` draws, in document order. Case
 * is ignored unless `caseSensitive`. An empty query finds nothing.
 */
export function findMatches(
  root: Element,
  query: string,
  caseSensitive: boolean,
): Range[] {
  if (query === "") return [];
  const fold = (text: string) => (caseSensitive ? text : foldCase(text));
  const wanted = fold(query);
  const matches: Range[] = [];
  for (const nodes of textRuns(root)) {
    const starts: number[] = [];
    let joined = "";
    for (const node of nodes) {
      starts.push(joined.length);
      joined += node.data;
    }
    const haystack = fold(joined);
    for (
      let at = haystack.indexOf(wanted);
      at >= 0;
      at = haystack.indexOf(wanted, at + wanted.length)
    ) {
      const range = root.ownerDocument.createRange();
      range.setStart(...pointAt(nodes, starts, at, false));
      range.setEnd(...pointAt(nodes, starts, at + wanted.length, true));
      matches.push(range);
    }
  }
  return matches;
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

/** Whether two ranges start at the same place. */
export function sameStart(one: Range, other: Range): boolean {
  return (
    one.startContainer === other.startContainer &&
    one.startOffset === other.startOffset
  );
}

/**
 * Which of `matches` is the current one after they were found again, so it
 * stays put while the conversation grows: the one that starts where
 * `previous` did, else the first after it, else the first. A previous match
 * whose text was drawn again (its entry changed) is kept by its place in the
 * list, `previousIndex`. Nothing when there is no match.
 */
export function keptCurrent(
  matches: readonly Range[],
  previous: Range | undefined,
  previousIndex: number | undefined,
): number | undefined {
  if (matches.length === 0) return undefined;
  if (previous === undefined || previousIndex === undefined) return 0;
  if (!previous.startContainer.isConnected)
    return Math.min(previousIndex, matches.length - 1);
  const same = matches.findIndex((match) => sameStart(match, previous));
  if (same >= 0) return same;
  const after = matches.findIndex(
    (match) => match.compareBoundaryPoints(Range.START_TO_START, previous) > 0,
  );
  return after >= 0 ? after : 0;
}
