/**
 * "Assign Issue": the four questions, as a wizard.
 *
 * Which Issue and what to do with it, which clone, which branch, which agent —
 * and each answer decides the next question, which is why this is a chain of
 * steps rather than four sheets that open each other. The branch answer is
 * acted on before the agent is asked about: the folder is made or found, and
 * the agent question is then New Agent's about that folder by its path,
 * earlier sessions and all. Nothing is opened until an agent is chosen — the
 * folder becomes the selected Workspace in the same act that starts the agent,
 * so no editor starts behind the question and the keyboard stays in it. Escape
 * goes back one question the whole way down, because that is the runner's
 * rule and no step here had to be told about it.
 *
 * Two kinds of "that did not work" show up in the same place, the line under
 * the field, and they are different things. A URL that is not an Issue URL is
 * this file's business — the question simply has not been answered yet, so it
 * is asked again with what was typed still in the field. A clone git refused,
 * or a worktree whose directory is in the way, is main's, and the runner brings
 * it back to whichever step caused it.
 */

import { useMemo } from "react";
import type { AgentChoice } from "../components/shell/AgentProfilePicker";
import type {
  AssignmentBranchWire,
  IssueAssignment,
  IssueFolderRequest,
} from "../../ipc/contract";
import {
  wipBranchForIssue,
  gitHubItemUrl,
  parseGitHubItemUrl,
  type GitHubItem,
} from "../../model/github";
import type { PickerItem } from "../components/shell/Picker";
import { Wizard } from "../components/shell/Wizard";
import type {
  WizardInput,
  WizardPrompt,
  WizardStep,
} from "../components/shell/wizardFlow";
import {
  CLONE_INTO_TYPED,
  cloneParentItems,
  cloneTypedItem,
} from "../components/shell/cloneDestination";
import type { AgentActionWire, IssueRepository } from "../../ipc/contract";
import { folderName, githubCloneTarget } from "../../model/projects";
import {
  baseName,
  worktreeDirectory,
  type WorkItem,
} from "../../model/worktrees";
import { placeLabel, type WorkspacePlaceWire } from "../../ipc/contract";
import { spokenFailure, toAppError, UserFacingFailure } from "../failure";
import { usePicker } from "./PickerContext";
import { FolderAgentPicker } from "./AgentPickerSheet";

export interface IssueAssignmentSheetProps {
  readonly onDismiss: () => void;
}

/** Rows that do something rather than name something that already exists. */
/** The row that runs the search again after one that did not finish. */
const LOOK_AGAIN = "devhub:look-again";
const CLONE_ELSEWHERE = "devhub:clone-elsewhere";
const ACCEPT_TYPED = "devhub:accept-typed";
/** A row that is one of the person's own actions, by its id. */
const ACTION_PREFIX = "devhub:action:";
const NEW_WORKTREE = "devhub:new-worktree";
/** The branch this work already has, checked out in a worktree of its own. */
const EXISTING_BRANCH = "devhub:existing-branch";
/** The folder that branch is already checked out in, opened as it is. */
const OPEN_CHECKOUT = "devhub:open-checkout";
const ROOT_CHECKOUT = "devhub:root-checkout";
/** The branch this work already has, switched to in the root checkout. */
const ROOT_EXISTING_BRANCH = "devhub:root-existing-branch";
/** `feature/128-wip`, made and switched to in the root checkout. */
const ROOT_NEW_BRANCH = "devhub:root-new-branch";
const USE_STALE_BASE = "devhub:use-stale-base";

function Wrong({ what }: { readonly what: string }) {
  return <span className="picker-note-failure">{what}</span>;
}

/** What every prompt in this flow has in common. */
const SHEET: Pick<WizardPrompt, "emptyNoMatch" | "emptyNoItems"> = {
  emptyNoMatch: "Nothing matches.",
  emptyNoItems: "Nothing to choose from.",
};

