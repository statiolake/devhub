/**
 * Syntax colouring for a closed code block.
 *
 * Shiki with the grammars and the two default themes of VS Code itself, so a
 * block in a transcript is coloured the way the editor beside it colours the
 * same file. The regex engine is Shiki's JavaScript one: no WebAssembly to
 * ship or instantiate.
 *
 * Nothing loads until the first block asks. The highlighter, each grammar and
 * the themes are their own chunks, fetched on first use and kept: a person who
 * never sees a Rust block never downloads the Rust grammar. The set is closed —
 * a language outside it is drawn as plain monospace, which is what a fence with
 * no language is drawn as too. Every grammar here is MIT-licensed and named in
 * `distribution/THIRD-PARTY-NOTICES.txt`, with its source and licence in
 * `distribution/licenses/Shiki-grammars-and-themes-NOTICE.txt`; a grammar is
 * added by adding it here and there. A grammar that embeds another brings that
 * one into the bundle too, which is why neither Markdown (it embeds sixty) nor
 * C++ (it embeds a GLSL grammar with no stated licence) is here.
 *
 * Every token carries both themes' colours, and the stylesheet picks one with
 * `light-dark()`. A change of appearance is therefore a restyle, not a second
 * pass over every block in the transcript.
 */

import type {
  HighlighterCore,
  LanguageRegistration,
  ThemeRegistration,
} from "shiki/core";

type Grammar = () => Promise<{ default: LanguageRegistration[] }>;

const GRAMMARS = {
  c: () => import("shiki/langs/c.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  docker: () => import("shiki/langs/docker.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
} satisfies Record<string, Grammar>;

export type GrammarId = keyof typeof GRAMMARS;

/** What people write after the fence, for the grammars above. */
const ALIASES: Readonly<Record<string, GrammarId>> = {
  bash: "shellscript",
  cjs: "javascript",
  cs: "csharp",
  dockerfile: "docker",
  golang: "go",
  h: "c",
  htm: "html",
  js: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  mjs: "javascript",
  patch: "diff",
  py: "python",
  rs: "rust",
  sh: "shellscript",
  shell: "shellscript",
  svg: "xml",
  ts: "typescript",
  zsh: "shellscript",
};

/**
 * The grammar for a fence's info string (`ts`, `Python`, `rust ignore`), or
 * `undefined` for a language this build does not colour.
 */
export function grammarFor(info: string | undefined): GrammarId | undefined {
  const word = info?.trim().split(/\s+/, 1)[0]?.toLowerCase();
  if (!word) return undefined;
  if (Object.hasOwn(GRAMMARS, word)) return word as GrammarId;
  return Object.hasOwn(ALIASES, word) ? ALIASES[word] : undefined;
}

const LIGHT = "light-plus";
const DARK = "dark-plus";

interface Palette {
  readonly highlighter: HighlighterCore;
  /** Each theme's foreground: a token in it is drawn in the text's own ink. */
  readonly lightForeground: string;
  readonly darkForeground: string;
}

let palette: Promise<Palette> | undefined;
const grammarsLoaded = new Map<GrammarId, Promise<void>>();

async function createPalette(): Promise<Palette> {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] =
    await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
    ]);
  const themes: Promise<{ default: ThemeRegistration }>[] = [
    import("shiki/themes/light-plus.mjs"),
    import("shiki/themes/dark-plus.mjs"),
  ];
  const highlighter = await createHighlighterCore({
    themes,
    langs: [],
    engine: createJavaScriptRegexEngine(),
  });
  return {
    highlighter,
    lightForeground: highlighter.getTheme(LIGHT).fg.toLowerCase(),
    darkForeground: highlighter.getTheme(DARK).fg.toLowerCase(),
  };
}

function loadGrammar(
  highlighter: HighlighterCore,
  grammar: GrammarId,
): Promise<void> {
  let loading = grammarsLoaded.get(grammar);
  if (!loading) {
    loading = highlighter.loadLanguage(GRAMMARS[grammar]());
    grammarsLoaded.set(grammar, loading);
  }
  return loading;
}

/**
 * One run of text in one colour. A colour is absent where the theme draws
 * the text's own foreground, so that run takes the transcript's ink.
 */
export interface Token {
  readonly text: string;
  readonly light: string | undefined;
  readonly dark: string | undefined;
}

function ownColour(
  colour: string | undefined,
  foreground: string,
): string | undefined {
  return colour === undefined || colour.toLowerCase() === foreground
    ? undefined
    : colour;
}

export type Colouring = readonly (readonly Token[])[];

/**
 * Colourings already made, by grammar and code. A block is drawn again from
 * scratch when its answer finishes streaming and becomes one document instead
 * of two; this is what lets it come back coloured in its first frame rather
 * than plain for one and coloured the next. Bounded, oldest out first.
 */
const COLOURINGS_KEPT = 2000;
const colourings = new Map<string, Colouring>();

function colouringKey(code: string, grammar: GrammarId): string {
  return `${grammar}\0${code}`;
}

/** The colouring `highlight` already made for this code, if it has. */
export function colouringOf(
  code: string,
  grammar: GrammarId,
): Colouring | undefined {
  return colourings.get(colouringKey(code, grammar));
}

/** `code`, coloured by `grammar`: one array of tokens per line. */
export async function highlight(
  code: string,
  grammar: GrammarId,
): Promise<Colouring> {
  const key = colouringKey(code, grammar);
  const kept = colourings.get(key);
  if (kept) return kept;
  palette ??= createPalette();
  const { highlighter, lightForeground, darkForeground } = await palette;
  await loadGrammar(highlighter, grammar);
  const { tokens } = highlighter.codeToTokens(code, {
    lang: grammar,
    themes: { light: LIGHT, dark: DARK },
    defaultColor: false,
  });
  const colouring: Colouring = tokens.map((line) =>
    line.map((token) => {
      const style = token.htmlStyle ?? {};
      return {
        text: token.content,
        light: ownColour(style["--shiki-light"], lightForeground),
        dark: ownColour(style["--shiki-dark"], darkForeground),
      };
    }),
  );
  colourings.set(key, colouring);
  if (colourings.size > COLOURINGS_KEPT) {
    colourings.delete(colourings.keys().next().value!);
  }
  return colouring;
}
