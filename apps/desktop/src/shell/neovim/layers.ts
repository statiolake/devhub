/**
 * What `devhub_gui`'s buffer-backed GUI layers leave on the page: views
 * (`gui.view`: one component per buffer line, painted over the windows that
 * show the buffer), inline cards (`gui.inline`: a component in the
 * `virt_lines` rows of an extmark),
 * popups (`gui.popup`: a component at a buffer position, a hover) and
 * framed views (`gui.view{ frame }`: a view drawn in a frame over a float,
 * round a query field and a preview window — a picker's frontend).
 *
 * Neovim owns all of it. Lua sends the content when it changes (`view`,
 * `inline`, their `*_clear`) and where everything is after every
 * scroll, cursor move, edit and window change (`layers`); the page paints
 * and sends clicks, wheel moves and a card's measured height back as Lua
 * calls. A payload of the wrong shape is ignored. See `docs/neovim-editor.md`.
 */

import {
  luaList,
  parseHlTable,
  parseNode,
  withPane,
  withSelected,
  type ComponentNode,
  type HlTable,
} from "./components";
import {
  DOCUMENT_EVENTS,
  NO_DOCUMENTS,
  applyDocumentEvent,
  type DocumentLayers,
} from "./documents";

export interface ViewItem {
  /** The buffer line (1-based) the item is. */
  readonly line: number;
  /** Its component; none: the line's own text, plainly. */
  readonly node: ComponentNode | undefined;
  /** Drawn above the item, not an item (a file's name over its matches). */
  readonly heading?: ComponentNode | undefined;
  readonly text: string;
  /** In a tree (`ViewContent.indent`), how deep the row is: 0 at the top. */
  readonly depth?: number | undefined;
  /** Held at the top while the items scroll under it (a tree's root). */
  readonly sticky?: boolean | undefined;
}

export interface ViewContent {
  readonly id: number;
  readonly items: readonly ViewItem[];
  readonly hl: HlTable;
  /** The hint line: keys and what they do. */
  readonly keys: readonly (readonly [string, string])[];
  /** Drawn in a frame over a float rather than over its windows. */
  readonly frame?: ViewFrame | undefined;
  /**
   * A tree: pixels per level of an item's `depth`. Each item is indented by
   * its depth and the guides run down the rows, one per level.
   */
  readonly indent?: number | undefined;
  /** Every item at least this tall (pixels), its content centred: a dense list. */
  readonly rowHeight?: number | undefined;
  /** It has a menu (`on_context_menu`): a right-click on an item puts it up. */
  readonly menu?: true | undefined;
}

export interface InlineContent {
  readonly id: number;
  readonly node: ComponentNode;
  readonly hl: HlTable;
}

/** A view in one window. */
export interface ViewPlace {
  readonly id: number;
  readonly win: number;
  /** The cursor's line in that window: the focused item. */
  readonly cursor: number;
  readonly current: boolean;
  /** Visual mode in that window: the first and last lines selected. */
  readonly visual?: readonly [number, number] | undefined;
}

/**
 * An inline card's reserved rows in one window, from the window's top,
 * above or below the window too, which the page cuts it to (`riders.ts`).
 */
export interface InlinePlace {
  readonly id: number;
  readonly win: number;
  readonly row: number;
  /** The rows its window had scrolled when this came (`riders.ts`). */
  readonly base: number;
  readonly col: number;
  readonly width: number;
  /** The rows reserved for it. */
  readonly rows: number;
  /** The cursor is on its anchor line(s): its keys work now. */
  readonly active: boolean;
}

/** A card whose anchor is not in view: measured ahead, at this width. */
export interface InlineMeasure {
  readonly id: number;
  readonly width: number;
  readonly full: number;
}

export type PopupPlacement = "below" | "above" | "auto";

export interface PopupContent {
  readonly id: number;
  readonly node: ComponentNode;
  readonly hl: HlTable;
  readonly placement: PopupPlacement;
  /** In cells, when the popup's owner bounds it. */
  readonly maxWidth: number | undefined;
  /** In cells: it is never narrower (a part that comes and goes). */
  readonly minWidth?: number | undefined;
  readonly maxHeight: number | undefined;
}

