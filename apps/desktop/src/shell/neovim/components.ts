/**
 * The declarative components a Neovim config hands DevHub to draw: data, not
 * HTML. `require('devhub').gui.ui` (devhub.nvim) builds them, `devhub_gui`
 * sends them (`view`, `inline`), and `ComponentView.tsx` draws them in
 * DevHub's type with Neovim's colours: every colour is a highlight group's
 * name, resolved by Neovim (`nvim_get_hl`) into the `hl` table sent with it.
 *
 * Nothing here runs code from the config: a click on a node with an `action`
 * is sent back to Neovim, where its Lua function runs. A node of the wrong
 * shape is dropped (its siblings stay), so an odd payload draws less, never
 * something else. HTML stays the escape hatch of `gui.open`. See
 * `docs/neovim-editor.md`.
 */

/** A highlight group's attributes, as Neovim resolved them (`nvim_get_hl`). */
export interface HlAttrs {
  readonly fg?: number | undefined;
  readonly bg?: number | undefined;
  readonly sp?: number | undefined;
  readonly bold?: boolean | undefined;
  readonly italic?: boolean | undefined;
  readonly underline?: boolean | undefined;
  readonly strikethrough?: boolean | undefined;
  readonly reverse?: boolean | undefined;
}

export type HlTable = ReadonlyMap<string, HlAttrs>;

export type Size = "xs" | "sm" | "md" | "lg";
export type Align = "start" | "center" | "end" | "baseline" | "stretch";
export type Justify = "start" | "center" | "end" | "between";

/** What every node may carry. */
interface Common {
  /** Set by Lua for a node with `on_click`: sent back on a click. */
  readonly action?: number | undefined;
  /** Takes the room left in its row or column. */
  readonly grow?: boolean | undefined;
  /** A tooltip. */
  readonly tip?: string | undefined;
}

export interface Run {
  readonly text: string;
  readonly hl?: string | undefined;
  readonly mono?: boolean | undefined;
  readonly bold?: boolean | undefined;
  readonly italic?: boolean | undefined;
  readonly dim?: boolean | undefined;
  readonly strike?: boolean | undefined;
  readonly underline?: boolean | undefined;
}

export interface StackNode extends Common {
  readonly type: "stack" | "hstack";
  readonly children: readonly ComponentNode[];
  /** Pixels between children. */
  readonly gap?: number | undefined;
  /** Padding in pixels: all sides, or [vertical, horizontal]. */
  readonly pad?: readonly [number, number] | undefined;
  readonly align?: Align | undefined;
  readonly justify?: Justify | undefined;
  readonly wrap?: boolean | undefined;
  /** A raised card: its own ground, a hairline border, rounded corners. */
  readonly card?: boolean | undefined;
  /** A bar down the left side in this group's colour. */
  readonly accent?: string | undefined;
  /** A ground in this group's background (or its colour, faintly). */
  readonly bg?: string | undefined;
  /** Indent from the left, in pixels (a tree's depth). */
  readonly indent?: number | undefined;
}

export interface TextNode extends Common {
  readonly type: "text";
  readonly runs: readonly Run[];
  readonly size?: Size | undefined;
  readonly mono?: boolean | undefined;
  readonly bold?: boolean | undefined;
  readonly dim?: boolean | undefined;
  readonly hl?: string | undefined;
  /** Wrap long text; otherwise one line, cut with an ellipsis. */
  readonly wrap?: boolean | undefined;
  readonly upper?: boolean | undefined;
}

export interface MarkdownNode extends Common {
  readonly type: "markdown";
  readonly text: string;
  readonly size?: Size | undefined;
  /**
   * Ranges of the source's fenced code drawn in a group's colours (an LSP
   * signature's active parameter): `line` is the source's (1-based),
   * `from`/`to` UTF-16 columns of it.
   */
  readonly marks?: readonly MdMark[] | undefined;
}

export interface MdMark {
  readonly line: number;
  readonly from: number;
  readonly to: number;
  readonly hl: string;
}

export interface BadgeNode extends Common {
  readonly type: "badge";
  readonly text: string;
  readonly hl?: string | undefined;
  readonly mono?: boolean | undefined;
  /** Round ends, for a count. */
  readonly pill?: boolean | undefined;
}

export interface KbdNode extends Common {
  readonly type: "kbd";
  readonly text: string;
}

