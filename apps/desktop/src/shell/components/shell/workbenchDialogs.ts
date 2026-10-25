/**
 * What the viewport has to know about workbenches it does not draw.
 *
 * The questions a workbench asks are not here any more: they are DevHub modals
 * like any other, drawn on the overlay layer by main's authority, and this
 * page never sees them. What is left is the one state the *hole* has of its
 * own — the workbench that is being built again in the same slot.
 */

import { useEffect, useState } from "react";
import type { EditorPlaceholderWire } from "../../../ipc/contract";
import { devhub } from "../../client";

/**
 * What stands in each editor surface whose workbench is not there right now:
 * being rebuilt, asleep with the last frame it showed, or waking.
 *
 * A workbench that ends, sleeps or wakes does not move the selection: the
 * Editor activity stays selected and the workbench comes back in the same
 * slot. Main derives this from the workbench's lifecycle phase
 * (`main/shell/workbenchLifecycle.ts`) and says it again whenever it changes,
 * so the page keeps what it was last told and nothing else — no merging, no
 * event that must arrive to take it down.
 */
export function useEditorPlaceholders(): ReadonlyMap<
  string,
  EditorPlaceholderWire
> {
  const [editors, setEditors] = useState<
    ReadonlyMap<string, EditorPlaceholderWire>
  >(new Map());

  useEffect(
    () =>
      devhub().onEditorPlaceholder(({ surfaceKey, placeholder }) => {
        setEditors((current) => {
          const next = new Map(current);
          if (placeholder === undefined) next.delete(surfaceKey);
          else next.set(surfaceKey, placeholder);
          return next;
        });
      }),
    [],
  );

  return editors;
}
