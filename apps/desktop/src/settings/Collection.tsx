/**
 * A collection, shown the way a Mac shows one: the list on the left, the
 * inspector for the selected entry on the right, and `+`/`−` under the list.
 *
 * The stacked form this replaces put every entry's whole form on one scrolling
 * page. With two sources that is merely long; with six it is a page on which
 * nothing can be found, every field is the fifth copy of a field with the same
 * label, and there is no way to say which entry you are looking at. A list and
 * an inspector answer all three at once: the list is the index, the selection
 * is the answer to "which one", and the inspector is one form rather than n.
 *
 * The scaffold owns the list, the selection and the keyboard; the caller owns
 * the words, the rows of the inspector, and what `+` and `−` mean. There is one
 * of these, used by both collections, so the two cannot drift apart.
 */

import { useEffect, useRef, type ReactNode } from "react";
import { MinusGlyph, PlusGlyph } from "./controls";

export interface CollectionEntry {
  /** Stable within one render — the list is keyed and focused by it. */
  readonly key: string;
  readonly title: string;
  /** The one fact that tells two entries apart at a glance. */
  readonly note?: string;
  readonly glyph: ReactNode;
}

export function Collection({
  label,
  entries,
  selected,
  onSelect,
  addLabel,
  onAdd,
  removeLabel,
  onRemove,
  empty,
  children,
}: {
  readonly label: string;
  readonly entries: readonly CollectionEntry[];
  /** The selected position, or nothing when the collection is empty. */
  readonly selected: number | undefined;
  readonly onSelect: (index: number) => void;
  /**
   * Adding and removing, when the membership is the person's to change.
   *
   * Absent for a collection that lists what DevHub *has* rather than what
   * somebody made: the actions an agent can be sent are built in, so there is
   * no plus and no minus, and the buttons are not merely disabled — a disabled
   * control says "not now", and the right answer here is "not ever".
   */
  readonly addLabel?: string;
  readonly onAdd?: () => void;
  readonly removeLabel?: string;
  readonly onRemove?: () => void;
  readonly empty: { readonly title: string; readonly message: string };
  /** The inspector for the selected entry. */
  readonly children: ReactNode;
}) {
  const list = useRef<HTMLDivElement>(null);
  // Roving tabindex: one stop for the whole list, and the arrows move within
  // it. Tab through the window therefore passes the list once, the way it
  // passes a popup button once, rather than once per entry.
  const focusWanted = useRef(false);

  useEffect(() => {
    if (!focusWanted.current) return;
    focusWanted.current = false;
    list.current
      ?.querySelector<HTMLElement>('[role="option"][tabindex="0"]')
      ?.focus();
  });

  const move = (index: number) => {
    focusWanted.current = true;
    onSelect(index);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (entries.length === 0 || selected === undefined) return;
    const last = entries.length - 1;
    const next =
      event.key === "ArrowDown"
        ? Math.min(selected + 1, last)
        : event.key === "ArrowUp"
          ? Math.max(selected - 1, 0)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    move(next);
  };

  return (
    <div className="sf-split">
      <div className="sf-list-pane">
        <div
          className="sf-list"
          role="listbox"
          aria-label={label}
          ref={list}
          onKeyDown={onKeyDown}
        >
          {entries.map((entry, index) => (
            <div
              key={entry.key}
              role="option"
              aria-selected={index === selected}
              tabIndex={index === selected ? 0 : -1}
              className={`sf-list-row${index === selected ? " is-selected" : ""}`}
              onClick={() => {
                onSelect(index);
              }}
            >
              <span className="sf-list-glyph">{entry.glyph}</span>
              <span className="sf-list-text">
                <span className="sf-list-title">{entry.title}</span>
                {entry.note ? (
                  <span className="sf-list-note">{entry.note}</span>
                ) : null}
              </span>
            </div>
          ))}
        </div>
        {/* The two actions sit under the list they act on, joined, the way a
            Mac's list controls do — not scattered at the end of a form. */}
        {onAdd && onRemove ? (
          <div className="sf-list-actions">
            <button
              type="button"
              className="sf-list-action"
              aria-label={addLabel}
              title={addLabel}
              onClick={onAdd}
            >
              <PlusGlyph />
            </button>
            <button
              type="button"
              className="sf-list-action"
              aria-label={removeLabel}
              title={removeLabel}
              disabled={selected === undefined}
              onClick={onRemove}
            >
              <MinusGlyph />
            </button>
          </div>
        ) : null}
      </div>

      <div className={`sf-detail${selected === undefined ? " is-empty" : ""}`}>
        {selected === undefined ? (
          <div className="mac-empty">
            <span className="mac-empty-glyph">
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <rect x="3" y="5" width="18" height="14" rx="2.5" />
                <path d="M3 10h18" />
              </svg>
            </span>
            <p className="mac-empty-title">{empty.title}</p>
            <p className="mac-empty-message">{empty.message}</p>
            {onAdd ? (
              <div className="mac-empty-actions">
                <button
                  type="button"
                  className="mac-button default"
                  onClick={onAdd}
                >
                  {addLabel}
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="sf-detail-column">{children}</div>
        )}
      </div>
    </div>
  );
}
