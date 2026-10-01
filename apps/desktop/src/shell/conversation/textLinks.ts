/**
 * The links in a piece of the conversation's text, found by their spelling
 * alone: file paths, and GitHub Issue and pull request references.
 *
 * One tokenizer for both, so a word is read once and is at most one of them:
 * `owner/repo#12` is a reference and never also a path, and `src/a.ts#L12` is
 * a path's line and never a reference. Every place a path is looked for is a
 * place a reference is looked for (`LinkedText`), and no other.
 *
 * **Paths.** This is the first of two gates, and the loose one: it says which
 * words *could* name a file, and main says which of those do, on the Agent's
 * own machine (`pathLinks.ts`). Only a word both gates pass is drawn as a
 * link, so this side leans towards asking — a word that is not a file costs
 * one line of a batched `test -f` — and never towards guessing a link itself.
 *
 * **References.** `#12` and `owner/repo#12`, which GitHub itself links. A
 * reference needs no second gate: `owner/repo#12` names its repository, and a
 * bare `#12` is a link only when the Agent's Workspace has a GitHub repository
 * to number it in (`issueLinks.tsx`).
 *
 * The rule, which `docs/agent-gui.md` states for the person:
 *
 * - A link is inside one word. Whitespace, quotes, backticks, brackets and
 *   braces, `, ; | = * ?` and CJK punctuation end it, so a path with a space
 *   in it, or one quoted in a way this cannot see through, is not found.
 * - A word with `://` in it is a URL, and nothing in it is either kind: a
 *   `#12` in a URL is the URL's.
 * - A reference is `#` and a number, with `owner/repo` before it or not, not
 *   run on from a letter, digit, `/`, `.`, `#`, `&` or `@` before it
 *   (`PR#12`, `a.ts#12`, `&#12;`) nor into one after it (`#12a`). Anything
 *   else, CJK included, may stand either side: `#12を` is `#12`. A word with a
 *   reference in it is not also looked through for a path.
 * - A path has no `:` in it: the first colon starts its position. `:12`,
 *   `:12:5` and `:12-20` are a line, a line and column, and a range of lines;
 *   GitHub's `#L12` and `#L12-L20` are the same line and range. Whatever
 *   follows the position (`src/a.ts:12:const x` in grep's output) is not part
 *   of the link.
 * - A word is a path candidate when it is absolute, starts with `~/`, or is
 *   relative and either has a `/` in it or ends in a file extension (`a.ts`).
 *   A trailing full stop or `!` is the sentence's, not the file's.
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
  readonly kind: "path";
  readonly start: number;
  readonly end: number;
}

/** An Issue or pull request, as the text names it. */
export interface IssueReference {
  /** `owner/repo` as written, or `undefined` for a bare `#12`. */
  readonly repository:
    | { readonly owner: string; readonly repository: string }
    | undefined;
  readonly number: number;
}

/** A reference, and the characters of the text it covers. */
export interface IssueSpan extends IssueReference {
  readonly kind: "issue";
  readonly start: number;
  readonly end: number;
}

export type LinkSpan = PathSpan | IssueSpan;

/** Everything that ends a word, a path's included. */
const WORD = /[^\s"'`<>()[\]{},;|=*?\u3000-\u303f\uff08\uff09\uff0c\uff1a]+/gu;

/** `:12`, `:12:5`, `:12-20`, `#L12`, `#L12-L20`, at the start of what follows a path. */
const POSITION =
  /^(?::(?<line>\d+)(?:(?<sep>[:-])(?<second>\d+))?|#L(?<gLine>\d+)(?:-L(?<gTo>\d+))?)/u;

/** A relative name without a `/` is a candidate only as a file with an extension. */
const FILE_NAME = /^\.?[\w@+.-]*[A-Za-z][\w@+.-]*\.[A-Za-z0-9]{1,12}$/u;

/**
 * `#12` or `owner/repo#12`, inside a word. The owner is GitHub's spelling of a
 * login (letters, digits, single hyphens); the repository is GitHub's of a
 * name.
 */
const ISSUE =
  /(?<![\w./#&@-])(?:(?<owner>[A-Za-z0-9](?:-?[A-Za-z0-9])*)\/(?<repository>[\w.-]+))?#(?<number>[1-9]\d{0,9})(?!\w)/gu;

/** Every link candidate in `text`, in order, none overlapping. */
export function linkSpans(text: string): readonly LinkSpan[] {
  const spans: LinkSpan[] = [];
  for (const match of text.matchAll(WORD)) {
    const word = match[0];
    if (word.includes("://")) continue;
    const issues = issueSpans(word, match.index);
    if (issues.length > 0) {
      spans.push(...issues);
      continue;
    }
    const path = pathSpanOf(word, match.index);
    if (path !== undefined) spans.push(path);
  }
  return spans;
}

function issueSpans(word: string, start: number): readonly IssueSpan[] {
  return [...word.matchAll(ISSUE)].map((match) => {
    const { owner, repository, number } = match.groups ?? {};
    return {
      kind: "issue",
      repository:
        owner !== undefined && repository !== undefined
          ? { owner, repository }
          : undefined,
      number: Number(number),
      start: start + match.index,
      end: start + match.index + match[0].length,
    };
  });
}

function pathSpanOf(word: string, start: number): PathSpan | undefined {
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
  return { kind: "path", path, range, start, end: start + covered };
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

/**
 * The file a Markdown link's target names, when it names one rather than a
 * page: `[a.ts](src/a.ts)`, `[a.ts](/abs/a.ts#L12)`, `[a.ts](file:///abs/a.ts)`.
 * `undefined` for a URL with any other scheme, and for an anchor (`#usage`),
 * which are the browser's.
 *
 * Unlike a word in prose, a link's target is a path because the Agent wrote it
 * as one, so it needs no spelling to look like one: only the second gate,
 * main's, applies, when it is followed.
 */
export function pathOfHref(href: string): PathCandidate | undefined {
  let target = href.trim();
  if (/^file:/iu.test(target)) {
    try {
      const url = new URL(target);
      target = decodeURIComponent(url.pathname) + url.hash;
    } catch {
      return undefined;
    }
  } else if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target)) {
    return undefined;
  } else {
    try {
      target = decodeURIComponent(target);
    } catch {
      // A stray `%` is the name's own.
    }
  }
  if (target === "" || target.startsWith("#")) return undefined;
  const colon = target.indexOf(":");
  const hash = target.search(/#L\d/u);
  const cut = [colon, hash]
    .filter((at) => at >= 0)
    .reduce((least, at) => Math.min(least, at), target.length);
  const path = target.slice(0, cut).replace(/[?#].*$/u, "");
  if (path === "" || path.endsWith("/")) return undefined;
  const position = POSITION.exec(target.slice(cut));
  return {
    path,
    range: position === null ? undefined : rangeOf(position.groups ?? {}),
  };
}

/** `:12`, `:12:5`, `:12-20`: a range as the text after a path would spell it. */
export function rangeSuffix(range: FileRange | undefined): string {
  if (range === undefined) return "";
  return range.kind === "line"
    ? `:${range.line}${range.column === 1 ? "" : `:${range.column}`}`
    : `:${range.from}-${range.to}`;
}
