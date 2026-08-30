/**
 * What a Surface shows when it is not showing a provider.
 *
 * Every Surface uses these: a Workspace whose root went missing, an Agent that
 * could not be stopped, an Activity that does not apply here. A failure that
 * belongs to a Surface is drawn in that Surface, and drawn the same way in
 * every one of them — a reader who has seen one has seen them all.
 *
 * The shape is the Finder's empty view, not a card: a large quiet glyph, one
 * sentence, and at most a couple of actions. There is no heading-and-paragraph
 * layout here, because a Surface with nothing in it is not a document.
 */

import type { ReactNode } from "react";

export interface SurfaceAction {
  readonly label: string;
  readonly primary?: boolean;
  readonly run: () => void;
}

function Frame({
  glyph,
  title,
  message,
  actions,
  role,
}: {
  readonly glyph: ReactNode;
  readonly title: string;
  readonly message?: string;
  readonly actions?: readonly SurfaceAction[];
  readonly role: "status" | "alert";
}) {
  return (
    <div className="mac mac-empty" role={role}>
      <span className="mac-empty-glyph" aria-hidden="true">
        {glyph}
      </span>
      <p className="mac-empty-title">{title}</p>
      {message ? <p className="mac-empty-message">{message}</p> : null}
      {actions && actions.length > 0 ? (
        <div className="mac-empty-actions">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className={`mac-button${action.primary ? " default" : ""}`}
              onClick={action.run}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Something is on its way. One line, and the spinner that says so. */
export function Waiting({ label }: { readonly label: string }) {
  return (
    <div className="mac mac-empty" role="status">
      <span className="mac-spinner" aria-hidden="true" />
      <p className="mac-empty-message">{label}</p>
    </div>
  );
}

/**
 * Something went wrong, in the Surface it went wrong in.
 *
 * `summary` is what happened in one sentence; `detail` is the thing the reader
 * needs to act on — a path, a name — not a stack trace.
 */
export function Failure({
  summary,
  detail,
  actions,
}: {
  readonly summary: string;
  readonly detail?: string;
  readonly actions?: readonly SurfaceAction[];
}) {
  return (
    <Frame
      role="alert"
      title={summary}
      message={detail}
      actions={actions}
      glyph={
        <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
          <path d="M16 4.6 30 27.4H2z" />
          <path d="M16 13v6M16 22.4v.8" />
        </svg>
      }
    />
  );
}

/** Nothing has gone wrong; there is simply nothing here yet. */
export function Empty({
  title,
  message,
  actions,
}: {
  readonly title: string;
  readonly message?: string;
  readonly actions?: readonly SurfaceAction[];
}) {
  return (
    <Frame
      role="status"
      title={title}
      message={message}
      actions={actions}
      glyph={
        <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
          <path d="M3.5 9a2 2 0 0 1 2-2h6.4l2.8 3.2H26.5a2 2 0 0 1 2 2V24a2 2 0 0 1-2 2h-21a2 2 0 0 1-2-2z" />
        </svg>
      }
    />
  );
}
