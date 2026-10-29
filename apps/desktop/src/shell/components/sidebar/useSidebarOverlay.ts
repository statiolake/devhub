/**
 * Compact mode's floating Sidebar: the expanded column, over the content,
 * while the pointer is on the rail.
 *
 * # What it is
 *
 * A browser's vertical tab bar (Edge, Arc, Firefox): the strip stays a strip,
 * and while the pointer is on it the whole bar floats out over the page at its
 * full width — the same tabs, the same layout — and goes back when the pointer
 * leaves. The page under it never moves. Here the strip is the rail and the
 * bar is the Sidebar exactly as it is docked: the same rows, the same markup
 * (`Sidebar.tsx` simply draws it expanded), on a raised card.
 *
 * # Who does what
 *
 * The page owns *when*, because only it sees the pointer in this view. Main
 * owns *where*: told that the overlay is up (`previewLayout({ sidebarOverlay
 * })`), it widens this view to the card and lifts it over the content, and
 * leaves every other child's rectangle alone (`windowLayout.sidebarRect`). The
 * content area is still laid out from the rail's width, so nothing under the
 * card reflows.
 *
 * # The rules
 *
 * - **Opens at once** on the pointer moving on the rail. No rest delay: the
 *   person decided that a rail which waits is a rail that feels stuck.
 * - **Closes after a grace** (`CLOSE_GRACE_MS`) when the pointer leaves the
 *   card, and coming back inside the grace keeps it — so a pointer that
 *   overshoots the edge by a few pixels does not make it flicker.
 * - **The keyboard keeps it.** Focus in it that came from the keyboard holds
 *   it open with the pointer gone; Escape closes it.
 * - **A choice closes it.** A row clicked does what a row does, and the card
 *   goes, the way a browser's does after a tab is picked. It does not come
 *   back under a pointer that has not left — see `Suppression`.
 * - **A press outside the card closes it at once.** The view is the card plus
 *   the room its shadow is drawn in, and that room takes the pointer like any
 *   other pixel of the view; it must not hold the card open or eat a second
 *   click.
 * - **A drag holds it.** HTML drag reports no pointer moves, so the overlay
 *   follows `dragover` instead and decides when the drop lands.
 * - **It lands.** Compact mode turned off while the card is up makes the
 *   docked Sidebar at the same width: the card drops its inset and its shadow
 *   in place (`LAND_MS`) while main has already moved the content over once,
 *   and only then does the view go back to being a column.
 * - **Compact mode turned on does not open it** under a pointer that was
 *   already there: not until the pointer moves.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { devhub } from "../../sidebar/client";

/**
 * How long the pointer may be off the card before it goes.
 *
 * Long enough to forgive an overshoot of the card's edge and a pass through
 * the room its shadow is in; short enough that leaving reads as leaving.
 */
export const CLOSE_GRACE_MS = 200;

/**
 * How long the card takes to land when compact mode is turned off under it —
 * `--motion-base`, the duration the stylesheet lands it in. Instant under
 * Reduce Motion, where the stylesheet does not move it at all.
 */
export const LAND_MS = 180;

export type OverlayPhase =
  /** The rail, or the docked column: nothing floats. */
  | "closed"
  /** The expanded Sidebar is floating over the content. */
  | "open"
  /** Compact mode went off under it, and it is settling into the column. */
  | "landing";

/**
 * Why the rail may not open the card for now.
 *
 * - `move`: compact mode was just turned on, or the page just came up, with
 *   the pointer resting on what is now the rail. A pointer that has not moved
 *   has not asked for anything; Chromium also sends a move for a pointer that
 *   only had the page laid out under it, at the same place.
 * - `leave`: the card was just closed under the pointer — a row chosen,
 *   Escape. It comes back when the pointer has left and come back, not on
 *   the next pixel it moves.
 */
type Suppression =
  | { readonly until: "move"; readonly x: number; readonly y: number }
  | { readonly until: "leave" };

