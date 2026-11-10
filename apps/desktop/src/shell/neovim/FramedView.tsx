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

import { useLayoutEffect, useRef, type CSSProperties } from "react";
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
        const box = host.boxes.find((b) => b.win === place.win);
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
          <QueryField content={content} place={place} />
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
  // cells over the frame never hide them.
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

function QueryField({
  content,
  place,
}: {
  readonly content: FrameContent;
  readonly place: FramePlace;
}) {
  const query = place.query;
  const text = query?.text ?? "";
  const at = query ? charOffsetOfByte(text, query.caret) : 0;
  const caret = query?.insert === true;
  return (
    <div
      className={`nvim-view-frame-field${caret ? " nvim-view-frame-field-active" : ""}`}
    >
      {text === "" && !caret && content.placeholder ? (
        <span className="nvim-view-frame-placeholder">
          {content.placeholder}
        </span>
      ) : (
        <span className="nvim-view-frame-text">
          {text.slice(0, at)}
          {caret ? <span className="nvim-view-frame-caret" /> : null}
          {text.slice(at)}
          {text === "" && caret && content.placeholder ? (
            <span className="nvim-view-frame-placeholder">
              {content.placeholder}
            </span>
          ) : null}
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
  const rowHeight = frameRowHeight(host.cell.height);
  const cursor = place.list.cursor;

  // How many rows fit, told once per change; and the selected row in sight.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const pad = getComputedStyle(el);
    const inner =
      el.clientHeight -
      (parseFloat(pad.paddingTop) || 0) -
      (parseFloat(pad.paddingBottom) || 0);
    const rows = frameRows(inner, rowHeight);
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
      {view.items.map((item) =>
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
              className={`nvim-view-frame-row${item.line === cursor ? " nvim-view-frame-selected" : ""}`}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
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
