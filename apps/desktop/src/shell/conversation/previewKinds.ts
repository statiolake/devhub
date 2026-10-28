/**
 * Which blocks of an answer are drawn as what they say rather than as their
 * source: the one registry of previewable kinds.
 *
 * A kind is a format the conversation can draw — an SVG, a Mermaid diagram, a
 * Markdown document, a Marp deck. Each is recognised the same way wherever
 * it appears: as a fenced block, by the fence's first info word and its
 * contents (` ```svg `), and as a file an answer embeds, by its extension
 * and its contents (`![](chart.svg)`). The order of `PREVIEW_KINDS` is the
 * order they are tried in, so a more particular kind (a Marp deck is
 * Markdown with `marp: true` in its front matter) comes before the general one.
 *
 * What a kind looks like drawn is not here: this module is only the facts,
 * so that the detection can be tested and read without React. `Preview.tsx`
 * maps each kind to the component that draws it, and owns the one thing every
 * kind shares — the toggle between the drawing and its source, and which of
 * the two is shown first (`defaultView`; a fence still being written is
 * always its source, see `Markdown.tsx`).
 */

import { diagramKindOf } from "./diagramSvg";

export type PreviewKindId = "marp" | "markdown" | "mermaid" | "svg";

export interface PreviewKind {
  readonly id: PreviewKindId;
  /** Fence info words that may be this kind (lower case). */
  readonly languages: readonly string[];
  /** File extensions that may be this kind (lower case, with the dot). */
  readonly extensions: readonly string[];
  /**
   * Whether `code` is this kind, given the info word it came under
   * (`undefined` for a file, whose extension has already matched).
   */
  readonly accepts: (code: string, word: string | undefined) => boolean;
  /** What the toggle back from the source says: "Show diagram". */
  readonly showLabel: string;
  /** Which of the two a settled block is drawn as first. */
  readonly defaultView: "preview" | "source";
  /**
   * Whether this kind draws Markdown inside the conversation's own renderer,
   * so that drawing it again inside itself has to stop somewhere.
   */
  readonly nests?: boolean;
}

/**
 * How deep a Markdown preview may sit inside another: a ```markdown block in
 * a ```markdown block in an answer is drawn, one deeper is its source. A
 * document that quotes itself is not drawn forever.
 */
export const MAX_PREVIEW_DEPTH = 2;

const FRONT_MATTER =
  /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/u;

/** Whether `markdown`'s front matter says it is a Marp deck (`marp: true`). */
export function isMarpDeck(markdown: string): boolean {
  const matter = FRONT_MATTER.exec(markdown);
  if (matter === null) return false;
  return /^marp[ \t]*:[ \t]*(?:true|"true"|'true')[ \t]*(?:#.*)?$/mu.test(
    matter[1]!,
  );
}

const hasText = (code: string) => code.trim() !== "";

export const PREVIEW_KINDS: readonly PreviewKind[] = [
  {
    id: "svg",
    languages: ["svg", "xml"],
    extensions: [".svg"],
    accepts: (code) => diagramKindOf("svg", code) === "svg",
    showLabel: "Show image",
    defaultView: "preview",
  },
  {
    id: "mermaid",
    languages: ["mermaid"],
    extensions: [".mmd", ".mermaid"],
    accepts: hasText,
    showLabel: "Show diagram",
    defaultView: "preview",
  },
  {
    id: "marp",
    languages: ["marp", "markdown", "md"],
    extensions: [".md", ".markdown"],
    // Under ```marp it is a deck whatever its front matter says; under
    // ```markdown, or as a file, only when it says so itself.
    accepts: (code, word) =>
      word === "marp" ? hasText(code) : isMarpDeck(code),
    showLabel: "Show slides",
    defaultView: "preview",
  },
  {
    id: "markdown",
    languages: ["markdown", "md"],
    extensions: [".md", ".markdown"],
    accepts: hasText,
    showLabel: "Show preview",
    defaultView: "preview",
    nests: true,
  },
];

/** A fence's first info word, lower case: ```Mermaid title → `mermaid`. */
export function fenceWord(info: string | undefined): string | undefined {
  const word = info?.trim().split(/\s+/u, 1)[0]?.toLowerCase();
  return word === "" ? undefined : word;
}

/**
 * The kind a fenced block is drawn as, or `undefined` for code. `depth` is
 * how many Markdown previews it is already inside.
 */
export function previewKindOfFence(
  info: string | undefined,
  code: string,
  depth = 0,
): PreviewKind | undefined {
  const word = fenceWord(info);
  if (word === undefined) return undefined;
  return PREVIEW_KINDS.find(
    (kind) =>
      kind.languages.includes(word) &&
      !(kind.nests === true && depth >= MAX_PREVIEW_DEPTH) &&
      kind.accepts(code, word),
  );
}

/** A path's extension, lower case with its dot: `a/Chart.SVG` → `.svg`. */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/** The kinds a file may be by its name, in the order they are tried. */
export function previewKindsOfPath(path: string): readonly PreviewKind[] {
  const extension = extensionOf(path);
  return PREVIEW_KINDS.filter((kind) => kind.extensions.includes(extension));
}

/** The kind a file's contents are drawn as, or `undefined` when none fits. */
export function previewKindOfFile(
  path: string,
  text: string,
  depth = 0,
): PreviewKind | undefined {
  return previewKindsOfPath(path).find(
    (kind) =>
      !(kind.nests === true && depth >= MAX_PREVIEW_DEPTH) &&
      kind.accepts(text, undefined),
  );
}
