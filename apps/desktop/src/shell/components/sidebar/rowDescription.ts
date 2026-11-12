import type {
  AgentSnapshot,
  WorkspaceLocationWire,
  WorkspaceSnapshot,
} from "../../../ipc/appShell";
import type {
  AgentOrchestrationWire,
  TooltipFactLineWire,
  TooltipLineWire,
  WorkspaceRepositoryWire,
} from "../../../ipc/contract";
import type { GlyphName } from "./icons";
import {
  PROJECT_SCOPE_HINT,
  projectsTooltip,
} from "../../../model/projectStatus";
import { agentLeadingText } from "../../../model/domain";
import { TASK_STATUS_WORDS } from "../../../model/tasks";
import { statusLabel } from "./status";
import { isGitHubPage } from "../../githubPage";
import { unreadShows } from "./StatusMark";
import {
  agentFailureLabel,
  closeDiagnosticLabel,
  closeFailureLabel,
} from "../shell/diagnosticLabel";

/**
 * What a row knows, as a list of facts — for everyone who is not reading the
 * row itself.
 *
 * There are two such readers and they want the same facts in different forms. A
 * screen reader is given the row's accessible name and needs the words: it
 * cannot see a mark, so *branch* has to be said. The pointer is given the
 * tooltip and needs the opposite: it can see the mark, it is looking at a list
 * of workspaces, and a tooltip that read "widget workspace, path
 * /projects/widget, branch main" spent three quarters of its ink on label words
 * naming the categories of facts a person had already recognised.
 *
 * So there is one list of facts and two renderings of it. `describe` turns the
 * list into the sentence a reader hears — `spoken` where a fact has words of
 * its own, the fact itself where the fact *is* the words. `tooltipLines` turns
 * the same list into the lines the tooltip page draws, each behind the same
 * mark the row would have drawn. Neither is composed twice, which is how a row
 * used to end up naming its Issue to one reader and not the other with nobody
 * able to tell.
 *
 * The composition rule is the row's own facts, in the order a person asks for
 * them: what it is, where it is, what it is a checkout of, what it is on, what
 * it is for, how it is going out, and which machine it is all happening on.
 */
export interface RowFact {
  /** The mark this fact is drawn behind, by name. Never a drawing. */
  readonly icon?: GlyphName;
  /** The fact itself, in the words the row would draw. */
  readonly text: string;
  /**
   * What a reader is told instead, where the mark carries what the words would
   * have been. Absent when the fact already says itself.
   */
  readonly spoken?: string;
  readonly style?: TooltipFactLineWire["style"];
  readonly tone?: TooltipFactLineWire["tone"];
  /**
   * The GitHub page this fact names, for the tooltip to link: the repository,
   * the Issue, the pull request. Only ever a `https://github.com/` page
   * (`gitHubHref`); the spoken sentence has no use for it.
   */
  readonly href?: string;
  /** Subdued words after the fact, on its line (`TooltipFactLineWire`). */
  readonly qualifier?: string;
  /** An absolute path the text names, for the box's copy button. */
  readonly copy?: string;
  /** An absolute path the qualifier names, for a copy button after it. */
  readonly qualifierCopy?: string;
  /** How that path is written in the qualifier: the button follows it. */
  readonly qualifierCopyAfter?: string;
}

/** A URL as a tooltip link, when it is a GitHub page; nothing otherwise. */
function gitHubHref(url: string): { readonly href?: string } {
  return isGitHubPage(url) ? { href: url } : {};
}

function said(facts: readonly (RowFact | undefined)[]): RowFact[] {
  return facts.filter((fact): fact is RowFact => fact !== undefined);
}

/** The sentence a screen reader is given: one fact per line, in words. */
export function describe(facts: readonly RowFact[]): string {
  return facts.map((fact) => fact.spoken ?? fact.text).join("\n");
}

