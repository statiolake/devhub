/**
 * `gui.document` on the page: what Lua sends of a document (its text, the
 * folder its links are found in), where it is (its window, the source line
 * Neovim has at the window's top, the link the keyboard is on), and what the
 * keys ask of it (a scroll, a link followed) — and the one piece of state
 * the page keeps: how far down, in pixels, its drawing is scrolled.
 *
 * The drawing tags each block with the source line it starts at
 * (`data-source-line`, `Markdown.tsx`'s `sourceLines`), so a source line is
 * a height in the drawing and a height is a source line (`pixelOfLine`,
 * `lineAtPixel`), interpolated between the blocks. See
 * `neovimDocument.ts` and `docs/neovim-editor.md`, "Documents".
 */

import { luaList } from "./components";

export interface DocumentContent {
  readonly id: number;
  readonly format: "markdown";
  readonly text: string;
  /** The folder its relative links and pictures are found in, on the Neovim's machine. */
  readonly base: string;
  /** Pictures from the web are drawn (else a placeholder). */
  readonly remoteImages: boolean;
  readonly title: string | undefined;
}

export interface DocumentPlace {
  readonly id: number;
  readonly win: number;
  /** The source line at the window's top, as Neovim has it. */
  readonly topline: number;
  readonly current: boolean;
  /** Neovim's top is the one the page last said: nothing to follow. */
  readonly told: boolean;
  /** The link the keyboard is on (`<Tab>`): its line and its target. */
  readonly focus: { readonly line: number; readonly href: string } | undefined;
}

/** A scroll the keys asked for (`seq` tells a new one). */
export interface DocumentScroll {
  readonly seq: number;
  readonly by: "line" | "half" | "page" | "top" | "bottom" | "to";
  readonly n: number;
  /** For `to`: the source line to put at the top. */
  readonly line: number | undefined;
}

/** A link the keys followed (`<CR>`). */
export interface DocumentActivation {
  readonly seq: number;
  readonly line: number;
  readonly href: string;
}

export interface DocumentLayers {
  readonly documents: ReadonlyMap<number, DocumentContent>;
  readonly placedDocuments: readonly DocumentPlace[];
  readonly documentScrolls: ReadonlyMap<number, DocumentScroll>;
  readonly documentActivations: ReadonlyMap<number, DocumentActivation>;
}

export const NO_DOCUMENTS: DocumentLayers = {
  documents: new Map(),
  placedDocuments: [],
  documentScrolls: new Map(),
  documentActivations: new Map(),
};

export const DOCUMENT_EVENTS: ReadonlySet<string> = new Set([
  "document",
  "document_clear",
  "documents",
  "document_scroll",
  "document_activate",
]);

type Rec = Readonly<Record<string, unknown>>;

function rec(value: unknown): Rec | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

