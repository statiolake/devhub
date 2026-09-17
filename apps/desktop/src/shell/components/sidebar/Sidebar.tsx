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
import { closingDeletesWorktree } from "../../../model/worktrees";
import { useSidebar, useSidebarDispatch } from "../../sidebar/SidebarContext";
import { devhub } from "../../sidebar/client";
import { isImeComposing } from "../../accessibility/ime";
import { Glyph } from "./icons";
import { RowTooltip } from "./RowTooltip";
import { RowMenu, type RowMenuItem } from "./RowMenu";
import { StatusMark, unreadShows } from "./StatusMark";
import { mergeExitingRows, useClosingExit } from "./closingExit";
import { moveIntent, sourceOfTreeItem } from "./reorder";
import { useReorder, type Reorder } from "./useReorder";
import {
  agentNote,
  agentRowFacts,
  agentTooltipFacts,
  issueLabel,
  issueMark,
  pullRequestLabel,
  pullRequestMark,
  tooltipLines,
  describe,
  pullRequestGlyphName,
  unavailableText,
  workspaceGlyphName,
  workspaceRowFacts,
} from "./rowDescription";

export interface SidebarProps {
  readonly snapshot: AppSnapshot;
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

/**
 * Selecting a row, and where the keyboard goes once it is selected.
 *
 * The selection is the same intent whoever raised it. What differs is what was
 * *meant* by it, and there are only two meanings:
 *
 * **A pointer selection means "take me there."** Somebody clicked a row —
 * expanded or on the rail — and what they want next is the thing they clicked:
 * the editor with its last-typed-into view, or the Agent's terminal. Leaving
 * the keys in a column they reached with the mouse means the next thing they
 * type goes to the arrow-key walk.
 *
 * **A keyboard selection means "and stay here."** Somebody is standing in the
 * Sidebar after `Cmd+Q S` and walking it with the arrows; Return there chooses
 * a row without leaving the list, and the next ↓ has to still be a ↓. Escape
 * is the way out, and it is the same request this makes.
 *
 * Which one it was is on the event and nowhere else: a click raised by a
 * pointer carries a `detail` of at least one, and a click raised by activating
 * a focused button from the keyboard carries zero. So this is read off the
 * activation rather than kept as a flag some other handler has to set and some
 * other handler has to clear — there is no second path to the same selection,
 * and nothing to time out.
 *
 * Where the keyboard actually lands is not decided here and cannot be: the
 * surface is usually a native `WebContentsView` this document cannot focus.
 * `focusSurface` is a request to main, which clears the one fact that says
 * "the person asked for the Sidebar" and then asks `keyboardChild` again — the
 * same door Escape uses, so the two can never come to disagree. It is sent
 * *after* the selection has been applied, because the child the keys belong to
 * is a function of the selection: asked any earlier it would answer with the
 * row that was selected a moment ago.
 */
function useSelectRow(): (
  event: { readonly detail: number },
  intent: AppIntent,
) => void {
  const { dispatch } = useSidebar();
  return useCallback(
    (event: { readonly detail: number }, intent: AppIntent) => {
      const byPointer = event.detail > 0;
      void dispatch(intent).then(() => {
        if (byPointer) void devhub().focusSurface();
      });
    },
    [dispatch],
  );
}

function WorkspaceRow({
  workspace,
  repository,
  snapshot,
  agentProfiles,
  agentProfilesAvailability,
  onCreateAgent,
  onCloseWorkspace,
  onRenameAgent,
  onAgentMenu,
  reorder,
}: {
  readonly workspace: WorkspaceSnapshot;
  /** What it is working on, as of the last look. Absent until the first one. */
  readonly repository: WorkspaceRepositoryWire | undefined;
  readonly snapshot: AppSnapshot;
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
  /** What this row and its Agents need while something is being dragged. */
  readonly reorder: Reorder;
}) {
  const selected =
    snapshot.selection.context.kind === "workspace" &&
    snapshot.selection.context.workspaceId === workspace.id;
  const selectedAgentId =
    snapshot.selection.context.kind === "agent"
      ? snapshot.selection.context.agentId
      : undefined;

  const dispatch = useSidebarDispatch();
  const selectRow = useSelectRow();

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

  // What this row says, for whoever is not reading the row: the screen reader
  // and, in the rail, the pointer. One composition (`rowDescription`), so the
  // two cannot come to say different things.
  // What this row says, for whoever is not reading the row. One list of facts
  // (`rowDescription`) rendered twice: as the sentence a screen reader hears,
  // and as the lines the tooltip page draws behind the row's own marks. Two
  // compositions of the same facts is how a row comes to name its Issue to one
  // reader and not the other, with neither able to tell.
  const facts = workspaceRowFacts(workspace, repository);
  const description = describe(facts);
  const collapsed = snapshot.sidebar.collapsed;

  return (
    <li
      className={`sidebar-tree-item${closing ? " is-closing" : ""}`}
      role="treeitem"
      {...reorder.rowProps({ kind: "workspace", id: workspace.id })}
      // A Workspace on its way out is not somewhere to put anything, and is
      // not something to pick up: it is leaving.
      draggable={!closing}
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
          {/* Which kind of Workspace this is, in the one column every row's
              mark is in — and, when there is a repository behind it, the way
              to that repository's page. The row's link used to be a second
              `repository` mark in the trailing group, which was a drawing of
              the thing this drawing already is. The rail draws the same mark
              from the same function, inside the select button and never as a
              link, which is what makes the rail the row with its words taken
              off. */}
          {collapsed ? null : (
            <WorkspaceGlyph
              workspace={workspace}
              repository={repository}
              description={description}
            />
          )}
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
            aria-label={description}
            // The same facts, drawn. The expanded row shows two of them and
            // the rail shows none, and this is where all of them are — which
            // is why it is the same list and not a shorter version of it.
            data-tooltip-lines={JSON.stringify(tooltipLines(facts))}
            onClick={(event) =>
              selectRow(event, {
                type: "select_context",
                context: { kind: "workspace", workspaceId: workspace.id },
              })
            }
          >
            {/* The rail's one mark, and the expanded row's none.

                In the rail the glyph *is* the entry: the label beside it is
                off, so a mark that opened GitHub would be the only thing left
                to click and the row could not be selected with a pointer at
                all. So the rail draws it here, inside the select button, where
                it cannot be a link. In the expanded row it is a sibling — see
                `WorkspaceGlyph` — because there it is the link and a button
                cannot go inside a button. */}
            {collapsed ? (
              <span className="row-glyph" aria-hidden="true">
                <Glyph name={workspaceGlyphName(workspace.location)} />
              </span>
            ) : null}
            {/* The name, then the branch, on one line that fades out under the
                marks rather than ellipsising into them — see `.row-text`. */}
            <span className="row-text">
              <span className="row-label">{workspace.label}</span>
              {repository?.branch === undefined ? null : (
                <span className="row-branch">
                  {repository.branch}
                  {repository.unborn ? " · empty" : ""}
                </span>
              )}
            </span>
          </button>
          {/* The trailing group: what this row is, as marks, each one its own
              hover. Nothing here is words — the numbers and the titles are in
              the tooltip, where there is room for all of them at once. */}
          {/* Not drawn in the rail at all, rather than drawn and hidden: the
              rail's rule is that the whole entry is the select control, and a
              link that is merely invisible is still a link the pointer can
              find. */}
          {collapsed ? null : <WorkspaceMarks repository={repository} />}
          {/* The links trail the label rather than leading it, which is the one
            place this differs from the sketch: they are buttons, a button
            cannot go inside the row's own button, and putting them before it
            would move the glyph column that every other row lines up with. */}
          {/* Which machine the folder is on is not one of the conditions.
              An Agent runs where its Workspace is, on this Mac or on a host,
              so the row offers it either way; a host DevHub cannot reach says
              so as a failure that names it, which is a different sentence from
              a button that was never there. A closing row still hides it: that
              one is about to stop existing. */}
          {workspace.canCreateAgent && !closing && (
            <button
              className="row-action-button"
              type="button"
              aria-label={`Create agent in ${workspace.label}${agentProfilesAvailability === "unavailable" || agentProfiles.length === 0 ? ", unavailable" : ""}`}
              data-tooltip={
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
              data-tooltip={
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
            // It is computed beside the sentence that says it
            // (`rowDescription`), so the line the row draws and the name a
            // screen reader hears cannot disagree about what stopped.
            const note = agentNote(agent);
            /**
             * A row leads with whatever tells it from the rows beside it.
             *
             * For a Workspace that is its name. For an Agent it is not: the
             * Agents under one Workspace are "Codex" and "Claude", and reading
             * a column of those tells you nothing you did not already know
             * from having started them. What tells them apart is what each one
             * is doing, so that is what leads, at the size a row's own name is
             * set in.
             *
             * An Agent that has not said anything yet leads with its name
             * instead. The leading text is never empty: a row whose only words
             * were 11px dimmed would be a row you cannot read the name of.
             */
            const leading = agent.activity ?? agent.displayName;
            const agentFacts = agentRowFacts(agent, {
              label: workspace.label,
              icon: workspaceGlyphName(workspace.location),
            });
            const agentDescription = describe(agentFacts);
            /**
             * The Agent's own name, when the name is a name.
             *
             * `agentLabelFor` gives the only Claude under a Workspace the bare
             * word "Claude", and two of them "Claude 1" and "Claude 2". The
             * bare word is the *kind* of Agent and nothing else — it is on the
             * row's status mark, it is what you chose when you started it, and
             * a row that spent its remaining width repeating it was spending it
             * on the one fact nobody was going to read. What is worth keeping
             * is what tells two Agents apart: the ordinal, or the name somebody
             * gave it. So the kind word is dropped and anything else is kept.
             */
            const profileName = agentProfiles.find(
              (profile) => profile.id === agent.profileId,
            )?.displayName;
            const naming =
              agent.activity && agent.displayName !== profileName
                ? agent.displayName
                : undefined;
            return (
              <li
                key={agent.id}
                role="treeitem"
                {...reorder.rowProps({
                  kind: "agent",
                  id: agent.id,
                  workspaceId: workspace.id,
                })}
                draggable={!closing}
                aria-level={2}
                aria-selected={agentSelected}
              >
                <div
                  className={`sidebar-row agent-row${agentSelected ? " is-selected" : ""}${unreadShows(agent.status, agent.unread) ? " is-unread" : ""}`}
                  data-control-state={agent.controlState.kind}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    onAgentMenu(agent, {
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                >
                  <div className="row-head">
                    {/* The icon column, and what an Agent puts in it: its one
                        status mark — the unread dot included, see
                        `unreadShows` in `StatusMark.tsx`.

                        It is the same column, at the same x, that a Workspace
                        draws its folder in and Scratch draws its terminal in.
                        Nothing is in front of it and the depth is behind it,
                        in the connector, so every status in the list is at one
                        x whatever row it is on — which is what makes them a
                        column a person can run an eye down, and what lets the
                        rail be these rows with the connector and the words
                        taken off. The button's hit area covers the whole row
                        (`.sidebar-context-button::after`), so the mark is
                        still part of what selects the row. */}
                    <span className="row-glyph">
                      <StatusMark status={agent.status} unread={agent.unread} />
                    </span>
                    <button
                      className="sidebar-context-button"
                      type="button"
                      data-tree-item-id={`agent:${agent.id}`}
                      tabIndex={agentSelected ? 0 : -1}
                      aria-current={agentSelected ? "page" : undefined}
                      aria-label={agentDescription}
                      // The one fact, for the rail — where the words are off
                      // and the pointer is the only way to ask which Agent
                      // this is. Not the accessible name: a reader has no mark
                      // to look at and is told the status in words, and a
                      // person looking at the box can see the mark and the row
                      // it belongs to. See `agentTooltipFacts`.
                      data-tooltip-lines={JSON.stringify(
                        tooltipLines(agentTooltipFacts(agent)),
                      )}
                      disabled={agent.controlState.kind === "stopping"}
                      // Command-click opens the Agent beside its workbench; a
                      // plain click gives it the whole content area. The same
                      // pair as Return and Command-Return in the picker, because
                      // it is the same choice, and it is stated in the intent
                      // rather than applied afterwards.
                      onClick={(event) =>
                        selectRow(event, {
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
                      {/* What it is doing, then which Agent it is, then why it
                          may not be doing it — one line, fading out under the
                          row's own controls. */}
                      <span className="row-text">
                        <span className="row-label">{leading}</span>
                        {naming ? (
                          <span className="row-name">{naming}</span>
                        ) : null}
                        {note ? <span className="row-note">{note}</span> : null}
                      </span>
                    </button>
                    {agent.controlState.kind === "stopping" ? null : (
                      <button
                        className="row-action-button agent-row-action"
                        type="button"
                        aria-label={`Stop ${agent.displayName}`}
                        data-tooltip={stopFailed ? "Retry stop" : "Stop agent"}
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
 * A Workspace's folder glyph, and — when there is a repository behind it — the
 * row's one way out to GitHub.
 *
 * There were two marks saying this. The folder said *this is a checkout*, in
 * the leading column; a `repository` mark in the trailing group said *and here
 * is its page*, in a second silhouette a person had to learn in order to press
 * it. They are one question — show me this on GitHub — asked about the one
 * thing the folder already stands for, so the folder answers it.
 *
 * A worktree leads to the same page, because that is the page it has: a
 * worktree is not a separate thing on GitHub. Which checkout it is is a line in
 * the tooltip, behind the `worktree` mark, where it is a fact rather than a
 * shape to tell apart at thirteen pixels.
 *
 * With no repository it is a `span`: inert, unfocusable, and with no hover of
 * its own. Not a disabled button — a button that is never pressable is a
 * control that has to explain itself, and there is nothing here to explain. The
 * row is still selected by clicking it, because the select button's hit area
 * covers the whole row underneath.
 *
 * It says the row and then what it does. The accessible name is the row's own
 * description — the same sentence the select button carries, so the link is not
 * a second, shorter account of which Workspace this is — with the action after
 * it.
 */
function WorkspaceGlyph({
  workspace,
  repository,
  description,
}: {
  readonly workspace: WorkspaceSnapshot;
  readonly repository: WorkspaceRepositoryWire | undefined;
  /** What this row is, in the words its select button uses. */
  readonly description: string;
}) {
  const { openExternalUrl } = useSidebar();
  const glyph = <Glyph name={workspaceGlyphName(workspace.location)} />;
  const url = repository?.repositoryUrl;
  if (url === undefined) {
    return (
      <span className="row-glyph" aria-hidden="true">
        {glyph}
      </span>
    );
  }
  return (
    <button
      className="row-glyph row-glyph-button"
      type="button"
      aria-label={`${description}, open on GitHub`}
      data-tooltip={`Open ${url.replace(/^https:\/\//, "")} on GitHub`}
      onClick={() => {
        openExternalUrl(url);
      }}
    >
      {glyph}
    </button>
  );
}

/**
 * What a Workspace row ends with: marks, and only marks.
 *
 * The row's words are its name and its branch, and they are the whole of what
 * it says in words. What is left is what the row is *for* and how it is going
 * out — the Issue and the pull request — in the order a person asks about them.
 *
 * What this is a checkout of is not here. It is the folder glyph at the row's
 * leading edge, which is the same drawing of the same thing and is the link to
 * the repository's page (`WorkspaceGlyph`); a `repository` mark in this group
 * was that question asked a second time, in a second silhouette. The machine is
 * not here for the same reason — a Workspace on another machine wears the
 * `remote` silhouette in that one column — and which machine it is, like which
 * worktree this is, is a line in the tooltip behind its own mark.
 *
 * They are marks and not words because there is one line now and a line is
 * about twenty characters wide. A number and a title beside them would be
 * spending that line on what the tooltip says in full a moment later — and it
 * is the tooltip that says it: each mark carries its own sentence, so hovering
 * the Issue gives the Issue and hovering the row gives the row.
 *
 */
function WorkspaceMarks({
  repository,
}: {
  readonly repository: WorkspaceRepositoryWire | undefined;
}) {
  const { openExternalUrl } = useSidebar();
  const issue = repository?.issue;
  const pullRequest = repository?.pullRequest;
  return (
    <span className="row-marks">
      {issue ? (
        <button
          className={`row-link-button is-issue-${issue.state}`}
          type="button"
          aria-label={issueLabel(issue)}
          data-tooltip-lines={JSON.stringify([
            {
              icon: issue.state === "closed" ? "issueClosed" : "issueOpen",
              text: issueMark(issue),
            },
          ])}
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
          aria-label={pullRequestLabel(pullRequest)}
          data-tooltip-lines={JSON.stringify([
            {
              icon: pullRequestGlyphName(pullRequest.state),
              text: pullRequestMark(pullRequest),
            },
          ])}
          onClick={() => {
            openExternalUrl(pullRequest.url);
          }}
        >
          <Glyph name={pullRequestGlyphName(pullRequest.state)} />
        </button>
      ) : null}
      {/* Asking. The branch is read every couple of seconds and GitHub once a
          minute, so a branch just switched to is on screen well before what it
          is about — and without this the gap looks exactly like a branch that
          is about no Issue. */}
      {repository?.pending ? (
        <span
          className="mac-spinner row-issue-spinner"
          role="status"
          aria-label={`Reading Issue #${String(repository.pending.number)}`}
          data-tooltip={`Reading #${String(repository.pending.number)}`}
        />
      ) : null}
      {/* The row cannot say what it is working on, and this is why. It is a
          mark rather than a sentence now, and it is still on the row rather
          than only in the tooltip: a failure nobody can see without hovering
          is a failure nobody sees. It wears the danger ink at rest — the one
          thing in this group that is coloured before it is asked — because it
          is the one thing here that is not simply context. */}
      {repository?.unavailable ? (
        <span
          className="row-link-button row-mark-unavailable"
          role="img"
          aria-label={unavailableText(repository.unavailable)}
          data-tooltip={unavailableText(repository.unavailable)}
        >
          <Glyph name="statusError" />
        </span>
      ) : null}
    </span>
  );
}

function ScratchRow({
  snapshot,
  rowRef,
}: {
  readonly snapshot: AppSnapshot;
  /** Where `Cmd+Q S` lands when Scratch is what is selected. */
  readonly rowRef: React.Ref<HTMLButtonElement>;
}) {
  const selectRow = useSelectRow();
  const selected = snapshot.selection.context.kind === "global";
  return (
    <button
      ref={rowRef}
      className={`sidebar-row scratch-row${selected ? " is-selected" : ""}`}
      type="button"
      aria-current={selected ? "page" : undefined}
      aria-label="Scratch terminal"
      data-tooltip={SCRATCH_NAME}
      onClick={(event) =>
        selectRow(event, {
          type: "select_context",
          context: { kind: "global" },
        })
      }
    >
      {/* Mirrors a Workspace row's first line so the glyph and the label land
          on the same columns. It has no second line: there is
          nothing a Scratch terminal is working on. */}
      <span className="row-head">
        <span className="row-glyph" aria-hidden="true">
          <Glyph name="terminal" />
        </span>
        <span className="sidebar-context-button">
          {/* In `.row-text` like every other row's words, because that is what
              the rail takes off. A label outside it would be the one row whose
              name survived the collapse. */}
          <span className="row-text">
            <span className="row-label">{SCRATCH_NAME}</span>
          </span>
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
          {/* Empty, and still here: the row is the picture of one that has just
              stopped existing, so its name has to stay on the column the names
              above and below it are on. */}
          <span className="row-glyph" />
          <span className="sidebar-context-button">
            <span className="row-text">
              <span className="row-label">{label}</span>
            </span>
          </span>
        </div>
      </div>
    </li>
  );
}

export function Sidebar({ snapshot }: SidebarProps) {
  const dispatchIntent = useSidebarDispatch();
  const { dispatch, agentProfiles, repositoryStatus, closeWorkspace, retry } =
    useSidebar();
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
   * it acts on is drawn here: the picker's trigger, the Sidebar's roving tab
   * stop, the projection this page is retrying. They arrive on one channel and
   * are answered in one place, so a command added later is a line here rather
   * than a second listener somewhere with its own idea of when it is mounted.
   *
   * It is a shorter list than it was, and it goes on shrinking as the pages
   * split: a command whose subject is drawn on another page is delivered to
   * that page instead of being routed through whichever page happened to be
   * listening.
   */
  useEffect(
    () =>
      devhub().onMenuCommand((command) => {
        // File ▸ Add Workspace… is the same command as the sidebar's +, so it
        // opens the same picker rather than a second way of adding a workspace.
        if (command === "open_workspace_picker") openPicker();
        // Main's half of `Cmd+Q S` has already put the keyboard in this view;
        // this is the half only this page can do, which is saying which row it
        // lands on. The other end of that chord — the Agent's pane — needs no
        // message at all any more: the Agents are a view of their own, so main
        // focuses them the way it focuses a workbench.
        if (command === "focus_sidebar") focusSidebar();
        // "Try Again" on an app-scoped notice. The notice is drawn on the
        // `toasts` view and what it restarts is this page's projection, so the
        // button's two ends are in two pages and main is what joins them. The
        // chord that puts a notice *away* is not here any more, for the same
        // reason in the other direction: the page that has the notice is the
        // page that can retire it.
        if (command === "retry_app") retry();
      }),
    [focusSidebar, openPicker, retry],
  );

  const [inProgressWidth, setInProgressWidth] = useState<number | null>(null);
  const renderedWidth = inProgressWidth ?? snapshot.sidebar.width;
  const collapsed = snapshot.sidebar.collapsed;

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
        // The model has the number now, so the preview is over: main goes back
        // to reading the sidebar's width off the projection.
        void devhub().previewLayout({ sidebarWidth: null });
      });
    },
    [dispatch],
  );

  // The handle moves under the pointer and the workbench beside it is a native
  // view main has to move with it — and main computes where that view goes.
  // What is reported is the *pointer*, which this page owns while the drag
  // lasts, and never a rectangle, which it does not. See `windowLayout.ts`.
  const previewResize = useCallback((width: number) => {
    setInProgressWidth(width);
    void devhub().previewLayout({ sidebarWidth: width });
  }, []);

  /**
   * Rearranging the list by hand.
   *
   * One piece of state for the whole tree, like the row menu above it: only one
   * row can be in the air. Where it may land is `model/workspaceOrder.ts`'s
   * answer and not this component's — the same answer `Alt+↑` gets.
   */
  const reorder = useReorder(snapshot);

  return (
    <aside
      className="sidebar"
      aria-label="Workspace navigation"
      // Collapsed is drawn and never rendered differently: the same rows in the
      // same order, with the words taken off. So the tree the arrows walk, the
      // labels a screen reader reads and the roving tab stop are one set of
      // markup in both states, and there is no second render path to keep in
      // step with the first.
      data-collapsed={collapsed ? "true" : undefined}
      // A row is in the air, so the rows it may not land among are dimmed:
      // the lit part of the list is the range. See `styles/reorder.css`.
      data-reordering={reorder.active ? "true" : undefined}
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
      <div className="sidebar-scroll-region">
        <ScratchRow snapshot={snapshot} rowRef={scratchRowRef} />
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
              data-tooltip="Assign issue"
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
              data-tooltip="Open workspace picker"
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
                // Option moves the row instead of moving to it — the drag,
                // under a key, so that a list nobody can drag is still a list
                // that can be arranged. The chord `Cmd+Q Alt+↑` raises the
                // same intent through the same rule; this is the version that
                // needs no prefix once the keyboard is already in the tree.
                if (event.altKey) {
                  const treeItemId = activeItem.dataset.treeItemId;
                  const source = treeItemId
                    ? sourceOfTreeItem(snapshot, treeItemId)
                    : undefined;
                  const intent = source
                    ? moveIntent(snapshot, source, delta)
                    : undefined;
                  // The roving tab stop is keyed to the row's id, and the row
                  // keeps its id wherever it lands, so the keyboard follows it
                  // without anything here having to put it back.
                  if (intent) dispatchIntent(intent);
                  return;
                }
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
                  agentProfiles={agentProfiles.profiles}
                  agentProfilesAvailability={agentProfiles.availability}
                  onCreateAgent={openAgentPicker}
                  onCloseWorkspace={closeWorkspaceRow}
                  onRenameAgent={openRename}
                  onAgentMenu={openAgentMenu}
                  reorder={reorder}
                />
              ),
            )}
          </ul>
        ) : (
          <p className="sidebar-empty">No workspaces open</p>
        )}
      </div>
      {/* A rail has no width to set: it is exactly its glyph column, or — on a
          window with no title bar — exactly what the traffic lights need. The
          handle is absent rather than disabled, because a
          disabled separator is a keyboard stop that answers nothing — and the
          width it would set is still there, waiting, for when the Sidebar
          comes back. */}
      {collapsed ? null : (
        <SidebarResizeHandle
          width={renderedWidth}
          onPreview={previewResize}
          onCommit={resize}
        />
      )}
      {/* One tooltip for the whole tree, decided here and drawn on a child of
          the window. See `RowTooltip.tsx` — this view is 44px wide on a
          collapsed rail, so a tooltip drawn in it is clipped by it, which is
          the exact failure `title` was replaced to avoid. The side is a fact
          about the row: a rail is a glyph with its sentence beside it, and an
          expanded row is a line of text with its sentence underneath. */}
      <RowTooltip prefer={collapsed ? "right" : "below"} />
      {agentMenu ? (
        <RowMenu
          at={agentMenu.at}
          label={`${agentMenu.agent.displayName} actions`}
          items={agentMenuItems(agentMenu.agent, dispatchIntent, openRename)}
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
