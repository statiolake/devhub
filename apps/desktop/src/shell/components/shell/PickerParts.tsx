/**
 * The quick pick's look, in parts: the header band, the search glyph and a
 * row's text. `Picker` is drawn from them, and so is every question DevHub
 * draws where the state is someone else's — tmux's choose-tree in control
 * mode (`shell/terminal/control/ChooserSheet.tsx`), whose filter, rows and
 * keys are tmux's semantics kept in the pty host. One look, whoever decides
 * (`docs/native-picker.md`, "Quick pick").
 */

import type { ReactNode } from "react";

/** What is being asked, and why: one band, the title over its sentence. */
export function PickerHeader({
  title,
  question,
  step,
  headingId,
  questionId,
}: {
  readonly title: string;
  readonly question: ReactNode;
  readonly step?: number;
  readonly headingId?: string;
  readonly questionId?: string;
}) {
  return (
    <header className="picker-header">
      <div className="picker-heading">
        <h2 className="picker-title" id={headingId}>
          {title}
        </h2>
        {step === undefined ? null : (
          <span className="picker-step mac-caption">Step {String(step)}</span>
        )}
      </div>
      <p className="picker-question mac-caption" id={questionId}>
        {question}
      </p>
    </header>
  );
}

export function PickerSearchGlyph() {
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

/** A row's glyph, name and second line, inside its `mac-list-row`. */
export function PickerRowText({
  glyph,
  label,
  detail,
  unavailable,
}: {
  readonly glyph?: ReactNode;
  readonly label: ReactNode;
  readonly detail?: ReactNode;
  readonly unavailable?: string;
}) {
  return (
    <>
      {glyph ? <span className="mac-list-glyph">{glyph}</span> : null}
      <span className="mac-list-text">
        <span className="mac-list-title">{label}</span>
        {detail ? (
          <span className="mac-list-subtitle mac-caption">{detail}</span>
        ) : null}
        {unavailable === undefined ? null : (
          <span className="mac-list-subtitle mac-caption picker-unavailable">
            {unavailable}
          </span>
        )}
      </span>
    </>
  );
}
