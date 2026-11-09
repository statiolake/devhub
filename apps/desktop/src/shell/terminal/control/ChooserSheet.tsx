/**
 * tmux's `choose-tree` and `find-window` in control mode, drawn as DevHub's
 * quick pick (`docs/native-picker.md`, "Quick pick").
 *
 * The look is the quick pick's — its header band, its search field, its
 * rows (`PickerParts`) — and nothing else is: what the filter matches, which
 * rows are open, which is chosen, what a key does and what choosing runs
 * stay tmux's semantics, kept in the pty host (`ptyHost/control/chooser.ts`)
 * and sent here as rows. The keys go there too (the terminal's own routing):
 * this draws, tmux decides. The chosen item's pane is the painter's grid,
 * drawn on the cells the pty host placed it on, `CHOOSER_HEAD_ROWS` under
 * the frame's top and a column right of the tree: the aside is left for it.
 */

import { useLayoutEffect, useRef } from "react";
import {
  CHOOSER_HEAD_ROWS,
  type ChooserRow,
} from "../../../ipc/terminalControl";
import {
  PickerHeader,
  PickerRowText,
  PickerSearchGlyph,
} from "../../components/shell/PickerParts";

export interface ChooserSheetProps {
  readonly box: { readonly x: number; readonly width: number };
  readonly preview: { readonly x: number };
  readonly filter: string;
  readonly rows: readonly ChooserRow[];
  readonly choice: number;
  /** A cell's width and a row's height, in pixels. */
  readonly cell: { readonly width: number; readonly height: number };
}

function Disclosure({ open }: { readonly open: boolean }) {
  return (
    <svg
      className="control-chooser-disclosure"
      viewBox="0 0 10 10"
      aria-hidden="true"
      focusable="false"
    >
      <path d={open ? "M2 3.5 5 6.5 8 3.5" : "M3.5 2 6.5 5 3.5 8"} />
    </svg>
  );
}

export function ChooserSheet({
  box,
  preview,
  filter,
  rows,
  choice,
  cell,
}: ChooserSheetProps) {
  const list = useRef<HTMLUListElement | null>(null);
  useLayoutEffect(() => {
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [choice, rows]);
  const head = CHOOSER_HEAD_ROWS * cell.height;
  return (
    <>
      <div
        className="control-chooser-head"
        style={{ height: `${String(head)}px` }}
      >
        <PickerHeader
          title="Choose a session, window or pane"
          question="Return switches to it · → opens · ← closes · Ctrl-X kills · Escape cancels"
        />
        <div className="picker-search">
          <PickerSearchGlyph />
          <span className="picker-input control-chooser-filter">
            {filter === "" ? (
              <span className="control-chooser-placeholder">
                Type to filter
              </span>
            ) : (
              filter
            )}
            <span className="control-chooser-caret" />
          </span>
        </div>
      </div>
      <div className="picker-body has-aside">
        <div
          className="picker-list"
          style={{
            flex: "none",
            width: `${String((preview.x - box.x) * cell.width)}px`,
          }}
        >
          <ul className="mac-list picker-results" role="listbox" ref={list}>
            {rows.map((row, index) => (
              <li key={`${String(index)}:${row.text}`}>
                <button
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === choice}
                  className="mac-list-row control-chooser-row"
                  data-index={index}
                  data-current={row.current}
                  style={{ paddingLeft: `${String(8 + row.depth * 16)}px` }}
                >
                  <PickerRowText
                    glyph={
                      row.expanded === undefined ? (
                        <span className="control-chooser-leaf" />
                      ) : (
                        <Disclosure open={row.expanded} />
                      )
                    }
                    label={row.text}
                  />
                  {row.current ? (
                    <span className="picker-accessory mac-caption">
                      current
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
        <aside className="picker-aside control-chooser-preview" />
      </div>
    </>
  );
}
