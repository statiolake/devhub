/**
 * The page's side of `layers.ts`: views painted over their windows, cards in
 * the rows their extmarks reserve, and popups.
 *
 * Neovim keeps the state and the keys. A view's focused item is the line
 * Neovim's cursor is on; the view scrolls (in pixels, its own way: items are
 * as tall as they draw) only as far as it takes to keep that item in sight.
 * A click moves the cursor there and runs the item's Lua; the wheel scrolls
 * the view and takes the cursor along when its item leaves the view. A
 * card's height is measured here and sent back, so Neovim reserves exactly
 * the rows it takes.
 */

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ComponentTree, fgOf, type ComponentTheme } from "./ComponentView";
import { ColouringWait } from "./DecorationViews";
import {
  clampScroll,
  isDark,
  revealScroll,
  rgbCss,
  rowsFor,
  wheelFocus,
  type HlTable,
} from "./components";
import type {
  InlineContent,
  Layers,
  PopupContent,
  PopupPlace,
  PopupScroll,
  ViewContent,
  ViewPlace,
} from "./layers";
import { placePopup, popupMaxWidth, popupScrollTop } from "./popup";
import type { OverPart } from "./painter";
import { createPortal } from "react-dom";
import type { GridBox } from "./redraw";
import { formatKeys } from "../../model/keyNotation";

interface Cell {
  readonly width: number;
  readonly height: number;
}

/** What the layers need from the page. */
export interface LayerHost {
  readonly cell: Cell;
  readonly boxes: readonly GridBox[];
  /** The grid's font family, for `mono` and icons. */
  readonly mono: string;
  readonly defaults: {
    readonly foreground: number;
    readonly background: number;
  };
  /** Run a function of `devhub_gui` in Neovim (a notification). */
  readonly lua: (fn: string, args: readonly unknown[]) => void;
  readonly openLink: (url: string) => void;
  /** Give the keyboard back to Neovim. */
  readonly refocus: () => void;
  /** Move what rides the windows' text to it (`riders.ts`). */
  readonly ride: () => void;
  /**
   * The element what lies over a grid goes in: its own clip, in its
   * stacking order (`GridPainter.over`).
   */
  readonly over: (grid: number, part: OverPart) => HTMLElement;
}

/** Riders laid out again: placed on the text before the frame is drawn. */
function useRide(host: LayerHost): void {
  useLayoutEffect(() => {
    host.ride();
  });
}

function themeFor(
  host: LayerHost,
  hl: HlTable,
  onAction: (action: number) => void,
): ComponentTheme {
  const normal = hl.get("Normal");
  const fg = normal?.fg ?? host.defaults.foreground;
  const bg = normal?.bg ?? host.defaults.background;
  return {
    hl,
    fg,
    bg,
    dark: isDark(bg),
    mono: host.mono,
    openLink: host.openLink,
    onAction,
  };
}

/** The cursor's colour: the ring around what the cursor is on. */
function ringColor(hl: HlTable, fg: number): string {
  const cursor = hl.get("Cursor");
  const rgb = cursor?.bg ?? cursor?.fg ?? fg;
  return rgbCss(rgb);
}

export function GuiViews({
  layers,
  host,
}: {
  readonly layers: Layers;
  readonly host: LayerHost;
}) {
  return (
    <>
      {layers.placedViews.map((place) => {
        const content = layers.views.get(place.id);
        const box = host.boxes.find((b) => b.win === place.win);
        if (!content || !box) return null;
        return createPortal(
          <GuiView content={content} place={place} box={box} host={host} />,
          host.over(box.grid, "covers"),
          `${String(place.id)}:${String(place.win)}`,
        );
      })}
    </>
  );
}

