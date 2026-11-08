/**
 * What `devhub_gui`'s buffer-backed GUI layers leave on the page: views
 * (`gui.view`: one component per buffer line, painted over the windows that
 * show the buffer), inline cards (`gui.inline`: a component in the
 * `virt_lines` rows of an extmark), line decorations (`gui.decorate`) and
 * popups (`gui.popup`: a component at a buffer position, a hover).
 *
 * Neovim owns all of it. Lua sends the content when it changes (`view`,
 * `inline`, `deco`, their `*_clear`) and where everything is after every
 * scroll, cursor move, edit and window change (`layers`); the page paints
 * and sends clicks, wheel moves and a card's measured height back as Lua
 * calls. A payload of the wrong shape is ignored. See `docs/neovim-editor.md`.
 */

import {
  luaList,
  parseHlTable,
  parseNode,
  type ComponentNode,
  type HlTable,
} from "./components";

export interface ViewItem {
  /** The buffer line (1-based) the item is. */
  readonly line: number;
  /** Its component; none: the line's own text, plainly. */
  readonly node: ComponentNode | undefined;
  readonly text: string;
}

export interface ViewContent {
  readonly id: number;
  readonly items: readonly ViewItem[];
  readonly hl: HlTable;
  /** The hint line: keys and what they do. */
  readonly keys: readonly (readonly [string, string])[];
}

export interface InlineContent {
  readonly id: number;
  readonly node: ComponentNode;
  readonly hl: HlTable;
}

export type DecoStyle = "dim" | "highlight" | "tag";

export interface DecoContent {
  readonly id: number;
  readonly style: DecoStyle;
  readonly tag: string | undefined;
  /** The group whose colour a highlight or a tag wears. */
  readonly group: string | undefined;
  readonly hl: HlTable;
}

/** A view in one window. */
export interface ViewPlace {
  readonly id: number;
  readonly win: number;
  /** The cursor's line in that window: the focused item. */
  readonly cursor: number;
  readonly current: boolean;
}

/** An inline card's reserved rows in one window, from the window's top. */
export interface InlinePlace {
  readonly id: number;
  readonly win: number;
  readonly row: number;
  readonly col: number;
  readonly width: number;
  /** The rows of it that are in the window. */
  readonly rows: number;
  /** The rows reserved for it. */
  readonly full: number;
  /** Rows of it above the window's top (scrolled past). */
  readonly clip: number;
  /** The cursor is on its anchor line(s): its keys work now. */
  readonly active: boolean;
}

/** A card whose anchor is not in view: measured ahead, at this width. */
export interface InlineMeasure {
  readonly id: number;
  readonly width: number;
  readonly full: number;
}

export interface DecoPlace {
  readonly id: number;
  readonly win: number;
  readonly row: number;
  readonly rows: number;
  readonly col: number;
  readonly width: number;
}

export type PopupPlacement = "below" | "above" | "auto";

export interface PopupContent {
  readonly id: number;
  readonly node: ComponentNode;
  readonly hl: HlTable;
  readonly placement: PopupPlacement;
  /** In cells, when the popup's owner bounds it. */
  readonly maxWidth: number | undefined;
  readonly maxHeight: number | undefined;
}

/** A popup's anchor: its cell, from its window's top-left. */
export interface PopupPlace {
  readonly id: number;
  readonly win: number;
  readonly row: number;
  readonly col: number;
  /** It has the keys (j/k scroll it, q closes it). */
  readonly focused: boolean;
}

/** A scroll Neovim asked of a popup (its keys); `seq` tells a new one. */
export interface PopupScroll {
  readonly seq: number;
  readonly by: "line" | "half" | "page" | "top" | "bottom";
  readonly n: number;
}

export interface Layers {
  readonly views: ReadonlyMap<number, ViewContent>;
  readonly inlines: ReadonlyMap<number, InlineContent>;
  readonly decos: ReadonlyMap<number, DecoContent>;
  readonly placedViews: readonly ViewPlace[];
  readonly placedInlines: readonly InlinePlace[];
  readonly measureInlines: readonly InlineMeasure[];
  readonly placedDecos: readonly DecoPlace[];
  readonly popups: ReadonlyMap<number, PopupContent>;
  readonly placedPopups: readonly PopupPlace[];
  readonly popupScrolls: ReadonlyMap<number, PopupScroll>;
}

export const NO_LAYERS: Layers = {
  views: new Map(),
  inlines: new Map(),
  decos: new Map(),
  placedViews: [],
  placedInlines: [],
  measureInlines: [],
  placedDecos: [],
  popups: new Map(),
  placedPopups: [],
  popupScrolls: new Map(),
};

