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

/** A workbench being rebuilt, or asleep with the last frame it showed. */
export interface EditorComeback {
  readonly restarting: boolean;
  /** Its frame from before it slept, a data URL; empty if none was taken. */
  readonly frame?: string;
}

/**
 * The editor surfaces whose workbench is being rebuilt right now, or is asleep.
 *
 * A workbench that ends for a reason DevHub did not choose does not move the
 * selection: the Editor activity stays selected and the workbench comes back
 * in the same slot. This is what lets the viewport say so while that happens,
 * instead of showing an empty rectangle. One that slept (`workbenchHibernation.ts`
 * in main) keeps its frame until it is up again.
 */
export function useRestartingEditors(): ReadonlyMap<string, EditorComeback> {
  const [editors, setEditors] = useState<ReadonlyMap<string, EditorComeback>>(
    new Map(),
  );

  useEffect(
    () =>
      devhub().onEditorRestarting(({ surfaceKey, restarting, frame }) => {
        setEditors((current) => {
          const next = new Map(current);
          if (restarting) {
            next.set(surfaceKey, { ...current.get(surfaceKey), restarting });
          } else if (frame !== undefined) {
            next.set(surfaceKey, { restarting, frame });
          } else {
            next.delete(surfaceKey);
          }
          return next;
        });
      }),
    [],
  );

  return editors;
}