/**
 * `owner/repo#128` — how an Issue or a pull request is named on screen.
 *
 * The same shape for both, because GitHub numbers them together and a person
 * reading `example/widget#128` in a heading knows which one they just pasted.
 * Where the difference matters the sentence says so in words.
 */
function itemLabel(item: GitHubItem): string {
  return `${item.owner}/${item.repository}#${String(item.number)}`;
}

export function IssueAssignmentSheet({ onDismiss }: IssueAssignmentSheetProps) {
  const {
    findIssueRepositories,
    cloneRepository,
    prepareIssueFolder,
    assignIssue,
    cloneParentDirectories,
    assignmentBranch,
    agentActions,
  } = usePicker();

  const start = useMemo<WizardStep>(
    () =>
      issueUrlStep({
        findIssueRepositories,
        cloneRepository,
        prepareIssueFolder,
        assignIssue,
        cloneParentDirectories,
        assignmentBranch,
        agentActions,
      }),
    [
      agentActions,
      assignIssue,
      prepareIssueFolder,
      cloneParentDirectories,
      cloneRepository,
      findIssueRepositories,
      assignmentBranch,
    ],
  );

  return <Wizard start={start} onFinished={onDismiss} />;
}

interface FlowServices {
  readonly findIssueRepositories: (
    url: string,
    signal?: AbortSignal,
  ) => Promise<readonly IssueRepository[]>;
  readonly cloneRepository: (url: string, parent: string) => Promise<string>;
  readonly prepareIssueFolder: (
    request: IssueFolderRequest,
  ) => Promise<WorkspacePlaceWire>;
  readonly assignIssue: (request: IssueAssignment) => Promise<unknown>;
  readonly cloneParentDirectories: (
    signal?: AbortSignal,
  ) => Promise<readonly string[]>;
  readonly assignmentBranch: (
    url: string,
    place: WorkspacePlaceWire,
    signal?: AbortSignal,
  ) => Promise<AssignmentBranchWire>;
  readonly agentActions: () => Promise<readonly AgentActionWire[]>;
}

/**
 * Which Issue.
 *
 * The step keeps asking until the answer parses, with what was typed still in
 * the field: a mistyped URL is a question not yet answered, not a failure, and
 * clearing the field would make the person paste it all again.
 */
function issueUrlStep(services: FlowServices): WizardStep {
  const ask = async (
    input: WizardInput,
    typed: string,
    wrong: boolean,
  ): Promise<WizardStep | undefined> => {
    // The actions are the rows here rather than a step of their own, because
    // "which Issue" and "to do what with it" are one thought: a person pastes a
    // URL because they have already decided whether they are implementing it or
    // reviewing it. A single row that said "Use this Issue" was a keystroke
    // asking them to confirm the only thing they could have meant.
    // The Issue flow's own actions, and only those. The workspace buttons are
    // in the same list and are not answers to this question: offering "Commit
    // the changes" as a way to start an agent on an Issue was a row that could
    // only produce a message about a working tree nobody has touched yet.
    const actions = (
      await input.working("Reading settings…", () => services.agentActions())
    ).filter((action) => action.trigger === "issue");
    const answer = await input.ask({
      title: "Assign Issue",
      question:
        "Paste the GitHub Issue or pull request to work on, then choose what the agent should do with it.",
      // The one field here worth an example: it shows where the number goes,
      // which the heading cannot. There are deliberately no empty-list
      // messages — the Issue is typed rather than chosen, so the list is empty
      // every time and a caption about it would only repeat the heading.
      placeholder: "https://github.com/owner/repo/issues/128 or /pull/128",
      initialQuery: typed,
      items: [],
      pinned:
        actions.length > 0
          ? // No second line: "paste the URL, then take this row" was the
            // heading again, once per row. What is left is the person's own
            // names for the things they start agents to do, which is what the
            // question is asking them to choose between.
            actions.map((action) => ({
              id: `${ACTION_PREFIX}${action.id}`,
              label: action.displayName,
            }))
          : [
              {
                id: ACCEPT_TYPED,
                label: "Use this URL",
                detail:
                  "No actions are configured, so the agent starts and is told nothing",
              },
            ],
      note: wrong ? (
        <Wrong what="That is not a GitHub Issue or pull request URL." />
      ) : undefined,
    });
    const item = parseGitHubItemUrl(answer.query);
    if (!item) return ask(input, answer.query, true);
    const actionId = answer.id.startsWith(ACTION_PREFIX)
      ? answer.id.slice(ACTION_PREFIX.length)
      : undefined;
    return repositoryStep(services, { item, actionId });
  };
  return (input) => ask(input, "", false);
}

