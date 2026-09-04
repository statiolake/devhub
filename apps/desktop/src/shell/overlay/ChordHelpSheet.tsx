/**
 * Every chord there is, on one sheet.
 *
 * `Cmd+Q ?`. **Nothing here is written down.** The rows arrive from main, built
 * from the command registry (`model/commands.ts`) and from the table actually
 * in effect — so a person who rebound a key reads their own keyboard rather
 * than DevHub's shipped one, and a command added later appears without anybody
 * remembering to add it. A hand-written help sheet is a second table to keep in
 * step with the first, and it is always the one that is out of date.
 *
 * Not a picker, and that is the exception rather than a lapse: a picker is for
 * choosing, and there is nothing here to choose. It is a reference you read and
 * close.
 */

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { ChordHelpRowWire } from "../../ipc/contract";

export interface ChordHelpSheetProps {
  readonly rows: readonly ChordHelpRowWire[];
  readonly onDismiss: () => void;
}

export function ChordHelpSheet({ rows, onDismiss }: ChordHelpSheetProps) {
  const sheet = useRef<HTMLDivElement>(null);

  // The sheet takes the keyboard so that Escape reaches it. Nothing else on
  // this layer is focusable while it stands, so there is nowhere for a key to
  // go that is not here.
  useEffect(() => {
    sheet.current?.focus();
  }, []);

  return createPortal(
    <div className="mac-scrim mac" role="presentation">
      <div
        ref={sheet}
        className="mac-sheet chord-help"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape" || event.key === "Enter") {
            event.preventDefault();
            onDismiss();
          }
        }}
      >
        <h1 className="chord-help-title">Keyboard shortcuts</h1>
        <p className="chord-help-note">
          Every DevHub command is two strokes: the prefix, then one key. A key
          that completes nothing cancels the chord and reaches nothing.
        </p>
        <ul className="chord-help-rows">
          {rows.map((row) => (
            <li key={row.commandId} className="chord-help-row">
              <span className="chord-help-keys">
                {row.chords.map((chord) => (
                  <kbd key={chord}>{chord}</kbd>
                ))}
              </span>
              <span className="chord-help-label">
                {row.label}
                {row.needs ? (
                  <span className="chord-help-needs"> {row.needs}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
        <div className="picker-footer chord-help-footer">
          <button type="button" className="mac-button" onClick={onDismiss}>
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