/** The same facts, as the tooltip page draws them. */
export function tooltipLines(facts: readonly RowFact[]): TooltipLineWire[] {
  return facts.map((fact) => ({
    ...(fact.icon === undefined ? {} : { icon: fact.icon }),
    text: fact.text,
    ...(fact.style === undefined ? {} : { style: fact.style }),
    ...(fact.tone === undefined ? {} : { tone: fact.tone }),
    ...(fact.href === undefined ? {} : { href: fact.href }),
    ...(fact.qualifier === undefined ? {} : { qualifier: fact.qualifier }),
    ...(fact.copy === undefined ? {} : { copy: fact.copy }),
    ...(fact.qualifierCopy === undefined
      ? {}
      : { qualifierCopy: fact.qualifierCopy }),
    ...(fact.qualifierCopyAfter === undefined
      ? {}
      : { qualifierCopyAfter: fact.qualifierCopyAfter }),
  }));
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
 * is in the row's facts, where it is a word rather than a shape — a line in
 * the row's tooltip behind the `worktree` and `repository` marks, which are
 * drawn there and nowhere on the row.
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

/** The Issue, as the row draws it: which one, and what it is called. */
export function issueMark(
  issue: NonNullable<WorkspaceRepositoryWire["issue"]>,
): string {
  return `#${String(issue.number)} ${issue.title}`;
}

/** The Issue, in full, for a reader who cannot see the mark beside it. */
export function issueLabel(
  issue: NonNullable<WorkspaceRepositoryWire["issue"]>,
): string {
  return `Issue #${String(issue.number)}, ${issue.state}: ${issue.title}`;
}

/**
 * Which repository the Issue is in, as `owner/name`, for its tooltip.
 *
 * The repository the workspace numbers its Issues in (`issueRepository`) when
 * main said, and otherwise what the Issue's own GitHub URL names. Undefined
 * when neither says — a number with a guessed repository is a wrong link.
 */
export function issueRepositoryName(
  repository: WorkspaceRepositoryWire | undefined,
  issue: NonNullable<WorkspaceRepositoryWire["issue"]>,
): string | undefined {
  const named = repository?.issueRepository;
  if (named !== undefined) return `${named.owner}/${named.repository}`;
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\//u.exec(
    issue.url,
  );
  return match === null ? undefined : `${match[1]}/${match[2]}`;
}

/**
 * The Issue's Projects line for a tooltip: boards and lanes, or the one hint
 * that the token cannot read them. Undefined when there is nothing to say.
 */
export function issueProjectLine(
  issue: NonNullable<WorkspaceRepositoryWire["issue"]>,
): string | undefined {
  if (issue.projects?.length) return projectsTooltip(issue.projects);
  return issue.projectsUnreadable ? PROJECT_SCOPE_HINT : undefined;
}

