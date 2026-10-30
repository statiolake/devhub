/**
 * Compact mode's floating Sidebar: the rail, grown to the full width over the
 * content while the pointer is on it.
 *
 * # What it is
 *
 * A browser's vertical tab bar (Edge, Arc, Firefox): the strip stays a strip,
 * and while the pointer is on it the bar slides out to its full width over the
 * page and back when the pointer leaves. The page under it never moves. Here
 * the strip is the rail, and the card is the rail *itself* growing to the
 * right: the same left edge, the same top, every row at the same height and
 * every mark where it was, the words appearing beside the marks as the
 * trailing edge passes them (`sidebarPage.css`).
 *
 * # Who does what
 *
 * The page owns *when*, because only it sees the pointer in this view. Main
 * owns *where*: told that the overlay is up (`previewLayout({ sidebarOverlay
 * })`), it widens this view to the card and its shadow and lifts it over the
 * content, and leaves every other child's rectangle alone
 * (`windowLayout.sidebarRect`). And main settles every leave: a pointer that
 * left this document may have gone onto the tooltip a row raised (another
 * view), or out of a window that went to the back, and from in here those look
 * like any other leave. So when the grace is up the page asks main where the
 * cursor is (`sidebarPointer`) rather than trusting the DOM.
 *
 * # The rules
 *
 * - **Opens at once** on the pointer moving on the rail, and grows out of it
 *   (`OPEN_MS`). No rest delay: a rail that waits is a rail that feels stuck.
 * - **Closes after a grace** (`CLOSE_GRACE_MS`) once the cursor is off the
 *   card *and* off its tooltip, and retracts the way it grew (`CLOSE_MS`).
 *   Coming back inside the grace, or while it retracts, keeps it.
 * - **A window in the back keeps it.** Nothing is decided while DevHub is not
 *   in front: the card waits, and the first check after it comes back decides.
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
 * - **It lands.** Compact mode turned off while the card is up: the card is
 *   already where the docked column goes, so it stays; main moves the content
 *   over once, the shadow fades (`LAND_MS`), and the view becomes a column.
 * - **Compact mode turned on does not open it** under a pointer that was
 *   already there: not until the pointer moves.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { devhub } from "../../sidebar/client";

/**
 * How long the cursor may be off the card before it goes.
 *
 * Long enough to forgive an overshoot of the card's edge and a pass through
 * the room its shadow is in; short enough that leaving reads as leaving. It is
 * also how often main is asked again while the answer is "not yet" — the
 * cursor is on the tooltip, or the window is in the back.
 */
export const CLOSE_GRACE_MS = 200;

/** `--motion-base`: the card growing out of the rail. */
export const OPEN_MS = 180;

/** `--motion-exit`: the card retracting into the rail. Leaving is quicker. */
export const CLOSE_MS = 140;

/**
 * How long the shadow takes to go when compact mode is turned off under the
 * card — `--motion-base`. Instant under Reduce Motion.
 */
export const LAND_MS = 180;

export type OverlayPhase =
  /** The rail, or the docked column: nothing floats. */
  | "closed"
  /** The rail has grown to the full width over the content. */
  | "open"
  /** Retracting into the rail; the view is still the card's until it has. */
  | "closing"
  /** Compact mode went off under it; it is the docked column now. */
  | "landing";

