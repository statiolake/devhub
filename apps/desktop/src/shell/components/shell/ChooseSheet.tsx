/**
 * Pick one thing from a short list.
 *
 * A sheet with a title, a source list, and Cancel — the shape macOS uses when
 * an action needs one more decision before it can start. Arrows move, Return
 * chooses, Escape cancels, and focus is trapped and restored, so it answers the
 * same keys as the workspace picker and the alerts do.
 *
 * The list is short by construction: a long one wants a search field, and that
 * is a different control (`WorkspacePicker`).
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { isImeComposing } from "../../accessibility/ime";
import { useModalPresence } from "./modalPresence";

export interface ChooseSheetOption {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
}

export interface ChooseSheetProps {
  readonly title: string;
  readonly message?: string;
  readonly options: readonly ChooseSheetOption[];
  /** What to say instead of a list when there is nothing to choose from. */
  readonly empty: string;
  /** A caveat about the list itself, shown under it. */
  readonly note?: ReactNode;
  readonly onChoose: (id: string) => void;
  readonly onCancel: () => void;
}

export function ChooseSheet({
  title,
  message,
  options,
  empty,
  note,
  onChoose,
  onCancel,
}: ChooseSheetProps) {
  const [active, setActive] = useState(0);
  const sheet = useRef<HTMLElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);
  useModalPresence();

  useEffect(() => {
    restoreTo.current = document.activeElement as HTMLElement | null;
    sheet.current?.querySelector<HTMLElement>("button")?.focus();
    return () => {
      const target = restoreTo.current;
      if (target?.isConnected) target.focus();
    };
  }, []);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (isImeComposing(event.nativeEvent)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (options.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActive(
        (current) => (current + delta + options.length) % options.length,
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const option = options[active];
      if (option) onChoose(option.id);
    }
  };

  return createPortal(
    <div
      className="mac-scrim mac"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <section
        className="mac-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={sheet}
        onKeyDown={onKeyDown}
      >
        <header className="mac-sheet-header">
          <h2 className="mac-title">{title}</h2>
          {message ? <p className="mac-message">{message}</p> : null}
        </header>

        {options.length > 0 ? (
          <ul className="mac-list" role="listbox" aria-label={title}>
            {options.map((option, index) => (
              <li key={option.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  className="mac-list-row"
                  onMouseEnter={() => {
                    setActive(index);
                  }}
                  onClick={() => {
                    onChoose(option.id);
                  }}
                >
                  <span className="mac-list-text">
                    <span className="mac-list-title">{option.label}</span>
                    {option.detail ? (
                      <span className="mac-list-subtitle mac-caption">
                        {option.detail}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mac-sheet-empty mac-caption" role="status">
            {empty}
          </p>
        )}

        {note ? (
          <p className="mac-sheet-note mac-caption" role="status">
            {note}
          </p>
        ) : null}

        <footer className="mac-sheet-footer">
          <button type="button" className="mac-button" onClick={onCancel}>
            Cancel
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
