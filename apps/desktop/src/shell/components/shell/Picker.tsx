/**
 * Open Quickly, for anything.
 *
 * One control answers every "which one?" DevHub asks: a search field, a ranked
 * list, and a footer. Typing filters, the arrows move, Return chooses, Escape
 * cancels — and Command-Return chooses the same row the other way, which is the
 * only thing a caller may vary. There used to be two of these, a searchable one
 * for workspaces and a plain list for agent profiles, and the second was a
 * different control answering the same question with different keys. A person
 * should not have to know which list they are looking at to know what Return
 * does.
 *
 * **Filtering is local, always.** The caller hands over everything it knows
 * about; this ranks it with the shared scorer (`model/fuzzy.ts`) and draws what
 * matches. A caller whose candidates come from somewhere slow — the workspace
 * sources — also gets `onQueryChange`, so it can go and ask for more; what
 * comes back is simply added to the items it passes. Nothing here waits for
 * that. That is what makes the list survive typing: the rows already on screen
 * are re-ranked in the same frame as the keystroke, and a search still running
 * can only add to them, never blank them.
 *
 * Focus lives in the field for as long as the sheet stands. Rows do not take
 * it — they refuse it on mousedown — and anything that manages to steal it is
 * taken back, because a picker that has stopped answering the keyboard and
 * cannot be clicked back into is a dead end with no way out but the mouse.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { score } from "../../../model/fuzzy";
import { isImeComposing } from "../../accessibility/ime";

/** One row: what is drawn, and what the query is matched against. */
export interface PickerItem {
  readonly id: string;
  readonly label: string;
  /** The second line, when a row has more to say than its name. */
  readonly detail?: ReactNode;
  /** What the query matches. The label, when a row is only its name. */
  readonly searchText?: string;
  readonly glyph?: ReactNode;
}

/**
 * A row, and how the person asked for it.
 *
 * `split` is the Command modifier — Command-Return, or Command-click — and it
 * is reported for every picker whether or not the caller has anything to do
 * with it. One key means one thing everywhere; a picker that quietly dropped
 * the modifier would teach that it sometimes does nothing.
 */
export interface PickerChoice {
  readonly id: string;
  readonly split: boolean;
  /**
   * What was in the field when the row was taken.
   *
   * Reported for every choice, like `split`, and for the same reason: a row
   * that means "make the thing I just typed" — "New Branch…", "Use this URL" —
   * needs the typing, and a caller that had to reach for it separately would be
   * reading a second copy of the field's state.
   */
  readonly query: string;
}

export interface PickerProps {
  /** Names the dialog for assistive technology; not drawn. */
  readonly title: string;
  readonly placeholder: string;
  /**
   * What the field starts with, for a question whose answer is mostly known —
   * a branch name that is going to begin `feature/128-` whatever else it says.
   * The caret starts after it, so the person types the rest and nothing else.
   */
  readonly initialQuery?: string;
  readonly items: readonly PickerItem[];
  /**
   * Rows that are not candidates: they *do* something rather than name
   * something that already exists — "New Project…", "Clone Project…".
   *
   * Two things follow from that, and they are the whole of why the picker
   * knows about them at all. They are never filtered out, because a person who
   * has typed the name of a project that does not exist yet is exactly the
   * person who wants to make it. And they move: first while nothing is typed,
   * because that is the menu of what one can do here; last once something is,
   * because then the list is an answer to a question and these are not part of
   * the answer. In every other respect they are rows — the arrows reach them,
   * Return takes them, the caller tells them apart by their id.
   */
  readonly pinned?: readonly PickerItem[];
  /** A source is still answering. Shown as a spinner, never as an empty list. */
  readonly busy?: boolean;
  /** Nothing matches what was typed. */
  readonly emptyNoMatch: string;
  /** Nothing to pick from at all, before anything was typed. */
  readonly emptyNoItems: string;
  /** A caveat about the list itself, under it. */
  readonly note?: ReactNode;
  /** A slow source's cue to go and look for more. Optional. */
  readonly onQueryChange?: (query: string) => void;
  /** How long to sit on a keystroke before `onQueryChange`. */
  readonly queryDelayMs?: number;
  readonly onChoose: (choice: PickerChoice) => void;
  readonly onCancel: () => void;
  /** The escape hatch beside Cancel — "Other…", and nothing else so far. */
  readonly extraAction?: { readonly label: string; readonly run: () => void };
}

function SearchGlyph() {
  return (
    <svg
      className="picker-search-glyph"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2 13.4 13.4" />
    </svg>
  );
}

const NO_PINNED: readonly PickerItem[] = [];

