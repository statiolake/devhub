/**
 * What the viewport has to know about workbenches it does not draw.
 *
 * The questions a workbench asks are not here any more: they are DevHub modals
 * like any other, drawn on the overlay layer by main's authority, and this
 * page never sees them. What is left is the one state the *hole* has of its
 * own — the workbench that is being built again in the same slot.
 */

import { useEffect, useState } from "react";
import { devhub } from "../../client";

/**
 * The editor surfaces whose workbench is being rebuilt right now.
 *
 * A workbench that ends for a reason DevHub did not choose does not move the
 * selection: the Editor activity stays selected and the workbench comes back
 * in the same slot. This is what lets the viewport say so while that happens,
 * instead of showing an empty rectangle.
 */
export function useRestartingEditors(): ReadonlySet<string> {
  const [restarting, setRestarting] = useState<ReadonlySet<string>>(new Set());

  useEffect(
    () =>
      devhub().onEditorRestarting(({ surfaceKey, restarting: active }) => {
        setRestarting((current) => {
          if (current.has(surfaceKey) === active) return current;
          const next = new Set(current);
          if (active) next.add(surfaceKey);
          else next.delete(surfaceKey);
          return next;
        });
      }),
    [],
  );

  return restarting;
}
