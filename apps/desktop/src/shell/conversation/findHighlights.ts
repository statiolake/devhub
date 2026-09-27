/**
 * The find bar's matches, painted: the CSS Custom Highlight API, which marks
 * ranges of text without touching the document React draws.
 *
 * A highlight is named in the stylesheet (`::highlight(conversation-find)`),
 * and a page holds one registry of them — while the Agents page may hold
 * several GUI conversations, each with its own find bar. So every bar owns
 * its own ranges here, and the two named highlights are the union of what
 * every bar has: its matches on view, and its current one.
 */

/** The matches on view of every open find bar. */
export const MATCH_HIGHLIGHT = "conversation-find";
/** Each open find bar's current match. */
export const CURRENT_HIGHLIGHT = "conversation-find-current";

interface Painted {
  readonly matches: readonly Range[];
  readonly current: Range | undefined;
}

const painted = new Map<object, Painted>();

function registry(): HighlightRegistry {
  // Chromium has had it since 105; a page without it cannot show a match.
  if (typeof CSS === "undefined" || CSS.highlights === undefined)
    throw new Error(
      "this page has no CSS Custom Highlight API, so the find bar cannot mark its matches",
    );
  return CSS.highlights;
}

/**
 * The two highlights, rebuilt from every bar's ranges, added one by one: a
 * list of any length is never spread into a call's arguments, whose number
 * the stack bounds.
 */
function repaint(): void {
  const highlights = registry();
  const matches = new Highlight();
  const current = new Highlight();
  for (const each of painted.values()) {
    for (const match of each.matches) matches.add(match);
    if (each.current !== undefined) current.add(each.current);
  }
  highlights.set(MATCH_HIGHLIGHT, matches);
  highlights.set(CURRENT_HIGHLIGHT, current);
}

/** Whether two ranges cover the same text. */
function same(one: Range | undefined, other: Range | undefined): boolean {
  if (one === undefined || other === undefined) return one === other;
  return (
    one.startContainer === other.startContainer &&
    one.startOffset === other.startOffset &&
    one.endContainer === other.endContainer &&
    one.endOffset === other.endOffset
  );
}

/**
 * What `owner`'s find bar has found on view now, and its current match.
 * Nothing is repainted when that is what is painted already — as while a
 * search counts on far from the view: each change to the registry has the
 * page repaint every highlight.
 */
export function paintMatches(
  owner: object,
  matches: readonly Range[],
  current: Range | undefined,
): void {
  const was = painted.get(owner);
  if (
    was !== undefined &&
    same(was.current, current) &&
    was.matches.length === matches.length &&
    was.matches.every((match, index) => same(match, matches[index]))
  )
    return;
  painted.set(owner, { matches, current });
  repaint();
}

/** `owner`'s find bar closed, or went away: none of its matches are shown. */
export function clearMatches(owner: object): void {
  if (!painted.delete(owner)) return;
  repaint();
}
