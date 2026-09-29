/**
 * The file paths in a piece of the conversation's text, found by their
 * spelling alone.
 *
 * This is the first of two gates, and the loose one: it says which words
 * *could* name a file, and main says which of those do, on the Agent's own
 * machine (`pathLinks.ts`). Only a word both gates pass is drawn as a link, so
 * this side leans towards asking — a word that is not a file costs one line of
 * a batched `test -f` — and never towards guessing a link itself.
 *
 * The rule, which `docs/agent-gui.md` states for the person:
 *
 * - A path is one word. Whitespace, quotes, backticks, brackets and braces,
 *   `, ; | = * ?` and CJK punctuation end it, so a path with a space in it, or
 *   one quoted in a way this cannot see through, is not found.
 * - A path has no `:` in it: the first colon starts its position. `:12`,
 *   `:12:5` and `:12-20` are a line, a line and column, and a range of lines;
 *   GitHub's `#L12` and `#L12-L20` are the same line and range. Whatever
 *   follows the position (`src/a.ts:12:const x` in grep's output) is not part
 *   of the link.
 * - A word is a candidate when it is absolute, starts with `~/`, or is
 *   relative and either has a `/` in it or ends in a file extension (`a.ts`).
 *   A URL (`scheme://…`) is not a path; a trailing full stop or `!` is the
 *   sentence's, not the file's.
 */

import type { FileRange } from "../../ipc/conversation";

/** A path as the text spells it, and where it points in the file. */
export interface PathCandidate {
  /** As written: absolute, `~/…`, or relative to the Agent's directory. */
  readonly path: string;
  readonly range: FileRange | undefined;
}

/** A candidate, and the characters of the text it covers — its position included. */
export interface PathSpan extends PathCandidate {
  readonly start: number;
  readonly end: number;
}

/** Everything that ends a word, a path's included. */
const WORD = /[^\s"'`<>()[\]{},;|=*?\u3000-\u303f\uff08\uff09\uff0c\uff1a]+/gu;

/** `:12`, `:12:5`, `:12-20`, `#L12`, `#L12-L20`, at the start of what follows a path. */
const POSITION =
  /^(?::(?<line>\d+)(?:(?<sep>[:-])(?<second>\d+))?|#L(?<gLine>\d+)(?:-L(?<gTo>\d+))?)/u;

/** A relative name without a `/` is a candidate only as a file with an extension. */
const FILE_NAME = /^\.?[\w@+.-]*[A-Za-z][\w@+.-]*\.[A-Za-z0-9]{1,12}$/u;

export function pathSpans(text: string): readonly PathSpan[] {
  const spans: PathSpan[] = [];
  for (const match of text.matchAll(WORD)) {
    const span = spanOf(match[0], match.index);
    if (span !== undefined) spans.push(span);
  }
  return spans;
}

function spanOf(word: string, start: number): PathSpan | undefined {
  if (word.includes("://")) return undefined;
  const colon = word.indexOf(":");
  const hash = word.search(/#L\d/u);
  const cut = [colon, hash]
    .filter((at) => at >= 0)
    .reduce((least, at) => Math.min(least, at), word.length);
  let path = word.slice(0, cut);
  const rest = word.slice(cut);
  const position = POSITION.exec(rest);
  const range = position === null ? undefined : rangeOf(position.groups ?? {});
  if (range === undefined) path = path.replace(/[.!]+$/u, "");
  if (!isCandidate(path)) return undefined;
  const covered =
    range === undefined ? path.length : cut + (position?.[0].length ?? 0);
  return { path, range, start, end: start + covered };
}

function rangeOf(
  groups: Partial<Record<string, string>>,
): FileRange | undefined {
  const line = Number(groups["line"] ?? groups["gLine"]);
  if (!Number.isInteger(line) || line < 1) return undefined;
  const to = Number(
    groups["gTo"] ?? (groups["sep"] === "-" ? groups["second"] : NaN),
  );
  if (Number.isInteger(to)) {
    return to > line
      ? { kind: "lines", from: line, to }
      : { kind: "line", line, column: 1 };
  }
  const column = groups["sep"] === ":" ? Number(groups["second"]) : 1;
  return { kind: "line", line, column: column >= 1 ? column : 1 };
}

function isCandidate(path: string): boolean {
  if (path === "" || path.endsWith("/") || path.startsWith("-")) return false;
  if (path.startsWith("~") && !path.startsWith("~/")) return false;
  if (path.includes("/")) return /[A-Za-z0-9_]/u.test(path);
  return FILE_NAME.test(path);
}

/** `:12`, `:12:5`, `:12-20`: a range as the text after a path would spell it. */
export function rangeSuffix(range: FileRange | undefined): string {
  if (range === undefined) return "";
  return range.kind === "line"
    ? `:${range.line}${range.column === 1 ? "" : `:${range.column}`}`
    : `:${range.from}-${range.to}`;
}
