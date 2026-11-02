import type {
  AgentSnapshot,
  EditorAttachmentWire,
  WorkspaceLocationWire,
  WorkspaceSnapshot,
} from "../../../ipc/appShell";
import type { WorkspaceRepositoryWire } from "../../../ipc/contract";
import type { GlyphName } from "./icons";
import {
  PROJECT_SCOPE_HINT,
  projectsLabel,
} from "../../../model/projectStatus";
import { statusLabel } from "./status";
import { unreadShows } from "./StatusMark";
import {
  agentFailureLabel,
  closeDiagnosticLabel,
  closeFailureLabel,
} from "../shell/diagnosticLabel";

/**
 * What a row knows, as the sentence a screen reader is given for it: one fact
 * per line, in words.
 *
 * The composition rule is the row's own facts, in the order a person asks for
 * them: what it is, where it is, what it is a checkout of, what it is on, what
 * it is for, how it is going out, and which machine it is all happening on.
 */
function said(facts: readonly (string | undefined)[]): string[] {
  return facts.filter((fact): fact is string => fact !== undefined);
}

/** The sentence a screen reader is given: one fact per line. */
export function describe(facts: readonly string[]): string {
  return facts.join("\n");
}

/**
 * Which silhouette a Workspace wears: a folder, or a folder somewhere else.
 *
 * Two, where there were four. A repository and a worktree of one used to have
 * marks of their own, and the column paid for it twice: three silhouettes that
 * have to be told apart at thirteen pixels are three silhouettes a person has
 * to *learn*, and what they bought was a distinction — this checkout is a
 * worktree — that changes nothing about what the row is or what you can do to
 * it. Every Workspace is a folder you have open. Which kind of checkout it is
 * is in the row's facts, where it is a word rather than a shape.
 *
 * The one distinction that survives is *where*: a folder on another machine is
 * a different thing to open, a different thing to close and a different place
 * for an Agent to run, and it is the fact a person needs before any other. It
 * is also the only one this column can carry, being the only mark the rail
 * keeps.
 */
export function workspaceGlyphName(location: WorkspaceLocationWire): GlyphName {
  switch (location.kind) {
    case "local":
      return "folder";
    case "ssh":
      return "remote";
  }
}

/**
 * How a Workspace row introduces itself: its mark, and whether it can be
 * closed or moved.
 *
 * Scratch is today's daily folder, an ordinary Workspace (`scratchWorkspaceId`),
 * and this is the one place the page tells it apart. Its name is already
 * "Scratch" on the wire (main names it once); what the page adds is the
 * terminal in place of its folder's mark, and that it is neither closed nor
 * dragged — main refuses both, and a control main refuses is not drawn.
 * Everything else about it — its path, its branch, its Agents — is a Workspace
 * row's. Yesterday's folder is not Scratch any more and is any other row.
 */
export interface RowIdentity {
  readonly glyph: GlyphName;
  /** Scratch: always first, never closed, never dragged. */
  readonly fixed: boolean;
}

export function rowIdentity(
  workspace: WorkspaceSnapshot,
  scratchWorkspaceId: string,
): RowIdentity {
  return workspace.id === scratchWorkspaceId
    ? { glyph: "terminal", fixed: true }
    : { glyph: workspaceGlyphName(workspace.location), fixed: false };
}

/**
 * What a row's editor is in, said, or nothing when it is on the Workspace's
 * own machine.
 *
 * It is the *editor's* fact and says so: the Workspace's terminals and Agents
 * are where its folder is, and a line that read "in a dev container" would
 * tell the person their Agents were in there. The definition's name follows
 * only when the folder has several to choose from.
 */
export function editorAttachmentFact(
  editor: EditorAttachmentWire,
): string | undefined {
  switch (editor.kind) {
    case "host":
      return undefined;
    case "devContainer":
      return editor.label === undefined
        ? "editor in its dev container"
        : `editor in the ${editor.label} dev container`;
  }
}

/** The Issue, in full, for a reader who cannot see the mark beside it. */
export function issueLabel(
  issue: NonNullable<WorkspaceRepositoryWire["issue"]>,
): string {
  return `Issue #${String(issue.number)}, ${issue.state}: ${issue.title}`;
}

/**
 * The Issue's Projects, in words: boards and lanes, or the one hint that the
 * token cannot read them. Undefined when there is nothing to say.
 */
export function issueProjectLine(
  issue: NonNullable<WorkspaceRepositoryWire["issue"]>,
): string | undefined {
  if (issue.projects?.length) return projectsLabel(issue.projects);
  return issue.projectsUnreadable ? PROJECT_SCOPE_HINT : undefined;
}

