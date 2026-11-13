/**
 * A framed view (`gui.view{ frame }`): a view drawn natively in a frame over
 * the float it covers — a header band (the plugin's title, the query field, its status),
 * the list's rows, a hint row — round a preview window that stays Neovim's
 * cells. A picker's frontend, whoever's picker it is: DevHub knows windows,
 * rows and components, never a plugin.
 *
 * Neovim keeps the state and the keys. The field is the query window's
 * first line, its caret that window's cursor while it is in Insert mode; the
 * selected row is the list window's cursor line. Where each part goes is
 * where Lua says its window stands (`FramePlace`), so the frame follows the
 * plugin's own layout. A click, the wheel and how many rows fit go back as
 * Lua calls; the plugin decides what they do.
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { ComponentTree, fgOf, type ComponentTheme } from "./ComponentView";
import { isDark, revealScroll, rgbCss, type HlTable } from "./components";
import type { FramePlace, Layers, ViewContent, ViewFrame } from "./layers";

/** A frame's parts, with its view's colours and keys. */
type FrameContent = ViewFrame & {
  readonly id: number;
  readonly hl: HlTable;
  readonly keys: readonly (readonly [string, string])[];
};
import type { LayerHost } from "./LayerViews";
import { PROVISIONAL_TTL_MS } from "./provisional";
import { charOffsetOfByte } from "./redraw";
import { formatKeys } from "../../model/keyNotation";

/** A row's height: a line and a third, so rows read as rows, not cells. */
export function frameRowHeight(cellHeight: number): number {
  return Math.round(cellHeight * 1.35);
}

/** How many rows a list of this height shows at once. */
export function frameRows(listHeight: number, rowHeight: number): number {
  return Math.max(1, Math.floor(listHeight / rowHeight));
}

/**
 * The items a list of `fit` rows draws: all of them once the plugin has its
 * page at that size (it renders `fit` items after `_view_rows`), and until
 * then the page it will send — `fit` items from the top, or ending at the
 * cursor's when that is further down. A picker opens with its window's
 * height in cells as its page, more rows than fit; drawn whole, the first
 * frame showed a half row at the foot that the plugin's next page took away.
 */
export function framePage<T extends { readonly line: number }>(
  items: readonly T[],
  fit: number,
  cursor: number | undefined,
): readonly T[] {
  if (fit < 1 || items.length <= fit) return items;
  const at = items.findIndex((item) => item.line === cursor);
  const start = at >= fit ? at - fit + 1 : 0;
  return items.slice(start, start + fit);
}

/** The wheel's pixels as rows to scroll, at least one per notch. */
export function wheelRows(deltaY: number, rowHeight: number): number {
  if (deltaY === 0) return 0;
  const rows = Math.max(1, Math.round(Math.abs(deltaY) / rowHeight));
  return deltaY < 0 ? -rows : rows;
}

