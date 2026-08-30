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

/**
 * The frame to draw where the workbench was, while a DevHub modal is open.
 *
 * The same mechanism the scoped VS Code dialog uses, for the same reason: a
 * modal the page draws needs the native view to stand down, and a workbench
 * that disappears is not what a sheet over a window looks like.
 */
export function useModalBackdrop(): string | undefined {
  const [backdrop, setBackdrop] = useState<string>();

  useEffect(
    () =>
      devhub().onModalBackdrop(({ backdrop: frame }) => {
        setBackdrop(frame);
      }),
    [],
  );

  return backdrop;
}
