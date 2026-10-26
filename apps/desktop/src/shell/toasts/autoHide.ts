/**
 * A toast's time on screen.
 *
 * `general.notice_seconds` after it appears it hides itself (into the notice
 * center; see `shell/notices.ts`), `0` never. The clock stops while the
 * person is with it — the pointer over it, the keyboard in it, or words in it
 * selected (they are being copied) — and when they leave it runs on from
 * where it stopped, with at least `RESUME_FLOOR_MS` left, so a toast does not
 * vanish the instant the pointer moves off it.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
} from "react";

/** The least time left once the person moves away from a toast. */
export const RESUME_FLOOR_MS = 2_000;

export interface AutoHide {
  readonly ref: (element: HTMLElement | null) => void;
  readonly onPointerEnter: () => void;
  readonly onPointerLeave: () => void;
  readonly onFocus: () => void;
  readonly onBlur: (event: FocusEvent) => void;
}

export function useAutoHide(seconds: number, onHide: () => void): AutoHide {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [selected, setSelected] = useState(false);
  const element = useRef<HTMLElement | null>(null);
  const hideRef = useRef(onHide);
  hideRef.current = onHide;
  const remaining = useRef(seconds * 1000);
  const forSeconds = useRef(seconds);
  if (forSeconds.current !== seconds) {
    // A new setting starts the clock over.
    forSeconds.current = seconds;
    remaining.current = seconds * 1000;
  }

  // Words selected inside the toast hold it, wherever the pointer went after.
  useEffect(() => {
    const changed = () => {
      const selection = document.getSelection();
      const node = element.current;
      setSelected(
        node !== null &&
          selection !== null &&
          !selection.isCollapsed &&
          (node.contains(selection.anchorNode) ||
            node.contains(selection.focusNode)),
      );
    };
    document.addEventListener("selectionchange", changed);
    return () => {
      document.removeEventListener("selectionchange", changed);
    };
  }, []);

  const paused = hovered || focused || selected;
  const wasPaused = useRef(false);
  if (paused) wasPaused.current = true;
  useEffect(() => {
    if (seconds <= 0 || paused) return undefined;
    const started = Date.now();
    const timer = setTimeout(
      () => {
        hideRef.current();
      },
      wasPaused.current
        ? Math.max(RESUME_FLOOR_MS, remaining.current)
        : remaining.current,
    );
    return () => {
      clearTimeout(timer);
      // Not when it is the setting that changed: that started over.
      if (forSeconds.current !== seconds) return;
      remaining.current -= Date.now() - started;
    };
  }, [paused, seconds]);

  return {
    ref: useCallback((node: HTMLElement | null) => {
      element.current = node;
    }, []),
    onPointerEnter: () => {
      setHovered(true);
    },
    onPointerLeave: () => {
      setHovered(false);
    },
    onFocus: () => {
      setFocused(true);
    },
    onBlur: (event) => {
      // Focus moving between the toast's own buttons is still in the toast.
      if (
        event.relatedTarget instanceof Node &&
        element.current?.contains(event.relatedTarget)
      ) {
        return;
      }
      setFocused(false);
    },
  };
}