function int(r: Rec, key: string): number | undefined {
  const v = r[key];
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

/** A document of at most this many characters is drawn (a book is not). */
export const MAX_DOCUMENT = 4_000_000;

const SCROLLS = new Set(["line", "half", "page", "top", "bottom", "to"]);

function without<T>(map: ReadonlyMap<number, T>, id: number): Map<number, T> {
  const next = new Map(map);
  next.delete(id);
  return next;
}

/** One document event, applied; anything of the wrong shape is ignored. */
export function applyDocumentEvent<S extends DocumentLayers>(
  state: S,
  kind: string,
  payload: unknown,
): S {
  const p = rec(payload);
  if (!p) return state;
  const id = int(p, "id");
  switch (kind) {
    case "document": {
      if (id === undefined || typeof p["text"] !== "string") return state;
      const content: DocumentContent = {
        id,
        format: "markdown",
        text: p["text"].slice(0, MAX_DOCUMENT),
        base: typeof p["base"] === "string" ? p["base"] : "",
        remoteImages: p["remote_images"] === true,
        title: typeof p["title"] === "string" ? p["title"] : undefined,
      };
      return {
        ...state,
        documents: new Map(state.documents).set(id, content),
      };
    }
    case "document_clear":
      if (id === undefined) return state;
      return {
        ...state,
        documents: without(state.documents, id),
        documentScrolls: without(state.documentScrolls, id),
        documentActivations: without(state.documentActivations, id),
        placedDocuments: state.placedDocuments.filter((d) => d.id !== id),
      };
    case "documents":
      return {
        ...state,
        placedDocuments: luaList(p["documents"]).flatMap(
          (value): DocumentPlace[] => {
            const r = rec(value);
            const one = r ? int(r, "id") : undefined;
            const win = r ? int(r, "win") : undefined;
            const topline = r ? int(r, "topline") : undefined;
            if (
              !r ||
              one === undefined ||
              win === undefined ||
              topline === undefined
            )
              return [];
            const f = rec(r["focus"]);
            const line = f ? int(f, "line") : undefined;
            const href = f?.["href"];
            return [
              {
                id: one,
                win,
                topline: Math.max(1, topline),
                current: r["current"] === true,
                told: r["told"] === true,
                focus:
                  line !== undefined && typeof href === "string"
                    ? { line, href }
                    : undefined,
              },
            ];
          },
        ),
      };
    case "document_scroll": {
      const seq = int(p, "seq");
      const by = p["by"];
      if (
        id === undefined ||
        seq === undefined ||
        typeof by !== "string" ||
        !SCROLLS.has(by)
      )
        return state;
      return {
        ...state,
        documentScrolls: new Map(state.documentScrolls).set(id, {
          seq,
          by: by as DocumentScroll["by"],
          n: int(p, "n") ?? 1,
          line: int(p, "line"),
        }),
      };
    }
    case "document_activate": {
      const seq = int(p, "seq");
      const line = int(p, "line");
      const href = p["href"];
      if (
        id === undefined ||
        seq === undefined ||
        line === undefined ||
        typeof href !== "string"
      )
        return state;
      return {
        ...state,
        documentActivations: new Map(state.documentActivations).set(id, {
          seq,
          line,
          href,
        }),
      };
    }
    default:
      return state;
  }
}

/** A block of the drawing: the source line it starts at and its top, in pixels. */
export interface LineMark {
  readonly line: number;
  readonly top: number;
}

/**
 * The marks in order of line, one per line (the outermost block's: the
 * first seen), each lower than or level with the one before — a nested
 * block (an item in a list) that starts on its parent's line is its parent.
 */
export function lineMarks(raw: readonly LineMark[]): LineMark[] {
  const byLine = new Map<number, number>();
  for (const mark of raw) {
    if (!Number.isFinite(mark.line) || !Number.isFinite(mark.top)) continue;
    const known = byLine.get(mark.line);
    if (known === undefined || mark.top < known)
      byLine.set(mark.line, mark.top);
  }
  const sorted = [...byLine]
    .map(([line, top]) => ({ line, top }))
    .sort((a, b) => a.line - b.line);
  const out: LineMark[] = [];
  for (const mark of sorted) {
    const before = out.at(-1);
    out.push(
      before && mark.top < before.top
        ? { line: mark.line, top: before.top }
        : mark,
    );
  }
  return out;
}

/**
 * Where source line `line` is drawn: the top of the block it is in, and on
 * from there in proportion to how far into the block's lines it is.
 * `height` is the drawing's, for the last block.
 */
export function pixelOfLine(
  marks: readonly LineMark[],
  line: number,
  height: number,
  lineCount: number,
): number {
  if (marks.length === 0) return 0;
  let i = -1;
  for (let k = 0; k < marks.length; k += 1) {
    if (marks[k]!.line <= line) i = k;
    else break;
  }
  if (i < 0) return 0;
  const here = marks[i]!;
  const next = marks[i + 1] ?? {
    line: Math.max(lineCount + 1, here.line + 1),
    top: Math.max(here.top, height),
  };
  const span = next.line - here.line;
  const into = Math.min(1, Math.max(0, (line - here.line) / span));
  return here.top + into * (next.top - here.top);
}

/**
 * The source line drawn at height `y`, with how far into it (the inverse of
 * `pixelOfLine`): 12.5 is half way down line 12's share of its block.
 */
export function lineAtPixelExact(
  marks: readonly LineMark[],
  y: number,
  height: number,
  lineCount: number,
): number {
  if (marks.length === 0) return 1;
  let i = 0;
  for (let k = 0; k < marks.length; k += 1) {
    if (marks[k]!.top <= y) i = k;
    else break;
  }
  const here = marks[i]!;
  const next = marks[i + 1] ?? {
    line: Math.max(lineCount + 1, here.line + 1),
    top: Math.max(here.top, height),
  };
  const tall = next.top - here.top;
  const into = tall <= 0 ? 0 : Math.min(1, Math.max(0, (y - here.top) / tall));
  return Math.max(1, here.line + into * (next.line - here.line));
}

/** The source line drawn at height `y`: the one whose share holds it. */
export function lineAtPixel(
  marks: readonly LineMark[],
  y: number,
  height: number,
  lineCount: number,
): number {
  const exact = lineAtPixelExact(marks, y, height, lineCount);
  return Math.max(1, Math.min(Math.max(1, lineCount), Math.floor(exact)));
}

/** How far a scroll the keys asked for goes, from `top`, in pixels. */
export function scrolledTop(
  scroll: DocumentScroll,
  top: number,
  viewport: number,
  max: number,
  lineHeight: number,
  pixelOf: (line: number) => number,
): number {
  const clamp = (y: number) => Math.min(Math.max(0, max), Math.max(0, y));
  switch (scroll.by) {
    case "line":
      return clamp(top + scroll.n * lineHeight * 3);
    case "half":
      return clamp(top + (scroll.n * viewport) / 2);
    case "page":
      return clamp(
        top + scroll.n * Math.max(lineHeight, viewport - lineHeight * 2),
      );
    case "top":
      return 0;
    case "bottom":
      return clamp(max);
    case "to":
      return clamp(pixelOf(scroll.line ?? 1));
  }
}

/**
 * A heading's anchor, as GitHub makes it: lower case, punctuation gone,
 * spaces as hyphens; the second of a name gets `-1`, and so on.
 */
export function headingSlug(text: string, seen: Map<string, number>): string {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n === 0 ? base : `${base}-${String(n)}`;
}
