import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  type AgentProfile,
  type AgentProfilesAvailabilityWire,
  type AgentSnapshot,
  type AppIntent,
  type AppSnapshot,
  type WorkspaceLocationWire,
  type WorkspaceSnapshot,
} from "../../../ipc/appShell";
import { clampSidebarWidth } from "../../../ipc/appShell";
import { SCRATCH_NAME } from "../../../ipc/windowTitles";
import type { WorkspaceRepositoryWire } from "../../../ipc/contract";
import { closingDeletesWorktree } from "../../../model/worktrees";
import { useAppShell } from "../../useAppShell";
import { devhub } from "../../client";
import { isImeComposing } from "../../accessibility/ime";
import { Glyph, type GlyphName } from "./icons";
import { RowMenu, type RowMenuItem } from "./RowMenu";
import { focusMainSurface } from "../../focusHome";
import { SidebarHeader } from "./SidebarHeader";
import { StatusMark } from "./StatusMark";
import { statusLabel } from "./status";
import { mergeExitingRows, useClosingExit } from "./closingExit";
import {
  closeDiagnosticLabel,
  agentFailureLabel,
  closeFailureLabel,
} from "../shell/diagnosticLabel";

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

export interface SidebarProps {
  readonly snapshot: AppSnapshot;
  readonly onDispatch: (intent: AppIntent) => void;
}

function treeContextButtons(tree: HTMLElement): HTMLButtonElement[] {
  return [
    ...tree.querySelectorAll<HTMLButtonElement>(
      "[data-tree-item-id]:not([disabled])",
    ),
  ];
}

function setTreeTabStop(
  tree: HTMLElement,
  button: HTMLButtonElement | undefined,
): void {
  for (const item of treeContextButtons(tree)) {
    item.tabIndex = item === button ? 0 : -1;
  }
}

