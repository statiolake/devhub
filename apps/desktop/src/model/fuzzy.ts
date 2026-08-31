/**
 * How well a candidate matches what was typed.
 *
 * One scorer, used by every picker there is and by the source that feeds them.
 * That is the whole point of it living here: the workspace search runs in main,
 * over sources it alone can read, while the sheet in the window ranks and
 * filters what has arrived so far — and a person typing must not see two
 * different answers to "does this match" depending on which side happened to
 * decide. Splitting it in two is how a row that main sent stays on screen
 * under a query it no longer matches.
 *
 * Subsequence matching, with a bonus for a hit in the last path component: a
 * person filtering "hub" means the folder, not a parent directory that happens
 * to contain the letters. A candidate that does not match at all scores zero,
 * which is what "not in the list" means everywhere it is used.
 */

/** The last path component of a candidate, or the whole of it when it has none. */
function lastComponent(text: string): string {
  const cut = text.lastIndexOf("/");
  return cut < 0 ? text : text.slice(cut + 1);
}

export function score(searchText: string, query: string): number {
  if (query.length === 0) return 1;
  const haystack = searchText.toLowerCase();
  const needle = query.toLowerCase();
  let index = 0;
  for (const character of needle) {
    index = haystack.indexOf(character, index);
    if (index < 0) return 0;
    index += 1;
  }
  return lastComponent(haystack).includes(needle) ? 100 : 10;
}
