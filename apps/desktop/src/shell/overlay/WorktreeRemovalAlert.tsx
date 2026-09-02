/**
 * "Remove this worktree, and lose what is in it?"
 *
 * Only reached when there is something to lose. A worktree DevHub has seen to
 * be clean is removed straight from the row without asking, because that
 * question's answer was always yes and a question whose answer is always yes is
 * what teaches people to dismiss the ones that matter. What is left is the case
 * that is genuinely destructive — uncommitted work, or DevHub unable to say
 * there is none — and this is the question for it.
 *
 * So it names the folder as well as the label. Two worktrees of one repository
 * differ by one word in a sidebar and by their whole path on disk, and the path
 * is what a person can actually check before destroying one.
 *
 * Answering it removes the worktree with `--force`. That is the only way a
 * worktree with uncommitted changes comes out at all — git refuses otherwise,
 * and that refusal is exactly what makes the unasked removals safe.
 *
 * The question says what will happen to each of the two things involved: the
 * folder goes, the branch stays.
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
    // Forced, because this question is only asked when git would refuse — or
    // when DevHub cannot promise it would not.
    void removeWorktree(request.workspaceId, true).then(
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
      title={`Remove the worktree ${request.label}, with the changes in it?`}
      message={
        request.branch
          ? `${request.root} is deleted, and any uncommitted work in it is lost. The branch ${request.branch} is kept, and so is everything committed to it.`
          : `${request.root} is deleted, and any uncommitted work in it is lost. Nothing is done to any branch.`
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
