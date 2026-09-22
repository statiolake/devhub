import type {
  AgentSnapshot,
  WorkspaceLocationWire,
  WorkspaceSnapshot,
} from "../../../ipc/appShell";
import type {
  TooltipLineWire,
  WorkspaceRepositoryWire,
} from "../../../ipc/contract";
import type { GlyphName } from "./icons";
import { statusLabel } from "./status";
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
  readonly style?: TooltipLineWire["style"];
  readonly tone?: TooltipLineWire["tone"];
  /**
   * The page this fact names, for the reader who can click it.
   *
   * The one part of a fact that only the tooltip's rendering takes: a reader
   * is told the fact in words, and a person looking at the box is given the
   * same link the row itself draws, to the same page. It is the
   * row's own URL and never a second one built here, so the box and the row
   * cannot lead anywhere different.
   */
  readonly href?: string;
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
 * is in the row's facts, where it is a word rather than a shape, and the
 * `worktree` and `repository` drawings are still what GitHub's own link mark
 * and the close button's promise are built from.
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
    // A dev container is the same distinction the rail already keeps — the
    // work happens somewhere that is not here — so it takes the same slot
    // rather than adding a fourth thing to learn. It is a mark of its own and
    // not the `remote` racks because the two are not the same somewhere: one
    // is a machine the person has an account on, the other is a box built from
    // a file in this folder, and what you do when either stops answering is
    // different.
    case "container":
      return "container";
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
 * What a dev container is called, in a row's facts.
 *
 * The folder's name and never the container's id: an id is a hash that changes
 * on every rebuild, and a fact that changed whenever somebody rebuilt would be
 * a tooltip that says something new about a Workspace that did not move. The
 * folder is what `locationKey` keys on, for the same reason.
 *
 * The name and not the path. The path fact above already carries where this
 * Workspace is — the path *inside* the container — and this line answers a
 * different question: which folder of mine is this. A second full path would
 * be read as a correction of the first one.
 */
function containerName(workspaceFolder: string): string {
  const trimmed = workspaceFolder.replace(/\/+$/u, "");
  const cut = trimmed.lastIndexOf("/");
  const name = cut === -1 ? trimmed : trimmed.slice(cut + 1);
  return name.length === 0 ? workspaceFolder : name;
}

/**
 * Which silhouette the mark that links to GitHub wears.
 *
 * One, and it is the repository's: the link leads to a repository's page
 * whether this checkout is the main worktree or a worktree of it — a worktree
 * is not a separate thing on GitHub — so a second drawing here would be a
 * distinction the destination does not have.
 */
export function repositoryGlyphName(): GlyphName {
  return "repository";
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
  return said([
    // What it is. The name, and it is the only fact in the list that is set as
    // one — everything under it qualifies it.
    {
      text: workspace.label,
      spoken: `${workspace.label} workspace`,
      style: "name",
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
    {
      text: workspace.displayRoot,
      spoken: `path ${workspace.displayRoot}`,
      style: "muted",
    },
    // A close that stopped. Said and not only drawn: the row's colour is what a
    // sighted reader gets, and this is the same statement for everyone else.
    closeFailed
      ? {
          icon: "statusError",
          text: closeFailureLabel(
            closeFailed.step,
            closeFailed.diagnostic,
            closeFailed.detail,
          ),
          spoken: `close failed: ${closeFailureLabel(closeFailed.step, closeFailed.diagnostic, closeFailed.detail)}`,
          style: "danger",
        }
      : undefined,
    // What it is a checkout of, and where that page is.
    repository?.repositoryUrl === undefined
      ? undefined
      : {
          icon: repositoryGlyphName(),
          text: repositoryPage(repository.repositoryUrl),
          spoken: `repository ${repositoryPage(repository.repositoryUrl)}`,
          style: "muted",
          href: repository.repositoryUrl,
        },
    // That this checkout is a worktree, and of what. The row's own mark stopped
    // saying it — every Workspace is a folder there — and it is worth saying
    // once, here, where there is room for the repository it was cut from.
    repository?.mainWorktree !== undefined &&
    repository.worktree !== undefined &&
    repository.worktree !== repository.mainWorktree
      ? {
          icon: "worktree",
          text: repository.mainWorktree,
          spoken: `worktree of ${repository.mainWorktree}`,
          style: "muted",
        }
      : undefined,
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
          href: issue.url,
        }
      : undefined,
    pullRequest
      ? {
          icon: PULL_REQUEST_GLYPH[pullRequest.state],
          text: pullRequestMark(pullRequest),
          spoken: pullRequestLabel(pullRequest),
          style: "muted",
          href: pullRequest.url,
        }
      : undefined,
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
          text: unavailableText(repository.unavailable),
          style: "danger",
        }
      : undefined,
    // Which machine all of it is happening on, when it is not this one.
    workspace.location.kind === "ssh"
      ? {
          icon: "remote",
          text: `ssh:${workspace.location.host}`,
          spoken: `on ${workspace.location.host}`,
          style: "muted",
        }
      : undefined,
    // The same fact for a container: where the terminals and the Agents are.
    // Worth saying even though the row's mark says it too, because the mark
    // says *that* it is a container and this says *which* — and because the
    // path above is the path inside it, which is not a folder the person has.
    workspace.location.kind === "container"
      ? {
          icon: "container",
          text: `dev container: ${containerName(workspace.location.workspaceFolder)}`,
          spoken: `in a dev container for ${containerName(workspace.location.workspaceFolder)}`,
          style: "muted",
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
 * The one fact an Agent's tooltip is: its mark, and what the row leads with.
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
 * what colour this Agent is. The text is the row's leading rule from
 * `Sidebar.tsx`: what it says it is doing, or its name when it has not said
 * anything yet.
 *
 * The spoken sentence is *not* cut down with it. A reader has no mark to look
 * at and no row to glance at either, so `agentRowFacts` stays as it was and
 * remains what the row's `aria-label` is composed from — the same facts, in
 * the form the reader who needs them can receive.
 */
export function agentTooltipFacts(agent: AgentSnapshot): RowFact[] {
  const unread = unreadShows(agent.status, agent.unread);
  return [
    {
      icon: unread ? "statusUnread" : STATUS_GLYPH[agent.status],
      text: agent.activity ?? agent.displayName,
      tone: agent.unread !== undefined && unread ? agent.unread : agent.status,
    },
  ];
}
