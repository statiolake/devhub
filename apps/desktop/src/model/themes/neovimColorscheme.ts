/**
 * The Neovim colorscheme DevHub generates from a theme's sixteen colours.
 *
 * Two steps, each a table in `docs/themes.md` with the reason for every row:
 *
 * 1. **Roles** (`neovimRoles`): the sixteen ANSI colours, the background
 *    and the foreground become what a colorscheme talks in — keyword,
 *    function, type, string, constant, special, comment, the diagnostic
 *    levels, and neutral surfaces. Hues come from the theme; what is fixed is
 *    which ANSI slot plays which role, chosen by what the well-known schemes
 *    agree on (tokyonight, catppuccin, kanagawa, gruvbox, onedark, nightfox,
 *    base16, mini.hues and Neovim's own default). Lightness is checked:
 *    every text role reaches a minimum contrast on the background, a slot
 *    that is missing its hue (grey where a colour should be) or duplicates
 *    another is given one, and surfaces are the background mixed toward the
 *    foreground in OKLab so a float separates without a new hue.
 * 2. **Groups** (`neovimColorscheme`): every group a colorscheme sets —
 *    the editor's UI, legacy syntax, Tree-sitter captures, LSP semantic
 *    tokens, diagnostics, diffs, and the plugins DevHub's Neovims commonly
 *    carry — as `nvim_set_hl` specs, most of them links, so a person's
 *    override of one group carries to everything linked to it.
 *
 * Pure: the same theme always gives the same table. DevHub sends it to every
 * Neovim it draws (`managedNeovim.ts#PUBLISH_THEME_LUA`) and publishes it
 * with the theme.
 */

import {
  contrast,
  distance,
  hexOfOklch,
  isDark,
  mix,
  oklchOf,
  withContrast,
  type Oklch,
} from "./color.js";
import type { Theme } from "./theme.js";

/** One `nvim_set_hl` spec, as msgpack carries it. */
export interface NeovimHighlight {
  readonly fg?: string;
  readonly bg?: string;
  readonly sp?: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly undercurl?: boolean;
  readonly strikethrough?: boolean;
  readonly reverse?: boolean;
  readonly link?: string;
}

/** The colorscheme: what `PUBLISH_THEME_LUA` applies. */
export interface NeovimColorscheme {
  readonly background: "dark" | "light";
  readonly highlights: Readonly<Record<string, NeovimHighlight>>;
  /** `g:terminal_color_0` … `15`. */
  readonly terminal: readonly string[];
  /**
   * The theme's own Neovim colorscheme (`Theme.neovimColorscheme`), worn
   * instead of `highlights` where it is installed; those are then only the
   * fallback. Absent for a theme that has none.
   */
  readonly colorscheme?: string;
  /** The plugin that provides `colorscheme`, `owner/repo`. */
  readonly plugin?: string;
}

/** The roles every group is made from. */
export interface NeovimRoles {
  readonly bg: string;
  readonly fg: string;
  /** The foreground a step toward the background: punctuation, operators. */
  readonly fgMuted: string;
  /** Comments: dim but readable (3:1). */
  readonly comment: string;
  /** Line numbers, fold markers: quieter than comments. */
  readonly subtle: string;
  /** `listchars`, indent guides, `~`: barely there. */
  readonly faint: string;
  /** Window separators, float borders. */
  readonly border: string;
  /** Floats and the completion menu. */
  readonly float: string;
  /** The cursor line, a closed fold, an inactive status line. */
  readonly surface1: string;
  /** The status line, references. */
  readonly surface2: string;
  /** The matching bracket. */
  readonly surface3: string;
  readonly visual: string;
  readonly accent: string;
  readonly red: string;
  readonly green: string;
  readonly yellow: string;
  readonly blue: string;
  readonly magenta: string;
  readonly cyan: string;
  /** Derived between red and yellow: ANSI has none. */
  readonly orange: string;
  readonly keyword: string;
  readonly func: string;
  readonly type: string;
  readonly string: string;
  readonly constant: string;
  readonly special: string;
  readonly member: string;
  readonly parameter: string;
  readonly builtin: string;
  readonly error: string;
  readonly warn: string;
  readonly info: string;
  readonly hint: string;
  readonly ok: string;
  readonly cursor: string;
  readonly cursorText: string;
}

