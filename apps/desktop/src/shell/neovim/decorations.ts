/**
 * What `devhub_gui`'s one-way events leave on the page: notifications and
 * inline images.
 *
 * An image sits in the `virt_lines` rows of an extmark. Lua says where it is
 * on every scroll, move, fold and close (`place`), relative to its window;
 * the page only follows.
 * A payload of the wrong shape is ignored, so anything odd leaves Neovim's own
 * grid showing. See `docs/neovim-editor.md`.
 */

export type ToastLevel = "debug" | "info" | "warn" | "error";

/**
 * A notification (`gui.notify`, `vim.notify` when devhub.nvim replaces it,
 * an LSP's progress): fidget-like, bottom right, grouped by its source.
 */
export interface Toast {
  readonly key: number;
  /** Lua's key for it: a later notify with the same one updates it. */
  readonly id: string | undefined;
  /** Its source (an LSP client, a plugin): the heading it is under. */
  readonly group: string;
  readonly title: string;
  readonly msg: string;
  readonly level: ToastLevel;
  /** How long it stays, in ms (0: until it is updated or dismissed). */
  readonly timeout: number;
  /** Work in progress: a spinner, a percentage, a tick when done. */
  readonly progress:
    | { readonly percent: number | undefined; readonly done: boolean }
    | undefined;
  /** Bumped by each update: its fade starts again. */
  readonly rev: number;
}

/**
 * An image's rows in one window: `row` is from the window's top, above or
 * below the window too, which the page cuts the image to (`riders.ts`).
 */
export interface ImagePlace {
  readonly id: number;
  readonly win: number;
  readonly row: number;
  /** The rows its window had scrolled when this came (`riders.ts`). */
  readonly base: number;
  readonly col: number;
  readonly width: number;
  readonly rows: number;
}

export interface Decorations {
  readonly toasts: readonly Toast[];
  readonly images: ReadonlyMap<number, string>;
  readonly placedImages: readonly ImagePlace[];
  readonly nextToast: number;
}

export const NO_DECORATIONS: Decorations = {
  toasts: [],
  images: new Map(),
  placedImages: [],
  nextToast: 1,
};

/** At most this many notifications at once; the oldest goes first. */
const MAX_TOASTS = 8;

/** A level's time on screen; work in progress stays until it is done. */
function timeoutOf(level: ToastLevel, progress: Toast["progress"]): number {
  if (progress) return progress.done ? 2000 : 0;
  return level === "error" ? 8000 : level === "warn" ? 6000 : 4000;
}

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

function imagePlace(
  value: unknown,
  rowsOf: (win: number) => number,
): ImagePlace[] {
  const r = record(value);
  if (!r) return [];
  const [id, win, row, col, width, rows] = [
    "id",
    "win",
    "row",
    "col",
    "width",
    "rows",
  ].map((k) => num(r, k));
  if (
    id === undefined ||
    win === undefined ||
    row === undefined ||
    col === undefined ||
    width === undefined ||
    rows === undefined ||
    rows <= 0
  )
    return [];
  return [{ id, win, row, base: rowsOf(win), col, width, rows }];
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
  /** The rows window `win` has scrolled, as the page has heard. */
  rowsOf: (win: number) => number = () => 0,
): Decorations {
  const p = record(payload);
  if (!p) return state;
  switch (kind) {
    case "notify": {
      const msg = typeof p["msg"] === "string" ? p["msg"] : "";
      const title = typeof p["title"] === "string" ? p["title"] : "";
      if (msg === "" && title === "") return state;
      const lvl = level(p["level"]);
      const id = typeof p["key"] === "string" ? p["key"] : undefined;
      const percent = num(p, "percent");
      const progress =
        p["progress"] === true || percent !== undefined
          ? {
              percent:
                percent !== undefined
                  ? Math.min(100, Math.max(0, percent))
                  : undefined,
              done: p["done"] === true,
            }
          : undefined;
      const before =
        id !== undefined ? state.toasts.find((t) => t.id === id) : undefined;
      const toast: Toast = {
        key: before?.key ?? state.nextToast,
        id,
        group: typeof p["group"] === "string" ? p["group"] : "",
        title,
        msg,
        level: lvl,
        timeout: num(p, "timeout") ?? timeoutOf(lvl, progress),
        progress,
        rev: (before?.rev ?? 0) + 1,
      };
      if (before) {
        return {
          ...state,
          toasts: state.toasts.map((t) => (t === before ? toast : t)),
        };
      }
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
    case "image_clear": {
      const id = num(p, "id");
      if (id === undefined) return state;
      const next = new Map(state.images);
      next.delete(id);
      return { ...state, images: next };
    }
    case "place":
      return {
        ...state,
        placedImages: list(p["images"]).flatMap((v) => imagePlace(v, rowsOf)),
      };
    default:
      return state;
  }
}

export function dismissToast(state: Decorations, key: number): Decorations {
  return { ...state, toasts: state.toasts.filter((t) => t.key !== key) };
}

/** Notifications by source, in the order each source first spoke. */
export function toastGroups(
  toasts: readonly Toast[],
): { readonly group: string; readonly toasts: readonly Toast[] }[] {
  const groups = new Map<string, Toast[]>();
  for (const toast of toasts) {
    const list = groups.get(toast.group);
    if (list) list.push(toast);
    else groups.set(toast.group, [toast]);
  }
  return [...groups].map(([group, list]) => ({ group, toasts: list }));
}
