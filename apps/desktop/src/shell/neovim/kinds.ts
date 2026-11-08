/**
 * Completion kinds (LSP's `CompletionItemKind`) as vector marks, pure.
 *
 * A completion menu says what kind each word is. In a terminal that is a
 * letter (`f`, `v`) or a Nerd Font glyph, in whatever colours a GUI picked;
 * here it is a small mark whose shape tells the family — something you
 * call, a value, a slot in a structure, a type, a keyword, a module, a
 * snippet, prose — and whose colour is the person's own group for that
 * kind (`BlinkCmpKind*`, `CmpItemKind*`, else the treesitter group the
 * kind's words have in the buffer). Twenty-five kinds, eight shapes: a
 * glyph per kind at 10 px is a puzzle; eight shapes are learnt at a glance,
 * as VS Code's and Zed's symbol marks are.
 *
 * Both menus use these: DevHub's own (`ext_popupmenu`, `NeovimApp.tsx`)
 * and a plugin's drawn in a float (blink.cmp), whose kind glyphs are known
 * by the person's own `kind_icons` table (`THEME_LUA`), not guessed.
 */

/** LSP's order (`CompletionItemKind` 1–25): a glyph two kinds share is the first's. */
export const KINDS = [
  "Text",
  "Method",
  "Function",
  "Constructor",
  "Field",
  "Variable",
  "Class",
  "Interface",
  "Module",
  "Property",
  "Unit",
  "Value",
  "Enum",
  "Keyword",
  "Snippet",
  "Color",
  "File",
  "Reference",
  "Folder",
  "EnumMember",
  "Constant",
  "Struct",
  "Event",
  "Operator",
  "TypeParameter",
] as const;

export type Kind = (typeof KINDS)[number];

export type KindFamily =
  | "callable"
  | "value"
  | "variable"
  | "member"
  | "type"
  | "keyword"
  | "module"
  | "snippet"
  | "text";

const FAMILY: Record<Kind, KindFamily> = {
  Text: "text",
  Method: "callable",
  Function: "callable",
  Constructor: "callable",
  Event: "callable",
  Field: "member",
  Property: "member",
  Variable: "variable",
  Class: "type",
  Interface: "type",
  Struct: "type",
  Enum: "type",
  TypeParameter: "type",
  Module: "module",
  File: "module",
  Folder: "module",
  Reference: "module",
  Unit: "value",
  Value: "value",
  Constant: "value",
  EnumMember: "value",
  Color: "value",
  Keyword: "keyword",
  Operator: "keyword",
  Snippet: "snippet",
};

/** Vim's own one-letter kinds (`:h complete-items`). */
const LETTERS: Record<string, Kind> = {
  v: "Variable",
  f: "Function",
  m: "Field",
  t: "TypeParameter",
  d: "Constant",
};

/**
 * The kind a menu item's `kind` names: an LSP kind's name (any case, as
 * lspkind and the language servers' omnifuncs give it, an icon before it
 * or not) or Vim's letter. `undefined` when it names none: no mark.
 */
export function kindOf(text: string): Kind | undefined {
  const words = text.trim().split(/\s+/);
  for (const word of words) {
    const letter = LETTERS[word];
    if (letter) return letter;
    const hit = KINDS.find((k) => k.toLowerCase() === word.toLowerCase());
    if (hit) return hit;
  }
  return undefined;
}

export function familyOf(kind: Kind): KindFamily {
  return FAMILY[kind];
}

/**
 * The treesitter group a kind's words wear in the buffer: its colour when
 * no completion plugin names one (`kindGroups`).
 */
const CAPTURE: Record<Kind, string> = {
  Text: "Comment",
  Method: "@function.method",
  Function: "@function",
  Constructor: "@constructor",
  Event: "@function",
  Field: "@variable.member",
  Property: "@property",
  Variable: "@variable",
  Class: "@type",
  Interface: "@type",
  Struct: "@type",
  Enum: "@type",
  TypeParameter: "@type",
  Module: "@module",
  File: "Directory",
  Folder: "Directory",
  Reference: "@markup.link",
  Unit: "@number",
  Value: "@number",
  Constant: "@constant",
  EnumMember: "@constant",
  Color: "@constant",
  Keyword: "@keyword",
  Operator: "@operator",
  Snippet: "Special",
};

