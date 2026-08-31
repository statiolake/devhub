import type {
  CloseDiagnosticWire,
  DisabledReasonWire,
} from "../../../ipc/appShell";

/** Product copy for Rust-owned disabled reasons; wire codes never reach UI. */
export const disabledReasonCopy: Readonly<Record<DisabledReasonWire, string>> =
  {
    "global-agent-not-applicable":
      "Select an Agent to open its control surface.",
    "workspace-agent-requires-agent-selection":
      "Select an Agent to open its control surface.",
    "workspace-unavailable": "This workspace is unavailable.",
    "workspace-closing": "This workspace is closing.",
    "workspace-closing-failed":
      "This workspace could not close cleanly. Retry close to continue.",
  };

export function disabledReasonLabel(reason: DisabledReasonWire): string {
  return disabledReasonCopy[reason];
}

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
      return "The editor is not running, so DevHub could not check it for unsaved changes.";
    case "close_editor_vetoed":
      return "The editor has unsaved changes. Save or discard them, then close the workspace again.";
    case "cleanup_failed":
      return "A cleanup step did not finish.";
    case "runtime_unavailable":
      return "A runtime DevHub needs is unavailable.";
  }
}
