/**
 * Links in a terminal pane (`docs/terminal-mode.md`, "Links"): a cell's OSC
 * 8 hyperlink, which the engine reads per cell and the frames carry
 * (`VtRow.links`), and a URL written as plain text, found on its row the
 * way Ghostty and iTerm find one. Which schemes DevHub hands to the system
 * is `openableLink`.
 *
 * Pure.
 */

import type { Cell, Rows } from "./selection";

/** A link's cells, both ends inclusive, in reading order, and its URI. */
export interface LinkSpan {
  readonly uri: string;
  readonly start: Cell;
  readonly end: Cell;
}

/**
 * The cells an OSC 8 link covers around `at`: the run of cells with its id,
 * on across soft wraps and rows the link goes on in (a link printed over
 * two lines is one link).
 */
export function linkSpan(
  rows: Rows,
  ids: (x: number, y: number) => number,
  uri: (id: number) => string | undefined,
  at: Cell,
): LinkSpan | undefined {
  const id = ids(at.x, at.y);
  const target = id === 0 ? undefined : uri(id);
  if (target === undefined) return undefined;
  const step = (c: Cell, by: 1 | -1): Cell | undefined => {
    const x = c.x + by;
    if (x >= 0 && x < rows.width) return { x, y: c.y };
    const y = c.y + by;
    if (y < 0 || y >= rows.height) return undefined;
    return { x: by > 0 ? 0 : rows.width - 1, y };
  };
  let start = at;
  for (
    let p = step(start, -1);
    p !== undefined && ids(p.x, p.y) === id;
    p = step(p, -1)
  )
    start = p;
  let end = at;
  for (
    let n = step(end, 1);
    n !== undefined && ids(n.x, n.y) === id;
    n = step(n, 1)
  )
    end = n;
  return { uri: target, start, end };
}

/** A URL in text: a scheme DevHub opens and what follows it up to a blank or a bracket. */
const URL_PATTERN =
  /\b(?:https?:\/\/|mailto:|ftp:\/\/)[^\s<>"'`│]*[^\s<>"'`│.,:;!?\]}]/g;

/**
 * A URL written as text over the cell `at` (no OSC 8 link): the row's text
 * and the soft-wrapped rows it goes on in, matched as a whole, so a URL
 * the terminal wrapped is found whole. A `)` closes only a `(` it holds,
 * as Ghostty takes `https://en.wikipedia.org/wiki/Foo_(bar)`.
 */
export function plainUrlAt(rows: Rows, at: Cell): LinkSpan | undefined {
  let top = at.y;
  while (top > 0 && rows.wrapped(top - 1)) top--;
  let bottom = at.y;
  while (bottom + 1 < rows.height && rows.wrapped(bottom)) bottom++;
  // The line's text, and the cell each UTF-16 unit of it came from.
  let text = "";
  const from: Cell[] = [];
  for (let y = top; y <= bottom; y++)
    for (let x = 0; x < rows.width; x++) {
      const c = rows.cell(x, y);
      if (c === "") continue;
      for (let i = 0; i < c.length; i++) from.push({ x, y });
      text += c;
    }
  for (const match of text.matchAll(URL_PATTERN)) {
    let url = match[0];
    // A closing bracket the URL does not open is the text's, not the URL's.
    for (;;) {
      if (url.endsWith(")") && count(url, "(") < count(url, ")"))
        url = url.slice(0, -1);
      else if (/[.,:;!?]$/.test(url)) url = url.slice(0, -1);
      else break;
    }
    const first = from[match.index];
    const lastAt = from[match.index + url.length - 1];
    if (first === undefined || lastAt === undefined) continue;
    const inside =
      (at.y > first.y || (at.y === first.y && at.x >= first.x)) &&
      (at.y < lastAt.y ||
        (at.y === lastAt.y &&
          (at.x <= lastAt.x ||
            (at.x === lastAt.x + 1 && rows.cell(at.x, at.y) === ""))));
    if (!inside) continue;
    const end =
      lastAt.x + 1 < rows.width && rows.cell(lastAt.x + 1, lastAt.y) === ""
        ? { x: lastAt.x + 1, y: lastAt.y }
        : lastAt;
    return { uri: url, start: first, end };
  }
  return undefined;
}

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}

/**
 * Whether DevHub hands a terminal's link to the system: the web, mail and
 * FTP. Anything else (`file:`, a custom scheme an app registered) could
 * open or run something on this machine from text a program printed; it is
 * refused, and said.
 */
export function openableLink(uri: string): boolean {
  return /^(https?:\/\/|mailto:|ftp:\/\/)/i.test(uri);
}

/** The cells of a span, per row, to underline. */
export function spanRows(
  span: { readonly start: Cell; readonly end: Cell },
  width: number,
): { y: number; x0: number; x1: number }[] {
  const out: { y: number; x0: number; x1: number }[] = [];
  for (let y = span.start.y; y <= span.end.y; y++)
    out.push({
      y,
      x0: y === span.start.y ? span.start.x : 0,
      x1: y === span.end.y ? span.end.x : width - 1,
    });
  return out;
}
