/**
 * The find bar's matches, painted: the CSS Custom Highlight API, which marks
 * ranges of text without touching the document React draws.
 *
 * A highlight is named in the stylesheet (`::highlight(conversation-find)`),
 * and a page holds one registry of them — while the Agents page may hold
 * several GUI conversations, each with its own find bar. So every bar owns
 * its own ranges here, and the two named highlights are the union of what
 * every bar has: all matches, and each bar's current one.
 */

/** Every match of every open find bar. */
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

function repaint(): void {
  const highlights = registry();
  const all = [...painted.values()];
  highlights.set(
    MATCH_HIGHLIGHT,
    new Highlight(...all.flatMap((each) => each.matches)),
  );
  highlights.set(
    CURRENT_HIGHLIGHT,
    new Highlight(
      ...all.flatMap((each) =>
        each.current === undefined ? [] : [each.current],
      ),
    ),
  );
}

/** What `owner`'s find bar has found now, and which of it is current. */
export function paintMatches(
  owner: object,
  matches: readonly Range[],
  current: Range | undefined,
): void {
  painted.set(owner, { matches, current });
  repaint();
}

/** `owner`'s find bar closed, or went away: none of its matches are shown. */
export function clearMatches(owner: object): void {
  if (!painted.delete(owner)) return;
  repaint();
}
