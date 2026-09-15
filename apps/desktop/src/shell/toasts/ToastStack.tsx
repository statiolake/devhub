/**
 * The one place the application speaks for itself.
 *
 * Everything app-scoped is drawn here and nowhere else — a failed intent, a
 * `gh` that is not on the PATH, a network that dropped — because a condition
 * about the whole application has no other honest home. It used to have two
 * homes and neither was one: a caption at the foot of the Sidebar, which is a
 * list of workspaces and not an error area, and a banner across the top of the
 * Surface, which is about the workspace you are looking at. Failures about an
 * Agent or about one workspace are not here at all; they are drawn at their
 * subject, which is the rule `main/shell/agentFailure.ts` routes by.
 *
 * # Where it is drawn
 *
 * In a view of its own, above every workbench — which is the answer
 * `styles/toast.css` named for itself and could not have while this was part
 * of the App Shell page. A native `WebContentsView` paints over everything in
 * that document, so a toast over the workbench was a toast nobody saw. The
 * stack answered that first by taking room, below the panes, with the
 * workbench hole giving up the height — and every appearance and disappearance
 * then reflowed the window, so one host that would not answer made the whole
 * workbench shake once a second. It answered it next by floating over the
 * Sidebar's column, the one column no native view was laid over — which worked
 * until the Sidebar was collapsed to its rail or dragged under the stack's
 * readable floor, and both of those are written down in the stylesheet as
 * limits this placement would remove.
 *
 * It removes them. A notice can be drawn anywhere in the window now, because
 * the window is what it is drawn in.
 *
 * The other half of the same fix is upstream: a machine that is not answering
 * is published *once per episode*, as a condition with hysteresis
 * (`main/shell/machineConditions.ts`), rather than as a failure raised every
 * round. A stack that cannot flap and a notice that does not flap are two
 * different guarantees, and both are wanted.
 */

import { useRef } from "react";
import { isImeComposing } from "../accessibility/ime";
import type { Notice } from "../notices";

function Toast({
  notice,
  onDismiss,
  onRetry,
  onOpenSettings,
}: {
  readonly notice: Notice;
  readonly onDismiss: () => void;
  readonly onRetry: () => void;
  readonly onOpenSettings: () => void;
}) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  return (
    <div
      className="toast"
      role={notice.live}
      // In the focus order, because a notice that can only be reached with the
      // pointer is a notice a keyboard cannot answer. Escape closes the one
      // that has the focus; `Cmd+Q D` closes the newest without going there.
      tabIndex={0}
      onKeyDown={(event) => {
        if (isImeComposing(event.nativeEvent)) return;
        if (event.key === "Escape") {
          event.preventDefault();
          dismiss.current();
        }
      }}
    >
      <span className="toast-mark" aria-hidden="true">
        {notice.live === "alert" ? "!" : "i"}
      </span>
      <div className="toast-text">
        <p className="toast-summary">{notice.summary}</p>
        {/* The summary says what to do; the detail says what happened. */}
        {notice.detail ? <p className="toast-detail">{notice.detail}</p> : null}
      </div>
      {notice.actions.length > 0 ? (
        <div className="toast-actions">
          {notice.actions.includes("retry") ? (
            <button type="button" className="toast-action" onClick={onRetry}>
              Try Again
            </button>
          ) : null}
          {notice.actions.includes("open_settings") ? (
            <button
              type="button"
              className="toast-action"
              onClick={onOpenSettings}
            >
              Open Settings
            </button>
          ) : null}
        </div>
      ) : null}
      <button
        type="button"
        className="toast-close"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          <path d="M3 3l6 6M9 3l-6 6" />
        </svg>
      </button>
    </div>
  );
}

export interface ToastStackProps {
  readonly notices: readonly Notice[];
  readonly onDismiss: (identity: string) => void;
  readonly onRetry: () => void;
  readonly onOpenSettings: () => void;
  /**
   * Where the measurement is taken.
   *
   * The view is exactly as big as this element, so whoever measures it needs
   * to hold it. See `stackSize.ts` for why the size is the page's to report
   * and the placement is main's to decide.
   */
  readonly ref?: (element: HTMLElement | null) => void;
}

export function ToastStack({
  notices,
  onDismiss,
  onRetry,
  onOpenSettings,
  ref,
}: ToastStackProps) {
  // Nothing is returned when there is nothing to say, and the size that goes
  // with that is reported by the effect rather than by an observer: an
  // observer on an element that is no longer in the document sees nothing, and
  // "the stack is empty" is precisely the report that must not be missed.
  if (notices.length === 0) return null;

  return (
    <div className="toast-stack" ref={ref}>
      {notices.map((notice) => (
        <Toast
          key={notice.identity}
          notice={notice}
          onDismiss={() => {
            onDismiss(notice.identity);
          }}
          onRetry={onRetry}
          onOpenSettings={onOpenSettings}
        />
      ))}
    </div>
  );
}