/** WCAG's AA for body text: every syntax role reads at least this well. */
const TEXT_CONTRAST = 4.5;
/** Comments are meant to recede, not to vanish: AA for large text. */
const COMMENT_CONTRAST = 3;
/** Line numbers and fold markers: present, below comments. */
const SUBTLE_CONTRAST = 2.2;

/** The hue each ANSI slot is meant to have, in OKLCH degrees. */
const CANONICAL_HUE: Readonly<Record<number, number>> = {
  1: 27, // red
  2: 145, // green
  3: 95, // yellow
  4: 255, // blue
  5: 330, // magenta
  6: 200, // cyan
};

const SLOTS = [1, 2, 3, 4, 5, 6] as const;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * One hue slot's syntax colour: the normal variant when it reads, else the
 * bright one, lifted to `TEXT_CONTRAST` if neither does. A theme's own colour
 * is never changed when it already reads.
 */
function readable(normal: string, bright: string, bg: string): string {
  if (contrast(normal, bg) >= TEXT_CONTRAST) return normal;
  if (contrast(bright, bg) >= TEXT_CONTRAST) return bright;
  const better = contrast(normal, bg) >= contrast(bright, bg) ? normal : bright;
  return withContrast(better, bg, TEXT_CONTRAST);
}

/**
 * The six hue slots, repaired: a slot with no hue of its own (chroma near
 * zero) in a theme whose other slots have one, or one that is the same colour
 * as a slot before it, gets its canonical hue at the theme's typical
 * lightness and chroma. A theme that is grey on purpose (most slots without
 * chroma) is left grey: its roles are then told apart by weight and slant.
 */
function hueSlots(theme: Theme): {
  readonly colors: Readonly<Record<number, string>>;
  readonly monochrome: boolean;
} {
  const raw = SLOTS.map((slot) =>
    readable(
      theme.palette[slot] ?? theme.foreground,
      theme.palette[slot + 8] ?? theme.foreground,
      theme.background,
    ),
  );
  const lch = raw.map(oklchOf);
  const chromas = lch.map((value) => value.c);
  const typical: Oklch = {
    l: median(lch.map((value) => value.l)),
    c: Math.max(0.08, median(chromas)),
    h: 0,
  };
  const monochrome = chromas.filter((c) => c < 0.03).length >= 4;
  const colors: Record<number, string> = {};
  SLOTS.forEach((slot, index) => {
    let color = raw[index] ?? theme.foreground;
    if (!monochrome) {
      const greyed = (lch[index]?.c ?? 0) < 0.03;
      const duplicate = SLOTS.slice(0, index).some(
        (earlier) => distance(colors[earlier] ?? "", color) < 0.04,
      );
      if (greyed || duplicate) {
        color = withContrast(
          hexOfOklch({ ...typical, h: CANONICAL_HUE[slot] ?? 0 }),
          theme.background,
          TEXT_CONTRAST,
        );
      }
    }
    colors[slot] = color;
  });
  return { colors, monochrome };
}

/** `a` and `b` interpolated in OKLCH, the hue the short way round. */
function between(a: string, b: string, t: number): string {
  const x = oklchOf(a);
  const y = oklchOf(b);
  let dh = y.h - x.h;
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  return hexOfOklch({
    l: x.l + (y.l - x.l) * t,
    c: x.c + (y.c - x.c) * t,
    h: (x.h + dh * t + 360) % 360,
  });
}

/**
 * A ground a step from `bg` toward its edge (darker on a dark theme, lighter
 * on a light one) — where Neovim's own default, tokyonight, catppuccin and
 * mini.hues put floats — or toward the foreground when the background is
 * already at the edge and a step would not show.
 */
function edgeward(bg: string, fg: string): string {
  const lch = oklchOf(bg);
  const dark = isDark(bg);
  const target = dark ? lch.l - 0.035 : lch.l + 0.035;
  if (dark ? target < 0.13 : target > 0.985) return mix(bg, fg, 0.07);
  return hexOfOklch({ ...lch, l: target });
}