/** The Issue, and what the agent is to do with it. */
interface Work {
  readonly item: GitHubItem;
  /** Which of the person's actions the agent is being started for. */
  readonly actionId: string | undefined;
}

/**
 * Which clone of the repository — asked only when there is more than one.
 *
 * A *repository*, not a directory. Its worktrees are the same repository in
 * several places, so they are one row here and the choice between them is the
 * next question. Asking somebody to pick a worktree and then asking whether
 * they wanted a different one was asking the same thing twice.
 *
 * One repository is not a choice, so it is taken and the flow moves on. None is
 * a real question with one answer — clone it — and that is where it goes.
 *
 * This used to always ask, on the reasoning that a step which decides for
 * itself is a step Escape cannot come back to. That was true of the runner and
 * is not any more: a step that asks nothing is no longer a place the stack
 * remembers, so Escape from the question after this one reaches the question
 * before it. See `runWizard`.
 */
function repositoryStep(services: FlowServices, work: Work): WizardStep {
  const { item } = work;
  return async (input) => {
    let repositories: readonly IssueRepository[];
    try {
      repositories = await input.working(
        `Looking for ${item.owner}/${item.repository}…`,
        // The signal is the wizard's: it fires when the person stops waiting,
        // and carrying it into the call is what makes Escape reach the `gh` or
        // `git` that is running rather than only the spinner drawn over it.
        (signal) => services.findIssueRepositories(gitHubItemUrl(item), signal),
      );
    } catch (error: unknown) {
      // A lookup that failed cannot be answered by looking again on its own.
      // The runner re-runs a step that failed, and this step *begins* with the
      // lookup — so handing the failure back would start a second lookup
      // immediately, and a third, and the person would watch a spinner that
      // reports nothing no matter how long they wait. That is the bug this
      // whole change is about, arrived at from the other side.
      //
      // So the refusal becomes a question, which is the only thing a person
      // can act on: here is what happened, and here is what you may do about
      // it. Looking again is one of the answers rather than something DevHub
      // decides on their behalf.
      const spoken = spokenFailure(error);
      if (!spoken) throw error;
      const answer = await input.ask({
        ...SHEET,
        title: `Looking for ${item.owner}/${item.repository}`,
        question: spoken.summary,
        items: [],
        pinned: [
          {
            id: LOOK_AGAIN,
            label: "Look again",
            detail: `Search this machine for ${item.owner}/${item.repository} once more`,
          },
          {
            id: CLONE_ELSEWHERE,
            label: "Clone…",
            detail: `Clone ${item.owner}/${item.repository} instead of looking for it`,
          },
        ],
      });
      return answer.id === LOOK_AGAIN
        ? repositoryStep(services, work)
        : cloneDestinationStep(
            services,
            work,
            `${item.owner}/${item.repository} is being cloned because the search for it did not finish.`,
          );
    }
    if (repositories.length === 0) {
      return cloneDestinationStep(services, work, nothingCloned(item));
    }
    const only = repositories.length === 1 ? repositories[0] : undefined;
    if (only) return branchStep(services, work, only.place);
    const answer = await input.ask({
      ...SHEET,
      title: `Which ${item.owner}/${item.repository}`,
      question: `This machine has more than one clone of ${item.owner}/${item.repository}. Choose the one to work in, or clone it again somewhere else.`,
      items: repositories.map((repository) => ({
        id: placeLabel(repository.place),
        label: placeLabel(repository.place),
        searchText: placeLabel(repository.place),
        detail: worktreeCount(repository.worktrees.length),
      })),
      pinned: [
        {
          id: CLONE_ELSEWHERE,
          label: "Clone…",
          detail: `Clone ${item.owner}/${item.repository} again, somewhere else`,
        },
      ],
      emptyNoItems: `No clone of ${item.owner}/${item.repository} was found.`,
      emptyNoMatch: "No repository matches.",
    });
    if (answer.id === CLONE_ELSEWHERE) {
      return cloneDestinationStep(
        services,
        work,
        `${item.owner}/${item.repository} is being cloned again rather than worked on where it already is.`,
      );
    }
    const chosen = repositories.find(
      (repository) => placeLabel(repository.place) === answer.id,
    );
    return chosen
      ? branchStep(services, work, chosen.place)
      : cloneDestinationStep(services, work, nothingCloned(item));
  };
}

