import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  type AgentProfile,
  type AgentProfilesAvailabilityWire,
  type AgentSnapshot,
  type AppIntent,
  type AppSnapshot,
  type WorkspaceSnapshot,
} from "../../../ipc/appShell";
import { clampSidebarWidth, sidebarWorkspaces } from "../../../ipc/appShell";
import {
  EMPTY_BOARD,
  type AgentOrchestrationWire,
  type WorkspaceRepositoryWire,
} from "../../../ipc/contract";
import { closingDeletesWorktree } from "../../../model/worktrees";
import { agentLeadingText } from "../../../model/domain";
import {
  useChordArmed,
  useSidebar,
  useSidebarDispatch,
  type SidebarValue,
} from "../../sidebar/SidebarContext";
import { UsageLimits } from "./UsageLimits";
import { devhub } from "../../sidebar/client";
import { isImeComposing } from "../../accessibility/ime";
import { Glyph, type GlyphName } from "./icons";
import { RowTooltip } from "./RowTooltip";
import {
  agentMenuItems,
  openRowMenu,
  workspaceMenuItems,
  type RowMenuItem,
} from "./rowMenu";
import {
  arrangementOf,
  groupByLane,
  orchestratorItems,
  type LaneGroup,
  type LaneId,
  type LaneSpec,
  type OrchestratorItem,
} from "./orchestratorLanes";
import {
  useOrchestratorFolds,
  useSettledArrangement,
  type OrchestratorFolds,
} from "./orchestratorGroup";
import { useGlide } from "../../glide";
import { StatusMark, unreadShows } from "./StatusMark";
import { mergeExitingRows, useClosingExit } from "./closingExit";
import {
  laneColorToken,
  primaryLane,
  statusLetter,
} from "../../../model/projectStatus";
import { moveIntent, sourceOfTreeItem } from "./reorder";
import { useReorder, type Reorder } from "./useReorder";
import { useSidebarOverlay } from "./useSidebarOverlay";
import {
  agentNote,
  agentRowFacts,
  agentTooltipFacts,
  issueLabel,
  checksBadge,
  hasUnresolvedConversations,
  pullRequestFacts,
  tooltipLines,
  describe,
  pullRequestGlyphName,
  unavailableText,
  rowIdentity,
  type RowIdentity,
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
 * Sidebar after `focus_sidebar` (from the command palette) and walking it
 * with the arrows; Return there chooses a row without leaving the list, and
 * the next ↓ has to still be a ↓. Escape is the way out, and it is the same
 * request this makes.
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
 *
 * **A click is a destination.** The same `detail` says whether the row is a
 * place for Back and Forward: a click on it is going there on purpose, so the
 * selection carries `reason: "explicit"` and is recorded at once, where
 * walking the list from the keyboard is passing over rows and records only
 * what is then used (`NavigationReason`, `docs/window-and-pages.md`).
 */
function useSelectRow(): (
  event: { readonly detail: number },
  intent: AppIntent,
) => void {
  const { dispatch } = useSidebar();
  return useCallback(
    (event: { readonly detail: number }, intent: AppIntent) => {
      const byPointer = event.detail > 0;
      const chosen: AppIntent =
        byPointer && intent.type === "select_context"
          ? { ...intent, reason: "explicit" }
          : intent;
      void dispatch(chosen).then(() => {
        if (byPointer) void devhub().focusSurface();
      });
    },
    [dispatch],
  );
}

function WorkspaceRow({
  workspace,
  identity,
  repository,
  snapshot,
  agentProfiles,
  agentProfilesAvailability,
  chordDigit,
  onCreateAgent,
  onCloseWorkspace,
  onAgentMenu,
  onWorkspaceMenu,
  reorder,
  level = 1,
  underOrchestrator = false,
}: {
  /** `aria-level`: 1 at the top, 3 under one of the Orchestrator's lanes. */
  readonly level?: number;
  /**
   * Under the Orchestrator row, in a lane: where it stands is the lanes'
   * to say, so it is not picked up, and its managed Agents wear no wash.
   */
  readonly underOrchestrator?: boolean;
  /** The digit that selects this row while the prefix is armed, if it has one. */
  readonly chordDigit?: number | undefined;
  readonly workspace: WorkspaceSnapshot;
  /** Its mark, and whether it is Scratch. See `rowIdentity`. */
  readonly identity: RowIdentity;
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
  readonly onAgentMenu: AgentMenu;
  /**
   * A right-click on the row: reopening an editor that is in a dev container
   * on the Workspace's own machine, and the row's close. Scratch outside a dev
   * container has nothing to offer and no menu.
   */
  readonly onWorkspaceMenu: (
    workspace: WorkspaceSnapshot,
    at: { x: number; y: number },
    menu: { readonly deletesWorktree: boolean; readonly fixed: boolean },
  ) => void;
  /** What this row and its Agents need while something is being dragged. */
  readonly reorder: Reorder;
}) {
  const selected =
    snapshot.selection.context.kind === "workspace" &&
    snapshot.selection.context.workspaceId === workspace.id;

  const selectRow = useSelectRow();
  const { openExternalUrl } = useSidebar();

  // A Workspace on its way out takes no instructions. This is the view half
  // of a fact the model already enforces — a close that is running refuses the
  // operations underneath anyway — and it is here so that the refusal is never
  // something a person has to run into: the row goes quiet at the same moment
  // it stops being able to answer. It covers the Agents as well as the
  // Workspace because they are going with it.
  const closing = workspace.close.kind === "running";
  // The orchestrator agent is drawn on its own row, above Scratch, and not
  // here as well.
  const rowAgents = workspace.agents.filter(
    (agent) => agent.id !== snapshot.orchestratorAgentId,
  );

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
  // A managed Workspace whose agent is stopped (完了): the agent that did
  // its work, which can be brought back with its conversation, and the
  // memo of that work — said in the tooltip, and as a quiet mark.
  const resumeBoard =
    (useSidebar() as Partial<SidebarValue>).board ?? EMPTY_BOARD;
  const resumable =
    underOrchestrator && rowAgents.length === 0
      ? resumableWorkAt(resumeBoard, workspace.id)
      : undefined;
  const facts = [
    ...workspaceRowFacts(workspace, repository),
    ...(resumable === undefined ? [] : resumable.facts),
  ];
  const issue = repository?.issue;
  const description = describe(facts);
  const collapsed = snapshot.sidebar.collapsed;
  // What the Workspace's own terminals are doing — absent when idle and read,
  // which is drawn as nothing (there is no "finished" check for a terminal).
  const terminals = workspace.terminals;

  return (
    <li
      className={`sidebar-tree-item${closing ? " is-closing" : ""}`}
      role="treeitem"
      {...reorder.rowProps({ kind: "workspace", id: workspace.id })}
      // A Workspace on its way out is not somewhere to put anything, and is
      // not something to pick up: it is leaving. Scratch is not picked up
      // either: it is first because it is Scratch, not because it was put there.
      draggable={!closing && !identity.fixed && !underOrchestrator}
      aria-level={level}
      aria-selected={selected}
      aria-busy={closing || undefined}
      // A Workspace is always open. The attribute states that, and there is
      // nothing that can change it.
      aria-expanded={rowAgents.length > 0 ? true : undefined}
    >
      <div
        className={`sidebar-row workspace-row${identity.fixed ? " is-scratch" : ""}${selected ? " is-selected" : ""}${terminals !== undefined && unreadShows(terminals.status, terminals.unread) ? " is-unread" : ""}`}
        data-state={workspace.state.kind}
        // The same facts, drawn. The expanded row shows two of them and the
        // rail shows none, and this is where all of them are — which is why it
        // is the same list and not a shorter version of it.
        //
        // On the row, because the row is what the tooltip is about and what
        // the pointer is on: the select button's hit area is stretched over
        // the whole row (`.sidebar-context-button::after`), so what a person
        // is pointing at is the row whichever part of it they are over, and
        // the box goes beside the row and not beside the button. Nothing inside
        // the row has a tooltip of its own — not the Issue or pull request
        // mark, not the unavailable mark, not +, × or the
        // spinner — so the pointer on any of them is the pointer on the row,
        // and what they would have said is a line here. Scratch has always
        // stated it here.
        data-tooltip-lines={JSON.stringify(tooltipLines(facts))}
        onContextMenu={
          !identity.fixed && !closing
            ? (event) => {
                event.preventDefault();
                onWorkspaceMenu(
                  workspace,
                  { x: event.clientX, y: event.clientY },
                  { deletesWorktree, fixed: identity.fixed },
                );
              }
            : undefined
        }
      >
        <div className="row-head">
          {/* Which kind of Workspace this is, in the one column every row's
              mark is in. Not a link and not a button: the select button's hit
              area covers it, so a click on it selects the row. The rail draws
              the same mark inside the select button, which is what makes the
              rail the row with its words taken off. */}
          {collapsed ? null : (
            <WorkspaceGlyph glyphName={identity.glyph} digit={chordDigit} />
          )}
          <button
            className={`sidebar-context-button${issue ? " has-issue-title" : ""}`}
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
            onClick={(event) =>
              selectRow(event, {
                type: "select_context",
                context: { kind: "workspace", workspaceId: workspace.id },
              })
            }
          >
            {/* The rail's one mark, and the expanded row's none: in the rail
                the glyph *is* the entry, the label beside it being off. */}
            {collapsed ? (
              <WorkspaceGlyph glyphName={identity.glyph} digit={chordDigit} />
            ) : null}
            {/* The name, then the branch, on one line that fades out under the
                marks rather than ellipsising into them — see `.row-text`. */}
            <span className="row-text">
              <span className="row-label">{workspace.label}</span>
              {repository?.branch === undefined || issue ? null : (
                <span className="row-branch">
                  {repository.branch}
                  {repository.unborn ? " · empty" : ""}
                </span>
              )}
            </span>
          </button>
          {/* When the Issue is known it takes the branch's place after the
              name — as its icon, and only its icon. The title used to follow
              it as a quiet note, and a title is a sentence: on a line about
              twenty characters wide it pushed the name and the marks around
              and was faded out half-read anyway. So the words live where there
              is room for all of them, in the row's tooltip (number, title,
              repository, Projects) and in this mark's accessible name; the row says
              *that* it has an Issue and in which state. The branch is what the
              Issue was read *from*, so once the Issue is known the Issue is
              still the better answer to "what is this". A button and not part
              of the select button, because a button cannot go inside a button;
              it is raised above the select button's hit area like every other
              mark — see `.row-issue-title`. */}
          {collapsed || !issue ? null : (
            <button
              className={`row-issue-title is-issue-${issue.state}`}
              type="button"
              aria-label={issueLabel(issue)}
              onClick={() => {
                openExternalUrl(issue.url);
              }}
            >
              <Glyph
                name={issue.state === "closed" ? "issueClosed" : "issueOpen"}
              />
              <ProjectBadge
                issue={issue}
                repository={repository?.issueRepository?.repository}
              />
            </button>
          )}
          {/* The trailing group: what this row is, as marks, none with a
              hover of its own. Nothing here is words — the numbers and the titles are in
              the tooltip, where there is room for all of them at once. */}
          {/* Not drawn in the rail at all, rather than drawn and hidden: the
              rail's rule is that the whole entry is the select control, and a
              link that is merely invisible is still a link the pointer can
              find. */}
          {/* The Workspace's terminals, in the mark an Agent's row leads with:
              working while a command in one of its tmux panes is printing,
              unread once one finished (or went quiet) unseen. Before the
              trailing group, so the pull request stays the last column. */}
          {collapsed || terminals === undefined ? null : (
            <span className="row-terminal-activity">
              <StatusMark
                status={terminals.status}
                unread={terminals.unread}
                subject="Terminal"
              />
            </span>
          )}
          {collapsed || resumable === undefined ? null : (
            <span className="row-resumable" aria-hidden="true">
              再開可
            </span>
          )}
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
              // Why it is off, or that the profiles behind it need
              // attention, is in its name and nowhere on hover: the button
              // has no tooltip of its own (no small control in a row does).
              aria-label={`Create agent in ${workspace.label}${createAgentCaveat(agentProfilesAvailability, agentProfiles.length)}`}
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
            icon that means the same thing. Scratch has none: it is today's
            folder, and tomorrow replaces it without anybody closing it.

            It says which of the two closes it is, because on a worktree row
            closing deletes the folder (`closingDeletesWorktree`). The ellipsis
            is the rest of that promise: a question may follow, and does
            whenever there is anything in the folder to lose. */}
          {!closing && !identity.fixed && (
            <button
              className="row-action-button"
              type="button"
              aria-label={
                deletesWorktree
                  ? `Close the worktree ${workspace.label}`
                  : `Close ${workspace.label}`
              }
              // No hover of its own. That the last close stopped, or that
              // this one removes a worktree and asks first, is a line in the
              // row's tooltip ("Retry close: …", "Close worktree…").
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
      <AgentTree
        workspace={workspace}
        agents={rowAgents}
        identity={identity}
        snapshot={snapshot}
        agentProfiles={agentProfiles}
        closing={closing}
        onAgentMenu={onAgentMenu}
        reorder={reorder}
        level={level + 1}
        underOrchestrator={underOrchestrator}
      />
    </li>
  );
}

/**
 * A Workspace's Agents, under its row: Scratch's, an ordinary Workspace's,
 * and a Workspace's under the Orchestrator row. One tree, so indentation,
 * status marks, unread and the drag rules are the same wherever an Agent is
 * listed.
 */
function AgentTree({
  workspace,
  agents,
  identity,
  snapshot,
  agentProfiles,
  closing,
  onAgentMenu,
  reorder,
  level = 2,
  underOrchestrator = false,
}: {
  readonly workspace: WorkspaceSnapshot;
  /** The Agents drawn: the orchestrator agent is drawn on its own row. */
  readonly agents: readonly AgentSnapshot[];
  readonly identity: RowIdentity;
  readonly snapshot: AppSnapshot;
  readonly agentProfiles: readonly AgentProfile[];
  readonly closing: boolean;
  readonly onAgentMenu: AgentMenu;
  readonly reorder: Reorder;
  /** `aria-level` of the Agents: their Workspace's, and one. */
  readonly level?: number;
  /** Drawn under the Orchestrator row: the place says "managed". */
  readonly underOrchestrator?: boolean;
}) {
  if (agents.length === 0) return null;
  return (
    <ul
      className="agent-tree"
      role="group"
      aria-label={`${workspace.label} agents`}
    >
      {agents.map((agent) => (
        <AgentRowItem
          key={agent.id}
          agent={agent}
          workspace={workspace}
          identity={identity}
          snapshot={snapshot}
          agentProfiles={agentProfiles}
          closing={closing}
          onAgentMenu={onAgentMenu}
          reorder={reorder}
          level={level}
          underOrchestrator={underOrchestrator}
        />
      ))}
    </ul>
  );
}

/** A right-click on an Agent's row; `more`, what that row adds to the menu. */
type AgentMenu = (
  agent: AgentSnapshot,
  at: { x: number; y: number },
  more?: readonly RowMenuItem[],
) => void;

/**
 * What an Agent's row says for its Workspace, when the two are one row: a
 * Workspace under the Orchestrator row with one Agent in it is drawn as that
 * Agent's row (`ManagedWorkspaceItem`).
 */
interface MergedWorkspace {
  /** `#128`, `PR #517`: what it is about, quiet, after the Agent's words. */
  readonly reference: string | undefined;
  /** The Workspace's own tooltip lines, after the Agent's. */
  readonly tooltip: ReturnType<typeof tooltipLines>;
  /** The Workspace's half of the row's name, for a screen reader. */
  readonly description: string;
  /** The Workspace's items, after the Agent's: Show Editor, Close. */
  readonly menu: readonly RowMenuItem[];
  /** The Workspace's editor is selected: the row is the one highlighted. */
  readonly selected: boolean;
}

/** One Agent's row: under its Workspace, a helper, or a merged row. */
function AgentRowItem({
  agent,
  workspace,
  identity,
  snapshot,
  agentProfiles,
  closing,
  onAgentMenu,
  reorder,
  level,
  underOrchestrator = false,
  draggable = true,
  merged,
}: {
  readonly agent: AgentSnapshot;
  readonly workspace: WorkspaceSnapshot;
  readonly identity: RowIdentity;
  readonly snapshot: AppSnapshot;
  readonly agentProfiles: readonly AgentProfile[];
  readonly closing: boolean;
  readonly onAgentMenu: AgentMenu;
  readonly reorder: Reorder;
  readonly level: number;
  readonly underOrchestrator?: boolean;
  readonly draggable?: boolean;
  readonly merged?: MergedWorkspace;
}) {
  const dispatch = useSidebarDispatch();
  const selectRow = useSelectRow();
  // What the orchestration says of each Agent (a Sidebar with no board: none).
  const sidebarBoard =
    (useSidebar() as Partial<SidebarValue>).board ?? EMPTY_BOARD;
  const agentStates = sidebarBoard.agentStates ?? {};
  // The last triage's priority (`orchestrator priority set`), said in the
  // tooltip only: the row stays as calm as it was.
  const agentPriority = sidebarBoard.agentPriorities?.[agent.id];
  const selectedAgentId =
    snapshot.selection.context.kind === "agent"
      ? snapshot.selection.context.agentId
      : undefined;
  const alsoSelected = merged?.selected === true;
  const agentSelected = selectedAgentId === agent.id || alsoSelected;
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
   * Unless somebody named it. A name a person gave an Agent — in the
   * rename sheet, or with `devhub --tell` when it was started — is
   * not "Claude" again: it is the word they chose to tell this one
   * from the rest, and the word they will scan the column for. So it
   * leads, and what the Agent is doing follows it, dimmed.
   *
   * An Agent that has not said anything yet leads with its name
   * instead. The leading text is never empty: a row whose only words
   * were 11px dimmed would be a row you cannot read the name of.
   * The rule is `agentLeadingText`, which the window title reads too.
   */
  const leading = agentLeadingText(agent);
  const agentFacts = agentRowFacts(agent, {
    label: workspace.label,
    icon: identity.glyph,
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
   * is what tells two Agents apart: the ordinal. So the kind word is
   * dropped and anything else is kept.
   *
   * A named Agent's name is already leading, so what follows it is
   * the other thing: what it is doing.
   */
  const profileName = agentProfiles.find(
    (profile) => profile.id === agent.profileId,
  )?.displayName;
  const naming = agent.named
    ? agent.activity
    : agent.activity && agent.displayName !== profileName
      ? agent.displayName
      : undefined;
  return (
    <li
      role="treeitem"
      {...reorder.rowProps({
        kind: "agent",
        id: agent.id,
        workspaceId: workspace.id,
      })}
      draggable={!closing && draggable}
      aria-level={level}
      aria-selected={agentSelected}
    >
      <div
        className={`sidebar-row agent-row${agentSelected ? " is-selected" : ""}${unreadShows(agent.status, agent.unread) ? " is-unread" : ""}${agent.managed === true && !underOrchestrator ? " is-managed" : ""}${merged === undefined ? "" : " is-merged"}`}
        data-control-state={agent.controlState.kind}
        // The one fact, for the rail — where the words are off and
        // the pointer is the only way to ask which Agent this is.
        // Not the accessible name: a reader has no mark to look at
        // and is told the status in words, and a person looking at
        // the box can see the mark and the row it belongs to. See
        // `agentTooltipFacts`.
        //
        // On the row and not on the select button, and on the rail
        // that is the difference between a tooltip and none. In the
        // rail an Agent's button holds nothing — its mark is the
        // sibling beside it and its words are off — so it is a
        // zero-by-zero box, and a tooltip anchored on it had no
        // rectangle to be beside: `RowTooltip` clips the anchor to
        // the column and drops what comes back empty, which is
        // exactly what a row with no height does. The row is what
        // the tooltip is about in either state, so the row is what
        // it is anchored on.
        data-tooltip-lines={JSON.stringify([
          ...tooltipLines(agentTooltipFacts(agent, agentStates[agent.id])),
          ...(agentPriority === undefined
            ? []
            : tooltipLines([{ text: `priority: ${agentPriority}` }])),
          ...(merged?.tooltip ?? []),
        ])}
        // The prompt cache's line is a countdown, composed when the
        // tooltip is drawn (`RowTooltip`), not when the row is.
        data-tooltip-cache={
          agent.promptCache === undefined
            ? undefined
            : JSON.stringify(agent.promptCache)
        }
        onContextMenu={(event) => {
          event.preventDefault();
          onAgentMenu(
            agent,
            {
              x: event.clientX,
              y: event.clientY,
            },
            merged?.menu,
          );
        }}
      >
        <div className="row-head">
          {/* An Agent's icon column, and what it puts in it: its
                one status mark — the unread dot included, see
                `unreadShows` in `StatusMark.tsx`.

                Indented the way a file tree draws a child: right of
                the connector, under its Workspace's name, so which
                Workspace an Agent belongs to is said by where it
                stands as well as by the guide. In the rail it comes
                back to the one column every row leads with. The
                button's hit area covers the whole row
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
            aria-label={
              merged === undefined
                ? agentDescription
                : `${agentDescription}, ${merged.description}`
            }
            disabled={agent.controlState.kind === "stopping"}
            // Option-click opens the Agent beside its workbench; a
            // plain click gives it the whole content area. The same
            // pair as Return and Option-Return in the picker, because
            // it is the same choice, and it is stated in the intent
            // rather than applied afterwards.
            onClick={(event) =>
              selectRow(event, {
                type: "select_context",
                context: { kind: "agent", agentId: agent.id },
                split: event.altKey,
              })
            }
          >
            {/* What it is doing, then which Agent it is — or, for an
                  Agent somebody named, the other way round — then why
                  it may not be doing it: one line, fading out under
                  the row's own controls. */}
            <span className="row-text">
              <span className="row-label">{leading}</span>
              {naming ? <span className="row-name">{naming}</span> : null}
              {note ? <span className="row-note">{note}</span> : null}
              {merged?.reference === undefined ? null : (
                <span className="row-name row-reference">
                  {merged.reference}
                </span>
              )}
            </span>
          </button>
          <AgentMarks orchestration={agentStates[agent.id]} />
          {agent.controlState.kind === "stopping" ? null : (
            <button
              className="row-action-button agent-row-action"
              type="button"
              aria-label={`Stop ${agent.displayName}`}
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
}

/**
 * The orchestrator's marks on an Agent's row, after its words: one of a 待機中
 * escalation's agents — stopped, but fine; needs action — managed, stopped,
 * and nothing settles it (missed); kept as it is by the orchestrator. Quiet,
 * like the row's other context, but for "needs action"; the tooltip says each
 * in words (`agentTooltipFacts`), off the board
 * (`OrchestratorBoardWire.agentStates`). Being under the orchestrator's
 * management (`Agent.managed`) is not a mark: the whole row wears a pale wash
 * of the accent (`.agent-row.is-managed`), and the tooltip says it in words.
 */
function AgentMarks({
  orchestration,
}: {
  readonly orchestration: AgentOrchestrationWire | undefined;
}) {
  const marks: GlyphName[] = [
    ...(orchestration?.waiting === undefined
      ? []
      : (["orchestratorWaiting"] as const)),
    ...(orchestration?.needsAction === undefined
      ? []
      : (["orchestratorNeedsAction"] as const)),
    ...(orchestration?.kept === undefined
      ? []
      : (["orchestratorKept"] as const)),
  ];
  if (marks.length === 0) return null;
  return (
    <span className="row-agent-marks">
      {marks.map((name) => (
        <Glyph
          key={name}
          name={name}
          className={`row-agent-mark${name === "orchestratorNeedsAction" ? " is-needs-action" : ""}`}
        />
      ))}
    </span>
  );
}

/**
 * What New Agent's accessible name adds to "Create agent in …": that it is
 * off, and why, or that the profiles behind it need attention. This used to
 * be the button's hover; no small control in a row has one now, and the
 * button's look already says it is off.
 */
function createAgentCaveat(
  availability: AgentProfilesAvailabilityWire,
  enabledProfiles: number,
): string {
  const reason =
    availability === "degraded"
      ? "agent profiles need attention"
      : enabledProfiles === 0
        ? "no enabled agent profiles"
        : undefined;
  if (availability === "unavailable" || enabledProfiles === 0)
    return reason === undefined ? ", unavailable" : `, unavailable: ${reason}`;
  return reason === undefined ? "" : `, ${reason}`;
}

/**
 * The Issue's Projects lane as one letter in a small rounded square, beside
 * the Issue icon. Fixed size, so it moves nothing; coloured from the lane's
 * GitHub colour where known, muted otherwise. Drawn only when a lane is known.
 */
function ProjectBadge({
  issue,
  repository,
}: {
  readonly issue: NonNullable<WorkspaceRepositoryWire["issue"]>;
  readonly repository: string | undefined;
}): ReactElement | null {
  const lane = primaryLane(issue.projects, repository);
  const letter = statusLetter(lane?.status);
  if (!lane || letter === undefined) return null;
  const token = laneColorToken(lane.color);
  return (
    <span
      className="row-project-badge"
      aria-hidden="true"
      style={
        token === undefined
          ? undefined
          : ({ "--badge-ink": `var(${token})` } as CSSProperties)
      }
    >
      {letter}
    </span>
  );
}

/**
 * A Workspace's leading mark: its folder glyph, or the digit that selects it
 * while the chord prefix is armed. Inert — a click on it is a click on the row,
 * whose select button's hit area covers it.
 */
function WorkspaceGlyph({
  glyphName,
  digit,
}: {
  /** While the chord prefix is armed: the digit that selects this row. */
  readonly digit?: number | undefined;
  readonly glyphName: GlyphName;
}) {
  return (
    <span className="row-glyph" aria-hidden="true">
      {digit === undefined ? (
        <Glyph name={glyphName} />
      ) : (
        <span className="row-glyph-digit" data-chord-digit={digit}>
          {digit}
        </span>
      )}
    </span>
  );
}

/**
 * What a Workspace row ends with: marks, and only marks.
 *
 * The row's words are its name and its branch — or, once the Issue is known, its
 * name and the Issue's title, which takes the branch's place and is not in this
 * group (see `.row-issue-title`). What is left is how the row is going out: the
 * pull request, always last so that it is one column down the Sidebar.
 *
 * What this is a checkout of is not here: it is the folder glyph at the row's
 * leading edge (`WorkspaceGlyph`, an inert mark), and the repository is a line
 * in the row's tooltip. The machine is not here for the same reason — a
 * Workspace on another machine wears the `remote` silhouette in that one
 * column — and which machine it is, like which worktree this is, is a line in
 * the row's tooltip.
 *
 * They are marks and not words because there is one line now and a line is
 * about twenty characters wide. A number and a title beside them would be
 * spending that line on what the tooltip says in full a moment later — and it
 * is the row's tooltip that says it. No mark has a hover of its own: the
 * pointer on any of them is the pointer on the row, and the row's tooltip has
 * a line for each — and the links to the repository, the Issue and the pull
 * request.
 */
function WorkspaceMarks({
  repository,
}: {
  readonly repository: WorkspaceRepositoryWire | undefined;
}) {
  const { openExternalUrl } = useSidebar();
  const pullRequest = repository?.pullRequest;
  const ciBadge = pullRequest ? checksBadge(pullRequest) : undefined;
  return (
    <span className="row-marks">
      {/* Asking. The branch is read every couple of seconds and GitHub once a
          minute, so a branch just switched to is on screen well before what it
          is about — and without this the gap looks exactly like a branch that
          is about no Issue. */}
      {repository?.pending ? (
        <span
          className="mac-spinner row-issue-spinner"
          role="status"
          aria-label={`Reading Issue #${String(repository.pending.number)}`}
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
        >
          <Glyph name="statusError" />
        </span>
      ) : null}
      {/* Last, so the pull request is always the group's last mark and so in
          one column down the Sidebar whatever else a row has to show. */}
      {pullRequest ? (
        <button
          className={`row-link-button is-pr-${pullRequest.state}`}
          type="button"
          aria-label={describe(pullRequestFacts(pullRequest))}
          onClick={() => {
            openExternalUrl(pullRequest.url);
          }}
        >
          <Glyph name={pullRequestGlyphName(pullRequest.state)} />
          {/* Somebody is waiting on an answer in it. On the mark and not
              beside it, because it is about this pull request and nothing
              else on the row; coloured at rest, because a conversation you
              have to hover to find out about is one nobody answers. The count
              is in the words above. */}
          {hasUnresolvedConversations(pullRequest) ? (
            <Glyph name="conversation" className="row-mark-badge" />
          ) : null}
          {/* What its CI says, at the opposite corner, and for the same
              reasons: about this pull request alone, and coloured at rest.
              Only a failure or a run still going is drawn; the counts are in
              the words above. */}
          {ciBadge === undefined ? null : (
            <Glyph name={ciBadge} className="row-mark-badge" />
          )}
        </button>
      ) : null}
    </span>
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
 * The Orchestrator row, above Scratch: the board, and the agent that
 * coordinates the others (`docs/orchestrator.md`).
 *
 * It leads with its own mark and ends with what the board has for the person:
 * the number of escalations waiting for an answer, as the one filled badge in
 * the Sidebar. The orchestrator agent's own status mark sits before them, so
 * its row says what it is doing the way an Agent row does.
 *
 * It is also its Workspace's row — the orchestrator's folder, as Scratch's
 * row is Scratch's (`orchestratorWorkspaceId`): `+` starts an Agent there,
 * and its right-click shows the folder's editor (the Workspace selected, the
 * row still the one highlighted).
 *
 * Under it is the orchestrator's work, by lane (`orchestratorLanes.ts`): its
 * helpers and the Workspaces it opened, under the board's lane headings. With
 * nothing there it is one row, as it always was: no disclosure, no count.
 * Folded, it is one row again, with how many items it holds beside the badge.
 */
function OrchestratorRow({
  snapshot,
  collapsed,
  workspace,
  agentProfiles,
  agentProfilesAvailability,
  onCreateAgent,
  groups,
  folds,
  onFoldGroup,
  onFoldLane,
  pointerHandlers,
  renderItem,
}: {
  readonly snapshot: AppSnapshot;
  readonly collapsed: boolean;
  /** The Orchestrator row's Workspace, while one is open. */
  readonly workspace: WorkspaceSnapshot | undefined;
  readonly agentProfiles: readonly AgentProfile[];
  readonly agentProfilesAvailability: AgentProfilesAvailabilityWire;
  readonly onCreateAgent: (workspaceId: string) => void;
  /** The lanes with something in them, as drawn (`useSettledArrangement`). */
  readonly groups: readonly LaneGroup<OrchestratorItem>[];
  readonly folds: OrchestratorFolds;
  readonly onFoldGroup: (folded: boolean) => void;
  readonly onFoldLane: (lane: LaneId, folded: boolean) => void;
  readonly pointerHandlers: ReturnType<
    typeof useSettledArrangement
  >["pointerHandlers"];
  readonly renderItem: (item: OrchestratorItem) => ReactElement;
}) {
  // A Sidebar mounted without a board (a test, a page between loads) has
  // nothing on it: the empty board.
  const board = (useSidebar() as Partial<SidebarValue>).board ?? EMPTY_BOARD;
  const selectRow = useSelectRow();
  const context = snapshot.selection.context;
  // The board, or its Workspace's editor: both are this row's.
  const selected =
    context.kind === "orchestrator" ||
    (workspace !== undefined &&
      context.kind === "workspace" &&
      context.workspaceId === workspace.id);
  const closing = workspace?.close.kind === "running";
  const agent = snapshot.workspaces
    .flatMap((workspace) => workspace.agents)
    .find((one) => one.id === snapshot.orchestratorAgentId);
  const waiting = board.needsAnswer.length;
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  // The rail draws the row alone, as it always has: its mark and the badge.
  const hasGroup = total > 0 && !collapsed;
  const open = hasGroup && !folds.group;
  const facts = [
    "Orchestrator",
    agent === undefined
      ? "no orchestrator running"
      : `${agent.displayName}, ${agent.status}`,
    `${String(waiting)} waiting for your answer`,
    ...(board.inProgress.length > 0
      ? [`${String(board.inProgress.length)} in progress`]
      : []),
    // The mode, always: off at every launch, so its absence would hide it.
    `mode: ${board.mode ?? "off"}${board.autoSaving === undefined ? "" : " (by itself: usage over the saving threshold)"}`,
    ...(total > 0 ? [`${String(total)} under it`] : []),
  ];
  return (
    <li
      className="sidebar-tree-item"
      role="treeitem"
      aria-level={1}
      aria-selected={selected}
      aria-expanded={hasGroup ? open : undefined}
      data-orchestrator="true"
      data-open={open ? "true" : undefined}
      {...(hasGroup ? pointerHandlers : {})}
    >
      <div
        className={`sidebar-row orchestrator-row${selected ? " is-selected" : ""}${agent !== undefined && unreadShows(agent.status, agent.unread) ? " is-unread" : ""}`}
        data-tooltip-lines={JSON.stringify(
          tooltipLines(facts.map((text) => ({ text }))),
        )}
        onContextMenu={
          workspace === undefined || closing
            ? undefined
            : (event) => {
                event.preventDefault();
                openRowMenu(
                  [
                    {
                      id: "show-editor",
                      label: "Show Editor",
                      run: () => {
                        selectRow(
                          { detail: 1 },
                          {
                            type: "select_context",
                            context: {
                              kind: "workspace",
                              workspaceId: workspace.id,
                            },
                          },
                        );
                      },
                    },
                  ],
                  { x: event.clientX, y: event.clientY },
                );
              }
        }
      >
        <div className="row-head">
          {collapsed ? null : hasGroup ? (
            // The mark, and the disclosure in its place under the pointer or
            // the keyboard: a column, not a new one. Not a stop of its own —
            // the row's → and ← fold it — so it takes no tab.
            <button
              className="row-glyph orchestrator-disclosure"
              type="button"
              tabIndex={-1}
              aria-label={
                open
                  ? "Fold the orchestrator's work"
                  : "Show the orchestrator's work"
              }
              aria-expanded={open}
              onClick={() => {
                onFoldGroup(open);
              }}
            >
              <Glyph
                name="orchestrator"
                className="orchestrator-disclosure-mark"
              />
              <Chevron />
            </button>
          ) : (
            <WorkspaceGlyph glyphName="orchestrator" />
          )}
          <button
            className="sidebar-context-button"
            type="button"
            data-tree-item-id="orchestrator"
            tabIndex={selected ? 0 : -1}
            aria-current={selected ? "page" : undefined}
            aria-label={facts.join(", ")}
            onClick={(event) =>
              selectRow(event, {
                type: "select_context",
                context: { kind: "orchestrator" },
              })
            }
          >
            {collapsed ? <WorkspaceGlyph glyphName="orchestrator" /> : null}
            <span className="row-text">
              <span className="row-label">Orchestrator</span>
              {agent?.activity === undefined || collapsed ? null : (
                <span className="row-name">{agent.activity}</span>
              )}
            </span>
          </button>
          {collapsed ? null : (
            <span className="row-marks orchestrator-marks">
              {agent === undefined ? null : (
                <span className="orchestrator-status">
                  <StatusMark status={agent.status} unread={agent.unread} />
                </span>
              )}
              {/* Folded, the row still says what it holds: the total, quiet,
                  and the badge, which is a request to you and never folds. */}
              {hasGroup && !open ? (
                <span className="orchestrator-total" aria-hidden="true">
                  {total}
                </span>
              ) : null}
              {waiting > 0 ? (
                <span className="orchestrator-badge" aria-hidden="true">
                  {waiting}
                </span>
              ) : null}
            </span>
          )}
          {collapsed && waiting > 0 ? (
            <span className="orchestrator-badge is-rail" aria-hidden="true">
              {waiting}
            </span>
          ) : null}
          {workspace?.canCreateAgent === true && !closing ? (
            <button
              className="row-action-button"
              type="button"
              aria-label={`Create agent in Orchestrator${createAgentCaveat(agentProfilesAvailability, agentProfiles.length)}`}
              disabled={
                agentProfilesAvailability === "unavailable" ||
                agentProfiles.length === 0
              }
              onClick={() => onCreateAgent(workspace.id)}
            >
              <Glyph name="plus" />
            </button>
          ) : null}
        </div>
      </div>
      {open ? (
        <ul
          className="orchestrator-lanes"
          role="group"
          aria-label="The orchestrator's work"
        >
          {groups.map((group) => (
            <LaneHeading
              key={group.lane.id}
              lane={group.lane}
              count={group.items.length}
              folded={folds.lanes[group.lane.id]}
              onFold={(folded) => {
                onFoldLane(group.lane.id, folded);
              }}
            >
              {group.items.map(renderItem)}
            </LaneHeading>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** The disclosure's chevron: right when folded, down when open (CSS). */
function Chevron() {
  return (
    <svg className="sidebar-chevron" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M3.5 2 L6.5 5 L3.5 8" />
    </svg>
  );
}

/**
 * One lane under the Orchestrator row: the board's word for it, its colour as
 * a dot (要対応, the one that is not a board lane, wears the needs-action
 * mark instead), and how many items are in it. A tree item of its own, so the
 * arrows walk it and fold it; a click folds it too. Only drawn with something
 * in it.
 */
function LaneHeading({
  lane,
  count,
  folded,
  onFold,
  children,
}: {
  readonly lane: LaneSpec;
  readonly count: number;
  readonly folded: boolean;
  readonly onFold: (folded: boolean) => void;
  readonly children: ReactNode;
}) {
  return (
    <li
      className="sidebar-tree-item orchestrator-lane-item"
      role="treeitem"
      aria-level={2}
      aria-selected={false}
      aria-expanded={!folded}
      data-lane={lane.id}
    >
      <div
        className="sidebar-row lane-row"
        data-lane={lane.id}
        data-tooltip-lines={JSON.stringify(
          tooltipLines([
            { text: `${lane.title} · ${String(count)}` },
            { text: lane.hint },
          ]),
        )}
      >
        <div className="row-head">
          <span className="row-glyph lane-chevron" aria-hidden="true">
            <Chevron />
          </span>
          <button
            className="sidebar-context-button"
            type="button"
            data-tree-item-id={`lane:${lane.id}`}
            tabIndex={-1}
            aria-label={`${lane.title}, ${String(count)}`}
            onClick={() => {
              onFold(!folded);
            }}
          >
            <span className="lane-mark" aria-hidden="true">
              {lane.id === "action" ? (
                <Glyph name="orchestratorNeedsAction" />
              ) : null}
            </span>
            <span className="row-text">
              <span className="row-label">{lane.title}</span>
            </span>
          </button>
          <span className="lane-count" aria-hidden="true">
            {count}
          </span>
        </div>
      </div>
      {folded ? null : (
        <ul
          className="orchestrator-lane-items"
          role="group"
          aria-label={lane.title}
        >
          {children}
        </ul>
      )}
    </li>
  );
}

/**
 * A Workspace the orchestrator manages, in its lane.
 *
 * With one Agent it is one row — that Agent's, with what the Workspace is
 * about (`#128`, `PR #517`) quiet after its words, and the Workspace's own
 * acts (Show Editor, Close) in its right-click: a worktree the orchestrator
 * made almost always holds one Agent, and a folder row over an Agent row
 * would say the same thing twice. With none, or several, it is the
 * Workspace's own row, its Agents under it, as anywhere else in the Sidebar.
 */
function ManagedWorkspaceItem({
  workspace,
  repository,
  snapshot,
  agentProfiles,
  agentProfilesAvailability,
  onCreateAgent,
  onCloseWorkspace,
  onAgentMenu,
  onWorkspaceMenu,
  reorder,
}: {
  readonly workspace: WorkspaceSnapshot;
  readonly repository: WorkspaceRepositoryWire | undefined;
  readonly snapshot: AppSnapshot;
  readonly agentProfiles: readonly AgentProfile[];
  readonly agentProfilesAvailability: AgentProfilesAvailabilityWire;
  readonly onCreateAgent: (workspaceId: string) => void;
  readonly onCloseWorkspace: (workspace: WorkspaceSnapshot) => void;
  readonly onAgentMenu: AgentMenu;
  readonly onWorkspaceMenu: (
    workspace: WorkspaceSnapshot,
    at: { x: number; y: number },
    menu: { readonly deletesWorktree: boolean; readonly fixed: boolean },
  ) => void;
  readonly reorder: Reorder;
}) {
  const selectRow = useSelectRow();
  const dispatch = useSidebarDispatch();
  const identity = rowIdentity(workspace, snapshot.scratchWorkspaceId);
  const closing = workspace.close.kind === "running";
  const agents = workspace.agents.filter(
    (agent) => agent.id !== snapshot.orchestratorAgentId,
  );
  const only = agents.length === 1 && !closing ? agents[0] : undefined;
  if (only === undefined)
    return (
      <WorkspaceRow
        workspace={workspace}
        identity={identity}
        repository={repository}
        snapshot={snapshot}
        agentProfiles={agentProfiles}
        agentProfilesAvailability={agentProfilesAvailability}
        onCreateAgent={onCreateAgent}
        onCloseWorkspace={onCloseWorkspace}
        onAgentMenu={onAgentMenu}
        onWorkspaceMenu={onWorkspaceMenu}
        reorder={reorder}
        level={3}
        underOrchestrator
      />
    );
  const facts = workspaceRowFacts(workspace, repository);
  const context = snapshot.selection.context;
  const deletesWorktree = closingDeletesWorktree(repository, workspace.root);
  const issue = repository?.issue;
  const pullRequest = repository?.pullRequest;
  return (
    <AgentRowItem
      agent={only}
      workspace={workspace}
      identity={identity}
      snapshot={snapshot}
      agentProfiles={agentProfiles}
      closing={closing}
      onAgentMenu={onAgentMenu}
      reorder={reorder}
      level={3}
      underOrchestrator
      draggable={false}
      merged={{
        reference:
          issue !== undefined
            ? `#${String(issue.number)}`
            : pullRequest !== undefined
              ? `PR #${String(pullRequest.number)}`
              : undefined,
        tooltip: tooltipLines(facts),
        description: describe(facts),
        selected:
          context.kind === "workspace" && context.workspaceId === workspace.id,
        menu: [
          {
            id: "show-editor",
            label: "Show Editor",
            separated: true,
            run: () => {
              selectRow(
                { detail: 1 },
                {
                  type: "select_context",
                  context: { kind: "workspace", workspaceId: workspace.id },
                },
              );
            },
          },
          ...workspaceMenuItems(workspace, {
            close: onCloseWorkspace,
            deletesWorktree,
            fixed: false,
            dispatch,
          }),
        ],
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
/** A row's identity for the glide: the id its button walks the tree by. */
function sidebarRowKey(row: HTMLElement): string | undefined {
  return (
    row.querySelector<HTMLElement>("[data-tree-item-id]")?.dataset[
      "treeItemId"
    ] ?? undefined
  );
}

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
  const {
    dispatch,
    agentProfiles,
    repositoryStatus,
    usageLimits,
    closeWorkspace,
    retry,
  } = useSidebar();
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
  //
  // Scratch is one of them, drawn first, in the order main counts entries in
  // (`sidebarWorkspaces`), so `Cmd+Q 0` and the row on top are the same row.
  const {
    scratch,
    orchestrator,
    rows: workspaces,
  } = useMemo(() => sidebarWorkspaces(snapshot), [snapshot]);
  // What is under the Orchestrator row, and in which lane
  // (`orchestratorLanes.ts`). A change of lane, or a new item, is drawn when
  // the pointer is not in the middle of using the group
  // (`useSettledArrangement`); every row's own content is live.
  const board = (useSidebar() as Partial<SidebarValue>).board ?? EMPTY_BOARD;
  const items = useMemo(
    () => orchestratorItems(snapshot, board),
    [snapshot, board],
  );
  const liveArrangement = useMemo(() => arrangementOf(items), [items]);
  // Before the board's first reading every lane is a guess: it is drawn as
  // soon as it comes, without a wait or a glide.
  const boardRead = board.revision > 0;
  const settled = useSettledArrangement(liveArrangement, boardRead);
  const groups = useMemo(() => {
    const drawnItems = items.flatMap((item) => {
      const lane = settled.drawn.get(item.key);
      return lane === undefined ? [] : [{ ...item, lane }];
    });
    return groupByLane(drawnItems, (item) => item.lane);
  }, [items, settled.drawn]);
  const { folds, setGroupFolded, setLaneFolded } = useOrchestratorFolds();
  // What the group looks like, as one string: a change of it is the one
  // cause the tree's rows glide for (`useGlide`'s `cause`).
  const groupShape = [
    folds.group ? "folded" : "open",
    ...groups.map(
      (group) =>
        `${group.lane.id}${folds.lanes[group.lane.id] ? "-" : "+"}:${group.items.map((item) => item.key).join(",")}`,
    ),
  ].join("|");
  // Rows that have finished closing, still on screen for as long as it takes
  // them to leave. See `closingExit.ts`.
  const armed = useChordArmed();
  const exiting = useClosingExit(workspaces);
  const rows = useMemo(
    () => mergeExitingRows(workspaces, exiting),
    [workspaces, exiting],
  );
  // The digit each live row answers to while the prefix is armed: `Cmd+Q 1`
  // is the first workspace below Scratch, as main counts them. A row that is
  // leaving is not counted, and rows past the ninth keep their folder.
  const liveDigits = useMemo(
    () =>
      new Map(
        workspaces
          .slice(0, 9)
          .map((workspace, index) => [workspace.id, index + 1] as const),
      ),
    [workspaces],
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
  const treeFocusId = useRef<string | undefined>(undefined);
  // Whether the keyboard is in the tree: set as a row takes focus, cleared
  // as focus leaves for somewhere that is still there. A focused row that is
  // removed (a lane change draws it anew) blurs with nothing to go to, and
  // that is not leaving: the layout effect puts the keyboard back on it.
  const treeHadFocus = useRef(false);

  /**
   * `focus_sidebar`: put the keyboard on the row that is selected. (Palette
   * only since `Cmd+Q S` was taken from it; `S` is unbound now.)
   *
   * The tree's roving tab stop is already the selected row — the layout effect
   * above keeps it there — so this focuses whatever that is and the tree's own
   * arrows, Home/End and Return take over from there. Scratch is the tree's
   * first row, so the tree is never empty and there is always somewhere to land.
   */
  const focusSidebar = useCallback(() => {
    const tree = workspaceTreeRef.current;
    const items = tree ? treeContextButtons(tree) : [];
    (items.find((item) => item.tabIndex === 0) ?? items[0])?.focus();
  }, []);

  /**
   * Escape: give the keyboard back.
   *
   * The way out of the chrome, and the counterpart of `focus_sidebar`. It is a
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
    // The keyboard was on a row that is not there any more. Either it went
    // (a close, a fold): the tab stop's row takes it. Or it moved — a lane
    // change draws the row anew under another heading — and it is still
    // here by its id: the keyboard goes with it.
    const lost =
      Boolean(previousId) &&
      treeHadFocus.current &&
      (active === document.body || active === tree || active === null);
    // Only when the keyboard was in the tree: a row folded or closed while
    // the person is elsewhere (the mouse on a disclosure, the page blurred)
    // takes nothing anywhere.
    const activeWasRemoved =
      Boolean(previousId) &&
      treeHadFocus.current &&
      !requested &&
      (active === document.body || active === tree || tree.contains(active));
    treeFocusId.current = target.dataset.treeItemId;
    if (activeWasRemoved || (lost && requested !== undefined)) target.focus();
  }, [snapshot.selection.context, snapshot.workspaces, groupShape]);

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
        // Main's half of `focus_sidebar` has already put the keyboard in this view;
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

  const { continueAgent } = useSidebar();

  /**
   * The row's context menu: a native menu over the window (`rowMenu.ts`), so
   * nothing about it is state here — macOS keeps exactly one up.
   */
  const openAgentMenu = useCallback(
    (
      agent: AgentSnapshot,
      at: { x: number; y: number },
      more: readonly RowMenuItem[] = [],
    ) => {
      openRowMenu(
        [
          ...agentMenuItems(agent, dispatchIntent, openRename, (each) => {
            continueAgent(each.id);
          }),
          ...more,
        ],
        at,
      );
    },
    [continueAgent, dispatchIntent, openRename],
  );
  const openWorkspaceMenu = useCallback(
    (
      workspace: WorkspaceSnapshot,
      at: { x: number; y: number },
      menu: { readonly deletesWorktree: boolean; readonly fixed: boolean },
    ) => {
      openRowMenu(
        workspaceMenuItems(workspace, {
          close: closeWorkspaceRow,
          dispatch: dispatchIntent,
          ...menu,
        }),
        at,
      );
    },
    [closeWorkspaceRow, dispatchIntent],
  );

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
   * One piece of state for the whole tree: only one row can be in the air.
   * Where it may land is `model/workspaceOrder.ts`'s answer and not this
   * component's — the same answer `Alt+↑` gets.
   */
  const reorder = useReorder(snapshot);

  /**
   * Compact mode's floating Sidebar (`useSidebarOverlay.ts`): the rail grown
   * to the full width over the content. While it floats — or lands as compact
   * mode goes off — the pane is drawn as the docked column, and the docked
   * column is the rail's arrangement with more of it shown (`tokens.css`): the
   * same rows at the same heights, every mark at the rail's x. So nothing in
   * it moves as it grows but its trailing edge, and it lands as exactly what
   * it already is. The model's `collapsed` does not move for it.
   */
  const paneRef = useRef<HTMLElement>(null);
  const overlay = useSidebarOverlay(collapsed, paneRef, reorder.active);

  /**
   * Folding the group or a lane. A row the keyboard is on that the fold takes
   * away hands the keyboard to the row that folded, so it is never lost.
   */
  const keepFocusOn = (holder: string) => {
    const tree = workspaceTreeRef.current;
    const active = document.activeElement;
    if (!tree || !(active instanceof HTMLElement)) return;
    const row = tree.querySelector<HTMLButtonElement>(
      `[data-tree-item-id="${holder}"]`,
    );
    const branch = row?.closest<HTMLElement>("[role=treeitem]");
    if (row && branch?.contains(active) && active !== row) {
      treeFocusId.current = holder;
      setTreeTabStop(tree, row);
      row.focus();
    }
  };
  const foldGroup = (folded: boolean) => {
    if (folded) keepFocusOn("orchestrator");
    setGroupFolded(folded);
  };
  const foldLane = (lane: LaneId, folded: boolean) => {
    if (folded) keepFocusOn(`lane:${lane}`);
    setLaneFolded(lane, folded);
  };
  /** What `item` folds, if it folds: the Orchestrator row's group, a lane. */
  const foldTarget = (
    item: HTMLElement,
  ):
    | { readonly folded: boolean; readonly set: (folded: boolean) => void }
    | undefined => {
    if (item.getAttribute("aria-expanded") === null) return undefined;
    if (item.dataset["orchestrator"] === "true")
      return { folded: folds.group, set: foldGroup };
    const lane = item.dataset["lane"] as LaneId | undefined;
    if (lane === undefined) return undefined;
    return {
      folded: folds.lanes[lane],
      set: (folded) => {
        foldLane(lane, folded);
      },
    };
  };

  const drawnCollapsed = collapsed && overlay.phase === "closed";
  const drawn = useMemo(
    () =>
      drawnCollapsed === snapshot.sidebar.collapsed
        ? snapshot
        : {
            ...snapshot,
            sidebar: { ...snapshot.sidebar, collapsed: drawnCollapsed },
          },
    [drawnCollapsed, snapshot],
  );

  // Rows that change place because the Orchestrator's group did — a lane
  // change, an item arriving, a fold — glide there (240 ms, the standard
  // curve), and what arrives rises in (`glide.ts`, docs/motion.md). Every commit is measured, but only a change
  // of the group's shape moves anything: the rail folding, a row renamed or
  // a Workspace opened below are drawn where they land, as before.
  useGlide(
    workspaceTreeRef,
    ".sidebar-row",
    sidebarRowKey,
    [snapshot, groups, folds, drawnCollapsed],
    // A row that changes lane passes over the rows between: it dips while
    // it does. Its neighbours, moved a row or two, only glide.
    { cause: boardRead ? groupShape : "", dimBeyond: 64 },
  );

  return (
    <aside
      ref={paneRef}
      className="sidebar"
      aria-label="Workspace navigation"
      // Collapsed is drawn and never rendered differently: the same rows in the
      // same order, with the words taken off. So the tree the arrows walk, the
      // labels a screen reader reads and the roving tab stop are one set of
      // markup in both states, and there is no second render path to keep in
      // step with the first.
      data-collapsed={drawnCollapsed ? "true" : undefined}
      // The rail grown over the content, retracting, or landing as compact
      // mode goes off. See `sidebarPage.css` — the same pane, raised.
      data-overlay={overlay.phase === "closed" ? undefined : overlay.phase}
      // The Agents' tree growing in out of the rail, or folding back into it.
      // See `shell.css`, "The tree growing in".
      data-tree={overlay.tree}
      {...overlay.paneHandlers}
      // A row chosen in the floating Sidebar does what a row does, and the
      // card goes, the way a browser's tab bar folds away after a tab is
      // picked.
      onClickCapture={(event) => {
        if ((event.target as Element).closest("[data-tree-item-id]") !== null) {
          overlay.dismiss();
        }
      }}
      // A row is in the air, so the rows it may not land among are dimmed:
      // the lit part of the list is the range. See `styles/reorder.css`.
      data-reordering={reorder.active ? "true" : undefined}
      style={{ "--sidebar-width": `${renderedWidth}px` } as React.CSSProperties}
      // Escape leaves the Sidebar, from anywhere in it: a row, the tree, the
      // resize handle. One handler on the pane rather than one per control,
      // because "the way out" is a fact about the pane. The row menu is a
      // native menu (`rowMenu.ts`) and answers its own Escape before this
      // page ever sees the key, so the key means one thing at a time.
      onKeyDown={(event) => {
        if (isImeComposing(event.nativeEvent)) return;
        if (event.key !== "Escape") return;
        event.preventDefault();
        // The floating Sidebar goes first; the keyboard goes back with it.
        overlay.dismiss();
        leaveSidebar();
      }}
    >
      {/* The Sidebar runs the full height of the window, so its own top strip
          is where the window buttons live and where the window is dragged. */}
      <div className="sidebar-scroll-region" {...reorder.regionProps}>
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
            treeHadFocus.current = true;
            setTreeTabStop(event.currentTarget, button);
          }}
          onBlurCapture={(event) => {
            const tree = event.currentTarget;
            const next = event.relatedTarget;
            if (next instanceof Node && tree.contains(next)) return;
            const left = event.target;
            // Removed while focused: not a decision to leave.
            queueMicrotask(() => {
              if (left.isConnected) treeHadFocus.current = false;
            });
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
            const focusItem = (item: HTMLButtonElement | null | undefined) => {
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
            // The tree's horizontal keys, as WAI-ARIA's tree has them. A
            // Workspace is always open, so on one → and ← only walk between
            // it and its Agents. What folds — the Orchestrator row's group
            // and each of its lanes — → opens, and → again enters its first
            // child; ← folds an open one, and on anything else goes to the
            // parent.
            const folding = foldTarget(item);
            if (event.key === "ArrowRight") {
              if (folding !== undefined && folding.folded) {
                event.preventDefault();
                folding.set(false);
                return;
              }
              const child = item.querySelector<HTMLButtonElement>(
                ":scope > [role=group] [data-tree-item-id]:not([disabled])",
              );
              if (!child) return;
              event.preventDefault();
              focusItem(child);
              return;
            }
            if (event.key === "ArrowLeft") {
              if (folding !== undefined && !folding.folded) {
                event.preventDefault();
                folding.set(true);
                return;
              }
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
          {/* The Orchestrator first, above Scratch: the board and the agent
                that coordinates the others. Walked like any row. */}
          <OrchestratorRow
            snapshot={drawn}
            collapsed={drawnCollapsed}
            workspace={orchestrator}
            agentProfiles={agentProfiles.profiles}
            agentProfilesAvailability={agentProfiles.availability}
            onCreateAgent={openAgentPicker}
            groups={groups}
            folds={folds}
            onFoldGroup={foldGroup}
            onFoldLane={foldLane}
            pointerHandlers={settled.pointerHandlers}
            renderItem={(item) =>
              item.kind === "helper" ? (
                <AgentRowItem
                  key={item.key}
                  agent={item.agent}
                  workspace={item.workspace}
                  identity={{ glyph: "orchestrator", fixed: true }}
                  snapshot={drawn}
                  agentProfiles={agentProfiles.profiles}
                  closing={item.workspace.close.kind === "running"}
                  onAgentMenu={openAgentMenu}
                  reorder={reorder}
                  level={3}
                  underOrchestrator
                  draggable={false}
                />
              ) : (
                <ManagedWorkspaceItem
                  key={item.key}
                  workspace={item.workspace}
                  repository={repositories.get(item.workspace.id)}
                  snapshot={drawn}
                  agentProfiles={agentProfiles.profiles}
                  agentProfilesAvailability={agentProfiles.availability}
                  onCreateAgent={openAgentPicker}
                  onCloseWorkspace={closeWorkspaceRow}
                  onAgentMenu={openAgentMenu}
                  onWorkspaceMenu={openWorkspaceMenu}
                  reorder={reorder}
                />
              )
            }
          />
          {/* Scratch first, as the tree's first row: it is a Workspace, so it
                is walked, selected and focused the way every Workspace is. */}
          <WorkspaceRow
            key={scratch.id}
            workspace={scratch}
            identity={rowIdentity(scratch, snapshot.scratchWorkspaceId)}
            repository={repositories.get(scratch.id)}
            snapshot={drawn}
            agentProfiles={agentProfiles.profiles}
            agentProfilesAvailability={agentProfiles.availability}
            chordDigit={armed ? 0 : undefined}
            onCreateAgent={openAgentPicker}
            onCloseWorkspace={closeWorkspaceRow}
            onAgentMenu={openAgentMenu}
            onWorkspaceMenu={openWorkspaceMenu}
            reorder={reorder}
          />
          {/* Between Scratch and the rest, as a row of the tree that is not
                one: `role="none"` takes it out of the tree the arrows walk
                (`treeContextButtons` only finds the rows' own buttons) and
                leaves the heading and its buttons where they always were. */}
          <li role="none">
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
                  onClick={openPicker}
                >
                  <Glyph name="plus" />
                </button>
              </span>
            </div>
          </li>
          {/* `rows` and not the snapshot: the last Workspace to close still
                has a ghost fading in its place, and swapping the whole list for
                "No workspaces open" underneath it is exactly the jump the ghost
                is there to prevent. */}
          {rows.length > 0 ? (
            rows.map((entry) =>
              entry.kind === "exiting" ? (
                <ClosingGhostRow key={entry.row.id} label={entry.row.label} />
              ) : (
                <WorkspaceRow
                  key={entry.workspace.id}
                  workspace={entry.workspace}
                  identity={rowIdentity(
                    entry.workspace,
                    snapshot.scratchWorkspaceId,
                  )}
                  repository={repositories.get(entry.workspace.id)}
                  snapshot={drawn}
                  agentProfiles={agentProfiles.profiles}
                  agentProfilesAvailability={agentProfiles.availability}
                  chordDigit={
                    armed ? liveDigits.get(entry.workspace.id) : undefined
                  }
                  onCreateAgent={openAgentPicker}
                  onCloseWorkspace={closeWorkspaceRow}
                  onAgentMenu={openAgentMenu}
                  onWorkspaceMenu={openWorkspaceMenu}
                  reorder={reorder}
                />
              ),
            )
          ) : (
            <li role="none">
              <p className="sidebar-empty">No workspaces open</p>
            </li>
          )}
        </ul>
      </div>
      <UsageLimits limits={usageLimits} />
      {/* A rail has no width to set: it is exactly its glyph column, or — on a
          window with no title bar — exactly what the traffic lights need. The
          handle is absent rather than disabled, because a
          disabled separator is a keyboard stop that answers nothing — and the
          width it would set is still there, waiting, for when the Sidebar
          comes back. */}
      {collapsed || overlay.phase !== "closed" ? null : (
        <SidebarResizeHandle
          width={renderedWidth}
          onPreview={previewResize}
          onCommit={resize}
        />
      )}
      {/* One tooltip for the whole tree, decided here and drawn on a child of
          the window. See `RowTooltip.tsx` — this view is 44px wide on a
          collapsed rail, so a tooltip drawn in it is clipped by it, which is
          the exact failure `title` was replaced to avoid. Where it goes is the
          owner's and takes no argument from here: beside the row, always. */}
      <RowTooltip generation={overlay.generation} />
    </aside>
  );
}

/**
 * The stopped agent whose work was done in `workspaceId` and can be resumed
 * (`OrchestratorWorkWire`), as the Workspace row's tooltip says it, with
 * the memo's latest line. Undefined: none.
 */
function resumableWorkAt(
  board: SidebarValue["board"],
  workspaceId: string,
): { readonly facts: readonly { readonly text: string }[] } | undefined {
  for (const work of board.work ?? []) {
    const last = work.agents.at(-1);
    if (last?.workspaceId !== workspaceId || !last.resumable) continue;
    const memo = board.memos?.find((one) => one.subject === work.subject);
    const latest = memo?.entries.at(-1)?.text.replace(/\s+/gu, " ").trim();
    return {
      facts: [
        {
          text: `Resumable: ${last.name} (devhub --tell agent resume ${work.token})`,
        },
        ...(latest === undefined
          ? []
          : [
              {
                text: `Memo: ${latest.length <= 120 ? latest : `${latest.slice(0, 119)}…`}`,
              },
            ]),
      ],
    };
  }
  return undefined;
}