export function neovimRoles(theme: Theme): NeovimRoles {
  const bg = theme.background;
  const fg = theme.foreground;
  const { colors, monochrome } = hueSlots(theme);
  const red = colors[1] ?? fg;
  const green = colors[2] ?? fg;
  const yellow = colors[3] ?? fg;
  const blue = colors[4] ?? fg;
  const magenta = colors[5] ?? fg;
  const cyan = colors[6] ?? fg;
  const orange = withContrast(between(red, yellow, 0.5), bg, TEXT_CONTRAST);

  // ANSI 8 is the terminal's own "dim" colour and what most terminal themes
  // mean comments to be; it is used when it sits between the ground and the
  // text, else the foreground half-way to the background.
  const brightBlack = theme.palette[8] ?? mix(fg, bg, 0.45);
  const comment = withContrast(
    contrast(brightBlack, bg) < contrast(fg, bg) * 0.85 &&
      distance(brightBlack, bg) > 0.05
      ? brightBlack
      : mix(fg, bg, 0.45),
    bg,
    COMMENT_CONTRAST,
  );
  const subtle = withContrast(mix(comment, bg, 0.3), bg, SUBTLE_CONTRAST);

  const selection = theme.selectionBackground;
  // The theme's selection when the text still reads on it (a terminal's
  // selection may be meant to swap the text's colour too, as Catppuccin's
  // is); else the ground tinted toward a blueish foreground, as far as the
  // text keeps 3.5:1.
  let visual = selection;
  if (contrast(fg, selection) < 3.5 || distance(selection, bg) <= 0.04) {
    const tint = mix(fg, blue, 0.6);
    visual = mix(bg, tint, 0.06);
    for (let amount = 0.24; amount > 0.06; amount -= 0.02) {
      const candidate = mix(bg, tint, amount);
      if (contrast(fg, candidate) >= 3.5) {
        visual = candidate;
        break;
      }
    }
  }

  return {
    bg,
    fg,
    fgMuted: mix(fg, bg, 0.25),
    comment,
    subtle,
    faint: mix(bg, fg, 0.18),
    border: mix(bg, fg, 0.28),
    float: edgeward(bg, fg),
    surface1: mix(bg, fg, 0.07),
    surface2: mix(bg, fg, 0.13),
    surface3: mix(bg, fg, 0.2),
    visual,
    accent: blue,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    orange,
    // In a grey theme there is no hue to tell keywords by.
    keyword: monochrome ? fg : magenta,
    func: blue,
    type: yellow,
    string: green,
    constant: orange,
    special: cyan,
    member: withContrast(mix(blue, fg, 0.45), bg, TEXT_CONTRAST),
    parameter: withContrast(mix(red, fg, 0.45), bg, TEXT_CONTRAST),
    builtin: red,
    error: red,
    warn: yellow,
    info: cyan,
    hint: blue,
    ok: green,
    cursor: theme.cursor,
    cursorText: theme.cursorText,
  };
}