/** Why a clone is being asked about when nobody asked for one. */
function nothingCloned(item: GitHubItem): string {
  return `No clone of ${item.owner}/${item.repository} was found on this machine, so it has to be cloned before the agent can start.`;
}

/** "No worktrees", "2 worktrees" — what a repository row says about itself. */
function worktreeCount(places: number): string {
  const others = places - 1;
  if (others <= 0) return "No worktrees";
  return others === 1 ? "1 worktree" : `${String(others)} worktrees`;
}

/**
 * Which branch the agent works on, which is the same question as where — and,
 * once answered, that folder made or found.
 *
 * There are three answers and never a fourth, because an agent runs in the
 * repository's root checkout or in exactly one worktree of it:
 *
 * 1. **the branch this work already has** — a pull request's head, an Issue's
 *    linked branch, a branch named for the Issue — in its worktree: the one
 *    it is already checked out in, or a new one;
 * 2. **a new branch**, `feature/128-wip`, in a new worktree, which is what an
 *    Issue nobody has started gets;
 * 3. **the branch this work already has, in the root checkout** — opened if it
 *    is checked out there, switched to otherwise;
 * 4. **a new branch in the root checkout**, made from the same base as 2 and
 *    switched to — refused while the root has uncommitted changes;
 * 5. **the root checkout as it stands**, where nothing is checked out and
 *    which branch to read is the agent's business.
 *
 * Each row says what choosing it does and where, in the folder names DevHub
 * will use (`worktreeDirectory`: `../widget_128`, named for the Issue whichever
 * branch it holds), because "a worktree of its own, beside the repository"
 * left a person to guess whether an existing folder was meant. A branch that
 * is already checked out is offered in the folder git says holds it, whatever
 * that folder is called.
 *
 * The first is the default when there is one, because a person assigning a pull
 * request has already decided what to work on and it is not a new branch. It is
 * absent when there is no such branch — most Issues — and when there is one this
 * clone cannot reach, which is a pull request from a fork: the branch is in
 * somebody else's copy, DevHub will not add a remote to somebody's repository
 * on their behalf, and the note says so rather than the row failing later.
 *
 * A branch that is *already checked out* turns the first row into a different
 * offer: git gives one branch one worktree, so the honest answer is that the
 * work already has a folder and this is which one.
 *
 * The folder work happens here, after the answer, rather than at the end of
 * the flow: the agent question that follows is about this folder, and its
 * earlier sessions are the reason to ask it there. A failure — a directory in
 * the way — comes back to this question with the reason under it.
 */