function WorkspaceRow({
  workspace,
  repository,
  snapshot,
  onDispatch,
  agentProfiles,
  agentProfilesAvailability,
  onCreateAgent,
  onCloseWorkspace,
  onRenameAgent,
  onAgentMenu,
}: {
  readonly workspace: WorkspaceSnapshot;
  /** What it is working on, as of the last look. Absent until the first one. */
  readonly repository: WorkspaceRepositoryWire | undefined;
  readonly snapshot: AppSnapshot;
  readonly onDispatch: (intent: AppIntent) => void;
  readonly agentProfiles: readonly AgentProfile[];
  readonly agentProfilesAvailability: AgentProfilesAvailabilityWire;
  readonly onCreateAgent: (workspaceId: string) => void;
  /**
   * Get rid of this workspace — and its folder, if the folder is a worktree.
   *
   * One prop where there were two buttons. The row used to offer a close *and*
   * a trash, so whether a worktree survived depended on which control you
   * happened to press; closing a worktree deletes it now, and what is asked is
   * decided in one place by whether there is anything in it to lose.
   */
  readonly onCloseWorkspace: (workspace: WorkspaceSnapshot) => void;
  readonly onRenameAgent: (agent: AgentSnapshot) => void;
  readonly onAgentMenu: (
    agent: AgentSnapshot,
    at: { x: number; y: number },
  ) => void;
}) {
  const selected =
    snapshot.selection.context.kind === "workspace" &&
    snapshot.selection.context.workspaceId === workspace.id;
  const selectedAgentId =
    snapshot.selection.context.kind === "agent"
      ? snapshot.selection.context.agentId
      : undefined;

  const dispatch = useCallback(
    (intent: AppIntent) => onDispatch(intent),
    [onDispatch],
  );

  // A Workspace on its way out takes no instructions. This is the view half
  // of a fact the model already enforces — a close that is running refuses the
  // operations underneath anyway — and it is here so that the refusal is never
  // something a person has to run into: the row goes quiet at the same moment
  // it stops being able to answer. It covers the Agents as well as the
  // Workspace because they are going with it.
  const closing = workspace.close.kind === "running";
  const closeFailed =
    workspace.close.kind === "failed" ? workspace.close : undefined;

  // What the close button is about to do, read from the same rule main uses to
  // decide it (`closingDeletesWorktree`). A second copy of the rule here is how
  // a button ends up promising a close and performing a deletion.
  const deletesWorktree = closingDeletesWorktree(repository, workspace.root);

  return (
    <li
      className={`sidebar-tree-item${closing ? " is-closing" : ""}`}
      role="treeitem"
      aria-level={1}
      aria-selected={selected}
      aria-busy={closing || undefined}
      // A Workspace is always open. The attribute states that, and there is
      // nothing that can change it.
      aria-expanded={workspace.agents.length > 0 ? true : undefined}
    >
      <div
        className={`sidebar-row workspace-row${selected ? " is-selected" : ""}`}
        data-state={workspace.state.kind}
      >
        <div className="row-head">
          <span className="row-rail" aria-hidden="true" />
          {/* Outside the row's own button, because when there is a GitHub page
              for this workspace the mark is the link to it, and a button
              cannot go inside a button. It keeps the glyph column either way:
              a folder and a repository start at the same pixel. */}
          <WorkspaceGlyph
            location={workspace.location}
            repository={repository}
          />
          <button
            className="sidebar-context-button"
            type="button"
            data-workspace-id={workspace.id}
            data-tree-item-id={`workspace:${workspace.id}`}
            // `disabled` and not merely un-clickable: the Sidebar's arrow-key
            // walk selects on `[data-tree-item-id]:not([disabled])`, so this
            // is also what takes a closing row out of the keyboard's path
            // instead of leaving a stop that goes nowhere.
            disabled={closing}
            tabIndex={selected && !closing ? 0 : -1}
            aria-current={selected ? "page" : undefined}
            // A Workspace has no status of its own. Its Agents each carry
            // theirs on their own row, and rolling four of them into one mark
            // only produced a fifth thing to read that named none of them.
            // A close that stopped is said, not only drawn: the row's colour
            // is what a sighted reader sees and this is the same statement
            // for everyone else.
            aria-label={`${workspace.label} workspace, path ${workspace.root}${
              closeFailed
                ? `, close failed: ${closeFailureLabel(closeFailed.step, closeFailed.diagnostic, closeFailed.detail)}`
                : ""
            }`}
            title={workspace.root}
            onClick={() =>
              dispatch({
                type: "select_context",
                context: { kind: "workspace", workspaceId: workspace.id },
              })
            }
          >
            <span className="row-label">{workspace.label}</span>
          </button>
          {/* The links trail the label rather than leading it, which is the one
            place this differs from the sketch: they are buttons, a button
            cannot go inside the row's own button, and putting them before it
            would move the glyph column that every other row lines up with. */}
          {/* Shown and disabled rather than absent when the reason is that
              the folder is on another machine. A button that is simply not
              there is indistinguishable from one this build never had, and
              the whole point of the sentence is that a person can tell "not
              yet" from "not a thing". A closing row still hides it: that one
              is about to stop existing. */}
          {(workspace.canCreateAgent ||
            workspace.localToolingUnavailable !== undefined) &&
            !closing && (
              <button
                className="row-action-button"
                type="button"
                aria-label={`Create agent in ${workspace.label}${workspace.localToolingUnavailable !== undefined || agentProfilesAvailability === "unavailable" || agentProfiles.length === 0 ? ", unavailable" : ""}`}
                title={
                  workspace.localToolingUnavailable ??
                  (agentProfilesAvailability === "degraded"
                    ? "Agent profiles need attention"
                    : agentProfiles.length > 0
                      ? "Create agent"
                      : "No enabled agent profiles")
                }
                disabled={
                  workspace.localToolingUnavailable !== undefined ||
                  agentProfilesAvailability === "unavailable" ||
                  agentProfiles.length === 0
                }
                onClick={() => onCreateAgent(workspace.id)}
              >
                <Glyph name="plus" />
              </button>
            )}
          {/* One close, whatever state the Workspace is in: a close that failed
            is retried by asking for the same thing again, not by a second
            icon that means the same thing.

            It says which of the two closes it is, because on a worktree row
            closing deletes the folder (`closingDeletesWorktree`). The ellipsis
            is the rest of that promise: a question may follow, and does
            whenever there is anything in the folder to lose. */}
          {!closing && (
            <button
              className="row-action-button"
              type="button"
              aria-label={
                deletesWorktree
                  ? `Close the worktree ${workspace.label}`
                  : `Close ${workspace.label}`
              }
              title={
                closeFailed
                  ? "Retry close"
                  : deletesWorktree
                    ? "Close worktree…"
                    : "Close workspace"
              }
              // One close, whichever state the row is in. The page used to
              // read `closing-failed` here and dispatch a different intent —
              // a rule the sidebar knew and the surface pane did not, which is
              // how closing the same workspace from two places did two things.
              // Whether this is a first attempt or a retry is main's to decide,
              // from state main already holds.
              onClick={() => {
                onCloseWorkspace(workspace);
              }}
            >
              <Glyph name="close" />
            </button>
          )}
        </div>
        {/* Line two: the branch, and nothing else on it.
            
            It is alone because it is long, it ends in the part that identifies
            it, and it is the fact that changes under you — sharing a line it
            got whatever the neighbours left over, and what survived was
            `feature/128-tidy-the…`, the half that says nothing. */}
        {workspace.location.kind === "ssh" ? (
          /* The machine, where a local row has its branch — because it is the
             same slot for the same reason: the one long fact that identifies
             the row and is not its name. A remote row has no branch to put
             here (git is not asked; see `supportsLocalTooling`), and the host
             is the thing a person with the same folder on three machines is
             actually reading the row for. */
          <div className="row-line row-line-secondary">
            <span
              className="row-branch"
              title={`${workspace.location.host}:${workspace.root}`}
            >
              {workspace.location.host}
            </span>
          </div>
        ) : repository?.branch ? (
          <div className="row-line row-line-secondary">
            <span className="row-branch" title={repository.branch}>
              {repository.branch}
            </span>
          </div>
        ) : null}
        {/* Line three: what this branch is working on — the Issue, the pull
            request out from it, and what the work is called.

            It is drawn only when there is one of those to draw. It used to
            appear for the repository link alone, which meant every workspace
            in a GitHub repository spent a third of its height on a single icon
            that said the same thing for all of them; that link is the row's
            first mark now, and this line is back to being about the work.

            The marks lead the line rather than trailing the name, which is the
            one place this differs from the row above: they are about the same
            subject as the words beside them, so they read as a sentence
            starting with its icons. Nothing here is on the name's line any
            more, which is what stopped four buttons from deciding how much of
            a branch name a person got to see. */}
        {/* Nothing DevHub reads itself reaches another machine yet, and the
            row says which of the two silences this is. Left blank it would
            look exactly like a repository whose branch is about no Issue —
            the same mistake `row-issue-unavailable` exists to stop one line
            down — and a person would go looking for a setting that is not
            missing. The sentence is the wire's, not this page's, so the row,
            the disabled New Agent button and the terminal pane all say it in
            the same words. */}
        {workspace.localToolingUnavailable ? (
          <div
            className="row-line row-line-links"
            title={workspace.localToolingUnavailable}
          >
            <span className="row-issue-unavailable">
              {workspace.localToolingUnavailable}
            </span>
          </div>
        ) : (repository?.issue ??
          repository?.pullRequest ??
          repository?.pending ??
          repository?.unavailable) ? (
          <div className="row-line row-line-links">
            <RepositoryLinks repository={repository} />
            {/* The Issue's title if there is an Issue, and the pull request's
                if there is not. One line of words, whichever of the two is
                carrying the meaning: a workspace with both is working on the
                Issue and delivering it through the pull request, and the
                Issue is the half that says what the work is. */}
            {(repository?.issue?.title ?? repository?.pullRequest?.title) ? (
              <span
                className="row-issue"
                title={repository.issue?.title ?? repository.pullRequest?.title}
              >
                {repository.issue?.title ?? repository.pullRequest?.title}
              </span>
            ) : null}
            {/* Asking. The branch is read every couple of seconds and GitHub
                once a minute, so a branch just switched to is on screen well
                before what it is about — and without this the gap looks
                exactly like a branch that is about no Issue. */}
            {repository?.pending ? (
              <>
                <span className="row-issue-number">
                  {`#${String(repository.pending.number)}`}
                </span>
                <span
                  className="mac-spinner row-issue-spinner"
                  role="status"
                  aria-label={`Reading Issue #${String(repository.pending.number)}`}
                />
              </>
            ) : null}
            {/* The row cannot say what it is working on, and this is why.
                Without it the row looked exactly like a branch that is about
                no Issue, while the reason sat at the foot of the Sidebar
                attached to nothing — so "it just does not link" had no answer
                on screen. The number says which Issue when the branch got far
                enough to name one; the failures upstream of that — git that
                would not run, a remote that is not a GitHub repository — have
                no number to show and lead with the reason instead. The whole
                of it is in the tooltip either way, because a Sidebar this
                narrow will always cut a sentence. */}
            {repository?.unavailable ? (
              <span
                className="row-issue-unavailable"
                title={
                  repository.unavailable.number === undefined
                    ? repository.unavailable.reason
                    : `Issue #${String(repository.unavailable.number)}: ${repository.unavailable.reason}`
                }
              >
                {repository.unavailable.number === undefined
                  ? repository.unavailable.reason
                  : `#${String(repository.unavailable.number)} · ${repository.unavailable.reason}`}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      {workspace.agents.length > 0 && (
        <ul
          className="agent-tree"
          role="group"
          aria-label={`${workspace.label} agents`}
        >
          {workspace.agents.map((agent) => {
            const agentSelected = selectedAgentId === agent.id;
            const control = agent.controlState;
            const stopFailed = control.kind === "stop-failed";
            // A stop that failed says why, in the vocabulary every other
            // reason is said in. DevHub computed the diagnostic when the stop
            // failed and it now crosses the wire with the state that carries
            // it, so the row states it rather than saying "Stop failed" and
            // leaving the person to guess at a reason DevHub already knows.
            // A refusal about *this* Agent leads, because it is the newest
            // news about it and it is news nothing else on screen carries: it
            // is delivered to this Agent rather than to an app-wide banner,
            // and it is retired by the next reconcile that reads the Agent.
            const note =
              control.kind === "stopping"
                ? "Stopping"
                : control.kind === "stop-failed"
                  ? closeDiagnosticLabel(control.diagnostic)
                  : agent.failure
                    ? agentFailureLabel(agent.failure)
                    : agent.runtimeHealth === "healthy"
                      ? undefined
                      : runtimeHealthLabel(agent.runtimeHealth);
            /**
             * A row leads with whatever tells it from the rows beside it.
             *
             * For a Workspace that is its name. For an Agent it is not: the
             * Agents under one Workspace are "Codex" and "Claude", and reading
             * a column of those tells you nothing you did not already know
             * from having started them. What tells them apart is what each one
             * is doing, so that is what leads, at the size a row's own name is
             * set in, and the name follows underneath it small and dimmed.
             *
             * An Agent that has not said anything yet leads with its name
             * instead. The leading line is never empty: a row whose only text
             * was 11px dimmed would be a row you cannot read the name of.
             */
            const leading = agent.activity ?? agent.displayName;
            const naming = agent.activity ? agent.displayName : undefined;
            return (
              <li
                key={agent.id}
                role="treeitem"
                aria-level={2}
                aria-selected={agentSelected}
              >
                <div
                  className={`sidebar-row agent-row${agentSelected ? " is-selected" : ""}${agent.unread ? " is-unread" : ""}`}
                  data-control-state={agent.controlState.kind}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    onAgentMenu(agent, {
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                >
                  {/* The unread mark, in the same leading rail every row
                      reserves — one column, at the leading edge, where Mail
                      puts the same fact. It used to trail the row while the
                      status glyph led it, which put two marks about one Agent
                      at opposite ends of a row narrow enough that the two
                      could not be read together.

                      It is not a second status. It says the Agent asked for
                      you and you have not been, which is a fact about the
                      person and outlives whatever the Agent is doing now — an
                      Agent can be idle and unread, and that is exactly the
                      case one mark would lose.

                      Its colour is the reason it is there: the status the
                      Agent went into while nobody was watching. A finish and a
                      question are not the same errand, and a dot that is
                      always blue would say they were. */}
                  <div className="row-head">
                    <span className="row-rail" aria-hidden="true">
                      {agent.unread ? (
                        <span
                          className={`row-unread row-unread-${agent.unread}`}
                        />
                      ) : null}
                    </span>
                    <button
                      className="sidebar-context-button"
                      type="button"
                      data-tree-item-id={`agent:${agent.id}`}
                      tabIndex={agentSelected ? 0 : -1}
                      aria-current={agentSelected ? "page" : undefined}
                      aria-label={`${agent.displayName}, ${statusLabel(agent.status)} agent, ${note ?? runtimeHealthLabel(agent.runtimeHealth)}${agent.unread ? ", unread" : ""}${agent.activity ? `, ${agent.activity}` : ""}`}
                      disabled={agent.controlState.kind === "stopping"}
                      // Command-click opens the Agent beside its workbench; a
                      // plain click gives it the whole content area. The same
                      // pair as Return and Command-Return in the picker, because
                      // it is the same choice, and it is stated in the intent
                      // rather than applied afterwards.
                      onClick={(event) =>
                        dispatch({
                          type: "select_context",
                          context: { kind: "agent", agentId: agent.id },
                          split: event.metaKey,
                        })
                      }
                      // Renaming is what a source list does on a second click at
                      // rest, and it stays off the row: an icon whose meaning has
                      // to be guessed is worse than one that is not there.
                      onDoubleClick={() => onRenameAgent(agent)}
                    >
                      {/* The leading glyph *is* the status. There is no second
                        mark trailing the row saying the same thing in a
                        smaller size. */}
                      <StatusMark status={agent.status} />
                      <span className="row-label">{leading}</span>
                    </button>
                    {agent.controlState.kind === "stopping" ? null : (
                      <button
                        className="row-action-button agent-row-action"
                        type="button"
                        aria-label={`Stop ${agent.displayName}`}
                        title={stopFailed ? "Retry stop" : "Stop agent"}
                        onClick={() =>
                          dispatch(
                            stopFailed
                              ? { type: "retry_stop_agent", agentId: agent.id }
                              : { type: "stop_agent", agentId: agent.id },
                          )
                        }
                      >
                        <Glyph name="close" />
                      </button>
                    )}
                  </div>
                  {/* The Agent's own name, and why it may not be doing what its
                      status says. The same second line a Workspace row has, and
                      it runs the full width for the same reason. */}
                  {(naming ?? note) ? (
                    <div className="row-line row-line-secondary">
                      {naming ? (
                        <span className="row-name">{naming}</span>
                      ) : null}
                      {note ? <span className="row-note">{note}</span> : null}
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

/**
 * What a Workspace row begins with, and where clicking it goes.
 *
 * Three marks, and which one a row starts with is how a person tells the three
 * kinds of Workspace apart at a glance: a plain folder, a repository, and a
 * worktree of one. They are three silhouettes rather than one silhouette with
 * a badge, because this column is scanned rather than read — see `icons.tsx`,
 * where they are drawn together for exactly that reason.
 *
 * When there is a GitHub page for it, the mark *is* the link to it. It used to
 * be a fourth button down on the third line, which meant a row with no Issue
 * spent a whole line on a single icon — and it is the same question either
 * way: *show me this on GitHub*. So the row's first mark answers it, and the
 * third line is left for what the row is working on.
 *
 * A worktree keeps its own silhouette here and still links to the repository's
 * page, because that is the page it has: a worktree is not a separate thing on
 * GitHub, and a mark that led somewhere else would be inventing one.
 */
function WorkspaceGlyph({
  location,
  repository,
}: {
  readonly location: WorkspaceLocationWire;
  readonly repository: WorkspaceRepositoryWire | undefined;
}) {
  const { openExternalUrl } = useAppShell();
  // `mainWorktree` is git's own answer to "which repository is this a checkout
  // of", so its absence is the whole of what "not a repository" means here.
  //
  // Which *kind* of checkout is the two roots compared with each other, and
  // never with the row's own path: a workspace opened at `repo/packages/app` is
  // in the main worktree and is neither of them, and comparing it to
  // `mainWorktree` answered "not the main worktree" — which is true, and is not
  // the question. That is what drew a plain subdirectory as a worktree.
  // A fourth silhouette, and it comes first: whether the folder is on this
  // machine is the thing a person needs to know before anything else about the
  // row, and DevHub has no repository facts for a remote folder to draw
  // anyway — `supportsLocalTooling` is false, so git was never asked.
  const name: GlyphName =
    location.kind === "ssh"
      ? "remote"
      : repository?.mainWorktree === undefined ||
          repository.worktree === undefined
        ? "folder"
        : repository.worktree === repository.mainWorktree
          ? "repository"
          : "worktree";
  const url = repository?.repositoryUrl;
  if (url === undefined) {
    return (
      <span className="row-glyph" aria-hidden="true">
        <Glyph name={name} />
      </span>
    );
  }
  const page = url.replace("https://github.com/", "");
  return (
    <button
      className="row-glyph row-glyph-button"
      type="button"
      aria-label={`Open ${page} on GitHub`}
      title={`Open ${page} on GitHub`}
      onClick={() => {
        openExternalUrl(url);
      }}
    >
      <Glyph name={name} />
    </button>
  );
}

/**
 * Which mark a pull request wears, by what became of it.
 *
 * Four states, four of GitHub's own drawings — there is no state here that has
 * to be told from another by colour, which is what lets the whole column go
 * grey at rest. See `icons.tsx`.
 */
const PULL_REQUEST_GLYPH: Record<
  NonNullable<WorkspaceRepositoryWire["pullRequest"]>["state"],
  GlyphName
> = {
  open: "pullRequest",
  draft: "pullRequestDraft",
  closed: "pullRequestClosed",
  merged: "pullRequestMerged",
};

/**
 * The Issue this workspace is for and the pull request out from its branch, as
 * marks that open GitHub.
 *
 * They are marks rather than words because the row already has words, and they
 * are GitHub's marks rather than DevHub's because what they say is GitHub's:
 * somebody who reads pull requests all day recognises these silhouettes
 * without being told. What each one says in full is in its label, for anyone
 * who cannot use a picture.
 *
 * The Issue leads, because the Issue is what the work is *for* and the pull
 * request is how it is being delivered. The number is in the label rather than
 * beside the mark: the line's words are the title, and a row that spent four
 * characters on `#128` before every title was spending them on the part a
 * person already knows.
 *
 * They are grey at rest and take GitHub's state colours under the pointer. The
 * state is never lost by that, because it is carried by the shape; what the
 * grey buys is a Sidebar in which the one coloured thing is an Agent that
 * wants something. `shell.css` carries the rule.
 */
function RepositoryLinks({
  repository,
}: {
  readonly repository: WorkspaceRepositoryWire | undefined;
}) {
  const { openExternalUrl } = useAppShell();
  if (!repository) return null;
  const issue = repository.issue;
  const pullRequest = repository.pullRequest;
  return (
    <>
      {issue ? (
        <button
          className={`row-link-button is-issue-${issue.state}`}
          type="button"
          aria-label={`Issue #${String(issue.number)}, ${issue.state}: ${issue.title}`}
          title={`Issue #${String(issue.number)} (${issue.state})`}
          onClick={() => {
            openExternalUrl(issue.url);
          }}
        >
          <Glyph
            name={issue.state === "closed" ? "issueClosed" : "issueOpen"}
          />
        </button>
      ) : null}
      {pullRequest ? (
        <button
          className={`row-link-button is-pr-${pullRequest.state}`}
          type="button"
          aria-label={`Pull request #${String(pullRequest.number)}, ${pullRequest.state}: ${pullRequest.title}`}
          title={`Pull request #${String(pullRequest.number)} (${pullRequest.state})`}
          onClick={() => {
            openExternalUrl(pullRequest.url);
          }}
        >
          <Glyph name={PULL_REQUEST_GLYPH[pullRequest.state]} />
        </button>
      ) : null}
    </>
  );
}

function ScratchRow({
  snapshot,
  onDispatch,
  rowRef,
}: {
  readonly snapshot: AppSnapshot;
  readonly onDispatch: (intent: AppIntent) => void;
  /** Where `Cmd+Q S` lands when Scratch is what is selected. */
  readonly rowRef: React.Ref<HTMLButtonElement>;
}) {
  const selected = snapshot.selection.context.kind === "global";
  return (
    <button
      ref={rowRef}
      className={`sidebar-row scratch-row${selected ? " is-selected" : ""}`}
      type="button"
      aria-current={selected ? "page" : undefined}
      aria-label="Scratch terminal"
      onClick={() =>
        onDispatch({ type: "select_context", context: { kind: "global" } })
      }
    >
      {/* Mirrors a Workspace row's first line so the rail, the glyph and the
          label land on the same columns. It has no second line: there is
          nothing a Scratch terminal is working on. */}
      <span className="row-head">
        <span className="row-rail" aria-hidden="true" />
        <span className="row-glyph" aria-hidden="true">
          <Glyph name="terminal" />
        </span>
        <span className="sidebar-context-button">
          <span className="row-label">{SCRATCH_NAME}</span>
        </span>
      </span>
    </button>
  );
}

function SidebarResizeHandle({
  width,
  onPreview,
  onCommit,
}: {
  readonly width: number;
  readonly onPreview: (width: number) => void;
  readonly onCommit: (width: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const pointerOrigin = useRef<
    { readonly x: number; readonly width: number } | undefined
  >(undefined);
  const previewWidth = useRef(width);

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointerOrigin.current = { x: event.clientX, width };
    previewWidth.current = width;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const continueResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = pointerOrigin.current;
    if (!origin || !dragging) return;
    const next = clampSidebarWidth(origin.width + event.clientX - origin.x);
    previewWidth.current = next;
    onPreview(next);
  };

  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (pointerOrigin.current) onCommit(previewWidth.current);
    pointerOrigin.current = undefined;
    setDragging(false);
  };

  const moveByKeyboard = (delta: number) =>
    onCommit(clampSidebarWidth(width + delta));

  useEffect(() => {
    if (!dragging) return undefined;
    document.body.classList.add("is-resizing-sidebar");
    return () => document.body.classList.remove("is-resizing-sidebar");
  }, [dragging]);

  return (
    <div
      className={`sidebar-resize-handle${dragging ? " is-dragging" : ""}`}
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-valuemin={200}
      aria-valuemax={400}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={beginResize}
      onPointerMove={continueResize}
      onPointerUp={endResize}
      onPointerCancel={endResize}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          moveByKeyboard(-4);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          moveByKeyboard(4);
        } else if (event.key === "Home") {
          event.preventDefault();
          onCommit(200);
        } else if (event.key === "End") {
          event.preventDefault();
          onCommit(400);
        }
      }}
    />
  );
}

/**
 * A row that has finished closing, on its way off the list.
 *
 * Deliberately not a `treeitem`: it is not an item, it is the picture of one
 * that has just stopped existing, and putting it in the tree would give a
 * screen reader a row to land on that answers nothing. `aria-hidden` says so,
 * and the tree's own arrow-key walk skips it for the same reason — it carries
 * no `data-tree-item-id`.
 */
function ClosingGhostRow({ label }: { label: string }) {
  return (
    <li className="sidebar-tree-item is-exiting" aria-hidden="true">
      <div className="sidebar-row workspace-row" data-state="closing">
        <div className="row-head">
          <span className="row-rail" />
          <span className="sidebar-context-button">
            <span className="row-label">{label}</span>
          </span>
        </div>
      </div>
    </li>
  );
}

export function Sidebar({ snapshot, onDispatch }: SidebarProps) {
  const {
    dispatch,
    agentProfiles,
    repositoryStatus,
    closeWorkspace,
    dismissIntentError,
  } = useAppShell();
  const repositories = useMemo(
    () =>
      new Map(
        repositoryStatus.workspaces.map((entry) => [entry.workspaceId, entry]),
      ),
    [repositoryStatus],
  );
  // Drawn in the order they arrive in. Worktrees sit under the repository
  // they came from and everything else is by name, but that is decided once,
  // in the projection (`model/workspaceOrder.ts`), so the rows on screen and
  // the rows `Cmd+Q Cmd+N` steps through are the same rows in the same order.
  const workspaces = snapshot.workspaces;
  // Rows that have finished closing, still on screen for as long as it takes
  // them to leave. See `closingExit.ts`.
  const exiting = useClosingExit(workspaces);
  const rows = useMemo(
    () => mergeExitingRows(workspaces, exiting),
    [workspaces, exiting],
  );
  // The sidebar draws no modals. Every one of them lives on the overlay layer
  // above the workbench views, so opening one is a request to main and nothing
  // more — there is no local "is it open" to keep in step with anything.
  //
  /**
   * Get rid of a workspace, whatever kind of workspace it is.
   *
   * Handed straight to main, which is where the one rule lives: an ordinary
   * folder is closed, a worktree is deleted — without a question when git can
   * rebuild it in a second, and with the three-way one when there is something
   * in it to lose. The page used to decide that here, from a poll up to a
   * minute old, while the chords decided it somewhere else; one of the two was
   * always going to be the wrong one.
   */
  const closeWorkspaceRow = useCallback(
    (workspace: WorkspaceSnapshot) => {
      closeWorkspace(workspace.id);
    },
    [closeWorkspace],
  );

  const openPicker = useCallback(() => {
    void devhub().openModal({ kind: "workspace-picker" });
  }, []);
  // Assigning an Issue is a way of starting work, so it stands beside the way
  // of opening one — same heading, same kind of request to main, and the
  // wizard it opens is drawn on the same layer as every other modal.
  const openIssueAssignment = useCallback(() => {
    void devhub().openModal({ kind: "issue-assignment" });
  }, []);
  const pickerTriggerRef = useRef<HTMLButtonElement>(null);
  const workspaceTreeRef = useRef<HTMLUListElement>(null);
  const scratchRowRef = useRef<HTMLButtonElement>(null);
  const treeFocusId = useRef<string | undefined>(undefined);
  // Which row the keyboard would land on, kept in a ref so that the one
  // subscription to main's commands does not have to be torn down and remade
  // every time the selection moves.
  const onScratch = useRef(false);
  onScratch.current = snapshot.selection.context.kind === "global";

  /**
   * `Cmd+Q S`: put the keyboard on the row that is selected.
   *
   * The tree's roving tab stop is already the selected row — the layout effect
   * above keeps it there — so this focuses whatever that is and the tree's own
   * arrows, Home/End and Return take over from there. Scratch is a button of
   * its own outside the tree, so a global selection lands on it; a Sidebar with
   * no workspaces has nothing else to land on either way.
   */
  const focusSidebar = useCallback(() => {
    const tree = workspaceTreeRef.current;
    const items = tree ? treeContextButtons(tree) : [];
    const stop = items.find((item) => item.tabIndex === 0) ?? items[0];
    const target = onScratch.current ? scratchRowRef.current : stop;
    (target ?? scratchRowRef.current)?.focus();
  }, []);

  /**
   * Escape: give the keyboard back.
   *
   * The way out of the chrome, and the counterpart of `Cmd+Q S`. It is a
   * request to main and not a `blur()` here, because the thing that should get
   * the keyboard is usually a native workbench view this document cannot
   * focus — `ShellWindow.focusSurface` is the one answer to where it goes, and
   * writing a second one here is how the two would come to disagree.
   */
  const leaveSidebar = useCallback(() => {
    void devhub().focusSurface();
  }, []);

  useLayoutEffect(() => {
    const tree = workspaceTreeRef.current;
    if (!tree) return;
    const items = treeContextButtons(tree);
    const previousId = treeFocusId.current;
    const requested = previousId
      ? items.find((item) => item.dataset.treeItemId === previousId)
      : undefined;
    const selected = items.find(
      (item) =>
        item
          .closest<HTMLElement>("[role=treeitem]")
          ?.getAttribute("aria-selected") === "true",
    );
    const target = requested ?? selected ?? items[0];
    setTreeTabStop(tree, target);
    if (!target) {
      treeFocusId.current = undefined;
      return;
    }
    const active = document.activeElement;
    const activeWasRemoved =
      Boolean(previousId) &&
      !requested &&
      (active === document.body || active === tree || tree.contains(active));
    treeFocusId.current = target.dataset.treeItemId;
    if (activeWasRemoved) target.focus();
  }, [snapshot.selection.context, snapshot.workspaces]);

  /**
   * Everything main asks this page to do, in one subscription.
   *
   * Every one of these is a command main cannot carry out itself because what
   * it acts on is drawn here: the picker's trigger, the Agent's pane, the
   * Sidebar's roving tab stop, the alert's lifetime. They arrive on one channel
   * and are answered in one place, so a command added later is a line here
   * rather than a second listener somewhere with its own idea of when it is
   * mounted.
   */
  useEffect(
    () =>
      devhub().onMenuCommand((command) => {
        // File ▸ Add Workspace… is the same command as the sidebar's +, so it
        // opens the same picker rather than a second way of adding a workspace.
        if (command === "open_workspace_picker") openPicker();
        // The page's half of `Cmd+Q Cmd+J` in the side-by-side layout: main
        // decides *that* the keyboard should move and this finds the pane,
        // through the one function that already answers "where does the
        // keyboard belong in this document".
        if (command === "focus_agent_pane") focusMainSurface();
        if (command === "focus_sidebar") focusSidebar();
        // The keyboard's version of the alert's `×`, and the same gesture: the
        // third of the three things that retire a failure. With nothing on
        // screen it records nothing and changes nothing, which is what makes
        // the chord a no-op rather than a case anybody has to check for.
        if (command === "dismiss_alert") dismissIntentError();
      }),
    [dismissIntentError, focusSidebar, openPicker],
  );

  const [inProgressWidth, setInProgressWidth] = useState<number | null>(null);
  const renderedWidth = inProgressWidth ?? snapshot.sidebar.width;

  const openAgentPicker = useCallback((workspaceId: string) => {
    void devhub().openModal({ kind: "agent-picker", workspaceId });
  }, []);

  const openRename = useCallback((agent: AgentSnapshot) => {
    void devhub().openModal({ kind: "agent-rename", agentId: agent.id });
  }, []);

  /**
   * The row's context menu.
   *
   * One piece of state for the whole tree rather than one per row: only one
   * menu can be open, and saying so here is what makes that true instead of
   * hoping every row closes itself when another opens.
   */
  const [agentMenu, setAgentMenu] = useState<
    | {
        readonly agent: AgentSnapshot;
        readonly at: { x: number; y: number };
      }
    | undefined
  >(undefined);
  const openAgentMenu = useCallback(
    (agent: AgentSnapshot, at: { x: number; y: number }) => {
      setAgentMenu({ agent, at });
    },
    [],
  );
  const closeAgentMenu = useCallback(() => {
    setAgentMenu(undefined);
  }, []);

  const resize = useCallback(
    (width: number) => {
      setInProgressWidth(width);
      void dispatch({ type: "resize_sidebar", width }).finally(() => {
        setInProgressWidth(null);
      });
    },
    [dispatch],
  );

  const previewResize = useCallback((width: number) => {
    setInProgressWidth(width);
  }, []);

  return (
    <aside
      className="sidebar"
      aria-label="Workspace navigation"
      style={{ "--sidebar-width": `${renderedWidth}px` } as React.CSSProperties}
      // Escape leaves the Sidebar, from anywhere in it: a row, the tree, the
      // resize handle. One handler on the pane rather than one per control,
      // because "the way out" is a fact about the pane. Anything inside that
      // has its own Escape — the row menu — stops the event, so the key means
      // one thing at a time.
      onKeyDown={(event) => {
        if (isImeComposing(event.nativeEvent)) return;
        if (event.key !== "Escape") return;
        event.preventDefault();
        leaveSidebar();
      }}
    >
      {/* The Sidebar runs the full height of the window, so its own top strip
          is where the window buttons live and where the window is dragged. */}
      <SidebarHeader />
      <div className="sidebar-scroll-region">
        <ScratchRow
          snapshot={snapshot}
          onDispatch={onDispatch}
          rowRef={scratchRowRef}
        />
        <div className="sidebar-section-heading">
          <h2>Workspaces</h2>
          {/* The two ways to start work, kept together at the trailing edge:
              open a workspace you have, or take an Issue and let DevHub make
              one. */}
          <span className="sidebar-section-actions">
            <button
              className="section-action-button"
              type="button"
              aria-label="Assign issue"
              title="Assign issue"
              onClick={openIssueAssignment}
            >
              {/* An act, not a state: DevHub's own mark, the same one the
                Agent shortcut for opening an Issue wears. The Octicon a
                Workspace row shows is GitHub reporting on an Issue that
                exists, which this button's is not. */}
              <Glyph name="openIssue" />
            </button>
            <button
              ref={pickerTriggerRef}
              className="section-action-button"
              type="button"
              aria-label="Open workspace picker"
              title="Open workspace picker"
              onClick={openPicker}
            >
              <Glyph name="plus" />
            </button>
          </span>
        </div>
        {/* `rows` and not the snapshot: the last Workspace to close still has
            a ghost fading in its place, and swapping the whole list for "No
            workspaces open" underneath it is exactly the jump the ghost is
            there to prevent. */}
        {rows.length > 0 ? (
          <ul
            ref={workspaceTreeRef}
            className="workspace-tree"
            role="tree"
            aria-label="Open workspaces"
            onFocusCapture={(event) => {
              const button = (
                event.target as HTMLElement
              ).closest<HTMLButtonElement>("[data-tree-item-id]");
              if (!button) return;
              const treeItemId = button.dataset.treeItemId;
              if (!treeItemId) return;
              treeFocusId.current = treeItemId;
              setTreeTabStop(event.currentTarget, button);
            }}
            onKeyDown={(event) => {
              if (
                isImeComposing(event.nativeEvent) ||
                event.target instanceof HTMLInputElement
              ) {
                return;
              }
              const active = event.currentTarget.ownerDocument
                .activeElement as HTMLElement | null;
              const activeItem = active?.closest<HTMLButtonElement>(
                "[data-tree-item-id]",
              );
              if (
                !activeItem ||
                activeItem.parentElement?.closest("[role=dialog]")
              ) {
                return;
              }
              const items = treeContextButtons(event.currentTarget);
              const index = items.indexOf(activeItem);
              if (index < 0) return;
              const focusItem = (
                item: HTMLButtonElement | null | undefined,
              ) => {
                if (!item) return;
                const treeItemId = item.dataset.treeItemId;
                if (!treeItemId) return;
                treeFocusId.current = treeItemId;
                setTreeTabStop(event.currentTarget, item);
                item.focus();
              };
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const delta = event.key === "ArrowDown" ? 1 : -1;
                focusItem(items[(index + delta + items.length) % items.length]);
                return;
              }
              if (event.key === "Home" || event.key === "End") {
                event.preventDefault();
                focusItem(event.key === "Home" ? items[0] : items.at(-1));
                return;
              }
              const item = activeItem.closest<HTMLElement>("[role=treeitem]");
              if (!item) return;
              // Nothing here collapses: a Workspace is always open, so the
              // horizontal keys only walk between a Workspace and its Agents.
              if (event.key === "ArrowRight") {
                const child = item.querySelector<HTMLButtonElement>(
                  ".agent-tree [data-tree-item-id]:not([disabled])",
                );
                if (!child) return;
                event.preventDefault();
                focusItem(child);
                return;
              }
              if (event.key === "ArrowLeft") {
                const parent =
                  item.parentElement?.closest<HTMLElement>("[role=treeitem]");
                if (!parent) return;
                event.preventDefault();
                focusItem(
                  parent.querySelector<HTMLButtonElement>(
                    ":scope > .sidebar-row [data-tree-item-id]",
                  ),
                );
              }
            }}
          >
            {rows.map((entry) =>
              entry.kind === "exiting" ? (
                <ClosingGhostRow key={entry.row.id} label={entry.row.label} />
              ) : (
                <WorkspaceRow
                  key={entry.workspace.id}
                  workspace={entry.workspace}
                  repository={repositories.get(entry.workspace.id)}
                  snapshot={snapshot}
                  onDispatch={onDispatch}
                  agentProfiles={agentProfiles.profiles}
                  agentProfilesAvailability={agentProfiles.availability}
                  onCreateAgent={openAgentPicker}
                  onCloseWorkspace={closeWorkspaceRow}
                  onRenameAgent={openRename}
                  onAgentMenu={openAgentMenu}
                />
              ),
            )}
          </ul>
        ) : (
          <p className="sidebar-empty">No workspaces open</p>
        )}
        {/* Why what is on the rows may be out of date. It stands beside what
            is still known rather than replacing it, and it goes when a later
            look succeeds — a network that dropped must not read as an issue
            that closed. */}
        {repositoryStatus.diagnostic ? (
          <p className="sidebar-status-note" role="status">
            {repositoryStatus.diagnostic}
          </p>
        ) : null}
      </div>
      <SidebarResizeHandle
        width={renderedWidth}
        onPreview={previewResize}
        onCommit={resize}
      />
      {agentMenu ? (
        <RowMenu
          at={agentMenu.at}
          label={`${agentMenu.agent.displayName} actions`}
          items={agentMenuItems(agentMenu.agent, onDispatch, openRename)}
          onDismiss={closeAgentMenu}
        />
      ) : null}
    </aside>
  );
}

/**
 * What a right-click on an Agent offers.
 *
 * Mark as Unread is the only one that is not already a control on the row, and
 * it is here because it is the counterpart to opening one: reading is
 * automatic, and un-reading has to be something you can say.
 */
function agentMenuItems(
  agent: AgentSnapshot,
  dispatch: (intent: AppIntent) => void,
  onRename: (agent: AgentSnapshot) => void,
): RowMenuItem[] {
  const items: RowMenuItem[] = [
    {
      id: "rename",
      label: "Rename…",
      run: () => {
        onRename(agent);
      },
    },
  ];
  if (!agent.unread) {
    items.push({
      id: "unread",
      label: "Mark as Unread",
      run: () => {
        dispatch({ type: "mark_agent_unread", agentId: agent.id });
      },
    });
  }
  if (agent.controlState.kind !== "stopping") {
    items.push({
      id: "stop",
      label:
        agent.controlState.kind === "stop-failed" ? "Retry Stop" : "Stop Agent",
      run: () => {
        dispatch(
          agent.controlState.kind === "stop-failed"
            ? { type: "retry_stop_agent", agentId: agent.id }
            : { type: "stop_agent", agentId: agent.id },
        );
      },
    });
  }
  return items;
}