/** Every group, from the roles. */
export function neovimColorscheme(theme: Theme): NeovimColorscheme {
  const r = neovimRoles(theme);
  const monochrome = r.keyword === r.fg;
  const tint = (color: string, amount: number): string =>
    mix(r.bg, color, amount);
  const link = (to: string): NeovimHighlight => ({ link: to });

  const h: Record<string, NeovimHighlight> = {
    // ----- the editor
    Normal: { fg: r.fg, bg: r.bg },
    NormalNC: link("Normal"),
    NormalFloat: { fg: r.fg, bg: r.float },
    FloatBorder: { fg: r.border, bg: r.float },
    FloatTitle: { fg: r.accent, bg: r.float, bold: true },
    FloatFooter: { fg: r.comment, bg: r.float },
    Cursor: { fg: r.cursorText, bg: r.cursor },
    lCursor: link("Cursor"),
    CursorIM: link("Cursor"),
    TermCursor: link("Cursor"),
    CursorLine: { bg: r.surface1 },
    CursorColumn: link("CursorLine"),
    ColorColumn: { bg: r.surface1 },
    LineNr: { fg: r.subtle },
    LineNrAbove: link("LineNr"),
    LineNrBelow: link("LineNr"),
    CursorLineNr: { fg: r.fg, bold: true },
    SignColumn: { fg: r.subtle },
    CursorLineSign: link("SignColumn"),
    FoldColumn: { fg: r.subtle },
    CursorLineFold: link("FoldColumn"),
    Folded: { fg: r.comment, bg: r.surface1 },
    NonText: { fg: r.faint },
    Whitespace: link("NonText"),
    EndOfBuffer: link("NonText"),
    SpecialKey: link("NonText"),
    Conceal: { fg: r.comment },
    Visual: { bg: r.visual },
    VisualNOS: link("Visual"),
    Search: { fg: r.fg, bg: tint(r.yellow, 0.3) },
    CurSearch: { fg: r.bg, bg: r.orange, bold: true },
    IncSearch: link("CurSearch"),
    Substitute: link("CurSearch"),
    MatchParen: { bg: r.surface3, bold: true },
    StatusLine: { fg: r.fg, bg: r.surface2 },
    StatusLineNC: { fg: r.comment, bg: r.surface1 },
    StatusLineTerm: link("StatusLine"),
    StatusLineTermNC: link("StatusLineNC"),
    WinBar: { fg: r.fg, bold: true },
    WinBarNC: { fg: r.comment },
    TabLine: { fg: r.comment, bg: r.surface1 },
    TabLineSel: { fg: r.fg, bg: r.bg, bold: true },
    TabLineFill: { bg: r.surface1 },
    WinSeparator: { fg: r.border },
    VertSplit: link("WinSeparator"),
    Pmenu: { fg: r.fg, bg: r.float },
    PmenuSel: { bg: r.visual, bold: true },
    PmenuKind: { fg: r.comment, bg: r.float },
    PmenuKindSel: { fg: r.comment, bg: r.visual },
    PmenuExtra: { fg: r.comment, bg: r.float },
    PmenuExtraSel: { fg: r.comment, bg: r.visual },
    PmenuMatch: { fg: r.accent, bold: true },
    PmenuMatchSel: { fg: r.accent, bold: true },
    PmenuSbar: { bg: r.float },
    PmenuThumb: { bg: r.border },
    WildMenu: link("PmenuSel"),
    Title: { fg: r.accent, bold: true },
    Directory: { fg: r.blue },
    Question: { fg: r.green },
    MoreMsg: { fg: r.green },
    ModeMsg: { fg: r.fg, bold: true },
    MsgArea: { fg: r.fg },
    ErrorMsg: { fg: r.error },
    WarningMsg: { fg: r.warn },
    QuickFixLine: { bg: r.surface2, bold: true },
    SpellBad: { undercurl: true, sp: r.error },
    SpellCap: { undercurl: true, sp: r.warn },
    SpellLocal: { undercurl: true, sp: r.info },
    SpellRare: { undercurl: true, sp: r.hint },

    // ----- diff
    DiffAdd: { bg: tint(r.green, 0.18) },
    DiffDelete: { fg: tint(r.red, 0.55), bg: tint(r.red, 0.14) },
    DiffChange: { bg: tint(r.blue, 0.12) },
    DiffText: { bg: tint(r.blue, 0.3) },
    Added: { fg: r.green },
    Changed: { fg: r.blue },
    Removed: { fg: r.red },

    // ----- legacy syntax; Tree-sitter's captures link here by default
    Comment: { fg: r.comment, italic: true },
    Constant: { fg: r.constant },
    String: { fg: r.string },
    Character: link("String"),
    Number: { fg: r.constant },
    Boolean: { fg: r.constant },
    Float: link("Number"),
    // Vim's own syntax files put names *and* declarations here (`const`,
    // `let` in TypeScript's): a quiet blue, as Neovim's default and gruvbox
    // give it, since Tree-sitter's `@variable` is set on its own.
    Identifier: { fg: r.member },
    Function: { fg: r.func },
    Statement: { fg: r.keyword, bold: monochrome },
    Conditional: link("Statement"),
    Repeat: link("Statement"),
    Label: { fg: r.special },
    Operator: { fg: r.fgMuted },
    Keyword: link("Statement"),
    Exception: link("Statement"),
    PreProc: { fg: r.keyword },
    Include: link("PreProc"),
    Define: link("PreProc"),
    Macro: link("PreProc"),
    PreCondit: link("PreProc"),
    Type: { fg: r.type },
    StorageClass: link("Statement"),
    Structure: link("Type"),
    Typedef: link("Type"),
    Special: { fg: r.special },
    SpecialChar: link("Special"),
    Tag: { fg: r.keyword },
    Delimiter: { fg: r.fgMuted },
    SpecialComment: { fg: r.comment, bold: true },
    Debug: link("Special"),
    Underlined: { underline: true },
    Ignore: { fg: r.faint },
    Error: { fg: r.error },
    Todo: { fg: r.bg, bg: r.accent, bold: true },

    // ----- Tree-sitter: only where a capture should not be its legacy group
    "@variable": { fg: r.fg },
    "@variable.builtin": { fg: r.builtin },
    "@variable.parameter": { fg: r.parameter },
    "@variable.parameter.builtin": link("@variable.builtin"),
    "@variable.member": { fg: r.member },
    "@property": link("@variable.member"),
    "@constant": link("Constant"),
    "@constant.builtin": link("Constant"),
    "@constant.macro": link("Constant"),
    "@module": link("Type"),
    "@module.builtin": link("Special"),
    "@label": link("Label"),
    "@string": link("String"),
    "@string.documentation": link("Comment"),
    "@string.regexp": link("Special"),
    "@string.escape": link("Special"),
    "@string.special": link("Special"),
    "@string.special.symbol": link("Constant"),
    "@string.special.url": { fg: r.cyan, underline: true },
    "@string.special.path": link("String"),
    "@character": link("Character"),
    "@character.special": link("Special"),
    "@boolean": link("Boolean"),
    "@number": link("Number"),
    "@number.float": link("Float"),
    "@type": link("Type"),
    "@type.builtin": link("Special"),
    "@type.definition": link("Type"),
    "@attribute": link("Constant"),
    "@attribute.builtin": link("Special"),
    "@function": link("Function"),
    "@function.builtin": link("Special"),
    "@function.call": link("Function"),
    "@function.macro": link("Macro"),
    "@function.method": link("Function"),
    "@function.method.call": link("Function"),
    "@constructor": link("Type"),
    "@operator": link("Operator"),
    "@keyword": link("Keyword"),
    "@keyword.coroutine": link("Keyword"),
    "@keyword.function": link("Keyword"),
    "@keyword.operator": link("Keyword"),
    "@keyword.import": link("Include"),
    "@keyword.type": link("Keyword"),
    "@keyword.modifier": link("Keyword"),
    "@keyword.repeat": link("Repeat"),
    "@keyword.return": link("Keyword"),
    "@keyword.debug": link("Debug"),
    "@keyword.exception": link("Exception"),
    "@keyword.conditional": link("Conditional"),
    "@keyword.directive": link("PreProc"),
    "@punctuation": link("Delimiter"),
    "@punctuation.delimiter": link("Delimiter"),
    "@punctuation.bracket": link("Delimiter"),
    "@punctuation.special": link("Special"),
    "@comment": link("Comment"),
    "@comment.documentation": link("Comment"),
    "@comment.error": { fg: r.bg, bg: r.error, bold: true },
    "@comment.warning": { fg: r.bg, bg: r.warn, bold: true },
    "@comment.todo": link("Todo"),
    "@comment.note": { fg: r.bg, bg: r.info, bold: true },
    "@markup": link("Special"),
    "@markup.strong": { bold: true },
    "@markup.italic": { italic: true },
    "@markup.strikethrough": { strikethrough: true },
    "@markup.underline": { underline: true },
    "@markup.heading": link("Title"),
    "@markup.quote": { fg: r.comment, italic: true },
    "@markup.math": link("Special"),
    "@markup.link": { fg: r.cyan },
    "@markup.link.label": { fg: r.cyan },
    "@markup.link.url": { fg: r.cyan, underline: true },
    "@markup.raw": link("String"),
    "@markup.raw.block": link("String"),
    "@markup.list": link("Special"),
    "@markup.list.checked": { fg: r.ok },
    "@markup.list.unchecked": { fg: r.comment },
    "@diff.plus": link("Added"),
    "@diff.minus": link("Removed"),
    "@diff.delta": link("Changed"),
    "@tag": link("Tag"),
    "@tag.builtin": link("Tag"),
    "@tag.attribute": link("@variable.member"),
    "@tag.delimiter": link("Delimiter"),

    // ----- LSP semantic tokens: Neovim links the rest to the captures above
    "@lsp.type.variable": {},
    "@lsp.type.namespace": link("@module"),
    "@lsp.type.enumMember": link("@constant"),
    "@lsp.type.builtinType": link("@type.builtin"),
    "@lsp.type.selfKeyword": link("@variable.builtin"),
    "@lsp.type.selfParameter": link("@variable.builtin"),
    "@lsp.type.escapeSequence": link("@string.escape"),
    "@lsp.type.formatSpecifier": link("@string.escape"),
    "@lsp.type.unresolvedReference": { undercurl: true, sp: r.error },
    "@lsp.mod.deprecated": { strikethrough: true },
    "@lsp.mod.readonly": link("@constant"),
    "@lsp.typemod.function.defaultLibrary": link("@function.builtin"),
    "@lsp.typemod.method.defaultLibrary": link("@function.builtin"),
    "@lsp.typemod.variable.defaultLibrary": link("@variable.builtin"),
    "@lsp.typemod.variable.readonly": link("@constant"),
    "@lsp.typemod.variable.callable": link("@function"),
    "@lsp.typemod.keyword.async": link("@keyword.coroutine"),
    LspReferenceText: { bg: r.surface2 },
    LspReferenceRead: link("LspReferenceText"),
    LspReferenceWrite: { bg: r.surface2, underline: true },
    LspReferenceTarget: link("LspReferenceText"),
    LspInlayHint: { fg: r.subtle, bg: r.surface1 },
    LspCodeLens: { fg: r.comment },
    LspCodeLensSeparator: { fg: r.faint },
    LspSignatureActiveParameter: { fg: r.accent, bold: true, underline: true },
    SnippetTabstop: { bg: r.surface2 },

    // ----- diagnostics
    DiagnosticError: { fg: r.error },
    DiagnosticWarn: { fg: r.warn },
    DiagnosticInfo: { fg: r.info },
    DiagnosticHint: { fg: r.hint },
    DiagnosticOk: { fg: r.ok },
    DiagnosticVirtualTextError: { fg: r.error, bg: tint(r.error, 0.1) },
    DiagnosticVirtualTextWarn: { fg: r.warn, bg: tint(r.warn, 0.1) },
    DiagnosticVirtualTextInfo: { fg: r.info, bg: tint(r.info, 0.1) },
    DiagnosticVirtualTextHint: { fg: r.hint, bg: tint(r.hint, 0.1) },
    DiagnosticVirtualTextOk: { fg: r.ok, bg: tint(r.ok, 0.1) },
    DiagnosticUnderlineError: { undercurl: true, sp: r.error },
    DiagnosticUnderlineWarn: { undercurl: true, sp: r.warn },
    DiagnosticUnderlineInfo: { undercurl: true, sp: r.info },
    DiagnosticUnderlineHint: { undercurl: true, sp: r.hint },
    DiagnosticUnderlineOk: { undercurl: true, sp: r.ok },
    DiagnosticDeprecated: { strikethrough: true, sp: r.comment },
    DiagnosticUnnecessary: { fg: r.comment },

    // ----- plugins: gitsigns, blink.cmp, snacks, fidget, nvim-tree
    GitSignsAdd: link("Added"),
    GitSignsChange: link("Changed"),
    GitSignsDelete: link("Removed"),
    GitSignsAddInline: { bg: tint(r.green, 0.3) },
    GitSignsDeleteInline: { bg: tint(r.red, 0.3) },
    GitSignsChangeInline: { bg: tint(r.blue, 0.3) },
    GitSignsCurrentLineBlame: { fg: r.subtle },
    BlinkCmpMenu: link("Pmenu"),
    BlinkCmpMenuBorder: link("FloatBorder"),
    BlinkCmpMenuSelection: link("PmenuSel"),
    BlinkCmpLabelMatch: { fg: r.accent, bold: true },
    BlinkCmpLabelDeprecated: { fg: r.comment, strikethrough: true },
    BlinkCmpLabelDetail: { fg: r.comment },
    BlinkCmpLabelDescription: { fg: r.comment },
    BlinkCmpSource: { fg: r.comment },
    BlinkCmpGhostText: { fg: r.subtle, italic: true },
    BlinkCmpDoc: link("NormalFloat"),
    BlinkCmpDocBorder: link("FloatBorder"),
    BlinkCmpSignatureHelp: link("NormalFloat"),
    BlinkCmpSignatureHelpBorder: link("FloatBorder"),
    BlinkCmpSignatureHelpActiveParameter: link("LspSignatureActiveParameter"),
    SnacksPickerMatch: { fg: r.accent, bold: true },
    SnacksPickerDir: { fg: r.comment },
    SnacksIndent: { fg: r.faint },
    SnacksIndentScope: { fg: r.border },
    FidgetTitle: { fg: r.accent, bold: true },
    FidgetTask: { fg: r.comment },
    NvimTreeNormal: link("Normal"),
    NvimTreeFolderName: { fg: r.blue },
    NvimTreeOpenedFolderName: { fg: r.blue, bold: true },
    NvimTreeRootFolder: { fg: r.accent, bold: true },
    NvimTreeGitDirty: link("Changed"),
    NvimTreeGitNew: link("Added"),
    NvimTreeGitDeleted: link("Removed"),
  };

  return {
    background: isDark(r.bg) ? "dark" : "light",
    highlights: h,
    terminal: [...theme.palette],
  };
}