function GuiView({
  content,
  place,
  box,
  host,
}: {
  readonly content: ViewContent;
  readonly place: ViewPlace;
  readonly box: GridBox;
  readonly host: LayerHost;
}) {
  const { cell } = host;
  const scroller = useRef<HTMLDivElement>(null);
  const placeRef = useRef(place);
  placeRef.current = place;
  // The focused item: the cursor's line, or the last item above it.
  let focused = -1;
  content.items.forEach((item, index) => {
    if (item.line <= place.cursor) focused = index;
  });
  const focusedRef = useRef(focused);
  focusedRef.current = focused;

  const boxes = (): { top: number; height: number }[] => {
    const el = scroller.current;
    if (!el) return [];
    return Array.from(el.children, (child) => {
      const item = child as HTMLElement;
      return { top: item.offsetTop, height: item.offsetHeight };
    });
  };

  // Keep the focused item in sight, moving as little as possible.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const item = boxes()[focusedRef.current];
    if (!item) return;
    el.scrollTop = revealScroll(
      el.scrollTop,
      el.clientHeight,
      item.top,
      item.height,
    );
  });

  const theme = themeFor(host, content.hl, () => undefined);
  const ring = ringColor(content.hl, theme.fg);
  const cursorLine = content.hl.get("CursorLine")?.bg;
  const click = (line: number, action: number | null) => {
    host.lua("_layers_click", ["view", content.id, place.win, line, action]);
    host.refocus();
  };

  const style: CSSProperties = {
    left: box.col * cell.width,
    top: box.row * cell.height,
    width: box.width * cell.width,
    height: box.height * cell.height,
    background: rgbCss(theme.bg),
    color: rgbCss(theme.fg),
    ["--nvim-ring" as string]: ring,
    ["--nvim-ground" as string]: rgbCss(theme.bg),
    ["--nvim-grid-font" as string]: host.mono,
    ["--nvim-cursorline" as string]:
      cursorLine !== undefined
        ? rgbCss(cursorLine)
        : `color-mix(in srgb, ${rgbCss(theme.fg)} 8%, transparent)`,
    ["--nvim-muted" as string]:
      fgOf(content.hl, "Comment") ?? rgbCss(theme.fg, 0.55),
  };
  return (
    <div
      className={`nvim-view${place.current ? " nvim-view-current" : ""}`}
      style={style}
      onWheel={(event) => {
        const el = scroller.current;
        if (!el) return;
        event.stopPropagation();
        const delta =
          event.deltaMode === 1
            ? event.deltaY * cell.height
            : event.deltaMode === 2
              ? event.deltaY * el.clientHeight
              : event.deltaY;
        const items = boxes();
        const last = items.at(-1);
        const height = last ? last.top + last.height : 0;
        el.scrollTop = clampScroll(
          el.scrollTop + delta,
          height,
          el.clientHeight,
        );
        const next = wheelFocus(
          items,
          focusedRef.current,
          el.scrollTop,
          el.clientHeight,
        );
        const item = content.items[next];
        if (next !== focusedRef.current && item) {
          focusedRef.current = next;
          host.lua("_view_cursor", [
            content.id,
            placeRef.current.win,
            item.line,
          ]);
        }
      }}
    >
      <div className="nvim-view-scroll" ref={scroller}>
        {content.items.map((item, index) => {
          const isCard =
            item.node !== undefined &&
            (item.node.type === "stack" || item.node.type === "hstack") &&
            item.node.card === true;
          return (
            <div
              key={item.line}
              className={[
                "nvim-view-item",
                index === focused ? "nvim-view-focused" : "",
                isCard ? "nvim-view-card" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              data-line={item.line}
              onMouseDown={(event) => {
                event.preventDefault();
                click(item.line, null);
              }}
            >
              {item.heading ? (
                <div className="nvim-view-heading">
                  <ComponentTree node={item.heading} theme={theme} />
                </div>
              ) : null}
              {item.node ? (
                <ComponentTree
                  node={item.node}
                  theme={{
                    ...theme,
                    onAction: (action) => {
                      click(item.line, action);
                    },
                  }}
                />
              ) : (
                <span className="nvim-view-plain">
                  {item.text === "" ? " " : item.text}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {content.keys.length > 0 ? (
        <div className="nvim-view-keys">
          {content.keys.map(([key, label], index) => (
            <span key={index} className="nvim-view-key">
              {key.split("/").map((part, i) => (
                <span key={i}>
                  {i > 0 ? "/" : null}
                  <kbd className="nvc-kbd">{formatKeys(part)}</kbd>
                </span>
              ))}
              <span>{label}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Inline cards. The rows were reserved by Lua; the card is measured here at
 * the width it is drawn and its rows are sent back when they differ, once
 * per change (the height depends on the width only, so it settles).
 */
export function InlineCards({
  layers,
  host,
}: {
  readonly layers: Layers;
  readonly host: LayerHost;
}) {
  // What was last asked for each card, as "reserved>measured": asked once
  // per change of either, so a card is never asked about twice while Lua
  // applies it, and is asked again when Lua's rows change under it.
  const reported = useRef(new Map<number, string>());
  const report = (id: number, full: number, rows: number) => {
    if (rows === full) {
      // Settled: a later change of Lua's rows is asked about afresh.
      reported.current.delete(id);
      return;
    }
    const key = `${String(full)}>${String(rows)}`;
    if (reported.current.get(id) === key) return;
    reported.current.set(id, key);
    host.lua("_inline_rows", [id, rows]);
  };
  useRide(host);
  const { cell } = host;
  const measured = new Set<number>();
  const cards: ReactNode[] = layers.placedInlines.map((place) => {
    const content = layers.inlines.get(place.id);
    const box = host.boxes.find((b) => b.win === place.win);
    if (!content || !box) return null;
    // One window measures; another of a different width only paints.
    const measures = !measured.has(place.id);
    measured.add(place.id);
    return createPortal(
      <div
        className="nvim-inline-slot"
        data-ride-win={place.win}
        data-ride-base={place.base}
        style={{
          left: (box.col + place.col) * cell.width,
          top: (box.row + place.row) * cell.height,
          width: place.width * cell.width,
          height: place.rows * cell.height,
        }}
      >
        <InlineCard
          content={content}
          host={host}
          active={place.active}
          full={place.rows}
          onHeight={
            measures
              ? (px) => {
                  report(place.id, place.rows, rowsFor(px, cell.height));
                }
              : undefined
          }
          onClick={() => {
            host.lua("_layers_click", [
              "inline",
              place.id,
              place.win,
              null,
              null,
            ]);
          }}
          onAction={(action) => {
            host.lua("_layers_click", [
              "inline",
              place.id,
              place.win,
              null,
              action,
            ]);
            host.refocus();
          }}
        />
      </div>,
      host.over(box.grid, "riders"),
      `${String(place.id)}:${String(place.win)}`,
    );
  });
  const ahead = layers.measureInlines.map((m) => {
    const content = layers.inlines.get(m.id);
    if (!content || measured.has(m.id)) return null;
    measured.add(m.id);
    return (
      <div
        key={`measure:${String(m.id)}`}
        className="nvim-inline-measure"
        style={{ width: m.width * cell.width }}
        aria-hidden
      >
        <InlineCard
          content={content}
          host={host}
          active={false}
          full={m.full}
          onHeight={(px) => {
            report(m.id, m.full, rowsFor(px, cell.height));
          }}
          onClick={() => undefined}
          onAction={() => undefined}
        />
      </div>
    );
  });
  return (
    <>
      {cards}
      {ahead}
    </>
  );
}

function InlineCard({
  content,
  host,
  active,
  full,
  onHeight,
  onClick,
  onAction,
}: {
  readonly content: InlineContent;
  readonly host: LayerHost;
  readonly active: boolean;
  /** The rows Lua reserved: measured again when they change. */
  readonly full: number;
  readonly onHeight: ((px: number) => void) | undefined;
  readonly onClick: () => void;
  readonly onAction: (action: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onHeightRef = useRef(onHeight);
  onHeightRef.current = onHeight;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      onHeightRef.current?.(el.offsetHeight);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [content, full]);
  const theme = themeFor(host, content.hl, onAction);
  return (
    <div
      ref={ref}
      className={`nvim-inline-card${active ? " nvim-inline-active" : ""}`}
      style={{
        color: rgbCss(theme.fg),
        ["--nvim-ring" as string]: ringColor(content.hl, theme.fg),
        ["--nvim-ground" as string]: rgbCss(theme.bg),
        ["--nvim-grid-font" as string]: host.mono,
        ["--nvim-muted" as string]:
          fgOf(content.hl, "Comment") ?? rgbCss(theme.fg, 0.55),
      }}
      onMouseDown={(event) => {
        if ((event.target as HTMLElement).closest("[data-action]")) return;
        event.preventDefault();
        onClick();
        host.refocus();
      }}
    >
      <ComponentTree node={content.node} theme={theme} />
    </div>
  );
}

/**
 * Popups (`gui.popup`, a hover): a component at a buffer position, with no
 * Neovim window. Laid out the page's way — prose reflowed, code wrapped —
 * at most as wide and tall as its owner says and the editor allows, under
 * its anchor or above it (`placePopup`), following the anchor as the window
 * scrolls; taller content scrolls inside, with a fade at the clipped edge.
 * Neovim keeps the keys: a focused popup scrolls as Lua asks (j/k, <C-d>,
 * gg/G: `popupScrolls`); the wheel scrolls it here.
 */
export function Popups({
  layers,
  host,
  area,
}: {
  readonly layers: Layers;
  readonly host: LayerHost;
  /** The editor's size, in pixels. */
  readonly area: { readonly width: number; readonly height: number };
}) {
  useRide(host);
  return (
    <>
      {layers.placedPopups.map((place) => {
        const content = layers.popups.get(place.id);
        const box = host.boxes.find((b) => b.win === place.win);
        if (!content || !box) return null;
        return (
          <Popup
            key={place.id}
            content={content}
            place={place}
            box={box}
            host={host}
            area={area}
            scroll={layers.popupScrolls.get(place.id)}
          />
        );
      })}
    </>
  );
}

/**
 * Where a popup's anchored node (`anchor = true`, the first) starts, from
 * the popup's outer left edge: the popup moves left by as much, so the node
 * starts at the anchor's column. Offsets, not boxes: an arriving popup's
 * scale does not count.
 */
function anchorOffset(popup: HTMLElement, body: HTMLElement): number {
  const node = body.querySelector<HTMLElement>("[data-anchor]");
  if (!node) return 0;
  let x = 0;
  let el: HTMLElement | null = node;
  while (el && el !== popup) {
    x += el.offsetLeft;
    const parent: Element | null = el.offsetParent;
    el = parent instanceof HTMLElement ? parent : null;
  }
  return el === popup ? x + popup.clientLeft : 0;
}

/**
 * The popup body's height as its pane (`stack{ pane }`) would leave it at
 * its own max_height: what the popup wants, whatever the pane gave up for
 * want of room (`--nvim-pane-cut`), so the cut never feeds back into it.
 */
function naturalHeight(body: HTMLElement, height: number): number {
  const pane = body.querySelector<HTMLElement>("[data-pane]");
  const max = Number(pane?.dataset["paneMax"]);
  if (!pane || !(max > 0)) return height;
  return height - pane.clientHeight + Math.min(pane.scrollHeight, max);
}

/** A width of the popup's, less its line on both sides (`--popup-line`). */
function inner(width: number): string {
  return `calc(${String(width)}px - 2 * var(--popup-line))`;
}

/** A popup's line, for j/k: its prose's line height. */
const POPUP_LINE = 19;

/**
 * How long a popup's first frame waits for the colouring of its code when
 * the grammar is still loading (the first hover in a language): long enough
 * for the app's own chunks, short enough that a popup never feels late.
 */
export const POPUP_COLOURING_HOLD_MS = 400;

function Popup({
  content,
  place,
  box,
  host,
  area,
  scroll,
}: {
  readonly content: PopupContent;
  readonly place: PopupPlace;
  readonly box: GridBox;
  readonly host: LayerHost;
  readonly area: { readonly width: number; readonly height: number };
  readonly scroll: PopupScroll | undefined;
}) {
  const { cell } = host;
  const scroller = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<
    { readonly width: number; readonly height: number } | undefined
  >();
  const [more, setMore] = useState({ above: false, below: false });
  // How far right of the popup's edge its anchored node starts (`anchor`).
  const [anchorDx, setAnchorDx] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  // Code blocks whose grammar is still loading: until they are coloured (or
  // the hold runs out) a popup not yet shown stays hidden, so that it opens
  // coloured and is never drawn plain first.
  const [colouring, setColouring] = useState(0);
  const shown = useRef(false);
  const waitColouring = useCallback((coloured: Promise<unknown>) => {
    if (shown.current) return;
    setColouring((n) => n + 1);
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(hold);
      setColouring((n) => n - 1);
    };
    const hold = setTimeout(settle, POPUP_COLOURING_HOLD_MS);
    void coloured.finally(settle);
  }, []);
  const edges = () => {
    const el = scroller.current;
    if (!el) return;
    const above = el.scrollTop > 1;
    const below = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    setMore((m) =>
      m.above === above && m.below === below ? m : { above, below },
    );
  };
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return undefined;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      // The popup's own border is outside its content: a popup as tall as
      // its content holds it all, with no scrollbar for those two pixels.
      const r = root.current;
      const width = rect.width + (r ? r.offsetWidth - r.clientWidth : 0);
      const height =
        naturalHeight(el, rect.height) +
        (r ? r.offsetHeight - r.clientHeight : 0);
      setSize((s) =>
        s?.width === width && s.height === height ? s : { width, height },
      );
      edges();
      const dx = root.current ? anchorOffset(root.current, el) : 0;
      setAnchorDx((d) => (d === dx ? d : dx));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [content]);
  const seq = useRef(0);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !scroll || scroll.seq === seq.current) return;
    seq.current = scroll.seq;
    // a pane inside (`stack{ pane }`) when it names one, else the popup
    const pane =
      scroll.pane !== undefined
        ? body.current?.querySelector<HTMLElement>(
            `[data-pane="${CSS.escape(scroll.pane)}"]`,
          )
        : undefined;
    const target = pane ?? el;
    target.scrollTop = popupScrollTop(target.scrollTop, scroll, {
      height: target.clientHeight,
      content: target.scrollHeight,
      line: POPUP_LINE,
    });
    edges();
  }, [scroll]);
  const maxWidth = popupMaxWidth(content.maxWidth, cell.width, area.width);
  const minWidth =
    content.minWidth !== undefined
      ? Math.min(content.minWidth * cell.width, maxWidth)
      : undefined;
  const anchorY = (box.row + place.row) * cell.height;
  const layout = size
    ? placePopup({
        anchor: {
          x: (box.col + place.col) * cell.width - anchorDx,
          y: anchorY,
        },
        cellHeight: cell.height,
        size,
        area,
        placement: content.placement,
        maxHeight:
          content.maxHeight !== undefined
            ? content.maxHeight * cell.height
            : undefined,
      })
    : undefined;
  const visible = layout !== undefined && (shown.current || colouring === 0);
  useLayoutEffect(() => {
    if (visible) shown.current = true;
  }, [visible]);
  const theme = themeFor(host, content.hl, (action) => {
    host.lua("_layers_click", ["popup", place.id, null, null, action]);
    host.refocus();
  });
  // A popup wears the floats' colours.
  const float = content.hl.get("NormalFloat");
  const bg = float?.bg ?? theme.bg;
  const fg = float?.fg ?? theme.fg;
  return (
    <div
      ref={root}
      className={`nvim-popup${place.focused ? " nvim-popup-focused" : ""}`}
      data-ride-win={place.win}
      data-ride-base={place.base}
      data-ride-cut={`anchor:${String(anchorY - (layout?.top ?? 0))}`}
      style={{
        left: layout?.left ?? 0,
        top: layout?.top ?? 0,
        height: layout?.height,
        maxWidth,
        visibility: visible ? undefined : "hidden",
        color: rgbCss(fg),
        background: rgbCss(bg),
        ["--nvim-ring" as string]: ringColor(content.hl, fg),
        ["--nvim-ground" as string]: rgbCss(bg),
        // The room the popup lacks, taken from its pane (not the list).
        ["--nvim-pane-cut" as string]: `${String(
          layout && size ? Math.max(0, size.height - layout.height) : 0,
        )}px`,
        ["--nvim-grid-font" as string]: host.mono,
        ["--nvim-muted" as string]:
          fgOf(content.hl, "Comment") ?? rgbCss(fg, 0.55),
      }}
      onMouseUp={() => {
        // A plain click gives the keyboard back to Neovim; a selection stays
        // (to be copied).
        if (window.getSelection()?.isCollapsed !== false) host.refocus();
      }}
    >
      <div ref={scroller} className="nvim-popup-scroll" onScroll={edges}>
        <div
          ref={body}
          className="nvim-popup-body"
          // The popup's widths are its outer ones: its body's are less its
          // line, or a popup at its max_width clips the body's right edge.
          style={{
            maxWidth: inner(maxWidth),
            ...(minWidth !== undefined ? { minWidth: inner(minWidth) } : {}),
          }}
        >
          <ColouringWait.Provider value={waitColouring}>
            <ComponentTree
              node={content.node}
              theme={{ ...theme, fg, bg, dark: isDark(bg) }}
            />
          </ColouringWait.Provider>
        </div>
      </div>
      {more.above ? (
        <div className="nvim-popup-fade nvim-popup-fade-top" aria-hidden />
      ) : null}
      {more.below ? (
        <div className="nvim-popup-fade nvim-popup-fade-bottom" aria-hidden />
      ) : null}
    </div>
  );
}
