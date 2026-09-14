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
 * # Where it is drawn, and why not over the workbench
 *
 * A native `WebContentsView` paints over everything in this document, so a
 * toast over the workbench rectangle is a toast nobody sees. This stack used
 * to answer that by taking room — sitting below the panes, in the flow, with
 * the workbench hole giving up the height — and that answer cost the thing it
 * was protecting: every appearance and disappearance reflowed the window, so
 * one host that would not answer made the whole workbench shake once a second.
 *
 * So it floats over the Sidebar's column instead, which is the one column no
 * native view is ever laid over: nothing in the Surface moves, main is told
 * nothing, and the notice is still certain to be seen. The placement lives in
 * `styles/toast.css`, with the trade-off written out there.
 *
 * The other half of the same fix is upstream: a machine that is not answering
 * is published *once per episode*, as a condition with hysteresis
 * (`main/shell/machineConditions.ts`), rather than as a failure raised every
 * round. A stack that cannot flap and a notice that does not flap are two
 * different guarantees, and both are wanted.
 */

import { useEffect, useRef } from "react";
import { isImeComposing } from "../../accessibility/ime";
import { focusMainSurface } from "../../focusHome";
import { useAppShell } from "../../useAppShell";
import type { Notice } from "../../notices";

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

export function Toasts() {
  const { notices, dismissNotice, retry, openSettings } = useAppShell();
  const held = useRef(false);

  // Nothing left to stand on: a stack that empties while one of its toasts held
  // the keyboard would drop focus on the document, which is nowhere. The
  // keyboard's home is the main area and there is one function that says so
  // (`focusHome.ts`), so this asks it rather than deciding for itself.
  useEffect(() => {
    if (notices.length > 0 || !held.current) return;
    held.current = false;
    focusMainSurface();
  }, [notices.length]);

  if (notices.length === 0) return null;

  return (
    <div
      className="toast-stack"
      onFocus={() => {
        held.current = true;
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          held.current = false;
        }
      }}
    >
      {notices.map((notice) => (
        <Toast
          key={notice.identity}
          notice={notice}
          onDismiss={() => {
            dismissNotice(notice.identity);
          }}
          onRetry={retry}
          onOpenSettings={() => {
            void openSettings();
          }}
        />
      ))}
    </div>
  );
}
