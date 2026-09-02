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
  type WorkspaceSnapshot,
} from "../../../ipc/appShell";
import { clampSidebarWidth } from "../../../ipc/appShell";
import { SCRATCH_NAME } from "../../../ipc/windowTitles";
import type { WorkspaceRepositoryWire } from "../../../ipc/contract";
import { useAppShell } from "../../useAppShell";
import { devhub } from "../../client";
import { isImeComposing } from "../../accessibility/ime";
import { Glyph, type GlyphName } from "./icons";
import { RowMenu, type RowMenuItem } from "./RowMenu";
import { SidebarHeader } from "./SidebarHeader";
import { StatusMark } from "./StatusMark";
import { statusLabel } from "./status";
import { orderWorkspaces } from "./workspaceOrder";
import { mergeExitingRows, useClosingExit } from "./closingExit";

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
  onRemoveWorktree,
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
  readonly onRemoveWorktree: (workspace: WorkspaceSnapshot) => void;
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
  // of a state the model already enforces — `closing` refuses the operations
  // underneath anyway — and it is here so that the refusal is never something
  // a person has to run into: the row goes quiet at the same moment it stops
  // being able to answer. It covers the Agents as well as the Workspace
  // because they are going with it.
  const closing = workspace.state === "closing";

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
        data-state={workspace.state}
      >
        <div className="row-head">
          <span className="row-rail" aria-hidden="true" />
          {/* Outside the row's own button, because when there is a GitHub page
              for this workspace the mark is the link to it, and a button
              cannot go inside a button. It keeps the glyph column either way:
              a folder and a repository start at the same pixel. */}
          <WorkspaceGlyph repository={repository} />
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
            aria-label={`${workspace.label} workspace, path ${workspace.root}`}
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
          {workspace.canCreateAgent && (
            <button
              className="row-action-button"
              type="button"
              aria-label={`Create agent in ${workspace.label}${agentProfilesAvailability === "unavailable" || agentProfiles.length === 0 ? ", unavailable" : ""}`}
              title={
                agentProfilesAvailability === "degraded"
                  ? "Agent profiles need attention"
                  : agentProfiles.length > 0
                    ? "Create agent"
                    : "No enabled agent profiles"
              }
              disabled={
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
            icon that means the same thing. */}
          {workspace.state !== "closing" && (
            <button
              className="row-action-button"
              type="button"
              aria-label={`Close ${workspace.label}`}
              title={
                workspace.state === "closing-failed"
                  ? "Retry close"
                  : "Close workspace"
              }
              onClick={() =>
                dispatch(
                  workspace.state === "closing-failed"
                    ? {
                        type: "retry_close_workspace",
                        workspaceId: workspace.id,
                      }
                    : {
                        type: "request_close_workspace",
                        workspaceId: workspace.id,
                      },
                )
              }
            >
              <Glyph name="close" />
            </button>
          )}
          {/* Only a worktree. A worktree is a place the repository is also
            checked out; the repository itself is not something this row
            deletes.

            Offered whether or not there is anything in it to lose, which is
            the change: the button used to appear only for a worktree DevHub
            had seen to be clean, so a worktree with one stray file had no way
            to be removed from DevHub at all — the control simply was not
            there, and nothing said why. What "clean" decides now is whether
            the removal is *asked about*, in `onRemoveWorktree`.

            And only when the row *is* the worktree, not merely inside one.
            `git worktree remove` takes the checkout's root, so a row on
            `worktree/packages/app` would offer a button that deletes the whole
            checkout around it — which is not what the row names, and is not
            recoverable. */}
          {!closing &&
          repository?.mainWorktree !== undefined &&
          repository.worktree !== undefined &&
          repository.worktree !== repository.mainWorktree &&
          repository.worktree === workspace.root ? (
            <button
              className="row-action-button"
              type="button"
              aria-label={`Remove the worktree ${workspace.label}`}
              title="Remove worktree"
              onClick={() => onRemoveWorktree(workspace)}
            >
              <Glyph name="trash" />
            </button>
          ) : null}
        </div>
        {/* Line two: the branch, and nothing else on it.
            
            It is alone because it is long, it ends in the part that identifies
            it, and it is the fact that changes under you — sharing a line it
            got whatever the neighbours left over, and what survived was
            `feature/128-tidy-the…`, the half that says nothing. */}
        {repository?.branch ? (
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
        {(repository?.issue ??
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
            const stopFailed = agent.controlState === "stop-failed";
            const note =
              agent.controlState === "stopping"
                ? "Stopping"
                : stopFailed
                  ? "Stop failed"
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
                  data-control-state={agent.controlState}
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
                      case one mark would lose. */}
                  <div className="row-head">
                    <span className="row-rail" aria-hidden="true">
                      {agent.unread ? <span className="row-unread" /> : null}
                    </span>
                    <button
                      className="sidebar-context-button"
                      type="button"
                      data-tree-item-id={`agent:${agent.id}`}
                      tabIndex={agentSelected ? 0 : -1}
                      aria-current={agentSelected ? "page" : undefined}
                      aria-label={`${agent.displayName}, ${statusLabel(agent.status)} agent, ${note ?? runtimeHealthLabel(agent.runtimeHealth)}${agent.unread ? ", unread" : ""}${agent.activity ? `, ${agent.activity}` : ""}`}
                      disabled={agent.controlState === "stopping"}
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
                    {agent.controlState === "stopping" ? null : (
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
  repository,
}: {
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
  const name: GlyphName =
    repository?.mainWorktree === undefined || repository.worktree === undefined
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
 * The Issue this workspace is for and the pull request out from its branch, as
 * marks that open GitHub.
 *
 * They are marks rather than words because the row already has words. What
 * each one says is its shape and then its colour — GitHub's own: an open issue
 * is green and a closed one purple; a pull request is green open, grey draft,
 * red closed and purple merged — and what it says in full is in its label, for
 * anyone who cannot use either.
 *
 * The Issue leads, because the Issue is what the work is *for* and the pull
 * request is how it is being delivered. The number is in the label rather than
 * beside the mark: the line's words are the title, and a row that spent four
 * characters on `#128` before every title was spending them on the part a
 * person already knows.
 *
 * Two pull-request drawings for four states, and the split is "did it land":
 * `merged` gets the junction, the other three get the arrow and differ by
 * colour. `icons.tsx` carries the argument.
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
          <Glyph
            name={
              pullRequest.state === "merged"
                ? "pullRequestMerged"
                : "pullRequest"
            }
          />
        </button>
      ) : null}
    </>
  );
}

function ScratchRow({
  snapshot,
  onDispatch,
}: {
  readonly snapshot: AppSnapshot;
  readonly onDispatch: (intent: AppIntent) => void;
}) {
  const selected = snapshot.selection.context.kind === "global";
  return (
    <button
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
    removeWorktree,
    reportFailure,
  } = useAppShell();
  const repositories = useMemo(
    () =>
      new Map(
        repositoryStatus.workspaces.map((entry) => [entry.workspaceId, entry]),
      ),
    [repositoryStatus],
  );
  // Worktrees under the repository they came from, everything else by name.
  // The identity is git's — see `orderWorkspaces` — and it arrives with the
  // rest of what each row knows, so the order settles as the first poll lands
  // rather than being guessed from folder names.
  const workspaces = useMemo(
    () =>
      orderWorkspaces(
        snapshot.workspaces,
        (workspace) => repositories.get(workspace.id)?.mainWorktree,
      ),
    [repositories, snapshot.workspaces],
  );
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
   * Remove a worktree, asking first only when there is an answer worth asking
   * for.
   *
   * A worktree with nothing uncommitted in it is a folder git can rebuild from
   * the repository in a second. Confirming that was a question whose answer was
   * always yes, put in front of somebody every single time — and a question
   * like that is worse than none, because it is what teaches people to dismiss
   * the ones that matter. So a clean worktree goes straight to git, without
   * `--force`: DevHub's "clean" is a poll up to a minute old, and if it was
   * stale git refuses and nothing has happened.
   *
   * Anything else is asked about on the modal layer, like every other
   * destructive question, and answering it removes the worktree with `--force`
   * — which is the only way a worktree with uncommitted work can be removed at
   * all. "Anything else" includes DevHub not knowing: not knowing is not clean,
   * and the question is the safe branch.
   */
  const askRemoveWorktree = useCallback(
    (workspace: WorkspaceSnapshot) => {
      const repository = repositories.get(workspace.id);
      if (repository?.dirty === false) {
        // Nothing to lose, so nothing to ask. The failure — git disagreeing
        // about "clean", a lock, a permission — goes to the one place the
        // shell shows failures, because this one has no sheet of its own.
        void removeWorktree(workspace.id, false).catch(reportFailure);
        return;
      }
      void devhub().openModal({
        kind: "worktree-removal",
        workspaceId: workspace.id,
        label: workspace.label,
        root: workspace.root,
        branch: repository?.branch,
      });
    },
    [removeWorktree, reportFailure, repositories],
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
  // File ▸ Add Workspace… is the same command as the sidebar's +, so it opens
  // the same picker rather than a second way of adding a workspace.
  useEffect(
    () =>
      devhub().onMenuCommand((command) => {
        if (command === "open_workspace_picker") openPicker();
      }),
    [openPicker],
  );
  const pickerTriggerRef = useRef<HTMLButtonElement>(null);
  const workspaceTreeRef = useRef<HTMLUListElement>(null);
  const treeFocusId = useRef<string | undefined>(undefined);

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
    >
      {/* The Sidebar runs the full height of the window, so its own top strip
          is where the window buttons live and where the window is dragged. */}
      <SidebarHeader />
      <div className="sidebar-scroll-region">
        <ScratchRow snapshot={snapshot} onDispatch={onDispatch} />
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
              {/* The same mark an open Issue wears on a Workspace row, so the
                button and the thing it produces say one thing. */}
              <Glyph name="issueOpen" />
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
                  onRemoveWorktree={askRemoveWorktree}
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
  if (agent.controlState !== "stopping") {
    items.push({
      id: "stop",
      label: agent.controlState === "stop-failed" ? "Retry Stop" : "Stop Agent",
      run: () => {
        dispatch(
          agent.controlState === "stop-failed"
            ? { type: "retry_stop_agent", agentId: agent.id }
            : { type: "stop_agent", agentId: agent.id },
        );
      },
    });
  }
  return items;
}
