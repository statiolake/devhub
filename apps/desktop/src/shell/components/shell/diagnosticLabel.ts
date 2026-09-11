import type {
  AgentFailureStateWire,
  AgentFailureWire,
  CloseDiagnosticWire,
  CloseStepWire,
} from "../../../ipc/appShell";

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
 * What a close that stopped has to say: the step, why it stopped, and — when
 * the thing that refused had words of its own — those words.
 *
 * One sentence, built in one place, so the row and the pane cannot describe
 * the same failure differently. Naming the step is the point — every step
 * reports the same handful of diagnostics, and "a cleanup step did not finish"
 * on its own never said which.
 *
 * The detail is the tool's own last line, carried from main rather than
 * composed here or there. `cleanup_failed` is the whole vocabulary a step has
 * for "git refused", so without it a person reading the row learned that
 * something did not finish and never learned that git had told them exactly
 * what to do about it.
 */
export function closeFailureLabel(
  step: CloseStepWire,
  diagnostic: CloseDiagnosticWire,
  detail?: string,
): string {
  const said = detail?.trim();
  return `Closing stopped while ${closeStepLabel(step)}. ${closeDiagnosticLabel(diagnostic)}${
    said === undefined || said.length === 0 ? "" : ` ${said}`
  }`;
}

/** Why an operation on one Agent was refused, in the words a person would use. */
export function agentFailureSummary(code: AgentFailureWire): string {
  switch (code) {
    case "agent_runtime_unavailable":
      return "The Agent runtime could not be reached.";
    case "tmux_command_failed":
      return "The Agent runtime refused the request.";
    case "tmux_command_timed_out":
      return "The Agent runtime did not answer in time.";
    case "tmux_session_conflict":
      return "The session this Agent needs is not the one that is there.";
    case "agent_profile_unavailable":
      return "This Agent's profile cannot be used.";
    case "workspace_unavailable":
      return "The workspace this Agent belongs to is unavailable.";
  }
}

/**
 * What this Agent's pane and row say about the last refusal.
 *
 * One sentence, built in one place, for the same reason `closeFailureLabel`
 * is: the pane and the row must not describe one failure two ways.
 *
 * The two tmux codes are the one case where the detail *replaces* the summary
 * rather than following it. Their summaries say the runtime refused or fell
 * silent, and their details say which command it refused and what it said
 * about it — so the summary is the same sentence with the facts taken out, and
 * putting both on screen reads as a sentence that has been said twice. Every
 * other code's detail adds something the summary does not have, so every other
 * code keeps both. See `PortFailure` in `main/terminal/ports.ts` for what a
 * detail may hold.
 */
export function agentFailureLabel(failure: AgentFailureStateWire): string {
  const said = failure.detail?.trim();
  if (said === undefined || said.length === 0) {
    return agentFailureSummary(failure.code);
  }
  return failure.code === "tmux_command_failed" ||
    failure.code === "tmux_command_timed_out"
    ? said
    : `${agentFailureSummary(failure.code)} ${said}`;
}