export interface ButtonNode extends Common {
  readonly type: "button";
  readonly text: string;
  readonly icon?: string | undefined;
  /** The key that does the same in Neovim, shown on the button. */
  readonly key?: string | undefined;
  readonly hl?: string | undefined;
}

export interface CheckboxNode extends Common {
  readonly type: "checkbox";
  readonly state: boolean | "mixed";
  readonly label?: string | undefined;
  readonly hl?: string | undefined;
}

export interface ProgressNode extends Common {
  readonly type: "progress";
  /** 0 … 1. */
  readonly value: number;
  readonly hl?: string | undefined;
  readonly label?: string | undefined;
  readonly width?: number | undefined;
}

export interface IconNode extends Common {
  readonly type: "icon";
  /** One glyph (a Nerd Font codepoint is drawn in the grid's font). */
  readonly glyph: string;
  readonly hl?: string | undefined;
  readonly size?: Size | undefined;
}

export interface AvatarNode extends Common {
  readonly type: "avatar";
  /** One or two letters. */
  readonly text: string;
  readonly hl?: string | undefined;
  readonly size?: number | undefined;
}

export interface SpacerNode extends Common {
  readonly type: "spacer";
  /** Pixels; none: takes the room left. */
  readonly size?: number | undefined;
}

export interface DividerNode extends Common {
  readonly type: "divider";
  readonly vertical?: boolean | undefined;
}

export interface SparklineNode extends Common {
  readonly type: "sparkline";
  readonly values: readonly number[];
  readonly kind: "line" | "bar";
  readonly hl?: string | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}

export interface ChartSeries {
  readonly values: readonly number[];
  readonly hl?: string | undefined;
  readonly label?: string | undefined;
}

export interface ChartNode extends Common {
  readonly type: "chart";
  readonly series: readonly ChartSeries[];
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}

export interface ImageNode extends Common {
  readonly type: "image";
  /** `data:image/…` (Lua reads a path into one) or `https:`. */
  readonly src: string;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}

export type ComponentNode =
  | StackNode
  | TextNode
  | MarkdownNode
  | BadgeNode
  | KbdNode
  | ButtonNode
  | CheckboxNode
  | ProgressNode
  | IconNode
  | AvatarNode
  | SpacerNode
  | DividerNode
  | SparklineNode
  | ChartNode
  | ImageNode;

export type ComponentType = ComponentNode["type"];

/** How deep a tree may be, and how much of it is kept. */
const MAX_DEPTH = 24;
const MAX_CHILDREN = 400;
const MAX_VALUES = 512;
const MAX_TEXT = 64 * 1024;

type Rec = Readonly<Record<string, unknown>>;

function rec(value: unknown): Rec | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

/** A Lua list: an array, or an empty table (which arrives as a map). */
export function luaList(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(r: Rec, key: string): string | undefined {
  const v = r[key];
  return typeof v === "string" ? v.slice(0, MAX_TEXT) : undefined;
}

function num(r: Rec, key: string, min: number, max: number) {
  const v = r[key];
  return typeof v === "number" && Number.isFinite(v)
    ? Math.min(max, Math.max(min, v))
    : undefined;
}

function bool(r: Rec, key: string): boolean | undefined {
  return r[key] === true ? true : undefined;
}

function oneOf<T extends string>(
  r: Rec,
  key: string,
  options: readonly T[],
): T | undefined {
  const v = r[key];
  return typeof v === "string" && (options as readonly string[]).includes(v)
    ? (v as T)
    : undefined;
}

const SIZES = ["xs", "sm", "md", "lg"] as const;
const ALIGNS = ["start", "center", "end", "baseline", "stretch"] as const;
const JUSTIFIES = ["start", "center", "end", "between"] as const;

function common(r: Rec): Common {
  return {
    action: num(r, "action", 1, Number.MAX_SAFE_INTEGER),
    grow: bool(r, "grow"),
    tip: str(r, "tip"),
  };
}

function run(value: unknown): Run | undefined {
  if (typeof value === "string") return { text: value };
  const r = rec(value);
  const text = r ? str(r, "text") : undefined;
  if (!r || text === undefined) return undefined;
  return {
    text,
    hl: str(r, "hl"),
    mono: bool(r, "mono"),
    bold: bool(r, "bold"),
    italic: bool(r, "italic"),
    dim: bool(r, "dim"),
    strike: bool(r, "strike"),
    underline: bool(r, "underline"),
  };
}

function mdMark(value: unknown): MdMark[] {
  const r = rec(value);
  if (!r) return [];
  const line = num(r, "line", 1, Number.MAX_SAFE_INTEGER);
  const from = num(r, "from", 0, MAX_TEXT);
  const to = num(r, "to", 0, MAX_TEXT);
  const hl = str(r, "hl");
  if (line === undefined || from === undefined || to === undefined) return [];
  if (hl === undefined || to <= from) return [];
  return [{ line: Math.floor(line), from, to, hl }];
}

/**
 * A line of tokens cut where marks begin and end: each piece with the
 * index of the mark over it (or -1). Columns are UTF-16, as JS counts.
 */
export function markPieces<T extends { readonly text: string }>(
  tokens: readonly T[],
  marks: readonly { readonly from: number; readonly to: number }[],
): { readonly token: T; readonly text: string; readonly mark: number }[] {
  const out: { token: T; text: string; mark: number }[] = [];
  let at = 0;
  for (const token of tokens) {
    const end = at + token.text.length;
    const cuts = new Set([at, end]);
    for (const m of marks) {
      if (m.from > at && m.from < end) cuts.add(m.from);
      if (m.to > at && m.to < end) cuts.add(m.to);
    }
    const points = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i + 1 < points.length; i += 1) {
      const a = points[i] ?? at;
      const b = points[i + 1] ?? end;
      const mark = marks.findIndex((m) => m.from <= a && b <= m.to);
      out.push({ token, text: token.text.slice(a - at, b - at), mark });
    }
    at = end;
  }
  return out;
}

