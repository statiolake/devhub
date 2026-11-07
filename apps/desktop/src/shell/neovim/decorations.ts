/**
 * What `devhub_gui`'s one-way events leave on the page: toasts, inline
 * images, and floats whose markdown DevHub draws natively.
 *
 * Every one is attached to a Neovim object. An image sits in the `virt_lines`
 * rows of an extmark; a rich float covers the text area of a Neovim float
 * (LSP hover, signature help). Lua says where they are on every scroll, move,
 * fold and close (`place`), relative to their window; the page only follows.
 * A payload of the wrong shape is ignored, so anything odd leaves Neovim's own
 * grid showing. See `docs/neovim-editor.md`.
 */

export type ToastLevel = "debug" | "info" | "warn" | "error";

export interface Toast {
  readonly key: number;
  readonly title: string;
  readonly msg: string;
  readonly level: ToastLevel;
  /** How long it stays, in ms. */
  readonly timeout: number;
}

/** An image's rows in one window: `row` is from the window's top. */
export interface ImagePlace {
  readonly id: number;
  readonly win: number;
  readonly row: number;
  readonly col: number;
  readonly width: number;
  /** The rows of it that are in the window. */
  readonly rows: number;
  /** The rows it has (a part below the window is clipped). */
  readonly full: number;
}

export interface RichPlace {
  readonly id: number;
  readonly win: number;
  readonly topline: number;
  readonly lines: number;
  readonly height: number;
  readonly border: boolean;
}

export interface Decorations {
  readonly toasts: readonly Toast[];
  readonly images: ReadonlyMap<number, string>;
  readonly rich: ReadonlyMap<number, string>;
  readonly placedImages: readonly ImagePlace[];
  readonly placedRich: readonly RichPlace[];
  readonly nextToast: number;
}

export const NO_DECORATIONS: Decorations = {
  toasts: [],
  images: new Map(),
  rich: new Map(),
  placedImages: [],
  placedRich: [],
  nextToast: 1,
};

/** At most this many toasts at once; the oldest goes first. */
const MAX_TOASTS = 4;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function num(r: Record<string, unknown>, key: string): number | undefined {
  const v = r[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function list(value: unknown): readonly unknown[] {
  // An empty Lua table arrives as an empty map.
  return Array.isArray(value) ? value : [];
}

function imagePlace(value: unknown): ImagePlace[] {
  const r = record(value);
  if (!r) return [];
  const [id, win, row, col, width, rows, full] = [
    "id",
    "win",
    "row",
    "col",
    "width",
    "rows",
    "full",
  ].map((k) => num(r, k));
  if (
    id === undefined ||
    win === undefined ||
    row === undefined ||
    col === undefined ||
    width === undefined ||
    rows === undefined ||
    full === undefined ||
    rows <= 0
  )
    return [];
  return [{ id, win, row, col, width, rows, full }];
}

function richPlace(value: unknown): RichPlace[] {
  const r = record(value);
  if (!r) return [];
  const [id, win, topline, lines, height] = [
    "id",
    "win",
    "topline",
    "lines",
    "height",
  ].map((k) => num(r, k));
  if (
    id === undefined ||
    win === undefined ||
    topline === undefined ||
    lines === undefined ||
    height === undefined
  )
    return [];
  return [{ id, win, topline, lines, height, border: r["border"] === true }];
}

function level(value: unknown): ToastLevel {
  return value === "debug" || value === "warn" || value === "error"
    ? value
    : "info";
}

/** One event from `devhub_gui`, applied. */
export function applyGuiEvent(
  state: Decorations,
  kind: string,
  payload: unknown,
): Decorations {
  const p = record(payload);
  if (!p) return state;
  switch (kind) {
    case "notify": {
      const msg = typeof p["msg"] === "string" ? p["msg"] : "";
      const title = typeof p["title"] === "string" ? p["title"] : "";
      if (msg === "" && title === "") return state;
      const lvl = level(p["level"]);
      const toast: Toast = {
        key: state.nextToast,
        title,
        msg,
        level: lvl,
        timeout:
          num(p, "timeout") ??
          (lvl === "error" ? 8000 : lvl === "warn" ? 6000 : 4000),
      };
      return {
        ...state,
        toasts: [...state.toasts, toast].slice(-MAX_TOASTS),
        nextToast: state.nextToast + 1,
      };
    }
    case "image": {
      const id = num(p, "id");
      const src = p["src"];
      if (id === undefined || typeof src !== "string") return state;
      if (!src.startsWith("data:image/") && !src.startsWith("https://"))
        return state;
      return { ...state, images: new Map(state.images).set(id, src) };
    }
    case "rich": {
      const id = num(p, "id");
      const markdown = p["markdown"];
      if (id === undefined || typeof markdown !== "string") return state;
      return { ...state, rich: new Map(state.rich).set(id, markdown) };
    }
    case "image_clear":
    case "rich_clear": {
      const id = num(p, "id");
      if (id === undefined) return state;
      const key = kind === "image_clear" ? "images" : "rich";
      const next = new Map(state[key]);
      next.delete(id);
      return { ...state, [key]: next };
    }
    case "place":
      return {
        ...state,
        placedImages: list(p["images"]).flatMap(imagePlace),
        placedRich: list(p["rich"]).flatMap(richPlace),
      };
    default:
      return state;
  }
}

export function dismissToast(state: Decorations, key: number): Decorations {
  return { ...state, toasts: state.toasts.filter((t) => t.key !== key) };
}

/**
 * How far a rich float's content is scrolled, as a fraction: Neovim's
 * topline over the lines it can scroll through.
 */
export function richScrollFraction(place: RichPlace): number {
  const scrollable = place.lines - place.height;
  if (scrollable <= 0) return 0;
  return Math.min(1, Math.max(0, (place.topline - 1) / scrollable));
}