/**
 * A popup's anchor: its cell, from its window's top-left — or, for one
 * anchored to the command line (`anchor = 'cmdline'`), the byte of the
 * command line's text it is lined up with (`cmdline`; `win`, `row` and
 * `col` are then 0): the page knows where the box and that byte's cell are.
 */
export interface PopupPlace {
  readonly id: number;
  readonly win: number;
  readonly cmdline?: number;
  readonly row: number;
  /** As an inline card's (`riders.ts`). */
  readonly base: number;
  readonly col: number;
  /** It has the keys (j/k scroll it, q closes it). */
  readonly focused: boolean;
}

/** A scroll Neovim asked of a popup (its keys); `seq` tells a new one. */
export interface PopupScroll {
  readonly seq: number;
  readonly by: "line" | "half" | "page" | "top" | "bottom";
  readonly n: number;
  /** A pane of the popup's (`stack{ pane }`) to scroll; none: the popup. */
  readonly pane?: string | undefined;
}

/** A framed view's parts round its items (`gui.view{ frame }`). */
export interface ViewFrame {
  readonly title: ComponentNode | undefined;
  readonly status: ComponentNode | undefined;
  readonly previewTitle: ComponentNode | undefined;
  readonly placeholder: string | undefined;
  /** At the hint row's right end: buttons (a composer's send, cancel). */
  readonly actions?: ComponentNode | undefined;
}

export interface FrameRect {
  readonly row: number;
  readonly col: number;
  readonly width: number;
  readonly height: number;
  /** Its top border's rows. */
  readonly top: number;
}

export interface FramePlace {
  readonly id: number;
  /** Its windows (the frame, query, list, preview): their chrome is the page's. */
  readonly wins: readonly number[];
  /** The view's id. */
  readonly win: number;
  readonly frame: FrameRect;
  readonly list: FrameRect & {
    /** The selected row: the list window's cursor line. */
    readonly cursor: number;
    readonly current: boolean;
  };
  readonly query:
    | (FrameRect & {
        readonly text: string;
        /** The cursor's byte column in the text. */
        readonly caret: number;
        readonly current: boolean;
        readonly insert: boolean;
        /**
         * Visual mode in it: the bytes selected, first and last (the last
         * the start of the last character selected).
         */
        readonly visual?: readonly [number, number];
      })
    | undefined;
  readonly preview: (FrameRect & { readonly win: number }) | undefined;
  /**
   * A frame round an editable window (`gui.frame`): `list` is that
   * window, drawn as Neovim's cells, not rows.
   */
  readonly editor?: boolean;
}

export interface Layers extends DocumentLayers {
  readonly views: ReadonlyMap<number, ViewContent>;
  readonly inlines: ReadonlyMap<number, InlineContent>;
  readonly placedViews: readonly ViewPlace[];
  readonly placedInlines: readonly InlinePlace[];
  readonly measureInlines: readonly InlineMeasure[];
  readonly popups: ReadonlyMap<number, PopupContent>;
  readonly placedPopups: readonly PopupPlace[];
  readonly popupScrolls: ReadonlyMap<number, PopupScroll>;
  readonly placedFrames: readonly FramePlace[];
  /**
   * The last `settled` seq Lua answered (`_settle`): the placements
   * here are those of Neovim's state after the floats the page asked about
   * were shown (`ClaimAsks`).
   */
  readonly settled: number;
}

export const NO_LAYERS: Layers = {
  views: new Map(),
  inlines: new Map(),
  placedViews: [],
  placedInlines: [],
  measureInlines: [],
  popups: new Map(),
  placedPopups: [],
  popupScrolls: new Map(),
  placedFrames: [],
  settled: 0,
  ...NO_DOCUMENTS,
};

