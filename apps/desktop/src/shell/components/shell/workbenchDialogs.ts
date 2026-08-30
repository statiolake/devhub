/**
 * The questions workbenches have asked, kept per workbench.
 *
 * A question raised by one editor is not the application's question: it is
 * modal to that editor and to nothing else. So they are held in a map keyed by
 * the surface they belong to, and the viewport draws only the one whose editor
 * is on screen. Switching workspace or activity therefore leaves a question
 * standing — it goes away with its editor and comes back with it, because
 * nothing about it has changed while you were looking elsewhere.
 */

import { useEffect, useState } from "react";
import { devhub } from "../../client";
import type { WorkbenchDialogRequest } from "../../../ipc/contract";

/** Told when a question has been answered, so it stops being drawn. */
let forget: ((surfaceKey: string) => void) | undefined;

export function useWorkbenchDialogs(): ReadonlyMap<
  string,
  WorkbenchDialogRequest
> {
  const [dialogs, setDialogs] = useState<
    ReadonlyMap<string, WorkbenchDialogRequest>
  >(new Map());

  useEffect(
    () =>
      devhub().onWorkbenchDialog((request) => {
        setDialogs((current) => {
          const next = new Map(current);
          // One at a time per workbench: a second question from the same editor
          // replaces the first, which is what VS Code's own serial dialogs do.
          next.set(request.surfaceKey, request);
          return next;
        });
      }),
    [],
  );

  useEffect(() => {
    forget = (surfaceKey) => {
      setDialogs((current) => {
        if (!current.has(surfaceKey)) return current;
        const next = new Map(current);
        next.delete(surfaceKey);
        return next;
      });
    };
    return () => {
      forget = undefined;
    };
  }, []);

  return dialogs;
}

export function answerWorkbenchDialog(
  request: WorkbenchDialogRequest,
  response: number,
): void {
  forget?.(request.surfaceKey);
  void devhub()
    .answerWorkbenchDialog({ id: request.id, response })
    .catch(() => {
      // Main settles the question on the window going away in any case, and
      // there is nowhere better than the failure surface for this — which is
      // reached through the same channel that just failed.
    });
}
