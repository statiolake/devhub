import type { AgentSnapshot, WorkspaceSnapshot } from "../../../ipc/appShell";
import type { WorkspaceRepositoryWire } from "../../../ipc/contract";
import { statusLabel } from "./status";
import {
  agentFailureLabel,
  closeDiagnosticLabel,
  closeFailureLabel,
} from "../shell/diagnosticLabel";

/**
 * What a row says, for anyone who is not reading the row itself.
 *
 * There is one sentence per row and two readers of it. A screen reader is
 * given it as the row's accessible name, and the collapsed rail is given the
 * same string as the pointer's tooltip — because the rail is in exactly the
 * position a screen reader is always in: the words are off, the glyph is all
 * there is, and the only way to ask which row this is is to ask for its name.
 *
 * They are one function and not two so that they cannot drift. Two
 * compositions of the same facts is how a row ends up naming its Issue to one
 * reader and not the other, and neither reader can tell that they did.
 *
 * The composition rule is the row's own drawing: **one line per line the
 * expanded row draws, in the order it draws them, joined with a newline; the
 * marks on a line become the words they would have been read as, joined with
 * a comma.** A line the row does not draw is a line the sentence does not
 * have — so a plain folder's name is one line, and a worktree with an Issue
 * and a pull request is three. `title` honours the newlines; the accessible
 * name computation folds them into spaces, which is the same sentence.
 */
function describe(lines: readonly (string | undefined)[]): string {
  return lines.filter((line) => line !== undefined).join("\n");
}

function clause(parts: readonly (string | undefined)[]): string | undefined {
  const said = parts.filter((part) => part !== undefined);
  return said.length > 0 ? said.join(", ") : undefined;
}

/**
 * The Issue mark, as the words it stands for: which Issue, and what became of
 * it. The mark's own tooltip says exactly this, because it is the same
 * question — *which Issue is this* — asked by a pointer instead of a reader.
 *
 * The title is not in it. The mark sits on the line the title is written on,
 * so a sentence that repeated it would be saying the row's own words back; the
 * mark's `aria-label` carries the title for the reader who has no line to read.
 */
export function issueMark(
  issue: NonNullable<WorkspaceRepositoryWire["issue"]>,
): string {
  return `Issue #${String(issue.number)} (${issue.state})`;
}

/** The Issue mark, in full, for a reader who cannot see the line beside it. */
export function issueLabel(
  issue: NonNullable<WorkspaceRepositoryWire["issue"]>,
): string {
  return `Issue #${String(issue.number)}, ${issue.state}: ${issue.title}`;
}

/** The pull request mark, as the words it stands for. */
export function pullRequestMark(
  pullRequest: NonNullable<WorkspaceRepositoryWire["pullRequest"]>,
): string {
  return `Pull request #${String(pullRequest.number)} (${pullRequest.state})`;
}

/** The pull request mark, in full. */
export function pullRequestLabel(
  pullRequest: NonNullable<WorkspaceRepositoryWire["pullRequest"]>,
): string {
  return `Pull request #${String(pullRequest.number)}, ${pullRequest.state}: ${pullRequest.title}`;
}

/** Why the row cannot say what it is working on, in the words the row draws. */
export function unavailableText(
  unavailable: NonNullable<WorkspaceRepositoryWire["unavailable"]>,
): string {
  return unavailable.number === undefined
    ? unavailable.reason
    : `#${String(unavailable.number)} · ${unavailable.reason}`;
}

export function workspaceRowDescription(
  workspace: WorkspaceSnapshot,
  repository: WorkspaceRepositoryWire | undefined,
): string {
  const closeFailed =
    workspace.close.kind === "failed" ? workspace.close : undefined;
  return describe([
    // Line one: what the row is, and where. A close that stopped is said and
    // not only drawn — the row's colour is what a sighted reader gets, and
    // this is the same statement for everyone else.
    `${workspace.label} workspace, path ${workspace.root}${
      closeFailed
        ? `, close failed: ${closeFailureLabel(closeFailed.step, closeFailed.diagnostic, closeFailed.detail)}`
        : ""
    }`,
    // Line two: the machine, when it is not this one, and the branch.
    clause([
      workspace.location.kind === "ssh"
        ? `on ${workspace.location.host}`
        : undefined,
      repository?.branch === undefined
        ? undefined
        : `branch ${repository.branch}`,
    ]),
    // Line three: what the branch is working on.
    clause([
      repository?.issue ? issueMark(repository.issue) : undefined,
      repository?.pullRequest
        ? pullRequestMark(repository.pullRequest)
        : undefined,
      repository?.issue?.title ?? repository?.pullRequest?.title,
      repository?.pending
        ? `reading #${String(repository.pending.number)}`
        : undefined,
      repository?.unavailable
        ? unavailableText(repository.unavailable)
        : undefined,
    ]),
  ]);
}

function runtimeHealthLabel(health: AgentSnapshot["runtimeHealth"]): string {
  switch (health) {
    case "starting":
      return "Starting runtime";
    case "degraded":
      return "Runtime needs attention";
    case "unavailable":
      return "Runtime unavailable";
    case "failed":
      return "Runtime unavailable";
    case "healthy":
      return "Connected";
  }
}

/**
 * Why this Agent may not be doing what its status says.
 *
 * The row draws it on its second line and the sentence says it, from here, so
 * the two cannot disagree about what stopped.
 */
export function agentNote(agent: AgentSnapshot): string | undefined {
  const control = agent.controlState;
  if (control.kind === "stopping") return "Stopping";
  if (control.kind === "stop-failed")
    return closeDiagnosticLabel(control.diagnostic);
  if (agent.failure) return agentFailureLabel(agent.failure);
  return agent.runtimeHealth === "healthy"
    ? undefined
    : runtimeHealthLabel(agent.runtimeHealth);
}

export function agentRowDescription(agent: AgentSnapshot): string {
  // One line, because an Agent row's own name is one line: the status glyph,
  // the unread dot and the activity are all on it, and its second line is the
  // name and the note this sentence already leads with.
  return `${agent.displayName}, ${statusLabel(agent.status)} agent, ${
    agentNote(agent) ?? runtimeHealthLabel(agent.runtimeHealth)
  }${agent.unread ? ", unread" : ""}${agent.activity ? `, ${agent.activity}` : ""}`;
}