function branchStep(
  services: FlowServices,
  work: Work,
  place: WorkspacePlaceWire,
): WizardStep {
  const { item } = work;
  const root = place.path;
  return async (input) => {
    // A refusal here loses the *plan* and not the question: the three answers
    // below — an existing branch, a new one, the root checkout — are what this
    // step is for, and two of the three need nothing GitHub knows. So the
    // refusal joins the question and the row that depended on the plan is
    // simply absent, rather than the flow ending or the step re-running the
    // very reads that did not finish.
    let plan: AssignmentBranchWire = { reachable: false };
    let refusal: string | undefined;
    try {
      plan = await input.working(`Reading ${itemLabel(item)}…`, (signal) =>
        services.assignmentBranch(gitHubItemUrl(item), place, signal),
      );
    } catch (error: unknown) {
      const spoken = spokenFailure(error);
      if (!spoken) throw error;
      refusal = spoken.summary;
    }
    // An Issue's branch that cannot be had is no branch at all: the answer is
    // to create one, not to report that it is missing. Main drops it already
    // (`issueBranchPlan`); this holds the sheet to the same rule whatever main
    // sent, so "is on neither this machine…" is only ever said of a pull
    // request's head.
    if (!plan.reachable && plan.checkedOutAt === undefined) {
      // A pull request is work on its head branch and nothing else: no
      // `feature/<n>-wip` is offered for one. A head that cannot be had stops
      // the flow here, before the branch question, with the reason under the
      // question before it.
      if (item.kind === "pull" && plan.branch !== undefined) {
        throw new UserFacingFailure(unreachableHead(item, plan));
      }
      plan = { reachable: false };
    }
    const wip = wipBranchForIssue(item.number);
    const answer = await input.ask({
      // Every answer is a pinned row, so "Nothing to choose from." would sit
      // above a list that has rows in it. Only the no-match text applies.
      emptyNoMatch: SHEET.emptyNoMatch,
      title: `Where to work on ${itemLabel(item)}`,
      question: `Choose where in ${folderName(root)} the agent works. The agent is chosen next.`,
      // Every row is an answer to the question rather than a name to search
      // among, so they are all pinned and the field filters nothing: there is
      // no list here that typing could narrow.
      items: [],
      pinned: folderRows(plan, root, item, wip),
      note: refusal,
    });
    const choice: FolderChoice =
      answer.id === OPEN_CHECKOUT && plan.checkedOutAt !== undefined
        ? // Somewhere the same repository is checked out, so the same
          // machine: git answered from there and could not have named a
          // folder anywhere else.
          {
            place: { ...place, path: plan.checkedOutAt },
            branch: undefined,
            inRoot: false,
          }
        : {
            place,
            branch:
              answer.id === NEW_WORKTREE || answer.id === ROOT_NEW_BRANCH
                ? wip
                : answer.id === EXISTING_BRANCH ||
                    answer.id === ROOT_EXISTING_BRANCH
                  ? plan.branch
                  : undefined,
            inRoot:
              answer.id === ROOT_NEW_BRANCH ||
              answer.id === ROOT_EXISTING_BRANCH,
          };
    return prepareFolder(services, input, work, choice, false);
  };
}

/**
 * The rows of the branch question, each saying what it does and where.
 *
 * `feature/128-wip` is the new branch only while it is not already the branch
 * this work has: once it is, the first row is that branch, and a second row
 * that would open the same folder under a claim that it "creates" one is not
 * an answer of its own. Likewise the root checkout is offered once, by the row
 * that says which branch it is on when that is the branch this work has.
 */