/** The events this reducer takes. */
export const LAYER_EVENTS: ReadonlySet<string> = new Set([
  "view",
  "view_clear",
  "inline",
  "inline_clear",
  "popup",
  "popup_clear",
  "popup_scroll",
  "popup_select",
  "popup_pane",
  "layers",
  "settled",
  // `gui.document` (`documents.ts`)
  ...DOCUMENT_EVENTS,
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

function num(r: Rec, key: string): number | undefined {
  const v = r[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
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
const MAX_DEPTH = 64;

function viewContent(id: number, p: Rec): ViewContent {
  const items = luaList(p["items"])
    .slice(0, MAX_ITEMS)
    .flatMap((value) => {
      const r = rec(value);
      const line = r ? int(r, "line") : undefined;
      if (!r || line === undefined || line < 1) return [];
      const text = typeof r["text"] === "string" ? r["text"] : "";
      const heading = parseNode(r["heading"]);
      const depth = int(r, "depth");
      return [
        {
          line,
          node: parseNode(r["node"]),
          text,
          ...(heading ? { heading } : {}),
          ...(depth !== undefined && depth >= 0
            ? { depth: Math.min(depth, MAX_DEPTH) }
            : {}),
          ...(r["sticky"] === true ? { sticky: true } : {}),
        },
      ];
    })
    .sort((a, b) => a.line - b.line);
  const frame = viewFrame(p["frame"]);
  const indent = num(p, "indent");
  const rowHeight = num(p, "row_height");
  return {
    id,
    items,
    ...(indent !== undefined && indent > 0
      ? { indent: Math.min(indent, 64) }
      : {}),
    ...(rowHeight !== undefined && rowHeight > 0
      ? { rowHeight: Math.min(rowHeight, 200) }
      : {}),
    hl: parseHlTable(p["hl"]),
    keys: keyList(p["keys"]),
    ...(frame ? { frame } : {}),
    ...(p["menu"] === true ? { menu: true as const } : {}),
  };
}

function keyList(value: unknown): (readonly [string, string])[] {
  return luaList(value).flatMap((entry) => {
    const [key, label] = luaList(entry);
    return typeof key === "string" && typeof label === "string"
      ? [[key, label] as const]
      : [];
  });
}

function viewFrame(value: unknown): ViewFrame | undefined {
  const f = rec(value);
  if (!f) return undefined;
  return {
    title: parseNode(f["title"]),
    status: parseNode(f["status"]),
    previewTitle: parseNode(f["preview_title"]),
    actions: parseNode(f["actions"]),
    placeholder:
      typeof f["placeholder"] === "string" ? f["placeholder"] : undefined,
  };
}

const RECT_KEYS = ["row", "col", "width", "height", "top"] as const;

function frameRect(value: unknown): FrameRect | undefined {
  const r = rec(value);
  const n = r ? ints(r, RECT_KEYS) : undefined;
  return n && n.width > 0 && n.height > 0 ? n : undefined;
}

/**
 * The windows the placed frames claim for the page, each with the window of
 * the float its frame is round (`claimFloats`).
 */
export function frameClaims(
  frames: readonly FramePlace[],
): ReadonlyMap<number, number> {
  return new Map(
    frames.flatMap((frame) =>
      frame.wins.map((win) => [win, frame.win] as const),
    ),
  );
}

/** A query's Visual bytes, `[first, last]`, when they are two in order. */
function visualOf(value: unknown): { visual?: readonly [number, number] } {
  const [from, to] = luaList(value);
  return typeof from === "number" &&
    typeof to === "number" &&
    Number.isInteger(from) &&
    Number.isInteger(to) &&
    from >= 0 &&
    to >= from
    ? { visual: [from, to] as const }
    : {};
}

function framePlace(value: unknown): FramePlace[] {
  const r = rec(value);
  const n = r ? ints(r, ["id", "win"] as const) : undefined;
  const frame = r ? frameRect(r["frame"]) : undefined;
  const listRec = r ? rec(r["list"]) : undefined;
  const list = listRec ? frameRect(listRec) : undefined;
  const cursor = listRec ? int(listRec, "cursor") : undefined;
  if (!r || !n || !frame || !listRec || !list || cursor === undefined)
    return [];
  const q = rec(r["query"]);
  const qRect = q ? frameRect(q) : undefined;
  const pv = rec(r["preview"]);
  const pvRect = pv ? frameRect(pv) : undefined;
  const pvWin = pv ? int(pv, "win") : undefined;
  const wins = luaList(r["wins"]).filter(
    (w): w is number => typeof w === "number" && Number.isInteger(w),
  );
  return [
    {
      ...n,
      wins,
      frame,
      list: { ...list, cursor, current: listRec["current"] === true },
      query:
        q && qRect
          ? {
              ...qRect,
              text: typeof q["text"] === "string" ? q["text"] : "",
              caret: int(q, "caret") ?? 0,
              current: q["current"] === true,
              insert: q["insert"] === true,
              ...visualOf(q["visual"]),
            }
          : undefined,
      preview:
        pvRect && pvWin !== undefined ? { ...pvRect, win: pvWin } : undefined,
      ...(r["editor"] === true ? { editor: true } : {}),
    },
  ];
}

/** One event from `devhub_gui`, applied. */
export function applyLayerEvent(
  state: Layers,
  kind: string,
  payload: unknown,
  /** The rows window `win` has scrolled, as the page has heard. */
  rowsOf: (win: number) => number = () => 0,
): Layers {
  const p = rec(payload);
  if (!p) return state;
  const id = int(p, "id");
  switch (kind) {
    case "settled": {
      const seq = int(p, "seq");
      return seq === undefined || seq <= state.settled
        ? state
        : { ...state, settled: seq };
    }
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
          minWidth: cells("min_width"),
        }),
      };
    }
    case "popup_pane": {
      const content = id !== undefined ? state.popups.get(id) : undefined;
      const name = p["pane"];
      if (id === undefined || !content || typeof name !== "string")
        return state;
      const children = luaList(p["children"])
        .slice(0, 400)
        .flatMap((child) => {
          const one = parseNode(child, 1);
          return one ? [one] : [];
        });
      const node = withPane(content.node, name, children);
      if (node === content.node) return state;
      // the groups the new content names, beside the ones the tree had
      const hl = new Map(content.hl);
      for (const [group, attrs] of parseHlTable(p["hl"])) hl.set(group, attrs);
      return {
        ...state,
        popups: new Map(state.popups).set(id, { ...content, node, hl }),
      };
    }
    case "popup_select": {
      const content = id !== undefined ? state.popups.get(id) : undefined;
      const n = int(p, "n");
      if (id === undefined || !content || n === undefined || n < 0)
        return state;
      const node = withSelected(content.node, n);
      if (node === content.node) return state;
      return {
        ...state,
        popups: new Map(state.popups).set(id, { ...content, node }),
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
          ...(typeof p["pane"] === "string" ? { pane: p["pane"] } : {}),
        }),
      };
    }
    case "layers":
      return {
        ...state,
        placedViews: luaList(p["views"]).flatMap((v) => {
          const r = rec(v);
          const n = r ? ints(r, ["id", "win", "cursor"] as const) : undefined;
          if (!r || !n) return [];
          const [from, to] = luaList(r["visual"]);
          const visual =
            typeof from === "number" &&
            typeof to === "number" &&
            Number.isInteger(from) &&
            Number.isInteger(to) &&
            from >= 1 &&
            to >= from
              ? ([from, to] as const)
              : undefined;
          return [
            {
              ...n,
              current: r["current"] === true,
              ...(visual ? { visual } : {}),
            },
          ];
        }),
        placedInlines: luaList(p["inlines"]).flatMap((v) => {
          const r = rec(v);
          const n = r
            ? ints(r, ["id", "win", "row", "col", "width", "rows"] as const)
            : undefined;
          if (!r || !n || n.rows <= 0) return [];
          return [{ ...n, base: rowsOf(n.win), active: r["active"] === true }];
        }),
        measureInlines: luaList(p["measure"]).flatMap((v) => {
          const r = rec(v);
          const n = r ? ints(r, ["id", "width", "full"] as const) : undefined;
          return n && n.width > 0 ? [n] : [];
        }),
        placedPopups: luaList(p["popups"]).flatMap((v): PopupPlace[] => {
          const r = rec(v);
          const id = r ? int(r, "id") : undefined;
          const byte = r ? int(r, "cmdline") : undefined;
          if (id !== undefined && byte !== undefined)
            return [
              {
                id,
                win: 0,
                row: 0,
                col: 0,
                base: 0,
                cmdline: Math.max(0, byte),
                focused: false,
              },
            ];
          const n = r
            ? ints(r, ["id", "win", "row", "col"] as const)
            : undefined;
          return r && n
            ? [{ ...n, base: rowsOf(n.win), focused: r["focused"] === true }]
            : [];
        }),
        placedFrames: luaList(p["frames"]).flatMap(framePlace),
      };
    default:
      return applyDocumentEvent(state, kind, payload);
  }
}
