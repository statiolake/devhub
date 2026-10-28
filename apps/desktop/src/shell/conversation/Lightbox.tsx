/**
 * A picture, page or deck of an answer, opened large: an overlay over the
 * Agents page, the rest dimmed behind it.
 *
 * What opens it is the drawing itself — a click on a picture (a diagram, a
 * chart, an SVG, an embedded image) or on a slide, or the header's enlarge
 * button for a page, whose frame takes its own clicks. A picture is fitted to
 * the window; a click on it shows it at its own size, scrolling inside the
 * overlay to pan, and a click again fits it. A page is the same sandboxed
 * frame, large; a deck is the slide viewer, large, ←/→ still flipping.
 *
 * Esc, the close button or a click outside the content closes it, and the
 * focus goes back where it was. It arrives the way a popover does (a fade
 * and a small scale, `conversation-popover-in` on the motion tokens), and
 * without motion when the person asks for less.
 */

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "./icons";

export function Lightbox({
  label,
  onClose,
  onKeyDown,
  children,
}: {
  /** What is open, for the dialog's accessible name: "Mermaid diagram". */
  readonly label: string;
  readonly onClose: () => void;
  /** Keys the content answers (a deck's ←/→); Esc is the overlay's. */
  readonly onKeyDown?: (event: KeyboardEvent) => void;
  readonly children: ReactNode;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement;
    dialog.current?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);
  return createPortal(
    <div
      className="conversation-lightbox"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        className="conversation-lightbox-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
            return;
          }
          onKeyDown?.(event);
        }}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        {children}
        <button
          type="button"
          className="conversation-copy conversation-lightbox-close"
          aria-label="Close"
          title="Close"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>
    </div>,
    document.body,
  );
}

/** A picture, fitted to the window; a click shows it at its own size, and back. */
export function LightboxPicture({
  src,
  alt,
  width,
  height,
}: {
  readonly src: string;
  readonly alt: string;
  readonly width?: number;
  readonly height?: number;
}) {
  const [actual, setActual] = useState(false);
  return (
    <div
      className="conversation-lightbox-stage"
      data-actual={actual || undefined}
    >
      <img
        src={src}
        alt={alt}
        width={width}
        height={height}
        // A picture of a known size is drawn to fill the window, however
        // small it is on its own; at its own size it is that size.
        style={
          !actual && width !== undefined && height !== undefined
            ? {
                width: `min(calc(100vw - 64px), calc((100vh - 64px) * ${width / height}))`,
              }
            : undefined
        }
        draggable={false}
        title={actual ? "Fit to window" : "Actual size"}
        onClick={() => setActual((shown) => !shown)}
      />
    </div>
  );
}

/** Whether a click on a drawing should open it: a plain click, not a selection. */
export function opensLightbox(event: {
  readonly button: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
}): boolean {
  const selection = window.getSelection();
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    (selection === null || selection.isCollapsed)
  );
}
