/**
 * "Remove this worktree?"
 *
 * A destructive act, so it is asked before it is done, and the question says
 * exactly what will happen to each of the two things involved: the folder goes,
 * the branch stays.
 *
 * That pairing is the rule and not a preference. A worktree is a *place*; a
 * branch is *work*. Removing the place must not destroy the work — the branch
 * may be pushed, may have a pull request open against it, and is the whole of
 * what links a workspace to its Issue. There is deliberately no checkbox
 * beside this: an option whose wrong setting loses commits is worse than no
 * option, and somebody who wants the branch gone runs `git branch -d`, where
 * git refuses if it is unmerged.
 *
 * A refusal keeps the sheet, the way every other failure DevHub can put words
 * to does: git declining because there are changes in the worktree is answered
 * by going and dealing with them, not by being told after the sheet has gone.
 */

import { useState } from "react";
import { Alert } from "../components/shell/Alert";
import { toAppError } from "../failure";
import { useAppShell } from "../useAppShell";
import type { ModalRequest } from "../../ipc/contract";

export type WorktreeRemovalRequest = Extract<
  ModalRequest,
  { kind: "worktree-removal" }
>;

export interface WorktreeRemovalAlertProps {
  readonly request: WorktreeRemovalRequest;
  readonly onDismiss: () => void;
}

export function WorktreeRemovalAlert({
  request,
  onDismiss,
}: WorktreeRemovalAlertProps) {
  const { removeWorktree } = useAppShell();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  const remove = () => {
    if (busy) return;
    setBusy(true);
    setFailure(undefined);
    void removeWorktree(request.workspaceId).then(
      onDismiss,
      (error: unknown) => {
        setBusy(false);
        setFailure(toAppError(error).summary);
      },
    );
  };

  return (
    <Alert
      tone="danger"
      title={`Remove the worktree ${request.label}?`}
      message={
        request.branch
          ? `Its folder is deleted. The branch ${request.branch} is kept, and so is everything committed to it.`
          : "Its folder is deleted. Nothing is done to any branch."
      }
      onCancel={onDismiss}
      actions={[
        { label: "Cancel", run: onDismiss, disabled: busy },
        {
          label: busy ? "Removing…" : "Remove",
          destructive: true,
          disabled: busy,
          run: remove,
        },
      ]}
    >
      {failure ? (
        <p className="mac-message" role="alert">
          {failure}
        </p>
      ) : null}
    </Alert>
  );
}