function folderRows(
  plan: AssignmentBranchWire,
  root: string,
  work: WorkItem,
  wip: string,
): readonly PickerItem[] {
  const branch = plan.branch;
  const checkedOutAt = plan.checkedOutAt;
  // The branch this work already has, when it can be had: checked out
  // somewhere already, or here or on a remote to check out.
  const existing =
    branch !== undefined && (checkedOutAt !== undefined || plan.reachable)
      ? branch
      : undefined;
  // Once the work's branch *is* `feature/128-wip`, rows that would "create"
  // it are not answers of their own.
  // A pull request's branch is its head; a new one is never offered for it.
  const offerNew = work.kind !== "pull" && branch !== wip;
  const rows: PickerItem[] = [];
  if (existing !== undefined && checkedOutAt !== root) {
    rows.push(
      checkedOutAt !== undefined
        ? {
            id: OPEN_CHECKOUT,
            label: `Open ${existing} in its worktree`,
            detail: `Already checked out in ${besideRoot(root, checkedOutAt)}`,
            searchText: `existing branch worktree ${existing} ${checkedOutAt}`,
          }
        : {
            id: EXISTING_BRANCH,
            label: `Open ${existing} in a new worktree`,
            detail: `Checks out the existing branch in ${besideRoot(root, worktreeDirectory(root, work, existing))}`,
            searchText: `existing branch worktree ${existing}`,
          },
    );
  }
  if (offerNew) {
    rows.push({
      id: NEW_WORKTREE,
      label: `Create ${wip} in a new worktree`,
      detail: `New branch from the default branch, in ${besideRoot(root, worktreeDirectory(root, work, wip))}`,
      searchText: `new branch worktree ${wip}`,
    });
  }
  if (existing !== undefined && checkedOutAt === root) {
    rows.push({
      id: OPEN_CHECKOUT,
      label: `Open ${existing} in the root checkout`,
      detail: `Already checked out in ${root}`,
      searchText: `existing branch root ${existing} ${root}`,
    });
  } else if (existing !== undefined && checkedOutAt === undefined) {
    rows.push({
      id: ROOT_EXISTING_BRANCH,
      label: `Open ${existing} in the root checkout`,
      detail: `Switches ${root} to the existing branch`,
      searchText: `existing branch root switch ${existing} ${root}`,
    });
  }
  if (offerNew) {
    rows.push({
      id: ROOT_NEW_BRANCH,
      label: `Create ${wip} in the root checkout`,
      detail: `New branch from the default branch, switched to in ${root}`,
      searchText: `new branch root switch ${wip} ${root}`,
    });
  }
  if (!(existing !== undefined && checkedOutAt === root)) {
    rows.push({
      id: ROOT_CHECKOUT,
      label: "Open the root checkout as it is",
      detail: `No branch change in ${root}`,
      searchText: `repository root as is ${root}`,
    });
  }
  return rows;
}

/**
 * A folder as the branch question names it: `../widget_128` when
 * it sits beside the repository, which is where DevHub puts worktrees, and
 * the whole path when it is anywhere else.
 */
function besideRoot(root: string, path: string): string {
  const parent = (of: string) =>
    of.slice(0, of.replace(/\/+$/u, "").lastIndexOf("/"));
  return parent(path) === parent(root) ? `../${baseName(path)}` : path;
}

/**
 * Why a pull request's head cannot be worked on here, in the words that are
 * true of it: merged or closed with the branch deleted, out of a fork with no
 * remote, or simply not on any remote this clone has.
 */
function unreachableHead(item: GitHubItem, plan: AssignmentBranchWire): string {
  const label = itemLabel(item);
  const branch = plan.branch ?? "";
  if (plan.fork !== undefined) {
    return `${branch} is in ${plan.fork}, which this clone has no remote for, so ${label} cannot be checked out here.`;
  }
  if (plan.pullRequestState === "merged") {
    return `${label} is a merged pull request, and its branch ${branch} no longer exists.`;
  }
  if (plan.pullRequestState === "closed") {
    return `${label} is a closed pull request, and its branch ${branch} no longer exists.`;
  }
  return `${branch}, the branch of ${label}, is on neither this machine nor any remote this clone has.`;
}

