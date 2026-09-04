/**
 * Closing a worktree that has something in it to lose.
 *
 * A worktree is a folder git made so that work could happen somewhere, so
 * closing the workspace deletes it — otherwise a machine fills up with
 * checkouts nobody can account for. That is only safe when there is nothing in
 * the folder to lose, which is why a *clean* worktree never reaches this sheet:
 * `closeWorkspaceOrWorktree` removes it without asking. Which rows are
 * worktrees at all is `closingDeletesWorktree`, read by main to decide this and
 * by the sidebar so its button can say what it is about to do.
 *
 * **Three answers, because there really are three.** A two-button dialog would
 * have had to drop one of them, and each of the three is something a person
 * genuinely means:
 *
 *   - keep the folder and just take the workspace off the sidebar,
 *   - delete it anyway, uncommitted work included,
 *   - do nothing.
 *
 * Cancel is first, and therefore what Return takes: it is the rule for every
 * question whose other answers destroy something. Escape means the same thing,
 * which is what a picker's Escape already means.
 *
 * It is a picker and not an alert, for the reason in `Picker`'s docstring:
 * every choice among options in DevHub is one control, so the keys are the same
 * keys wherever the question comes from. A confirmation is a list with three
 * rows and a default.
 */

import { Picker } from "../components/shell/Picker";
import { useAppShell } from "../useAppShell";

export interface WorktreeCloseSheetProps {
  readonly workspaceId: string;
  readonly label: string;
  readonly root: string;
  readonly branch?: string;
  /** Nothing when DevHub could not read the working tree at all. */
  readonly dirty?: boolean;
  readonly onDismiss: () => void;
}

export function WorktreeCloseSheet({
  workspaceId,
  label,
  root,
  branch,
  dirty,
  onDismiss,
}: WorktreeCloseSheetProps) {
  const { dispatch, removeWorktree, reportFailure } = useAppShell();

  return (
    <Picker
      title={`Close ${label}`}
      question={
        dirty === true
          ? `${label} is a worktree with uncommitted changes in it. What should happen to the folder?`
          : // Not knowing is not clean, and saying which of the two it is
            // matters: "there are changes" and "DevHub could not tell" lead to
            // different decisions.
            `${label} is a worktree, and DevHub could not tell whether there is anything uncommitted in it. What should happen to the folder?`
      }
      items={[
        {
          id: "cancel",
          label: "Cancel",
          detail: "Leave the workspace open.",
        },
        {
          id: "close",
          label: "Just close the workspace",
          detail: `Keep ${root} on disk.`,
        },
        {
          id: "delete",
          label: "Delete the worktree",
          detail: branch
            ? `Remove ${root} and everything uncommitted on ${branch}.`
            : `Remove ${root} and everything uncommitted in it.`,
        },
      ]}
      onChoose={({ id }) => {
        if (id === "close") {
          void dispatch({ type: "request_close_workspace", workspaceId });
        } else if (id === "delete") {
          // `--force` is the only way a worktree with uncommitted work can be
          // removed at all, and it is what this row says it will do. The close
          // that follows is `removeWorktree`'s own second half.
          void removeWorktree(workspaceId, true).catch(reportFailure);
        }
        onDismiss();
      }}
      onCancel={onDismiss}
    />
  );
}