function frameTheme(
  host: LayerHost,
  hl: HlTable,
  onAction: (action: number) => void,
): ComponentTheme {
  const ground = hl.get("NormalFloat") ?? hl.get("Normal");
  const fg = ground?.fg ?? hl.get("Normal")?.fg ?? host.defaults.foreground;
  const bg = ground?.bg ?? hl.get("Normal")?.bg ?? host.defaults.background;
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

/** A group's ground as CSS, or the ink faintly when it has none. */
function groundOf(
  hl: HlTable,
  group: string,
  ink: number,
  alpha: number,
): string {
  const attrs = hl.get(group);
  const rgb = attrs?.reverse === true ? attrs.fg : attrs?.bg;
  return rgb !== undefined ? rgbCss(rgb) : rgbCss(ink, alpha);
}

export function GuiFrames({
  layers,
  host,
}: {
  readonly layers: Layers;
  readonly host: LayerHost;
}) {
  return (
    <>
      {layers.placedFrames.map((place) => {
        const view = layers.views.get(place.id);
        // Laid out, not drawn: the frame and the paint of its windows
        // are one frame (`claimWindows`).
        const box = host.laidOut(place.win);
        if (!view?.frame || !box) return null;
        const content: FrameContent = {
          ...view.frame,
          id: view.id,
          hl: view.hl,
          keys: view.keys,
        };
        return (
          <FrameParts
            key={place.id}
            content={content}
            view={view}
            place={place}
            host={host}
            frameGrid={box.grid}
            frameAt={{ row: box.row, col: box.col }}
          />
        );
      })}
    </>
  );
}

/** A part of the picker, in cells from the frame's top-left. */
export interface FramePart {
  readonly row: number;
  readonly col: number;
  readonly width: number;
  readonly height: number;
}

export interface FrameParts {
  readonly header: FramePart | undefined;
  readonly list: FramePart;
  readonly previewTitle: FramePart | undefined;
  readonly keys: FramePart | undefined;
}

/**
 * Where each part goes, from where the plugin's windows stand: the header
 * is the query window's rows across the frame (or what is above the list),
 * the list is the list window's cells, the hint row is the frame's last row
 * (the list stops above it), and the preview's title is the row above the
 * preview window when one is free there.
 */
export function frameParts(
  place: FramePlace,
  withKeys: boolean,
  withPreviewTitle: boolean,
): FrameParts {
  const { frame, list, query, preview } = place;
  const rel = (r: { row: number; col: number }) => ({
    row: r.row - frame.row,
    col: r.col - frame.col,
  });
  const headerRows = query
    ? Math.max(0, query.row - frame.row + query.height)
    : Math.max(0, list.row - frame.row);
  const keys =
    withKeys && frame.height > headerRows + 1
      ? { row: frame.height - 1, col: 0, width: frame.width, height: 1 }
      : undefined;
  const at = rel(list);
  const listTop = Math.max(at.row, headerRows);
  const listBottom = Math.min(
    at.row + list.height,
    keys ? keys.row : frame.height,
  );
  let previewTitle: FramePart | undefined;
  if (withPreviewTitle && preview) {
    const p = rel(preview);
    if (p.row - 1 >= headerRows)
      previewTitle = {
        row: p.row - 1,
        col: p.col,
        width: preview.width,
        height: 1,
      };
  }
  return {
    header:
      headerRows > 0
        ? { row: 0, col: 0, width: frame.width, height: headerRows }
        : undefined,
    list: {
      row: listTop,
      col: at.col,
      width: list.width,
      height: Math.max(0, listBottom - listTop),
    },
    previewTitle,
    keys,
  };
}

function FrameParts({
  content,
  view,
  place,
  host,
  frameGrid,
  frameAt,
}: {
  readonly content: FrameContent;
  readonly view: ViewContent;
  readonly place: FramePlace;
  readonly host: LayerHost;
  readonly frameGrid: number;
  readonly frameAt: { readonly row: number; readonly col: number };
}) {
  const { cell } = host;
  const theme = frameTheme(host, content.hl, (action) => {
    host.lua("_frame_action", [content.id, action]);
    host.refocus();
  });
  const vars = {
    ["--nvim-grid-font" as string]: host.mono,
    ["--frame-row" as string]: `${String(frameRowHeight(cell.height))}px`,
    ["--frame-muted" as string]:
      fgOf(content.hl, "Comment") ?? rgbCss(theme.fg, 0.55),
    ["--frame-ink" as string]: rgbCss(theme.fg),
    ["--frame-ground" as string]: rgbCss(theme.bg),
    // The selected row: the theme's selection (Visual) while the picker has
    // the keys, its cursor line's ground otherwise.
    ["--frame-selected" as string]: groundOf(
      content.hl,
      "Visual",
      theme.fg,
      0.16,
    ),
    ["--frame-selected-idle" as string]: groundOf(
      content.hl,
      "CursorLine",
      theme.fg,
      0.08,
    ),
  } as CSSProperties;
  const { frame } = place;
  const parts = frameParts(
    place,
    content.keys.length > 0,
    content.previewTitle !== undefined,
  );
  const px = (r: FramePart): CSSProperties => ({
    top: r.row * cell.height,
    left: r.col * cell.width,
    width: r.width * cell.width,
    height: r.height * cell.height,
  });
  const panel = (
    <div
      className="nvim-view-frame"
      style={{
        ...vars,
        left: frameAt.col * cell.width,
        top: frameAt.row * cell.height,
        width: frame.width * cell.width,
        height: frame.height * cell.height,
      }}
      onMouseDown={(event) => {
        event.preventDefault();
        host.refocus();
      }}
    >
      {parts.header ? (
        <div className="nvim-view-frame-header" style={px(parts.header)}>
          {content.title ? (
            <div className="nvim-view-frame-title">
              <ComponentTree node={content.title} theme={theme} />
            </div>
          ) : null}
          <QueryField content={content} place={place} host={host} />
          {content.status ? (
            <div className="nvim-view-frame-status">
              <ComponentTree node={content.status} theme={theme} />
            </div>
          ) : null}
        </div>
      ) : null}
      <FrameList
        view={view}
        place={place}
        host={host}
        theme={frameTheme(host, view.hl, () => undefined)}
        style={px(parts.list)}
      />
      {parts.previewTitle && content.previewTitle ? (
        <div
          className="nvim-view-frame-preview-title"
          style={px(parts.previewTitle)}
        >
          <ComponentTree node={content.previewTitle} theme={theme} />
        </div>
      ) : null}
      {place.preview ? (
        <div
          className="nvim-view-frame-rule"
          style={{
            top: parts.list.row * cell.height,
            left: (parts.list.col + parts.list.width) * cell.width - 1,
            height: parts.list.height * cell.height,
          }}
        />
      ) : null}
      {parts.keys ? (
        <div className="nvim-view-frame-keys" style={px(parts.keys)}>
          {content.keys.map(([key, label], index) => (
            <span key={index} className="nvim-view-frame-key">
              <kbd className="nvc-kbd">{formatKeys(key)}</kbd>
              <span>{label}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
  // The frame's windows are bare (`claimFloats`): its line and shadow are
  // the page's, under the grids round the frame float, so the preview's
  // cells over the frame never hide them. The line is round at the
  // corners, bending in over the frame float's cells there: the panel is
  // as round, and the painter cuts the windows' cells at the same shape
  // (`claimedShape`), so nothing square covers it.
  const edge = (
    <div
      className="nvim-view-frame-edge"
      style={{
        left: frameAt.col * cell.width,
        top: frameAt.row * cell.height,
        width: frame.width * cell.width,
        height: frame.height * cell.height,
      }}
    />
  );
  return (
    <>
      {createPortal(
        edge,
        host.over(frameGrid, "shadow"),
        `frame-edge:${String(place.id)}`,
      )}
      {createPortal(
        panel,
        host.over(frameGrid, "covers"),
        `frame:${String(place.id)}`,
      )}
    </>
  );
}

/** A run of the query's text: the caret's character, a selection's, or plain. */
export interface FieldRun {
  readonly text: string;
  /** The caret is on it (a block, an underline) or before it (a bar). */
  readonly caret: boolean;
  readonly selected: boolean;
}

/**
 * The query's text as runs: the character under the cursor (`caret`, a
 * byte column) on its own, a blank one past the end, and Visual mode's
 * bytes (`visual`, first and last) selected, the last character whole.
 */
export function fieldRuns(
  text: string,
  caret: number | undefined,
  visual?: readonly [number, number],
): FieldRun[] {
  const at = caret === undefined ? undefined : charOffsetOfByte(text, caret);
  const from = visual ? charOffsetOfByte(text, visual[0]) : undefined;
  const lastStart = visual ? charOffsetOfByte(text, visual[1]) : undefined;
  const width = (i: number) => ((text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1);
  const to = lastStart === undefined ? undefined : lastStart + width(lastStart);
  const runs: FieldRun[] = [];
  const push = (piece: string, isCaret: boolean, selected: boolean) => {
    if (piece === "") return;
    const prev = runs[runs.length - 1];
    if (prev && !prev.caret && !isCaret && prev.selected === selected)
      runs[runs.length - 1] = { ...prev, text: prev.text + piece };
    else runs.push({ text: piece, caret: isCaret, selected });
  };
  for (let i = 0; i < text.length; ) {
    const w = width(i);
    const selected =
      from !== undefined && to !== undefined && i >= from && i < to;
    push(text.slice(i, i + w), i === at, selected);
    i += w;
  }
  if (at !== undefined && at >= text.length)
    runs.push({ text: " ", caret: true, selected: false });
  return runs;
}

function QueryField({
  content,
  place,
  host,
}: {
  readonly content: FrameContent;
  readonly place: FramePlace;
  readonly host: LayerHost;
}) {
  const query = place.query;
  const text = query?.text ?? "";
  // The query has the keys: the cursor drawn as Neovim's would be in this
  // mode (`guicursor`): a bar in Insert mode, a block in Normal mode, the
  // Visual selection.
  const current = query?.current === true;
  const look = current ? host.caret : undefined;
  const shape = look?.shape ?? (query?.insert === true ? "vertical" : "block");
  const runs = fieldRuns(
    text,
    current ? query?.caret : undefined,
    query?.visual,
  );
  const caretRef = useRef<HTMLSpanElement>(null);
  const on = look?.blinkon ?? 0;
  const off = look?.blinkoff ?? 0;
  const wait = look?.blinkwait ?? 0;
  const moved = `${String(query?.caret)},${shape},${String(current)}`;
  // `guicursor`'s blink, restarted on every move, as the grid's cursor.
  useLayoutEffect(() => {
    const caret = caretRef.current;
    if (!caret || on <= 0 || off <= 0 || typeof caret.animate !== "function")
      return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const split = on / (on + off);
    const blink = caret.animate(
      [
        { opacity: 1, offset: 0 },
        { opacity: 1, offset: split },
        { opacity: 0, offset: split },
        { opacity: 0, offset: 1 },
      ],
      { duration: on + off, delay: wait, iterations: Infinity },
    );
    return () => {
      blink.cancel();
    };
  }, [moved, on, off, wait]);
  const pct = Math.min(100, Math.max(1, look?.percentage ?? 25)) / 100;
  const caretStyle: CSSProperties = {
    ...(look?.colors
      ? shape === "block"
        ? { background: rgbCss(look.colors.bg), color: rgbCss(look.colors.fg) }
        : { ["--frame-caret" as string]: rgbCss(look.colors.bg) }
      : {}),
    ...(shape === "vertical"
      ? {
          width: `max(1.5px, calc(1ch * ${String(pct)}))`,
        }
      : shape === "horizontal"
        ? {
            ["--frame-caret-height" as string]: `max(1.5px, calc(1.15em * ${String(pct)}))`,
          }
        : {}),
  };
  const placeholder =
    text === "" && content.placeholder ? (
      <span className="nvim-view-frame-placeholder">{content.placeholder}</span>
    ) : null;
  return (
    <div
      className={`nvim-view-frame-field${current ? " nvim-view-frame-field-active" : ""}`}
    >
      {!current ? (
        (placeholder ?? <span className="nvim-view-frame-text">{text}</span>)
      ) : (
        <span className="nvim-view-frame-text">
          {runs.map((run, index) => {
            const selected = run.selected ? " nvim-view-frame-selection" : "";
            if (!run.caret)
              return (
                <span key={index} className={selected.trim() || undefined}>
                  {run.text}
                </span>
              );
            if (shape === "vertical") {
              // A bar on the edge before the character, taking no room:
              // half of it on each side; past the end, its own room (the
              // field cuts what is past its text).
              const end = run.text === " " && index === runs.length - 1;
              const half = `calc(-0.5 * max(1.5px, calc(1ch * ${String(pct)})))`;
              return (
                <span key={index} className={selected.trim() || undefined}>
                  <span
                    ref={caretRef}
                    className="nvim-view-frame-caret"
                    style={{
                      ...caretStyle,
                      marginLeft: end ? 0 : half,
                      marginRight: end ? 0 : half,
                    }}
                  />
                  {end ? null : run.text}
                </span>
              );
            }
            return (
              <span
                key={index}
                ref={caretRef}
                // The cursor over the selection, as in Neovim: its own look.
                className={`nvim-view-frame-caret-${shape}${shape === "block" ? "" : selected}`}
                style={caretStyle}
              >
                {run.text}
              </span>
            );
          })}
          {text === "" ? placeholder : null}
        </span>
      )}
    </div>
  );
}

function FrameList({
  view,
  place,
  host,
  theme,
  style,
}: {
  readonly view: ViewContent;
  readonly place: FramePlace;
  readonly host: LayerHost;
  readonly theme: ComponentTheme;
  readonly style: CSSProperties;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const reported = useRef(0);
  // How many rows fit, as measured: what is drawn (`framePage`) from the
  // first frame, before the plugin's page has that size. Set in a layout
  // effect, so the render it causes is in the same frame.
  const [fit, setFit] = useState(0);
  const rowHeight = frameRowHeight(host.cell.height);
  // A row pressed is selected at once, before Neovim's cursor gets there
  // (`provisional.ts`), as long as Neovim's is still where it was.
  const [pressed, setPressed] = useState<
    { readonly line: number; readonly base: number } | undefined
  >(undefined);
  const actual = place.list.cursor;
  useEffect(() => {
    if (pressed === undefined) return;
    if (pressed.base !== actual) {
      setPressed(undefined);
      return;
    }
    const timer = setTimeout(() => {
      setPressed(undefined);
    }, PROVISIONAL_TTL_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [pressed, actual]);
  const cursor =
    pressed !== undefined && pressed.base === actual ? pressed.line : actual;
  // The row under the pointer. A frame lies under the levels of the floats
  // above it, which take the pointer (`forwardedToFrame` hands its events
  // on), so CSS's :hover never reaches a row: the moves handed on say
  // which, and the first real move outside the list ends it.
  const [hovered, setHovered] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (hovered === undefined) return;
    const off = (event: MouseEvent) => {
      const el = scroller.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (
        event.clientX < r.left ||
        event.clientX >= r.right ||
        event.clientY < r.top ||
        event.clientY >= r.bottom
      )
        setHovered(undefined);
    };
    window.addEventListener("mousemove", off);
    return () => {
      window.removeEventListener("mousemove", off);
    };
  }, [hovered]);

  // How many rows fit, told once per change; and the selected row in sight.
  // After every render, as the list's size and its rows may have changed;
  // `setFit` only when the measure changed, so it settles at once.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const pad = getComputedStyle(el);
    const inner =
      el.clientHeight -
      (parseFloat(pad.paddingTop) || 0) -
      (parseFloat(pad.paddingBottom) || 0);
    const rows = frameRows(inner, rowHeight);
    if (rows !== fit) setFit(rows);
    if (rows !== reported.current) {
      reported.current = rows;
      host.lua("_view_rows", [view.id, rows]);
    }
    const row = el.querySelector<HTMLElement>(".nvim-view-frame-selected");
    if (row) {
      el.scrollTop = revealScroll(
        el.scrollTop,
        el.clientHeight,
        row.offsetTop,
        row.offsetHeight,
      );
    } else {
      el.scrollTop = 0;
    }
  });

  const active = place.list.current || place.query?.current === true;
  return (
    <div
      className={`nvim-view-frame-list${active ? " nvim-view-frame-active" : ""}`}
      style={style}
      ref={scroller}
      onWheel={(event) => {
        event.stopPropagation();
        const delta =
          event.deltaMode === 1 ? event.deltaY * rowHeight : event.deltaY;
        const rows = wheelRows(delta, rowHeight);
        if (rows !== 0) host.lua("_view_scroll", [view.id, rows]);
      }}
    >
      {framePage(view.items, fit, cursor).map((item) =>
        // A blank line the view draws nothing for is no row (a page the
        // plugin did not fill).
        item.node === undefined && item.text === "" ? null : (
          <div key={item.line} className="nvim-view-frame-item">
            {item.heading ? (
              <div className="nvim-view-frame-heading">
                <ComponentTree node={item.heading} theme={theme} />
              </div>
            ) : null}
            <div
              className={`nvim-view-frame-row${item.line === cursor ? " nvim-view-frame-selected" : ""}${item.line === hovered ? " nvim-view-frame-hover" : ""}`}
              onMouseMove={() => {
                if (hovered !== item.line) setHovered(item.line);
              }}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setPressed(
                  item.line === actual
                    ? undefined
                    : { line: item.line, base: actual },
                );
                host.lua("_frame_click", [
                  place.id,
                  item.line,
                  event.detail >= 2 ? 2 : 1,
                ]);
                host.refocus();
              }}
            >
              {item.node ? (
                <ComponentTree node={item.node} theme={theme} />
              ) : (
                <span className="nvim-view-frame-plain">{item.text}</span>
              )}
            </div>
          </div>
        ),
      )}
    </div>
  );
}