function values(value: unknown): number[] {
  return luaList(value)
    .slice(0, MAX_VALUES)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

/** A pad of one number, or of [vertical, horizontal]. */
function pad(value: unknown): readonly [number, number] | undefined {
  const clamp = (n: number) => Math.min(64, Math.max(0, n));
  if (typeof value === "number" && Number.isFinite(value))
    return [clamp(value), clamp(value)];
  const list = luaList(value);
  const [v, h] = list;
  if (typeof v === "number" && typeof h === "number")
    return [clamp(v), clamp(h)];
  return undefined;
}

/**
 * A node from Lua, checked: what it says it is and has what that needs, or
 * `undefined`. A string is a text node.
 */
export function parseNode(
  value: unknown,
  depth = 0,
): ComponentNode | undefined {
  if (depth > MAX_DEPTH) return undefined;
  if (typeof value === "string")
    return { type: "text", runs: [{ text: value.slice(0, MAX_TEXT) }] };
  const r = rec(value);
  if (!r) return undefined;
  const base = common(r);
  switch (r["type"]) {
    case "stack":
    case "hstack": {
      const children = luaList(r["children"])
        .slice(0, MAX_CHILDREN)
        .flatMap((child) => {
          const node = parseNode(child, depth + 1);
          return node ? [node] : [];
        });
      return {
        ...base,
        type: r["type"],
        children,
        gap: num(r, "gap", 0, 64),
        pad: pad(r["pad"]),
        align: oneOf(r, "align", ALIGNS),
        justify: oneOf(r, "justify", JUSTIFIES),
        wrap: bool(r, "wrap"),
        card: bool(r, "card"),
        accent: str(r, "accent"),
        bg: str(r, "bg"),
        indent: num(r, "indent", 0, 400),
      };
    }
    case "text": {
      const text = str(r, "text");
      const runs =
        text !== undefined
          ? [{ text }]
          : luaList(r["runs"])
              .slice(0, MAX_CHILDREN)
              .flatMap((v) => {
                const one = run(v);
                return one ? [one] : [];
              });
      return {
        ...base,
        type: "text",
        runs,
        size: oneOf(r, "size", SIZES),
        mono: bool(r, "mono"),
        bold: bool(r, "bold"),
        dim: bool(r, "dim"),
        hl: str(r, "hl"),
        wrap: bool(r, "wrap"),
        upper: bool(r, "upper"),
      };
    }
    case "markdown": {
      const text = str(r, "text");
      if (text === undefined) return undefined;
      const marks = luaList(r["marks"]).flatMap(mdMark).slice(0, 64);
      return {
        ...base,
        type: "markdown",
        text,
        size: oneOf(r, "size", SIZES),
        ...(marks.length > 0 ? { marks } : {}),
      };
    }
    case "badge":
    case "kbd": {
      const text = str(r, "text");
      if (text === undefined) return undefined;
      if (r["type"] === "kbd") return { ...base, type: "kbd", text };
      return {
        ...base,
        type: "badge",
        text,
        hl: str(r, "hl"),
        mono: bool(r, "mono"),
        pill: bool(r, "pill"),
      };
    }
    case "button": {
      const text = str(r, "text");
      if (text === undefined) return undefined;
      return {
        ...base,
        type: "button",
        text,
        icon: str(r, "icon"),
        key: str(r, "key"),
        hl: str(r, "hl"),
      };
    }
    case "checkbox": {
      const state = r["state"];
      return {
        ...base,
        type: "checkbox",
        state: state === "mixed" ? "mixed" : state === true,
        label: str(r, "label"),
        hl: str(r, "hl"),
      };
    }
    case "progress": {
      const value = num(r, "value", 0, 1);
      if (value === undefined) return undefined;
      return {
        ...base,
        type: "progress",
        value,
        hl: str(r, "hl"),
        label: str(r, "label"),
        width: num(r, "width", 8, 2000),
      };
    }
    case "icon": {
      const glyph = str(r, "glyph");
      if (glyph === undefined || glyph === "") return undefined;
      return {
        ...base,
        type: "icon",
        glyph: [...glyph].slice(0, 2).join(""),
        hl: str(r, "hl"),
        size: oneOf(r, "size", SIZES),
      };
    }
    case "avatar": {
      const text = str(r, "text");
      if (text === undefined) return undefined;
      return {
        ...base,
        type: "avatar",
        text: [...text].slice(0, 2).join(""),
        hl: str(r, "hl"),
        size: num(r, "size", 10, 64),
      };
    }
    case "spacer":
      return { ...base, type: "spacer", size: num(r, "size", 0, 400) };
    case "divider":
      return { ...base, type: "divider", vertical: bool(r, "vertical") };
    case "sparkline":
      return {
        ...base,
        type: "sparkline",
        values: values(r["values"]),
        kind: r["kind"] === "bar" ? "bar" : "line",
        hl: str(r, "hl"),
        width: num(r, "width", 8, 2000),
        height: num(r, "height", 4, 400),
      };
    case "chart": {
      const series = luaList(r["series"])
        .slice(0, 8)
        .flatMap((s) => {
          const one = rec(s);
          if (!one) return [];
          return [
            {
              values: values(one["values"]),
              hl: str(one, "hl"),
              label: str(one, "label"),
            },
          ];
        });
      return {
        ...base,
        type: "chart",
        series,
        width: num(r, "width", 16, 2000),
        height: num(r, "height", 16, 600),
      };
    }
    case "image": {
      const src = str(r, "src");
      if (
        src === undefined ||
        !(src.startsWith("data:image/") || src.startsWith("https://"))
      )
        return undefined;
      return {
        ...base,
        type: "image",
        src,
        width: num(r, "width", 1, 4000),
        height: num(r, "height", 1, 4000),
      };
    }
    default:
      return undefined;
  }
}

/** The `hl` table sent with a tree: group name → attributes. */
export function parseHlTable(value: unknown): HlTable {
  const r = rec(value);
  const out = new Map<string, HlAttrs>();
  if (!r) return out;
  for (const [name, attrs] of Object.entries(r)) {
    const a = rec(attrs);
    if (!a) continue;
    const n = (key: string) => {
      const v = a[key];
      return typeof v === "number" && Number.isInteger(v) && v >= 0
        ? v & 0xffffff
        : undefined;
    };
    out.set(name, {
      fg: n("fg"),
      bg: n("bg"),
      sp: n("sp"),
      bold: bool(a, "bold"),
      italic: bool(a, "italic"),
      underline: bool(a, "underline"),
      strikethrough: bool(a, "strikethrough"),
      reverse: bool(a, "reverse"),
    });
  }
  return out;
}

/** Every action a tree carries, for a click's lookup. */
export function actionsOf(node: ComponentNode): number[] {
  const own = node.action !== undefined ? [node.action] : [];
  if (node.type === "stack" || node.type === "hstack")
    return [...own, ...node.children.flatMap(actionsOf)];
  return own;
}

// ---------------------------------------------------------------------------
// Layout decisions, kept pure.

/** The rows a card of `px` pixels needs (a hair over a row is not a row). */
export function rowsFor(px: number, cellHeight: number): number {
  if (!(cellHeight > 0) || !(px > 0)) return 1;
  return Math.max(1, Math.min(200, Math.ceil((px - 0.5) / cellHeight)));
}

/**
 * Where a list scrolls to show the item at `top` … `top + height`, moving as
 * little as it can: not at all when it is in view, so that the focus can
 * walk a list that stays still. `margin` keeps some room around it.
 */
export function revealScroll(
  scrollTop: number,
  viewport: number,
  top: number,
  height: number,
  margin = 8,
): number {
  if (viewport <= 0) return Math.max(0, top);
  const want = Math.min(height + 2 * margin, viewport);
  if (top - margin < scrollTop) return Math.max(0, top - margin);
  if (top - margin + want > scrollTop + viewport)
    return Math.max(0, top - margin + want - viewport);
  return scrollTop;
}

export interface ItemBox {
  readonly top: number;
  readonly height: number;
}

/** The scroll a list can go to: from 0 to its overflow. */
export function clampScroll(
  scrollTop: number,
  contentHeight: number,
  viewport: number,
): number {
  return Math.min(
    Math.max(0, contentHeight - viewport),
    Math.max(0, scrollTop),
  );
}

/**
 * After the wheel moved a list, the item the cursor goes to: the focused one
 * while any of it is in view, else the nearest one wholly in view (the first
 * when the list moved down, the last when it moved up), so that Neovim's
 * cursor stays where the eye is.
 */
export function wheelFocus(
  items: readonly ItemBox[],
  focused: number,
  scrollTop: number,
  viewport: number,
): number {
  const current = items[focused];
  const bottom = scrollTop + viewport;
  if (
    current &&
    current.top < bottom &&
    current.top + current.height > scrollTop
  )
    return focused;
  const inView = items.flatMap((item, index) =>
    item.top >= scrollTop - 0.5 && item.top + item.height <= bottom + 0.5
      ? [index]
      : [],
  );
  const partly = items.flatMap((item, index) =>
    item.top < bottom && item.top + item.height > scrollTop ? [index] : [],
  );
  const pool = inView.length > 0 ? inView : partly;
  if (pool.length === 0) return focused;
  const below = current ? current.top >= bottom : false;
  return below ? (pool.at(-1) ?? focused) : (pool[0] ?? focused);
}

/** A sparkline's or a chart's points, in a `width` × `height` box. */
export function linePoints(
  vals: readonly number[],
  width: number,
  height: number,
  range?: { readonly min: number; readonly max: number },
): [number, number][] {
  if (vals.length === 0) return [];
  const min = range?.min ?? Math.min(...vals);
  const max = range?.max ?? Math.max(...vals);
  const span = max - min;
  const step = vals.length > 1 ? width / (vals.length - 1) : 0;
  const inset = 1;
  return vals.map((v, i) => [
    round2(vals.length > 1 ? i * step : width / 2),
    round2(
      span === 0
        ? height / 2
        : inset + (height - 2 * inset) * (1 - (v - min) / span),
    ),
  ]);
}

/** Bars for a sparkline: x, width, y and height of each. */
export function barRects(
  vals: readonly number[],
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number }[] {
  if (vals.length === 0) return [];
  const max = Math.max(...vals.map((v) => Math.max(0, v))) || 1;
  const slot = width / vals.length;
  const gap = slot > 3 ? 1 : 0;
  return vals.map((v, i) => {
    const h = round2(Math.max(v > 0 ? 1 : 0, (Math.max(0, v) / max) * height));
    return {
      x: round2(i * slot),
      y: round2(height - h),
      w: round2(slot - gap),
      h,
    };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** A 24-bit colour as CSS. */
export function rgbCss(rgb: number, alpha = 1): string {
  const r = (rgb >> 16) & 255;
  const g = (rgb >> 8) & 255;
  const b = rgb & 255;
  return alpha >= 1
    ? `rgb(${String(r)} ${String(g)} ${String(b)})`
    : `rgb(${String(r)} ${String(g)} ${String(b)} / ${String(Math.round(alpha * 100))}%)`;
}

/** Whether a colour is dark (for what goes on it). */
export function isDark(rgb: number): boolean {
  const r = (rgb >> 16) & 255;
  const g = (rgb >> 8) & 255;
  const b = rgb & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
}