/**
 * The groups a kind's colour is asked by, each with the plugin's generic
 * group it falls back to: the first that gives the kind a colour of its
 * own wins. blink.cmp links every `BlinkCmpKind*` to one `BlinkCmpKind`
 * unless something sets them; one colour for every kind says nothing
 * about the kind, so then the kind's words' own colour in the buffer.
 */
export function kindGroups(
  kind: Kind,
): readonly { readonly name: string; readonly generic?: string }[] {
  return [
    { name: `BlinkCmpKind${kind}`, generic: "BlinkCmpKind" },
    { name: `CmpItemKind${kind}`, generic: "CmpItemKind" },
    { name: CAPTURE[kind] },
  ];
}

/** Every group `kindGroups` asks, for `THEME_GROUPS`. */
export const KIND_GROUPS: readonly string[] = [
  ...new Set([
    "BlinkCmpKind",
    "CmpItemKind",
    ...KINDS.flatMap((k) => kindGroups(k).map((g) => g.name)),
  ]),
];

/**
 * A family's mark in a `size`-pixel square: SVG path data, filled or
 * stroked. Drawn on a 10-unit grid and scaled; a stroke is a tenth of the
 * square, a regular stem of the type beside it.
 *
 * - callable `∧`: a step up and back — an action, not a thing;
 * - value `●`: a point — a fixed value;
 * - variable `○`: the same point, open — a place a value goes;
 * - member `□`: an open box — a slot of a structure;
 * - type `■`: the box filled — the structure itself;
 * - keyword `–`: a bar — a word of the language;
 * - module `◇`: a box turned — a container of names;
 * - snippet `⋯`: three dots — text with gaps to fill;
 * - text `=`: two lines — words of the buffer.
 */
export function markPath(
  family: KindFamily,
  size: number,
): { readonly d: string; readonly fill: boolean; readonly stroke: number } {
  const u = size / 10;
  const n = (v: number) => String(Math.round(v * u * 100) / 100);
  const circle = (cx: number, cy: number, r: number) =>
    `M${n(cx - r)} ${n(cy)}A${n(r)} ${n(r)} 0 1 0 ${n(cx + r)} ${n(cy)}A${n(r)} ${n(r)} 0 1 0 ${n(cx - r)} ${n(cy)}Z`;
  const stroke = size / 10;
  switch (family) {
    case "callable":
      return {
        d: `M${n(2)} ${n(8.5)}L${n(5)} ${n(1.5)}L${n(8)} ${n(8.5)}`,
        fill: false,
        stroke,
      };
    case "value":
      return { d: circle(5, 5, 3.2), fill: true, stroke };
    case "variable":
      return { d: circle(5, 5, 2.9), fill: false, stroke };
    case "member":
      return {
        d: `M${n(1.8)} ${n(1.8)}H${n(8.2)}V${n(8.2)}H${n(1.8)}Z`,
        fill: false,
        stroke,
      };
    case "type":
      return {
        d: `M${n(1.5)} ${n(1.5)}H${n(8.5)}V${n(8.5)}H${n(1.5)}Z`,
        fill: true,
        stroke,
      };
    case "keyword":
      return { d: `M${n(1.5)} ${n(5)}H${n(8.5)}`, fill: false, stroke };
    case "module":
      return {
        d: `M${n(5)} ${n(1)}L${n(9)} ${n(5)}L${n(5)} ${n(9)}L${n(1)} ${n(5)}Z`,
        fill: false,
        stroke,
      };
    case "snippet":
      return {
        d: [2, 5, 8].map((x) => circle(x, 5, 1)).join(""),
        fill: true,
        stroke,
      };
    case "text":
      return {
        d: `M${n(1.5)} ${n(3.5)}H${n(8.5)}M${n(1.5)} ${n(6.5)}H${n(6)}`,
        fill: false,
        stroke,
      };
  }
}

/**
 * The person's kind icons (blink.cmp's `appearance.kind_icons`), glyph to
 * kind: a glyph two kinds share is the one earlier in LSP's order.
 */
export function iconKinds(icons: Record<string, unknown>): Map<string, Kind> {
  const out = new Map<string, Kind>();
  for (const kind of KINDS) {
    const icon = icons[kind];
    if (typeof icon !== "string") continue;
    const glyph = icon.trim();
    if (glyph !== "" && !out.has(glyph)) out.set(glyph, kind);
  }
  return out;
}
