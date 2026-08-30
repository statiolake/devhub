/**
 * The questions a workbench asks, drawn where the workbench is.
 *
 * VS Code raises these as native message boxes; DevHub intercepts them (see
 * `main/shell/workbenchDialogs.ts`) because a native one becomes a sheet
 * across the whole application. Here they are DevHub alerts instead, so a
 * question about one editor looks like a question about one editor — and the
 * sidebar, the activities and every other workspace stay live behind it.
 *
 * One at a time, in the order they arrived: two workbenches can both have
 * something to ask, and stacking their sheets would leave the person unable to
 * tell which editor they are answering for.
 */

import { useEffect, useState } from "react";
import { devhub } from "../../client";
import type { WorkbenchDialogRequest } from "../../../ipc/contract";
import { Alert } from "./Alert";

export function WorkbenchDialogHost() {
  const [queue, setQueue] = useState<readonly WorkbenchDialogRequest[]>([]);

  useEffect(
    () =>
      devhub().onWorkbenchDialog((request) => {
        setQueue((current) => [...current, request]);
      }),
    [],
  );

  const current = queue[0];
  if (!current) return null;

  const answer = (response: number) => {
    setQueue((rest) => rest.slice(1));
    void devhub()
      .answerWorkbenchDialog({ id: current.id, response })
      .catch(() => {
        // The main process is the only reader, and it settles the question on
        // the window closing anyway; there is nowhere better for this to go.
      });
  };

  return (
    <Alert
      title={current.message}
      message={current.detail}
      tone={
        current.kind === "error"
          ? "danger"
          : current.kind === "warning"
            ? "caution"
            : undefined
      }
      onCancel={() => {
        answer(current.cancelId);
      }}
      actions={current.buttons.map((label, index) => ({
        label,
        isDefault: index === current.defaultId,
        run: () => {
          answer(index);
        },
      }))}
    />
  );
}