/** The pull request, in full. */
export function pullRequestLabel(
  pullRequest: NonNullable<WorkspaceRepositoryWire["pullRequest"]>,
): string {
  return `Pull request #${String(pullRequest.number)}, ${pullRequest.state}: ${pullRequest.title}`;
}

/**
 * A pull request's unresolved review conversations, in words — or nothing,
 * when there are none and none went uncounted.
 *
 * A count read from only the first page of threads says so, rather than being
 * drawn as the whole of it: "2 unresolved conversations" about a pull request
 * with two hundred threads, most of them never looked at, would be a number
 * that is merely what fitted.
 */
export function unresolvedConversationsText(
  conversations: NonNullable<
    WorkspaceRepositoryWire["pullRequest"]
  >["conversations"],
): string | undefined {
  const { unresolved, uncounted } = conversations;
  if (unresolved === 0 && uncounted === 0) return undefined;
  const counted = `${String(unresolved)} unresolved conversation${unresolved === 1 ? "" : "s"}`;
  return uncounted === 0
    ? counted
    : `${counted}, ${String(uncounted)} more not counted`;
}

/**
 * Whether the pull request mark carries the badge that says somebody is still
 * waiting on an answer in it: at least one conversation known to be unresolved.
 * One that went uncounted is not known to be, so it is said in words and not
 * drawn.
 */
export function hasUnresolvedConversations(
  pullRequest: NonNullable<WorkspaceRepositoryWire["pullRequest"]>,
): boolean {
  return pullRequest.conversations.unresolved > 0;
}

type PullRequestChecks = NonNullable<
  NonNullable<WorkspaceRepositoryWire["pullRequest"]>["checks"]
>;

/** The badge each CI verdict worth a glance is drawn with. */
const CHECKS_GLYPH: Record<
  Exclude<PullRequestChecks["state"], "passing">,
  GlyphName
> = {
  failing: "checksFailing",
  pending: "checksPending",
};

/**
 * A pull request's CI, in words: the verdict, and how many of how many checks
 * earned it.
 *
 * The count is the checks in the verdict's own state — failing ones for a
 * failing rollup, unfinished ones for a pending one — because that is the
 * number somebody acts on. A passing rollup has nothing in it to act on, so it
 * says only how many reported. A verdict none of whose counts landed in its own
 * state (a rollup GitHub calls failing while every counted check is fine, say)
 * says the verdict alone rather than "0 of 12".
 */
export function checksText(checks: PullRequestChecks): string {
  const checksOf = (count: number) =>
    `${String(count)} check${count === 1 ? "" : "s"}`;
  switch (checks.state) {
    case "failing":
      return checks.failing === 0
        ? "CI: failing"
        : `CI: failing (${String(checks.failing)} of ${checksOf(checks.total)})`;
    case "pending":
      return checks.pending === 0
        ? "CI: pending"
        : `CI: pending (${String(checks.pending)} of ${checksOf(checks.total)})`;
    case "passing":
      return `CI: passing (${checksOf(checks.total)})`;
  }
}

/**
 * The badge the pull request mark wears for its CI, by glyph name — or none.
 *
 * None when nothing has reported, and none when everything passed: a passing
 * pull request is the ordinary case and the one that asks nothing, so a green
 * mark on every such row would be ink that is almost always there and so is
 * never read. A failure and a run still going are the two worth a glance; the
 * accessible name still says "passing" for the one that is.
 */
export function checksBadge(
  pullRequest: NonNullable<WorkspaceRepositoryWire["pullRequest"]>,
): GlyphName | undefined {
  const checks = pullRequest.checks;
  if (checks === undefined || checks.state === "passing") return undefined;
  return CHECKS_GLYPH[checks.state];
}

/**
 * The pull request, as facts: the pull request itself, then its unresolved
 * conversations when it has any, then its CI when anything has reported. One
 * list, used by the row's description and by the pull request mark's own
 * accessible name, so the two cannot come to say differently.
 */
export function pullRequestFacts(
  pullRequest: NonNullable<WorkspaceRepositoryWire["pullRequest"]>,
): string[] {
  return said([
    pullRequestLabel(pullRequest),
    unresolvedConversationsText(pullRequest.conversations),
    pullRequest.checks === undefined
      ? undefined
      : checksText(pullRequest.checks),
  ]);
}

/** Why the row cannot say what it is working on, in the words the row draws. */
export function unavailableText(
  unavailable: NonNullable<WorkspaceRepositoryWire["unavailable"]>,
): string {
  return unavailable.number === undefined
    ? unavailable.reason
    : `#${String(unavailable.number)} · ${unavailable.reason}`;
}

