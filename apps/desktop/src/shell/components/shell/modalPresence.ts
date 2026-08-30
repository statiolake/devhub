/**
 * Whether the page has a modal open — counted once, reported once.
 *
 * A native `WebContentsView` always paints above this document, so a workbench
 * on screen covers anything the page draws: an alert or a sheet would be
 * invisible while still holding focus, which is the worst of both. Main
 * therefore hides the revealed view while the page has a modal up.
 *
 * Every modal DevHub has goes through the same three components, and each of
 * them calls this on mount and on unmount, so there is one rule rather than a
 * report at every call site — which is how one dialog is eventually forgotten.
 */

import { useEffect } from "react";
import { devhub } from "../../client";

let open = 0;

function report(): void {
  void devhub()
    .setModalOpen(open > 0)
    .catch(() => {
      // Not a swallow with consequences: the flag is re-sent by the next modal
      // to open or close, and a failure here cannot be shown *in* a modal.
    });
}

/** Declare that this component is a modal for as long as it is mounted. */
export function useModalPresence(): void {
  useEffect(() => {
    open += 1;
    if (open === 1) report();
    return () => {
      open -= 1;
      if (open === 0) report();
    };
  }, []);
}
