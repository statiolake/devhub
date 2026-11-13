/**
 * A native menu Lua asks for (`gui.menu`, and a view's `on_context_menu` on
 * a right-click or `<S-F10>`): the `menu` event from `devhub_gui`, read
 * here, and put up by main as every other context menu in the window is
 * (`main/shell/contextMenu.ts`, the Sidebar's row menus and the links').
 *
 * Only labels and ids cross: what an item does stays a Lua function, run by
 * `_menu_done` with the id that comes back. Neovim keeps the keys, so the
 * keyboard's way to the menu is a key Neovim is typed (`<S-F10>`, which the
 * menu key is sent as: `keys.ts`), mapped by `devhub_gui` in a view's buffer.
 *
 * An item's keys are as Vim writes them (`<C-v>`, `a`, `gy`): one that a
 * macOS menu can show in its key column is shown there (display only —
 * Neovim still takes the key); a sequence it cannot is put after the label
 * in brackets, as VS Code does for a chord.
 */

import type { ContextMenuItemWire } from "../../ipc/contract";

export interface MenuEntry {
  readonly label?: string;
  readonly id?: string;
  readonly enabled: boolean;
  readonly keys?: string;
  readonly separator?: true;
  readonly submenu?: readonly MenuEntry[];
}

export interface MenuRequest {
  readonly id: number;
  readonly items: readonly MenuEntry[];
  /** The pointer, in the page's coordinates: a right-click. */
  readonly at?: { readonly x: number; readonly y: number };
  readonly win: number;
  readonly line: number;
  /** The view of that window, whose item of `line` it is under. */
  readonly view?: number;
  /** The line's first cell on the screen, 1-based (0: not in sight). */
  readonly screen?: { readonly row: number; readonly col: number };
}

type Rec = Readonly<Record<string, unknown>>;

function rec(value: unknown): Rec | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

/** Lua's list: an array, or `{}` (an empty table arrives as a map). */
function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

const MAX_ITEMS = 200;
const MAX_DEPTH = 8;

function entries(value: unknown, depth: number): MenuEntry[] {
  if (depth > MAX_DEPTH) return [];
  return list(value)
    .slice(0, MAX_ITEMS)
    .flatMap((raw): MenuEntry[] => {
      const r = rec(raw);
      if (!r) return [];
      if (r["separator"] === true) return [{ enabled: true, separator: true }];
      const label = r["label"];
      if (typeof label !== "string" || label === "") return [];
      const keys = typeof r["keys"] === "string" ? r["keys"] : undefined;
      const enabled = r["enabled"] !== false;
      if (r["submenu"] !== undefined) {
        const submenu = entries(r["submenu"], depth + 1);
        return [{ label, enabled, submenu }];
      }
      const id = r["id"];
      if (typeof id !== "string") return [];
      return [{ label, id, enabled, ...(keys !== undefined ? { keys } : {}) }];
    });
}

/** The `menu` event's payload, or `undefined` for one of the wrong shape. */
export function parseMenuRequest(payload: unknown): MenuRequest | undefined {
  const p = rec(payload);
  const id = p ? finite(p["id"]) : undefined;
  if (!p || id === undefined) return undefined;
  const at = rec(p["at"]);
  const x = at ? finite(at["x"]) : undefined;
  const y = at ? finite(at["y"]) : undefined;
  const screen = rec(p["screen"]);
  const row = screen ? finite(screen["row"]) : undefined;
  const col = screen ? finite(screen["col"]) : undefined;
  const view = finite(p["view"]);
  return {
    id,
    items: entries(p["items"], 0),
    win: finite(p["win"]) ?? 0,
    line: finite(p["line"]) ?? 0,
    ...(x !== undefined && y !== undefined ? { at: { x, y } } : {}),
    ...(view !== undefined ? { view } : {}),
    ...(row !== undefined && col !== undefined && row > 0
      ? { screen: { row, col } }
      : {}),
  };
}

/** Vim's names of keys an Electron accelerator names too. */
const ACCELERATOR_KEYS: Readonly<Record<string, string>> = {
  cr: "Return",
  enter: "Return",
  return: "Return",
  tab: "Tab",
  bs: "Backspace",
  del: "Delete",
  esc: "Escape",
  space: "Space",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  insert: "Insert",
  lt: "<",
  bslash: "\\",
  bar: "|",
};

