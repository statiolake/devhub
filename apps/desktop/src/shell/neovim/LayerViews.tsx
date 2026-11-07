/**
 * The page's side of `layers.ts`: views painted over their windows, cards in
 * the rows their extmarks reserve, and line decorations.
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
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ComponentTree, fgOf, type ComponentTheme } from "./ComponentView";
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
  DecoContent,
  InlineContent,
  Layers,
  ViewContent,
  ViewPlace,
} from "./layers";
import type { GridBox } from "./redraw";

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
        return (
          <GuiView
            key={`${String(place.id)}:${String(place.win)}`}
            content={content}
            place={place}
            box={box}
            host={host}
          />
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
    zIndex: box.z + 2,
    background: rgbCss(theme.bg),
    color: rgbCss(theme.fg),
    ["--nvim-ring" as string]: ring,
    ["--nvim-ground" as string]: rgbCss(theme.bg),
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
                <span
                  className="nvim-view-plain"
                  style={{ fontFamily: host.mono }}
                >
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
                  <kbd className="nvc-kbd" style={{ fontFamily: host.mono }}>
                    {part}
                  </kbd>
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
  const reported = useRef(new Map<number, number>());
  const report = (id: number, full: number, rows: number) => {
    if (rows === full) {
      reported.current.set(id, rows);
      return;
    }
    if (reported.current.get(id) === rows) return;
    reported.current.set(id, rows);
    host.lua("_inline_rows", [id, rows]);
  };
  const { cell } = host;
  const measured = new Set<number>();
  const cards: ReactNode[] = layers.placedInlines.map((place) => {
    const content = layers.inlines.get(place.id);
    const box = host.boxes.find((b) => b.win === place.win);
    if (!content || !box) return null;
    // One window measures; another of a different width only paints.
    const measures = !measured.has(place.id);
    measured.add(place.id);
    return (
      <div
        key={`${String(place.id)}:${String(place.win)}`}
        className="nvim-inline-slot"
        style={{
          left: (box.col + place.col) * cell.width,
          top: (box.row + place.row) * cell.height,
          width: place.width * cell.width,
          height: place.rows * cell.height,
          zIndex: box.z + 1,
        }}
      >
        <InlineCard
          content={content}
          host={host}
          active={place.active}
          offset={-place.clip * cell.height}
          onHeight={
            measures
              ? (px) => {
                  report(place.id, place.full, rowsFor(px, cell.height));
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
      </div>
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
          offset={0}
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
  offset,
  onHeight,
  onClick,
  onAction,
}: {
  readonly content: InlineContent;
  readonly host: LayerHost;
  readonly active: boolean;
  readonly offset: number;
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
  }, [content]);
  const theme = themeFor(host, content.hl, onAction);
  return (
    <div
      ref={ref}
      className={`nvim-inline-card${active ? " nvim-inline-active" : ""}`}
      style={{
        top: offset,
        color: rgbCss(theme.fg),
        ["--nvim-ring" as string]: ringColor(content.hl, theme.fg),
        ["--nvim-ground" as string]: rgbCss(theme.bg),
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

/** Line decorations: a dimmed, a highlighted range, or a tag beside it. */
export function LineDecorations({
  layers,
  host,
}: {
  readonly layers: Layers;
  readonly host: LayerHost;
}) {
  const { cell } = host;
  return (
    <>
      {layers.placedDecos.map((place, index) => {
        const content = layers.decos.get(place.id);
        const box = host.boxes.find((b) => b.win === place.win);
        if (!content || !box) return null;
        return (
          <Decoration
            key={`${String(place.id)}:${String(place.win)}:${String(index)}`}
            content={content}
            host={host}
            style={{
              left: (box.col + place.col) * cell.width,
              top: (box.row + place.row) * cell.height,
              width: place.width * cell.width,
              height: place.rows * cell.height,
              zIndex: box.z + 1,
            }}
          />
        );
      })}
    </>
  );
}

function Decoration({
  content,
  host,
  style,
}: {
  readonly content: DecoContent;
  readonly host: LayerHost;
  readonly style: CSSProperties;
}) {
  const normal = content.hl.get("Normal");
  const bg = normal?.bg ?? host.defaults.background;
  const color =
    fgOf(content.hl, content.group) ??
    fgOf(content.hl, "DiagnosticWarn") ??
    rgbCss(host.defaults.foreground);
  const tag =
    content.tag !== undefined ? (
      <span
        className="nvim-deco-tag"
        style={{
          color: rgbCss(bg),
          background: color,
          lineHeight: `${String(host.cell.height - 6)}px`,
        }}
      >
        {content.tag}
      </span>
    ) : null;
  if (content.style === "dim") {
    return (
      <div
        className="nvim-deco nvim-deco-dim"
        style={{ ...style, background: rgbCss(bg, 0.55) }}
      >
        {tag}
      </div>
    );
  }
  if (content.style === "tag") {
    return (
      <div className="nvim-deco" style={style}>
        {tag}
      </div>
    );
  }
  return (
    <div
      className="nvim-deco nvim-deco-highlight"
      style={{
        ...style,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
        borderLeftColor: color,
      }}
    >
      {tag}
    </div>
  );
}