export interface SidebarOverlay {
  readonly phase: OverlayPhase;
  /**
   * Counts every time the card opened or closed, read at the moment it is
   * asked. The tooltips ask it: a row the pointer arrived on as the card
   * opened is a row the card already shows in full, and a sentence about it
   * beside the card is the rail's tooltip doubled up with the overlay.
   */
  readonly generation: () => number;
  /** Close it now, and keep it closed under a pointer that has not left. */
  readonly dismiss: () => void;
  /** The handlers the pane wears. */
  readonly paneHandlers: {
    readonly onPointerMove: (event: React.PointerEvent) => void;
    readonly onPointerEnter: () => void;
    readonly onPointerLeave: () => void;
  };
}

function reducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * @param collapsed compact mode, as the model has it.
 * @param pane the Sidebar's own element: the card, when it floats.
 * @param holding a row is in the air (`useReorder`), so nothing may close it.
 */
export function useSidebarOverlay(
  collapsed: boolean,
  pane: React.RefObject<HTMLElement | null>,
  holding: boolean,
): SidebarOverlay {
  const [phase, setPhaseState] = useState<OverlayPhase>("closed");
  const phaseRef = useRef<OverlayPhase>("closed");
  const generationRef = useRef(0);
  const collapsedRef = useRef(collapsed);
  const holdingRef = useRef(holding);
  holdingRef.current = holding;

  /** Where the pointer was last seen in this view, in its own pixels. */
  const lastPointer = useRef<{ x: number; y: number } | undefined>(undefined);
  /** Whether the pointer is on the card (or the rail) right now. */
  const pointerInside = useRef(false);
  /** Whether the last thing the person did here was a key rather than the pointer. */
  const keyboardMode = useRef(false);
  const suppression = useRef<Suppression | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const landTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const setPhase = useCallback((next: OverlayPhase) => {
    if (phaseRef.current === next) return;
    const wasFloating = phaseRef.current !== "closed";
    phaseRef.current = next;
    if (next === "open" || next === "closed") generationRef.current += 1;
    setPhaseState(next);
    // Whatever tooltip was up is about a row that just changed shape under
    // it; the next one is asked for by the row the pointer goes to next.
    devhub().hideTooltip();
    const floating = next !== "closed";
    if (floating !== wasFloating) {
      void devhub().previewLayout({ sidebarOverlay: floating });
    }
  }, []);

  const cancelClose = useCallback(() => {
    if (closeTimer.current === undefined) return;
    clearTimeout(closeTimer.current);
    closeTimer.current = undefined;
  }, []);

  /** Whether focus in the card is the keyboard's, which holds it open. */
  const keyboardInside = useCallback((): boolean => {
    const element = pane.current;
    return (
      keyboardMode.current &&
      element !== null &&
      element.contains(element.ownerDocument.activeElement)
    );
  }, [pane]);

  const closeNow = useCallback(() => {
    cancelClose();
    if (phaseRef.current === "open") setPhase("closed");
  }, [cancelClose, setPhase]);

  const scheduleClose = useCallback(() => {
    if (phaseRef.current !== "open") return;
    cancelClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = undefined;
      if (phaseRef.current !== "open") return;
      if (pointerInside.current || holdingRef.current || keyboardInside()) {
        return;
      }
      setPhase("closed");
    }, CLOSE_GRACE_MS);
  }, [cancelClose, keyboardInside, setPhase]);

  const dismiss = useCallback(() => {
    if (phaseRef.current !== "open") return;
    suppression.current = { until: "leave" };
    closeNow();
  }, [closeNow]);

  // Compact mode moving, in either direction.
  useEffect(() => {
    const was = collapsedRef.current;
    collapsedRef.current = collapsed;
    if (was === collapsed) return;
    if (collapsed) {
      // Turned on: the rail is under a pointer that has not asked for
      // anything. Wait for it to move.
      const at = lastPointer.current;
      suppression.current =
        at === undefined ? undefined : { until: "move", ...at };
      cancelClose();
      return;
    }
    // Turned off. A card that was up lands in the column it now is; one that
    // was not has nothing to do.
    cancelClose();
    suppression.current = undefined;
    if (phaseRef.current !== "open") return;
    setPhase("landing");
    const duration = reducedMotion() ? 0 : LAND_MS;
    landTimer.current = setTimeout(() => {
      landTimer.current = undefined;
      if (phaseRef.current === "landing") setPhase("closed");
    }, duration);
  }, [cancelClose, collapsed, setPhase]);

  // Compact mode turned back on while a card was still landing: it is a
  // column now, and the rail closes it.
  useEffect(() => {
    if (!collapsed || phaseRef.current !== "landing") return;
    if (landTimer.current !== undefined) clearTimeout(landTimer.current);
    landTimer.current = undefined;
    setPhase("closed");
  }, [collapsed, setPhase]);

  // A drag that ended decides for itself whether the card stays.
  useEffect(() => {
    if (holding) {
      cancelClose();
      return;
    }
    if (!pointerInside.current) scheduleClose();
  }, [cancelClose, holding, scheduleClose]);

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const at = { x: event.clientX, y: event.clientY };
      lastPointer.current = at;
      pointerInside.current = true;
      keyboardMode.current = false;
      if (!collapsedRef.current) return;
      cancelClose();
      const held = suppression.current;
      if (held !== undefined) {
        if (held.until === "leave") return;
        if (held.x === at.x && held.y === at.y) return;
        suppression.current = undefined;
      }
      if (phaseRef.current === "closed") setPhase("open");
    },
    [cancelClose, setPhase],
  );

  const onPointerEnter = useCallback(() => {
    pointerInside.current = true;
    cancelClose();
  }, [cancelClose]);

  const onPointerLeave = useCallback(() => {
    pointerInside.current = false;
    if (suppression.current?.until === "leave") suppression.current = undefined;
    scheduleClose();
  }, [scheduleClose]);

  // What happens outside the pane, or is not a pointer at all.
  useEffect(() => {
    const document = pane.current?.ownerDocument;
    if (!document) return;
    const view = document.defaultView;
    // A press in the room the shadow is drawn in: outside the card, inside
    // this view. The card goes at once so the next click reaches what is
    // under it; this one was already this view's.
    const pointerDown = (event: PointerEvent) => {
      keyboardMode.current = false;
      const element = pane.current;
      if (!element || !(event.target instanceof Node)) return;
      if (!element.contains(event.target)) closeNow();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") return;
      keyboardMode.current = true;
      cancelClose();
    };
    // The keyboard leaving the card, with the pointer not on it: it goes the
    // way it would have gone for the pointer.
    const focusOut = (event: FocusEvent) => {
      const element = pane.current;
      if (!element) return;
      const next = event.relatedTarget;
      if (next instanceof Node && element.contains(next)) return;
      if (!pointerInside.current) scheduleClose();
    };
    // During an HTML drag the pointer reports nothing; `dragover` is where
    // it is.
    const dragOver = (event: DragEvent) => {
      const element = pane.current;
      pointerInside.current =
        element !== null &&
        event.target instanceof Node &&
        element.contains(event.target);
    };
    // The window going away takes the pointer and the keyboard with it.
    const blur = () => {
      pointerInside.current = false;
      closeNow();
    };
    document.addEventListener("pointerdown", pointerDown, true);
    document.addEventListener("keydown", keyDown, true);
    document.addEventListener("focusout", focusOut);
    document.addEventListener("dragover", dragOver, true);
    view?.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("pointerdown", pointerDown, true);
      document.removeEventListener("keydown", keyDown, true);
      document.removeEventListener("focusout", focusOut);
      document.removeEventListener("dragover", dragOver, true);
      view?.removeEventListener("blur", blur);
    };
  }, [cancelClose, closeNow, pane, scheduleClose]);

  // Nothing outlives the page: a card left floating by a page that has gone
  // would be a view over the workbench nobody draws.
  useEffect(
    () => () => {
      if (closeTimer.current !== undefined) clearTimeout(closeTimer.current);
      if (landTimer.current !== undefined) clearTimeout(landTimer.current);
      if (phaseRef.current !== "closed") {
        void devhub().previewLayout({ sidebarOverlay: false });
      }
    },
    [],
  );

  const generation = useCallback(() => generationRef.current, []);

  return {
    phase,
    generation,
    dismiss,
    paneHandlers: { onPointerMove, onPointerEnter, onPointerLeave },
  };
}