/** The page a repository mark leads to, as it would be written down. */
function repositoryPage(url: string): string {
  return url.replace(/^https:\/\//, "");
}

/**
 * Which mark a pull request wears, by what became of it.
 *
 * Four states, four of GitHub's own drawings — there is no state here that has
 * to be told from another by colour, which is what lets the whole column go
 * grey at rest. See `icons.tsx`.
 */
export function pullRequestGlyphName(
  state: NonNullable<WorkspaceRepositoryWire["pullRequest"]>["state"],
): GlyphName {
  return PULL_REQUEST_GLYPH[state];
}

const PULL_REQUEST_GLYPH: Record<
  NonNullable<WorkspaceRepositoryWire["pullRequest"]>["state"],
  GlyphName
> = {
  open: "pullRequest",
  draft: "pullRequestDraft",
  closed: "pullRequestClosed",
  merged: "pullRequestMerged",
};

export function workspaceRowFacts(
  workspace: WorkspaceSnapshot,
  repository: WorkspaceRepositoryWire | undefined,
): string[] {
  const closeFailed =
    workspace.close.kind === "failed" ? workspace.close : undefined;
  const issue = repository?.issue;
  const pullRequest = repository?.pullRequest;
  return said([
    // What it is.
    `${workspace.label} workspace`,
    // Where it is. The path is the one fact a row never draws and always has,
    // because two workspaces with the same folder name are told apart by
    // nothing else.
    //
    // `displayRoot` and not `root`: the same folder, written the way the person
    // whose folder it is writes it, with their home directory as `~`. Which
    // home that is, is main's to know — a Workspace on a host is under that
    // machine's home — so the page reads the answer and never computes one. See
    // `WorkspaceWire.displayRoot`.
    `path ${workspace.displayRoot}`,
    // A close that stopped. Said and not only drawn: the row's colour is what a
    // sighted reader gets, and this is the same statement for everyone else.
    closeFailed
      ? `close failed: ${closeFailureLabel(closeFailed.step, closeFailed.diagnostic, closeFailed.detail)}`
      : undefined,
    // What its own terminals are doing, when there is anything to say. The
    // mark on the row is the Agents' (`StatusMark`); this is the same fact for
    // a reader, and for the rail, where the mark is not drawn.
    workspace.terminals === undefined
      ? undefined
      : workspace.terminals.status === "working"
        ? "terminal working"
        : "terminal finished, unread",
    // What it is a checkout of.
    repository?.repositoryUrl === undefined
      ? undefined
      : `repository ${repositoryPage(repository.repositoryUrl)}`,
    // That this checkout is a worktree, and of what.
    repository?.mainWorktree !== undefined &&
    repository.worktree !== undefined &&
    repository.worktree !== repository.mainWorktree
      ? `worktree of ${repository.mainWorktree}`
      : undefined,
    // What it is on.
    repository?.branch === undefined
      ? undefined
      : repository.unborn
        ? `branch ${repository.branch}, no commits yet`
        : `branch ${repository.branch}`,
    // What it is for, and how it is going out.
    issue ? issueLabel(issue) : undefined,
    issue ? issueProjectLine(issue) : undefined,
    ...(pullRequest ? pullRequestFacts(pullRequest) : []),
    repository?.pending
      ? `reading #${String(repository.pending.number)}`
      : undefined,
    // Why it cannot say what it is working on.
    repository?.unavailable
      ? unavailableText(repository.unavailable)
      : undefined,
    // Which machine all of it is happening on, when it is not this one.
    workspace.location.kind === "ssh"
      ? `on ${workspace.location.host}`
      : undefined,
    // Where the editor is, when it is not on the Workspace's machine.
    editorAttachmentFact(workspace.editor),
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
 * The row draws it and the sentence says it, from here, so the two cannot
 * disagree about what stopped.
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

export function agentRowFacts(
  agent: AgentSnapshot,
  /** The Workspace this Agent is in, for the fact that says which. */
  owner?: { readonly label: string },
): string[] {
  const note = agentNote(agent);
  const unread = unreadShows(agent.status, agent.unread);
  return said([
    agent.displayName,
    // What it is doing. Unread is part of this fact and not a fact of its own:
    // it only means anything while the Agent is idle, and then it *is* the
    // status. See `unreadShows`.
    unread
      ? `${statusLabel(agent.status)} agent, unread`
      : `${statusLabel(agent.status)} agent`,
    // What it says it is doing, in its own words.
    agent.activity,
    // Why it may not be doing what its status says.
    note,
    owner?.label,
  ]);
}

export function agentRowDescription(
  agent: AgentSnapshot,
  owner?: { readonly label: string },
): string {
  return describe(agentRowFacts(agent, owner));
}