/** The events this reducer takes. */
export const LAYER_EVENTS: ReadonlySet<string> = new Set([
  "view",
  "view_clear",
  "inline",
  "inline_clear",
  "deco",
  "deco_clear",
  "popup",
  "popup_clear",
  "popup_scroll",
  "layers",
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

function ints<K extends string>(
  r: Rec,
  keys: readonly K[],
): Record<K, number> | undefined {
  const out = {} as Record<K, number>;
  for (const key of keys) {
    const v = int(r, key);
    if (v === undefined) return undefined;
    out[key] = v;
  }
  return out;
}

function without<T>(map: ReadonlyMap<number, T>, id: number): Map<number, T> {
  const next = new Map(map);
  next.delete(id);
  return next;
}

const MAX_ITEMS = 5000;

function viewContent(id: number, p: Rec): ViewContent {
  const items = luaList(p["items"])
    .slice(0, MAX_ITEMS)
    .flatMap((value) => {
      const r = rec(value);
      const line = r ? int(r, "line") : undefined;
      if (!r || line === undefined || line < 1) return [];
      const text = typeof r["text"] === "string" ? r["text"] : "";
      return [{ line, node: parseNode(r["node"]), text }];
    })
    .sort((a, b) => a.line - b.line);
  const keys = luaList(p["keys"]).flatMap((entry) => {
    const [key, label] = luaList(entry);
    return typeof key === "string" && typeof label === "string"
      ? [[key, label] as const]
      : [];
  });
  return { id, items, hl: parseHlTable(p["hl"]), keys };
}

/** One event from `devhub_gui`, applied. */
export function applyLayerEvent(
  state: Layers,
  kind: string,
  payload: unknown,
): Layers {
  const p = rec(payload);
  if (!p) return state;
  const id = int(p, "id");
  switch (kind) {
    case "view":
      if (id === undefined) return state;
      return {
        ...state,
        views: new Map(state.views).set(id, viewContent(id, p)),
      };
    case "view_clear":
      return id === undefined
        ? state
        : { ...state, views: without(state.views, id) };
    case "inline": {
      const node = parseNode(p["node"]);
      if (id === undefined || !node) return state;
      return {
        ...state,
        inlines: new Map(state.inlines).set(id, {
          id,
          node,
          hl: parseHlTable(p["hl"]),
        }),
      };
    }
    case "inline_clear":
      return id === undefined
        ? state
        : { ...state, inlines: without(state.inlines, id) };
    case "deco": {
      const style = p["style"];
      if (
        id === undefined ||
        (style !== "dim" && style !== "highlight" && style !== "tag")
      )
        return state;
      return {
        ...state,
        decos: new Map(state.decos).set(id, {
          id,
          style,
          tag: typeof p["tag"] === "string" ? p["tag"] : undefined,
          group: typeof p["group"] === "string" ? p["group"] : undefined,
          hl: parseHlTable(p["hl"]),
        }),
      };
    }
    case "popup": {
      const node = parseNode(p["node"]);
      if (id === undefined || !node) return state;
      const placement = p["placement"];
      const cells = (key: string) => {
        const v = int(p, key);
        return v !== undefined && v > 0 ? v : undefined;
      };
      return {
        ...state,
        popups: new Map(state.popups).set(id, {
          id,
          node,
          hl: parseHlTable(p["hl"]),
          placement:
            placement === "above" || placement === "auto" ? placement : "below",
          maxWidth: cells("max_width"),
          maxHeight: cells("max_height"),
        }),
      };
    }
    case "popup_clear":
      return id === undefined
        ? state
        : {
            ...state,
            popups: without(state.popups, id),
            popupScrolls: without(state.popupScrolls, id),
          };
    case "popup_scroll": {
      const by = p["by"];
      const seq = int(p, "seq");
      if (
        id === undefined ||
        seq === undefined ||
        (by !== "line" &&
          by !== "half" &&
          by !== "page" &&
          by !== "top" &&
          by !== "bottom")
      )
        return state;
      return {
        ...state,
        popupScrolls: new Map(state.popupScrolls).set(id, {
          seq,
          by,
          n: int(p, "n") ?? 1,
        }),
      };
    }
    case "deco_clear":
      return id === undefined
        ? state
        : { ...state, decos: without(state.decos, id) };
    case "layers":
      return {
        ...state,
        placedViews: luaList(p["views"]).flatMap((v) => {
          const r = rec(v);
          const n = r ? ints(r, ["id", "win", "cursor"] as const) : undefined;
          return r && n ? [{ ...n, current: r["current"] === true }] : [];
        }),
        placedInlines: luaList(p["inlines"]).flatMap((v) => {
          const r = rec(v);
          const n = r
            ? ints(r, [
                "id",
                "win",
                "row",
                "col",
                "width",
                "rows",
                "full",
              ] as const)
            : undefined;
          if (!r || !n || n.rows <= 0) return [];
          return [
            { ...n, clip: int(r, "clip") ?? 0, active: r["active"] === true },
          ];
        }),
        measureInlines: luaList(p["measure"]).flatMap((v) => {
          const r = rec(v);
          const n = r ? ints(r, ["id", "width", "full"] as const) : undefined;
          return n && n.width > 0 ? [n] : [];
        }),
        placedDecos: luaList(p["decos"]).flatMap((v) => {
          const r = rec(v);
          const n = r
            ? ints(r, ["id", "win", "row", "rows", "col", "width"] as const)
            : undefined;
          return n && n.rows > 0 ? [n] : [];
        }),
        placedPopups: luaList(p["popups"]).flatMap((v) => {
          const r = rec(v);
          const n = r
            ? ints(r, ["id", "win", "row", "col"] as const)
            : undefined;
          return r && n ? [{ ...n, focused: r["focused"] === true }] : [];
        }),
      };
    default:
      return state;
  }
}