/**
 * Where a clone goes, and then the clone itself.
 *
 * `reason` is the sentence that says how the person got here, and it is a
 * parameter because there are two ways and they are not the same news. One is
 * a step they took — "Clone…" from the list of clones. The other is a question
 * they never asked for: the repository is nowhere on this machine, so a flow
 * about assigning an Issue has put up a list of folders. That was the whole of
 * the confusion this step used to cause, and a step that told both people the
 * same thing would still be causing half of it.
 */
function cloneDestinationStep(
  services: FlowServices,
  work: Work,
  reason: string,
): WizardStep {
  const { item } = work;
  return async (input) => {
    // The folders this person already keeps projects in, and where they were
    // last told new ones go. The same rows the "Clone Project…" sheet offers,
    // built by the same function, because it is the same question.
    //
    // A walk that did not finish loses the *rows* and not the question: the
    // folder can still be typed, and the pinned row below has always been able
    // to take it. So the refusal joins the question rather than replacing it,
    // and the person is one keystroke from the same outcome. Re-running the
    // step instead would start the walk again — and this step begins with the
    // walk, which is how a bounded lookup turns back into an endless spinner.
    let parents: readonly string[] = [];
    let refusal: string | undefined;
    try {
      parents = await input.working("Reading folders…", (signal) =>
        services.cloneParentDirectories(signal),
      );
    } catch (error: unknown) {
      const spoken = spokenFailure(error);
      if (!spoken) throw error;
      refusal = spoken.summary;
    }
    const answer = await input.ask({
      ...SHEET,
      title: `Clone ${item.owner}/${item.repository}`,
      question:
        refusal === undefined
          ? `${reason} Choose the folder to clone it into.`
          : `${refusal} Type the folder to clone it into.`,
      // No starting value: the field is a filter over the rows now, and a path
      // typed into it before anything is chosen would hide the list it is
      // meant to search. Where projects go is a *row* — main puts it there when
      // the sources imply no folders of their own.
      items: cloneParentItems(parents, item.repository),
      pinned: [cloneTypedItem(item.repository)],
      emptyNoItems: "Type the folder the clone should go into.",
      emptyNoMatch: "No folder matches. Type one instead.",
    });
    // A row names its own folder; the typed row means the field. One or the
    // other, decided here, so `cloneRepository` is only ever handed a path.
    const destination =
      answer.id === CLONE_INTO_TYPED ? answer.query : answer.id;
    // Built by the same rule as a repository somebody types into the Clone
    // Project sheet, rather than composed here: a URL rather than the SSH form,
    // because it is the one that works without the person's keys being set up
    // and git rewrites it if their config says to.
    const target = githubCloneTarget(item.owner, item.repository);
    // The owner and name came out of an Issue URL that parsed, so a name GitHub
    // could not have is DevHub having got its own parsing wrong. It goes to the
    // root handler rather than being turned into something to retype.
    if (target.kind !== "clone") {
      throw new Error(
        `the Issue's repository is not a name GitHub could have: ${target.reason}`,
      );
    }
    const directory = await input.working(
      `Cloning ${item.owner}/${item.repository}…`,
      () => services.cloneRepository(target.url, destination),
    );
    // A repository that has just been cloned is checked out in exactly one
    // place, so the location question is asked over that one place and a new
    // worktree — which is the same question everybody else gets, from the same
    // step, rather than a second arrangement of it.
    return branchStep(services, work, {
      kind: "local",
      path: directory,
    });
  };
}

/** The folder the branch question settled on, before it is made or found. */
interface FolderChoice {
  /** The clone, or — for a branch already checked out — the folder it is in. */
  readonly place: WorkspacePlaceWire;
  /** The branch whose worktree to open, made if need be; absent is `place` as it is. */
  readonly branch: string | undefined;
  /** Check `branch` out in `place` itself rather than in a worktree. */
  readonly inRoot: boolean;
}

/**
 * Make or find the folder, then ask which agent — opening nothing.
 *
 * Run from inside the step that asked for it, so a failure re-asks that step
 * with the reason under it. The one failure that is a question rather than a
 * reason is the fetch a new branch starts with: `origin` as of the last
 * successful fetch is on disk, and whether to start from it is the person's
 * call.
 */