const MODIFIERS: Readonly<Record<string, string>> = {
  c: "Ctrl",
  s: "Shift",
  m: "Alt",
  a: "Alt",
  d: "Cmd",
};

function acceleratorKey(key: string, shifted: boolean): string | undefined {
  const named = ACCELERATOR_KEYS[key.toLowerCase()];
  if (named !== undefined) return named;
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(key)) return key.toUpperCase();
  if (key.length !== 1) return undefined;
  // A letter Vim spells upper-case is Shift and that letter.
  if (/[A-Z]/.test(key)) return shifted ? undefined : `Shift+${key}`;
  if (/[a-z]/.test(key)) return key.toUpperCase();
  // A printable key as it is (`-`, `.`, `?`).
  return /[!-~]/.test(key) ? key : undefined;
}

/**
 * The keys as an Electron accelerator a menu can show — one key, with or
 * without modifiers — or `undefined` for a sequence (`gy`) or a key it has
 * no name for (`<2-LeftMouse>`).
 */
export function vimKeysToAccelerator(keys: string): string | undefined {
  const bracket = /^<([A-Za-z0-9]-)*[^<>]+>$/.exec(keys);
  if (bracket) {
    const body = keys.slice(1, -1);
    const parts = body.split("-");
    // `<C-->`: the key is "-"
    let key = parts.pop() ?? "";
    if (key === "" && body.endsWith("-")) {
      parts.pop();
      key = "-";
    }
    const mods: string[] = [];
    for (const part of parts) {
      const mod = MODIFIERS[part.toLowerCase()];
      if (mod === undefined) return undefined;
      if (!mods.includes(mod)) mods.push(mod);
    }
    if (key.length === 1 && mods.includes("Ctrl")) key = key.toLowerCase();
    const base = acceleratorKey(key, mods.includes("Shift"));
    if (base === undefined) return undefined;
    const all = base.startsWith("Shift+")
      ? [...mods.filter((m) => m !== "Shift"), base]
      : [...mods, base];
    return all.join("+");
  }
  if ([...keys].length !== 1) return undefined;
  return acceleratorKey(keys, false);
}

/**
 * The items as main's menu takes them: a separator becomes the next item's
 * `separatorBefore`, keys become the accelerator or the label's suffix.
 */
export function menuWire(
  items: readonly MenuEntry[],
): readonly ContextMenuItemWire[] {
  const out: ContextMenuItemWire[] = [];
  let separate = false;
  items.forEach((item, index) => {
    if (item.separator === true || item.label === undefined) {
      separate = out.length > 0;
      return;
    }
    const accelerator =
      item.keys !== undefined ? vimKeysToAccelerator(item.keys) : undefined;
    const label =
      item.keys !== undefined && accelerator === undefined
        ? `${item.label} [${item.keys}]`
        : item.label;
    const submenu =
      item.submenu !== undefined ? menuWire(item.submenu) : undefined;
    out.push({
      id: item.id ?? `submenu:${String(index)}`,
      label,
      ...(separate ? { separatorBefore: true as const } : {}),
      ...(item.enabled ? {} : { enabled: false as const }),
      ...(accelerator !== undefined ? { accelerator } : {}),
      ...(submenu !== undefined ? { submenu } : {}),
    });
    separate = false;
  });
  return out;
}

/**
 * Where the menu goes, in the page's coordinates: at the pointer for a
 * right-click; else under the start of the view's row for the line (the
 * keyboard's menu, at the focused row); else under the line's first cell.
 */
export function menuPoint(
  request: MenuRequest,
  rowBox: (view: number, win: number, line: number) => DOMRect | undefined,
  screen:
    | {
        readonly left: number;
        readonly top: number;
        readonly cell: { readonly width: number; readonly height: number };
      }
    | undefined,
): { readonly x: number; readonly y: number } {
  if (request.at !== undefined) return request.at;
  const box =
    request.view !== undefined
      ? rowBox(request.view, request.win, request.line)
      : undefined;
  if (box !== undefined) return { x: box.left + 8, y: box.bottom };
  if (request.screen !== undefined && screen !== undefined) {
    return {
      x: screen.left + (request.screen.col - 1) * screen.cell.width,
      y: screen.top + request.screen.row * screen.cell.height,
    };
  }
  return { x: screen?.left ?? 0, y: screen?.top ?? 0 };
}
