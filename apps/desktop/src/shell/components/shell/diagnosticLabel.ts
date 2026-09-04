import type { CloseDiagnosticWire } from "../../../ipc/appShell";

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
      return "The editor did not answer the request to close. Closing again will close it anyway.";
    case "close_editor_vetoed":
      return "The editor has unsaved changes. Save or discard them, then close the workspace again.";
    case "cleanup_failed":
      return "A cleanup step did not finish.";
    case "runtime_unavailable":
      return "A runtime DevHub needs is unavailable.";
  }
}