async function prepareFolder(
  services: FlowServices,
  input: WizardInput,
  work: Work,
  choice: FolderChoice,
  allowStaleBase: boolean,
): Promise<WizardStep> {
  let folder: WorkspacePlaceWire;
  try {
    folder = await input.working(
      choice.branch === undefined
        ? `Reading ${baseName(choice.place.path)}…`
        : choice.inRoot
          ? `Switching ${baseName(choice.place.path)} to ${choice.branch}…`
          : `Setting up the worktree for ${choice.branch}…`,
      () =>
        services.prepareIssueFolder({
          issueUrl: gitHubItemUrl(work.item),
          place: choice.place,
          ...(choice.branch === undefined
            ? {}
            : choice.inRoot
              ? { branch: choice.branch, inRoot: true }
              : { branch: choice.branch }),
          allowStaleBase,
        }),
    );
  } catch (error: unknown) {
    if (toAppError(error).code !== "git_fetch_failed") throw error;
    return staleBaseStep(services, work, choice, error);
  }
  return agentStep(services, work, folder);
}

/**
 * Which agent works on it, in the folder the branch question settled on.
 *
 * New Agent's question, word for word, with the Issue in the title: a new
 * session of one of the profiles, or one of the earlier sessions that ran in
 * that folder, read by its path on its machine — the reason the folder is made
 * first. A worktree just made has had no session, so it offers the New rows
 * only, the same as New Agent in it would. A session taken is resumed and then
 * told about the Issue.
 *
 * The answer is what opens the folder: `assignIssue` opens it as the selected
 * Workspace and starts the agent in one act, so the Workspace, its editor and
 * the keyboard move only once there is an agent to go to. Escape goes back to
 * the branch question and opens nothing; a worktree it made stays on disk,
 * where the branch question's "Existing worktree" row finds it next time.
 */
function agentStep(
  services: FlowServices,
  work: Work,
  folder: WorkspacePlaceWire,
): WizardStep {
  const { item } = work;
  return async (input) => {
    const agent = await input.sheet<AgentChoice>((controls) => (
      <FolderAgentPicker
        title={`Agent for ${itemLabel(item)}`}
        place={folder}
        step={controls.step}
        failure={controls.failure}
        onChoose={controls.answer}
        onCancel={controls.back}
      />
    ));
    await input.working(`Starting the agent for ${itemLabel(item)}…`, () =>
      services.assignIssue({
        issueUrl: gitHubItemUrl(item),
        place: folder,
        profileId: agent.profileId,
        actionId: work.actionId,
        split: agent.split,
        presentation: agent.presentation,
        ...(agent.resume === undefined ? {} : { resume: agent.resume }),
      }),
    );
    return undefined;
  };
}

/** The fetch failed: start from the copy on disk, or not at all. */
function staleBaseStep(
  services: FlowServices,
  work: Work,
  choice: FolderChoice,
  failure: unknown,
): WizardStep {
  const branch = choice.branch;
  return async (input) => {
    const answer = await input.ask({
      ...SHEET,
      title: "The remote could not be reached",
      question: `${branch ?? "The branch"} cannot be started from the latest origin, because the fetch failed. Start it from the copy on this machine, or press Escape to go back.`,
      items: [
        {
          id: USE_STALE_BASE,
          label: "Start from the copy on this machine",
          detail: `${branch ?? "The branch"} starts from origin as of the last successful fetch`,
          searchText: "yes anyway offline stale local",
        },
      ],
      note: <Wrong what={toAppError(failure).summary} />,
    });
    // Escape is the other answer, and it is the runner's: back to the branch,
    // where a branch that already exists needs no fetch at all.
    return answer.id === USE_STALE_BASE
      ? prepareFolder(services, input, work, choice, true)
      : undefined;
  };
}