/** The pull request, as the row draws it. */
export function pullRequestMark(
  pullRequest: NonNullable<WorkspaceRepositoryWire["pullRequest"]>,
): string {
  return `#${String(pullRequest.number)} ${pullRequest.title}`;
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

/** The mark each CI verdict is drawn with, in a tooltip line and as a badge. */
const CHECKS_GLYPH: Record<PullRequestChecks["state"], GlyphName> = {
  passing: "checksPassing",
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
 * tooltip still says "passing" for the one that is.
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
 * list, used by the row's tooltip and by the pull request mark's own, so the
 * two cannot come to say differently. The order is the badges' own, top-right
 * before bottom-right.
 */
export function pullRequestFacts(
  pullRequest: NonNullable<WorkspaceRepositoryWire["pullRequest"]>,
): RowFact[] {
  const conversations = unresolvedConversationsText(pullRequest.conversations);
  return said([
    {
      icon: PULL_REQUEST_GLYPH[pullRequest.state],
      text: pullRequestMark(pullRequest),
      spoken: pullRequestLabel(pullRequest),
      style: "muted",
      ...gitHubHref(pullRequest.url),
    },
    conversations === undefined
      ? undefined
      : { icon: "conversation", text: conversations, style: "muted" },
    pullRequest.checks === undefined
      ? undefined
      : {
          icon: CHECKS_GLYPH[pullRequest.checks.state],
          text: checksText(pullRequest.checks),
          style: "muted",
        },
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

/**
 * The repository the Issue is numbered in, as `owner/name`, when it is not the
 * checkout's own repository; undefined when it is, or when nothing says.
 */
function issueRepositoryElsewhere(
  repository: WorkspaceRepositoryWire | undefined,
  issue: NonNullable<WorkspaceRepositoryWire["issue"]>,
): string | undefined {
  const name = issueRepositoryName(repository, issue);
  if (name === undefined) return undefined;
  const own = repository?.repositoryUrl;
  return own !== undefined &&
    repositoryPage(own).toLowerCase() === `github.com/${name}`.toLowerCase()
    ? undefined
    : name;
}

/**
 * A path on the Workspace's machine, written the way its own path is.
 *
 * Which home directory is `~` is main's to know (`WorkspaceWire.displayRoot`),
 * so it is read off the one answer main gave: where `displayRoot` is `~/…`,
 * the home is `root` with that tail taken off, and a path under that home is
 * written with `~` too. Anything else is written as it is.
 */
export function writtenLikeRoot(
  workspace: Pick<WorkspaceSnapshot, "root" | "displayRoot">,
  path: string,
): string {
  const { root, displayRoot } = workspace;
  if (displayRoot !== "~" && !displayRoot.startsWith("~/")) return path;
  const tail = displayRoot.slice(1);
  if (!root.endsWith(tail)) return path;
  const home = root.slice(0, root.length - tail.length);
  if (home === "" || home === "/") return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** The page a repository mark leads to, as it would be written down. */
function repositoryPage(url: string): string {
  return url.replace(/^https:\/\//, "");
}

const ISSUE_GLYPH: Record<
  NonNullable<WorkspaceRepositoryWire["issue"]>["state"],
  GlyphName
> = { open: "issueOpen", closed: "issueClosed" };

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
): RowFact[] {
  const closeFailed =
    workspace.close.kind === "failed" ? workspace.close : undefined;
  const issue = repository?.issue;
  const pullRequest = repository?.pullRequest;
  // The checkout this folder is a worktree of, when it is one and that is
  // somewhere else.
  const mainCheckout =
    repository?.mainWorktree !== undefined &&
    repository.worktree !== undefined &&
    repository.worktree !== repository.mainWorktree &&
    repository.mainWorktree !== workspace.root
      ? repository.mainWorktree
      : undefined;
  // Where it is, when that is not simply a folder on this Mac: said beside
  // the name in the heading, subdued, rather than as lines of their own.
  const whereabouts = [
    workspace.location.kind === "ssh"
      ? `SSH: ${workspace.location.host}`
      : undefined,
  ].filter((part): part is string => part !== undefined);
  const spokenWhereabouts = [
    workspace.location.kind === "ssh"
      ? `on ${workspace.location.host}`
      : undefined,
  ].filter((part): part is string => part !== undefined);
  return said([
    // What it is. The name, and it is the only fact in the list that is set as
    // one — everything under it qualifies it.
    {
      text: workspace.label,
      spoken: [`${workspace.label} workspace`, ...spokenWhereabouts].join(", "),
      style: "name",
      ...(whereabouts.length === 0
        ? {}
        : { qualifier: `· ${whereabouts.join(" · ")}` }),
    },
    // What it is a checkout of, and the link to it: the folder glyph is an
    // inert mark, so this line is the way to the repository on GitHub. First
    // after the name, before the path.
    repository?.repositoryUrl === undefined
      ? undefined
      : {
          icon: "repository",
          text: repositoryPage(repository.repositoryUrl),
          spoken: `repository ${repositoryPage(repository.repositoryUrl)}`,
          style: "muted",
          ...gitHubHref(repository.repositoryUrl),
        },
    // Where it is. The path is the one fact a row never draws and always has,
    // because two workspaces with the same folder name are told apart by
    // nothing else.
    //
    // `displayRoot` and not `root`: the same folder, written the way the person
    // whose folder it is writes it, with their home directory as `~`. Which
    // home that is, is main's to know — a Workspace on a host is under that
    // machine's home — so the page reads the answer and never computes one. See
    // `WorkspaceWire.displayRoot`.
    //
    // One path line. A worktree says what it was cut from on the same line,
    // subdued — "(worktree of ~/src/widget)" — written with `~` the way this
    // folder's path is, so the box never holds two bare paths for a reader to
    // tell apart. Each path carries its absolute form for the box's copy
    // button, drawn inline right after the path it copies.
    {
      text: workspace.displayRoot,
      spoken:
        mainCheckout === undefined
          ? `path ${workspace.displayRoot}`
          : `path ${workspace.displayRoot}, worktree of ${writtenLikeRoot(workspace, mainCheckout)}`,
      style: "muted",
      copy: workspace.root,
      ...(mainCheckout === undefined
        ? {}
        : {
            qualifier: `(worktree of ${writtenLikeRoot(workspace, mainCheckout)})`,
            qualifierCopy: mainCheckout,
            // The copy button sits right after the path it copies, inside the
            // bracket, rather than after the bracket.
            qualifierCopyAfter: writtenLikeRoot(workspace, mainCheckout),
          }),
    },
    // A close that stopped. Said and not only drawn: the row's colour is what a
    // sighted reader gets, and this is the same statement for everyone else.
    //
    // Labelled with what the row's × does about it now, which used to be the
    // ×'s own hover and is the row's to say: the × has none.
    closeFailed
      ? {
          icon: "statusError",
          text: `Retry close: ${closeFailureLabel(
            closeFailed.step,
            closeFailed.diagnostic,
            closeFailed.detail,
          )}`,
          spoken: `close failed: ${closeFailureLabel(closeFailed.step, closeFailed.diagnostic, closeFailed.detail)}`,
          style: "danger",
        }
      : undefined,
    // What its own terminals are doing, when there is anything to say. The
    // mark on the row is the Agents' (`StatusMark`); this is the same fact for
    // a reader and for the rail, where the mark is not drawn.
    workspace.terminals === undefined
      ? undefined
      : workspace.terminals.status === "working"
        ? {
            icon: "statusWorking",
            text: "A command is running in a terminal",
            spoken: "terminal working",
            tone: "working",
          }
        : {
            icon: "statusUnread",
            text: "A terminal command finished",
            spoken: "terminal finished, unread",
            tone: "idle",
          },
    // What it is on.
    repository?.branch === undefined
      ? undefined
      : {
          icon: "branch",
          text: repository.unborn
            ? `${repository.branch} · empty`
            : repository.branch,
          spoken: repository.unborn
            ? `branch ${repository.branch}, no commits yet`
            : `branch ${repository.branch}`,
          style: "muted",
        },
    // What it is for, and how it is going out.
    issue
      ? {
          icon: ISSUE_GLYPH[issue.state],
          text: issueMark(issue),
          spoken: issueLabel(issue),
          style: "muted",
          ...gitHubHref(issue.url),
        }
      : undefined,
    // Which repository the Issue is numbered in, when that is not the
    // checkout's own — an upstream's Issues, say. The same repository twice
    // would be one fact on two lines.
    issue && issueRepositoryElsewhere(repository, issue) !== undefined
      ? {
          icon: "repository",
          text: `Issue in ${issueRepositoryElsewhere(repository, issue) as string}`,
          style: "muted",
        }
      : undefined,
    issue && issueProjectLine(issue) !== undefined
      ? {
          icon: "project",
          text: issueProjectLine(issue) as string,
          style: "muted",
        }
      : undefined,
    ...(pullRequest ? pullRequestFacts(pullRequest) : []),
    repository?.pending
      ? {
          text: `Reading #${String(repository.pending.number)}`,
          spoken: `reading #${String(repository.pending.number)}`,
          style: "muted",
        }
      : undefined,
    // Why it cannot say what it is working on.
    repository?.unavailable
      ? {
          icon: "statusError",
          text: `Unavailable: ${unavailableText(repository.unavailable)}`,
          spoken: `issue unavailable: ${unavailableText(repository.unavailable)}`,
          style: "danger",
        }
      : undefined,
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

const STATUS_GLYPH: Record<AgentSnapshot["status"], GlyphName> = {
  working: "statusWorking",
  background: "statusBackground",
  waiting: "statusWaiting",
  idle: "statusIdle",
  error: "statusError",
  unknown: "statusUnknown",
};

export function agentRowFacts(
  agent: AgentSnapshot,
  /** The Workspace this Agent is in, for the fact that says which. */
  owner?: { readonly label: string; readonly icon: GlyphName },
): RowFact[] {
  const note = agentNote(agent);
  const unread = unreadShows(agent.status, agent.unread);
  return said([
    { text: agent.displayName, style: "name" },
    // What it is doing, in its own colour — the one coloured thing anywhere in
    // this window, and the reason a person looked at the row at all. Unread is
    // part of this fact and not a fact of its own: it only means anything while
    // the Agent is idle, and then it *is* the status. See `unreadShows`.
    {
      icon: unread ? "statusUnread" : STATUS_GLYPH[agent.status],
      text: unread
        ? `${statusLabel(agent.status)} · unread`
        : statusLabel(agent.status),
      spoken: unread
        ? `${statusLabel(agent.status)} agent, unread`
        : `${statusLabel(agent.status)} agent`,
      tone: agent.unread !== undefined && unread ? agent.unread : agent.status,
    },
    // What it says it is doing, in its own words.
    agent.activity === undefined
      ? undefined
      : { text: agent.activity, style: "muted" },
    // Why it may not be doing what its status says.
    note === undefined ? undefined : { text: note, style: "note" },
    owner === undefined
      ? undefined
      : { icon: owner.icon, text: owner.label, style: "muted" },
  ]);
}

export function agentRowDescription(
  agent: AgentSnapshot,
  owner?: { readonly label: string; readonly icon: GlyphName },
): string {
  return describe(agentRowFacts(agent, owner));
}

/**
 * The one fact an Agent's tooltip is: its mark, and what the row leads with —
 * and, for an Agent somebody named, what the row says after its name.
 *
 * A Workspace's tooltip is a list because a Workspace *has* a list of facts a
 * person cannot see on the row — the path, the branch, the Issue, the machine.
 * An Agent has none of that. Its tooltip drew the status in words beside the
 * mark that already says it, the note the row already draws, and the Workspace
 * whose row is directly above it, which between them made four lines out of a
 * row that has one thing to tell you: which Agent this is and what it is
 * doing. On the rail, where the tooltip is the only way to ask, the answer is
 * the row's own leading text — so that is the answer, behind the row's own
 * mark, and nothing else.
 *
 * The mark and its tone are the row's, taken from the same place
 * `agentRowFacts` takes them, so the box and the row cannot disagree about
 * what colour this Agent is. The text is the row's leading rule,
 * `agentLeadingText`: what it says it is doing, or its name when it has not
 * said anything yet — or the name, first, when a person gave it one. Then the
 * box carries the second thing too, dimmed, the way the row does: on the rail
 * the box is the only place left to read what a named Agent is doing, and a
 * tooltip that answered "Investigator" and stopped would have dropped the one
 * fact the row had and the rail did not.
 *
 * The spoken sentence is *not* cut down with it. A reader has no mark to look
 * at and no row to glance at either, so `agentRowFacts` stays as it was and
 * remains what the row's `aria-label` is composed from — the same facts, in
 * the form the reader who needs them can receive.
 */
export function agentTooltipFacts(
  agent: AgentSnapshot,
  orchestration?: AgentOrchestrationWire,
): RowFact[] {
  const unread = unreadShows(agent.status, agent.unread);
  return said([
    {
      icon: unread ? "statusUnread" : STATUS_GLYPH[agent.status],
      text: agentLeadingText(agent),
      tone: agent.unread !== undefined && unread ? agent.unread : agent.status,
    },
    agent.named === true && agent.activity !== undefined
      ? { text: agent.activity, style: "muted" }
      : undefined,
    agent.managed === true
      ? {
          icon: "orchestrator",
          text: "Managed by the orchestrator",
          style: "muted",
        }
      : undefined,
    // What the orchestration says of it: the task it is bound to (and its
    // status), and needing action (and the clause it fails).
    orchestration?.task === undefined
      ? undefined
      : {
          icon:
            orchestration.task.status === "waiting"
              ? "orchestratorWaiting"
              : "orchestrator",
          text: `Task #${String(orchestration.task.id)} (${TASK_STATUS_WORDS[orchestration.task.status]}): ${orchestration.task.title}`,
          style: "muted",
        },
    orchestration?.needsAction === undefined
      ? undefined
      : {
          icon: "orchestratorNeedsAction",
          text: `Needs action: ${orchestration.needsAction}`,
          tone: "waiting",
        },
    // Its own key/value pairs (`model/agentMeta.ts`), quietly, one a line:
    // somebody's notes about the Agent, never the row's business.
    ...Object.entries(agent.meta ?? {}).map(
      ([key, value]): RowFact => ({ text: `${key}: ${value}`, style: "muted" }),
    ),
    // A stop that failed, and what the row's × does about it now. It was the
    // ×'s own hover ("Retry stop"); the × has none, so the row says it.
    agent.controlState.kind === "stop-failed"
      ? {
          icon: "statusError",
          text: `Retry stop: ${closeDiagnosticLabel(agent.controlState.diagnostic)}`,
          style: "danger",
        }
      : undefined,
  ]);
}
