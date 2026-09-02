/**
 * An alert, shaped like the one macOS shows.
 *
 * Icon, a bold message line, informative text, and the buttons on the trailing
 * edge with the default action rightmost. Return activates the default, Escape
 * cancels, and focus is trapped until one of them is chosen — a person who has
 * used any other Mac app already knows how to answer this.
 *
 * The caller supplies the words and the actions; it never supplies a layout.
 * Every destructive confirmation in DevHub goes through here, so they cannot
 * drift into looking like different kinds of question.
 */

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { isImeComposing } from "../../accessibility/ime";

export interface AlertAction {
  readonly label: string;
  /** The rightmost button, activated by Return. */
  readonly isDefault?: boolean;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly run: () => void;
}

export interface AlertProps {
  readonly title: string;
  readonly message?: string;
  /** Extra rows the person needs before deciding, as label/value pairs. */
  readonly detail?: readonly (readonly [string, string])[];
  /**
   * `plain` is a sheet that asks for something rather than warning about it —
   * a name, a path, a URL. It draws no caution mark, because a triangle on a
   * form teaches that the triangle means nothing.
   */
  readonly tone?: "plain" | "caution" | "danger";
  readonly actions: readonly AlertAction[];
  /** Escape, and clicking outside. Cancelling is always available. */
  readonly onCancel: () => void;
  readonly children?: ReactNode;
}

function CautionGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 3.4 22 20.6H2z" />
      <path d="M12 10v4.4M12 17.3v.6" />
    </svg>
  );
}

export function Alert({
  title,
  message,
  detail,
  tone = "caution",
  actions,
  onCancel,
  children,
}: AlertProps) {
  const dialog = useRef<HTMLDivElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreTo.current = document.activeElement as HTMLElement | null;
    const buttons = dialog.current?.querySelectorAll<HTMLElement>(
      "button:not([disabled])",
    );
    // The default action holds focus, so Return works without a Tab first.
    (buttons?.[buttons.length - 1] ?? buttons?.[0])?.focus();
    return () => {
      const target = restoreTo.current;
      if (target?.isConnected) target.focus();
    };
  }, []);

  /** Move the focus round the ring the alert traps it in. */
  const step = (backwards: boolean) => {
    const focusable = [
      ...(dialog.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ) ?? []),
    ];
    if (focusable.length === 0) return;
    const index = focusable.indexOf(document.activeElement as HTMLElement);
    const next = backwards
      ? index <= 0
        ? focusable.length - 1
        : index - 1
      : (index + 1) % focusable.length;
    focusable[next]?.focus();
  };

  return createPortal(
    <div
      className="mac-scrim mac"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className="mac-alert"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="mac-alert-title"
        aria-describedby={message ? "mac-alert-message" : undefined}
        ref={dialog}
        // Every key this alert answers, answered here — on the alert itself,
        // the way the picker answers its own.
        //
        // Escape and Tab used to be a listener on `document`, and that is not a
        // smaller version of this: a sheet that hands over to another sheet
        // does so *while the key that dismissed it is still travelling*, so the
        // arriving alert's listener went on `document` in time to catch the
        // very Escape that summoned it and cancelled itself. Escape out of the
        // clone folder list closed the whole sheet instead of going back to the
        // repository. A handler on the element cannot be reached by a key
        // pressed inside something else.
        onKeyDown={(event) => {
          if (isImeComposing(event.nativeEvent)) return;
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
            return;
          }
          if (event.key === "Tab") {
            event.preventDefault();
            step(event.shiftKey);
            return;
          }
          if (
            event.key === "Enter" &&
            event.target instanceof HTMLElement &&
            event.target.tagName !== "BUTTON"
          ) {
            event.preventDefault();
            const fallback = actions.find(
              (action) => action.isDefault && !action.disabled,
            );
            fallback?.run();
          }
        }}
      >
        <div className={`mac-alert-body${tone === "plain" ? " plain" : ""}`}>
          {tone === "plain" ? null : (
            <div
              className={`mac-alert-icon${tone === "danger" ? " danger" : ""}`}
            >
              <CautionGlyph />
            </div>
          )}
          <div className="mac-alert-text">
            <h2 className="mac-title" id="mac-alert-title">
              {title}
            </h2>
            {message ? (
              <p className="mac-message" id="mac-alert-message">
                {message}
              </p>
            ) : null}
            {detail && detail.length > 0 ? (
              <ul className="mac-alert-detail">
                {detail.map(([label, value]) => (
                  <li key={label}>
                    <span>{label}</span>
                    <span>{value}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {children}
          </div>
        </div>
        <div className="mac-alert-actions">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className={`mac-button${
                action.destructive
                  ? " destructive"
                  : action.isDefault
                    ? " default"
                    : ""
              }`}
              disabled={action.disabled}
              onClick={action.run}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
