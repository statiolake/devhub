/**
 * An alert that belongs to one workbench, drawn inside that workbench's rect.
 *
 * DevHub's own alerts are the application asking, so they cover the window. A
 * workbench's question is not: it is about one editor, and covering the sidebar
 * and every other workspace with it would stop the person doing the very thing
 * that helps them answer — looking at something else.
 *
 * It is drawn on the modal layer, whose view main sizes to that workbench's
 * own rectangle — so it is clipped to the editor area by construction, the
 * live workbench is still there underneath it, and the sidebar and every other
 * workspace are not covered at all and stay usable.
 *
 * There is no dismiss-by-clicking-outside. Outside is another part of the
 * application, not a way of answering a question about unsaved work; only the
 * buttons and Escape answer it, exactly as in VS Code.
 */

import { useEffect, useRef } from "react";
import { isImeComposing } from "../../accessibility/ime";
import type { WorkbenchDialogRequest } from "../../../ipc/contract";

export interface ViewScopedAlertProps {
  readonly request: WorkbenchDialogRequest;
  readonly onAnswer: (response: number) => void;
}

export function ViewScopedAlert({ request, onAnswer }: ViewScopedAlertProps) {
  const panel = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const buttons = panel.current?.querySelectorAll("button");
    buttons?.[request.defaultId]?.focus();
  }, [request.defaultId]);

  return (
    <div
      className="mac view-scoped-alert"
      role="dialog"
      aria-modal="true"
      aria-label={request.message}
      onKeyDown={(event) => {
        if (isImeComposing(event.nativeEvent)) return;
        if (event.key === "Escape") {
          event.preventDefault();
          onAnswer(request.cancelId);
        }
      }}
    >
      <div className="view-scoped-alert-scrim" />
      <div className="mac-alert" ref={panel}>
        <div className="mac-alert-body">
          <div className="mac-alert-text">
            <h2 className="mac-title">{request.message}</h2>
            {request.detail ? (
              <p className="mac-message">{request.detail}</p>
            ) : null}
          </div>
        </div>
        <div className="mac-alert-actions">
          {request.buttons.map((label, index) => (
            <button
              key={label}
              type="button"
              className={`mac-button${index === request.defaultId ? " default" : ""}`}
              onClick={() => {
                onAnswer(index);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