export function Picker({
  title,
  placeholder,
  initialQuery = "",
  items,
  pinned = NO_PINNED,
  busy = false,
  emptyNoMatch,
  emptyNoItems,
  note,
  onQueryChange,
  queryDelayMs = 150,
  onChoose,
  onCancel,
  extraAction,
}: PickerProps) {
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const composing = useRef(false);
  const input = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  const ranked = useMemo(() => {
    const scored = items.flatMap((item) => {
      const value = score(item.searchText ?? item.label, query);
      return value === 0 ? [] : [{ item, value }];
    });
    // A stable order under a query that ranks everything the same: the caller's
    // order is the one the person already saw, and re-sorting equal rows on
    // every keystroke moves the selection out from under them.
    return scored
      .map((entry, index) => ({ ...entry, index }))
      .sort((left, right) =>
        right.value === left.value
          ? left.index - right.index
          : right.value - left.value,
      )
      .map((entry) => entry.item);
  }, [items, query]);

  /**
   * Every row there is, in the order it is drawn.
   *
   * The pinned rows lead while nothing is typed and trail once something is;
   * from here down nothing distinguishes them, so the arrows, Return, the
   * click and the scroll-into-view are one implementation and cannot disagree
   * about what "the row you are on" means.
   */
  const rows = useMemo(
    () =>
      query.length === 0 ? [...pinned, ...ranked] : [...ranked, ...pinned],
    [pinned, query.length, ranked],
  );

  const focusField = useCallback(() => {
    const field = input.current;
    if (field && document.activeElement !== field) field.focus();
  }, []);

  useEffect(() => {
    restoreTo.current = document.activeElement as HTMLElement | null;
    focusField();
    // A starting value is a prefix to be typed on, not a selection to be
    // replaced: the caret goes after it.
    const field = input.current;
    if (field && initialQuery.length > 0) {
      field.setSelectionRange(initialQuery.length, initialQuery.length);
    }
    return () => {
      const target = restoreTo.current;
      if (target?.isConnected) target.focus();
    };
  }, [focusField, initialQuery]);

  // There is deliberately no "take the keyboard back whenever this window is
  // focused" rule here. It was written, and it made the app unusable: every
  // other window — DevTools, Settings — got into a tug of war with the sheet
  // the moment it opened, because the sheet cannot tell "focus came back to
  // me" from "focus went somewhere the person chose". Recovery is driven by
  // what happens *inside* the sheet instead: it is opened, it is clicked in,
  // it is typed into. Those are the three ways focus can be lost to something
  // this control owns, and they are the three it takes it back from.

  // The source, if there is one, is told what was typed — after a pause, so a
  // burst of keystrokes is one search. The first call is not delayed: the
  // sheet comes up empty and the only thing that fills it is this.
  const first = useRef(true);
  useEffect(() => {
    if (!onQueryChange) return;
    if (first.current) {
      first.current = false;
      onQueryChange(query);
      return;
    }
    const timer = window.setTimeout(() => {
      onQueryChange(query);
    }, queryDelayMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [onQueryChange, query, queryDelayMs]);

  // The top row is the one Return takes, so a list that changed under the
  // person must not leave the selection pointing into the middle of it.
  const activeId = rows[active]?.id;
  useEffect(() => {
    setActive((current) => (current < rows.length ? current : 0));
  }, [rows.length]);

  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const choose = useCallback(
    (id: string, split: boolean) => {
      onChoose({ id, split, query });
    },
    [onChoose, query],
  );

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (isImeComposing(event.nativeEvent, composing.current)) {
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (rows.length === 0) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (current + delta + rows.length) % rows.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const candidate = rows[active];
      if (candidate) choose(candidate.id, event.metaKey);
      return;
    }
    // Anything else is typing, and typing belongs in the field.
    focusField();
  };

  const emptyMessage =
    items.length === 0 && busy
      ? "Searching…"
      : query.length > 0
        ? emptyNoMatch
        : emptyNoItems;

  return createPortal(
    <div
      className="mac-scrim mac"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <section
        className="mac-sheet picker"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={onKeyDown}
        // A click inside the sheet acts, it does not move the keyboard. The
        // field keeps it whatever was pressed, which is what makes the sheet
        // still answer Return after a row was clicked and missed.
        onMouseDown={focusField}
      >
        <div className="picker-search">
          <SearchGlyph />
          <input
            ref={input}
            className="picker-input"
            type="text"
            aria-label={title}
            placeholder={placeholder}
            value={query}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
          />
          {busy ? (
            <span
              className="mac-spinner"
              aria-label="Searching"
              role="status"
            />
          ) : null}
        </div>

        {/* One band whatever it holds. The message and the rows can both be
            here at once — nothing you typed exists yet, but "New Project…"
            still does — so the sheet's seams do not move with its state. */}
        <div className="picker-body">
          {ranked.length === 0 ? (
            <p className="picker-empty mac-caption" role="status">
              {emptyMessage}
            </p>
          ) : null}
          <ul
            className="mac-list picker-results"
            role="listbox"
            aria-label={title}
            ref={listRef}
            hidden={rows.length === 0}
          >
            {rows.map((item, index) => (
              <li key={item.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  className="mac-list-row"
                  tabIndex={-1}
                  onMouseDown={(event) => {
                    // The row is a target, not a place to stand: taking focus
                    // here is what used to leave the sheet deaf to the keyboard.
                    event.preventDefault();
                  }}
                  onMouseEnter={() => {
                    setActive(index);
                  }}
                  onClick={(event) => {
                    choose(item.id, event.metaKey);
                  }}
                >
                  {item.glyph ? (
                    <span className="mac-list-glyph">{item.glyph}</span>
                  ) : null}
                  <span className="mac-list-text">
                    <span className="mac-list-title">{item.label}</span>
                    {item.detail ? (
                      <span className="mac-list-subtitle mac-caption">
                        {item.detail}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* The note is part of the footer, not a band of its own. It is the
            sheet saying something about itself — what the modifier does, why
            the list is short — and giving it its own band would put a rule
            between a caption and the thing it captions, and would make the
            sheet's seams depend on whether a caller passed one. */}
        <footer className="picker-footer">
          {note ? (
            <p className="picker-note mac-caption" role="status">
              {note}
            </p>
          ) : null}
          <div className="picker-actions">
            {extraAction ? (
              <button
                type="button"
                className="mac-button plain"
                tabIndex={-1}
                onClick={extraAction.run}
              >
                {extraAction.label}
              </button>
            ) : (
              <span />
            )}
            <button
              type="button"
              className="mac-button"
              tabIndex={-1}
              onClick={onCancel}
            >
              Cancel
            </button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
