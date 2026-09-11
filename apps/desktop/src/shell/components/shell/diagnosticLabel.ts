import type { CloseDiagnosticWire, CloseStepWire } from "../../../ipc/appShell";

/**
 * Why a workspace is in the state it is in.
 *
 * The same vocabulary the sidebar's inspection uses, so a reason reads the
 * same wherever it is shown.
 */
export function closeDiagnosticLabel(diagnostic: CloseDiagnosticWire): string {
  switch (diagnostic) {
    case "root_missing":
      return "The workspace folder is missing.";
    case "root_inaccessible":
      return "The workspace folder cannot be read.";
    case "close_agents_unknown":
      return "DevHub could not confirm the agents had stopped.";
    case "close_terminal_unknown":
      return "DevHub could not confirm the terminal had closed.";
    case "close_editor_unknown":
      return "DevHub could not check the editor for unsaved changes.";
    case "close_editor_starting":
      return "The editor had not finished starting, so DevHub could not check it for unsaved changes.";
    case "close_editor_unresponsive":
      return "The editor did not answer the request to close.";
    case "close_editor_vetoed":
      return "The editor has unsaved changes. Save or discard them, then close the workspace again.";
    case "cleanup_failed":
      return "A cleanup step did not finish.";
    case "runtime_unavailable":
      return "A runtime DevHub needs is unavailable.";
  }
}

/** What each step of a close was doing, in the words a person would use. */
function closeStepLabel(step: CloseStepWire): string {
  switch (step) {
    case "editor":
      return "asking the editor to close";
    case "agents":
      return "stopping the agents";
    case "terminal":
      return "closing the terminal";
    case "view":
      return "closing the editor window";
    case "worktree":
      return "removing the worktree folder";
    case "state":
      return "saving DevHub's state";
  }
}

/**
 * What a close that stopped has to say: the step, and why it stopped.
 *
 * One sentence, built in one place, so the row and the pane cannot describe
 * the same failure differently. Naming the step is the point — every step
 * reports the same handful of diagnostics, and "a cleanup step did not finish"
 * on its own never said which.
 */
export function closeFailureLabel(
  step: CloseStepWire,
  diagnostic: CloseDiagnosticWire,
): string {
  return `Closing stopped while ${closeStepLabel(step)}. ${closeDiagnosticLabel(diagnostic)}`;
}