/**
 * Why the rail may not open the card for now.
 *
 * - `move`: compact mode was just turned on with the pointer resting on what
 *   is now the rail. A pointer that has not moved has not asked for anything;
 *   Chromium also sends a move for a pointer that only had the page laid out
 *   under it, at the same place.
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
   * opened is a row the card is about to show in full, and a sentence about it
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
  /** Whether the pointer is on the card (the rail included) right now. */
  const pointerInside = useRef(false);
  /** Whether the last thing the person did here was a key rather than the pointer. */
  const keyboardMode = useRef(false);
  const suppression = useRef<Suppression | undefined>(undefined);
  /** The grace, or the next question to main while the answer is "not yet". */
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  /** The retract or the landing running out. */
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const setPhase = useCallback((next: OverlayPhase) => {
    const was = phaseRef.current;
    if (was === next) return;
    phaseRef.current = next;
    // Opening and closing are what a tooltip has to know about; retracting
    // and coming back out of a retract are one opening.
    if (next === "closed" || (next === "open" && was === "closed")) {
      generationRef.current += 1;
    }
    setPhaseState(next);
    if (next === "open" && was === "closing") return;
    // Whatever tooltip was up is about a row that just changed shape under
    // it; the next one is asked for by the row the pointer goes to next.
    devhub().hideTooltip();
    const floating = next !== "closed";
    if (floating !== (was !== "closed")) {
      void devhub().previewLayout({ sidebarOverlay: floating });
    }
  }, []);

  const clearTimer = (
    timer: React.MutableRefObject<ReturnType<typeof setTimeout> | undefined>,
  ) => {
    if (timer.current === undefined) return;
    clearTimeout(timer.current);
    timer.current = undefined;
  };

  const cancelClose = useCallback(() => {
    clearTimer(closeTimer);
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

  /** Retract into the rail, then let the view go. */
  const retract = useCallback(() => {
    cancelClose();
    if (phaseRef.current !== "open") return;
    setPhase("closing");
    clearTimer(settleTimer);
    settleTimer.current = setTimeout(
      () => {
        settleTimer.current = undefined;
        if (phaseRef.current === "closing") setPhase("closed");
      },
      reducedMotion() ? 0 : CLOSE_MS,
    );
  }, [cancelClose, setPhase]);

  /** Gone this instant: a press outside the card, which must reach under it. */
  const closeNow = useCallback(() => {
    cancelClose();
    clearTimer(settleTimer);
    if (phaseRef.current === "open" || phaseRef.current === "closing") {
      setPhase("closed");
    }
  }, [cancelClose, setPhase]);

  /**
   * The grace is up: ask main where the cursor is, and close only if it is
   * off the card and its tooltip *and* the window is in front. Otherwise ask
   * again after another grace — the pointer is on the tooltip, or DevHub is in
   * the back and nothing is to be decided until it comes forward.
   */
  const scheduleClose = useCallback(() => {
    if (phaseRef.current !== "open") return;
    cancelClose();
    const check = () => {
      closeTimer.current = setTimeout(() => {
        closeTimer.current = undefined;
        if (phaseRef.current !== "open") return;
        if (pointerInside.current || holdingRef.current || keyboardInside()) {
          return;
        }
        void devhub()
          .sidebarPointer()
          .then(
            (where) => where,
            () => ({ inside: false, active: true }),
          )
          .then((where) => {
            // Something answered first: the pointer came back, or the card
            // closed another way.
            if (phaseRef.current !== "open" || closeTimer.current !== undefined)
              return;
            if (pointerInside.current || holdingRef.current) return;
            if (where.inside || !where.active) {
              check();
              return;
            }
            retract();
          });
      }, CLOSE_GRACE_MS);
    };
    check();
  }, [cancelClose, keyboardInside, retract]);

  const dismiss = useCallback(() => {
    if (phaseRef.current !== "open") return;
    suppression.current = { until: "leave" };
    retract();
  }, [retract]);

  // Compact mode moving, in either direction.
  useEffect(() => {
    const was = collapsedRef.current;
    collapsedRef.current = collapsed;
    if (was === collapsed) return;
    cancelClose();
    clearTimer(settleTimer);
    if (collapsed) {
      // Turned on: the rail is under a pointer that has not asked for
      // anything. Wait for it to move. A card still landing is a rail again.
      const at = lastPointer.current;
      suppression.current =
        at === undefined ? undefined : { until: "move", ...at };
      if (phaseRef.current === "landing") setPhase("closed");
      return;
    }
    // Turned off. A card that was up is already where the column goes: it
    // stays, and lets its shadow go. One that was retracting simply goes.
    suppression.current = undefined;
    if (phaseRef.current === "closing") {
      setPhase("closed");
      return;
    }
    if (phaseRef.current !== "open") return;
    setPhase("landing");
    settleTimer.current = setTimeout(
      () => {
        settleTimer.current = undefined;
        if (phaseRef.current === "landing") setPhase("closed");
      },
      reducedMotion() ? 0 : LAND_MS,
    );
  }, [cancelClose, collapsed, setPhase]);

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
      if (phaseRef.current === "closed" || phaseRef.current === "closing") {
        clearTimer(settleTimer);
        setPhase("open");
      }
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
    // The window going to the back closes nothing: whatever the pointer does
    // meanwhile is decided by main's answer once DevHub is in front again.
    document.addEventListener("pointerdown", pointerDown, true);
    document.addEventListener("keydown", keyDown, true);
    document.addEventListener("focusout", focusOut);
    document.addEventListener("dragover", dragOver, true);
    return () => {
      document.removeEventListener("pointerdown", pointerDown, true);
      document.removeEventListener("keydown", keyDown, true);
      document.removeEventListener("focusout", focusOut);
      document.removeEventListener("dragover", dragOver, true);
    };
  }, [cancelClose, closeNow, pane, scheduleClose]);

  // Nothing outlives the page: a card left floating by a page that has gone
  // would be a view over the workbench nobody draws.
  useEffect(
    () => () => {
      clearTimer(closeTimer);
      clearTimer(settleTimer);
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
