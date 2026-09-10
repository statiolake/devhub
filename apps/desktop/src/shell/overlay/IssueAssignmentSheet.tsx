/**
 * "Assign Issue": the four questions, as a wizard.
 *
 * Which Issue and what to do with it, which agent, which clone, which branch —
 * and each answer decides the next question, which is why this is a chain of
 * steps rather than four sheets that open each other. Escape goes back one
 * question the whole way down, because that is the runner's rule and no step
 * here had to be told about it.
 *
 * Two kinds of "that did not work" show up in the same place, the line under
 * the field, and they are different things. A URL that is not an Issue URL is
 * this file's business — the question simply has not been answered yet, so it
 * is asked again with what was typed still in the field. A clone git refused,
 * or a worktree whose directory is in the way, is main's, and the runner brings
 * it back to whichever step caused it.
 */

import { useMemo, useRef, type ReactNode } from "react";
import type { AgentProfilesWire } from "../../ipc/appShell";
import type { AssignmentBranchWire } from "../../ipc/contract";
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
import type { AgentActionWire, IssueRepository } from "../client";
import { folderName, githubCloneTarget } from "../../model/projects";
import { toAppError } from "../failure";
import { useAppShell } from "../useAppShell";

export interface IssueAssignmentSheetProps {
  readonly onDismiss: () => void;
}

/** Rows that do something rather than name something that already exists. */
const CLONE_ELSEWHERE = "devhub:clone-elsewhere";
const ACCEPT_TYPED = "devhub:accept-typed";
/** A row that is one of the person's own actions, by its id. */
const ACTION_PREFIX = "devhub:action:";
const NEW_WORKTREE = "devhub:new-worktree";
/** The branch this work already has, checked out in a worktree of its own. */
const EXISTING_BRANCH = "devhub:existing-branch";
/** The checkout that branch is already in, opened as the workspace it is. */
const OPEN_CHECKOUT = "devhub:open-checkout";
const ROOT_CHECKOUT = "devhub:root-checkout";
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
    agentProfiles,
    findIssueRepositories,
    cloneRepository,
    assignIssue,
    cloneParentDirectories,
    assignmentBranch,
    agentActions,
  } = useAppShell();

  /**
   * The profiles as they are *now*, not as they were when the flow started.
   *
   * The flow is built once and walked over several seconds; the profiles are a
   * projection that arrives after the page mounts. Closing over the value
   * caught the sheet asking "which agent?" over an empty list and answering
   * "profiles are unavailable" — true at mount, false by the time anyone read
   * it. Everything else the flow needs is a stable callback, so this is the
   * only reading that has to be taken late.
   */
  const profiles = useRef(agentProfiles);
  profiles.current = agentProfiles;

  const start = useMemo<WizardStep>(
    () =>
      issueUrlStep({
        agentProfiles: () => profiles.current,
        findIssueRepositories,
        cloneRepository,
        assignIssue,
        cloneParentDirectories,
        assignmentBranch,
        agentActions,
      }),
    [
      agentActions,
      assignIssue,
      cloneParentDirectories,
      cloneRepository,
      findIssueRepositories,
      assignmentBranch,
    ],
  );

  return <Wizard start={start} onFinished={onDismiss} />;
}

interface FlowServices {
  readonly agentProfiles: () => AgentProfilesWire;
  readonly findIssueRepositories: (
    url: string,
  ) => Promise<readonly IssueRepository[]>;
  readonly cloneRepository: (url: string, parent: string) => Promise<string>;
  readonly assignIssue: (request: {
    readonly issueUrl: string;
    readonly directory: string;
    readonly branch?: string;
    readonly profileId: string;
    readonly actionId?: string;
    readonly split: boolean;
    readonly allowStaleBase?: boolean;
  }) => Promise<unknown>;
  readonly cloneParentDirectories: () => Promise<readonly string[]>;
  readonly assignmentBranch: (
    url: string,
    directory: string,
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
    return agentStep(services, item, actionId);
  };
  return (input) => ask(input, "", false);
}

/** Which agent starts on it. */
function agentStep(
  services: FlowServices,
  item: GitHubItem,
  actionId: string | undefined,
): WizardStep {
  return async (input) => {
    const answer = await input.ask({
      ...SHEET,
      title: `Agent for ${itemLabel(item)}`,
      question: `Which agent should start on ${itemLabel(item)}?`,
      items: services.agentProfiles().profiles.map((profile) => ({
        id: profile.id,
        label: profile.displayName,
        searchText: `${profile.displayName} ${profile.kind}`,
      })),
      note: "⌘Return opens the agent beside the editor.",
      emptyNoItems:
        services.agentProfiles().availability === "unavailable"
          ? "Agent profiles are unavailable until the configuration is readable again."
          : "No agent profiles are enabled.",
      emptyNoMatch: "No agent profiles match.",
    });
    return repositoryStep(services, item, {
      profileId: answer.id,
      split: answer.split,
      actionId,
    });
  };
}

interface AgentChoice {
  readonly profileId: string;
  readonly split: boolean;
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
function repositoryStep(
  services: FlowServices,
  item: GitHubItem,
  agent: AgentChoice,
): WizardStep {
  return async (input) => {
    const repositories = await input.working(
      `Looking for ${item.owner}/${item.repository}…`,
      () => services.findIssueRepositories(gitHubItemUrl(item)),
    );
    if (repositories.length === 0) {
      return cloneDestinationStep(services, item, agent, nothingCloned(item));
    }
    const only = repositories.length === 1 ? repositories[0] : undefined;
    if (only) return branchStep(services, item, agent, only.mainWorktree);
    const answer = await input.ask({
      ...SHEET,
      title: `Which ${item.owner}/${item.repository}`,
      question: `This machine has more than one clone of ${item.owner}/${item.repository}. Choose the one to work in, or clone it again somewhere else.`,
      items: repositories.map((repository) => ({
        id: repository.mainWorktree,
        label: repository.mainWorktree,
        searchText: repository.mainWorktree,
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
        item,
        agent,
        `${item.owner}/${item.repository} is being cloned again rather than worked on where it already is.`,
      );
    }
    const chosen = repositories.find(
      (repository) => repository.mainWorktree === answer.id,
    );
    return chosen
      ? branchStep(services, item, agent, chosen.mainWorktree)
      : cloneDestinationStep(services, item, agent, nothingCloned(item));
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
 * Which branch the agent works on, which is the same question as where.
 *
 * There are three answers and never a fourth, because an agent runs in the
 * repository's root checkout or in exactly one worktree of it:
 *
 * 1. **the branch this work already has** — a pull request's head, an Issue's
 *    linked branch — checked out in a worktree;
 * 2. **a new branch**, `feature/128-wip`, in a worktree, which is what an Issue
 *    nobody has started gets;
 * 3. **the root checkout**, taken as it stands, where nothing is checked out
 *    and which branch to read is the agent's business.
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
 * work already has a folder and this is which one. Opening it is not "another
 * worktree for the agent" — it is the workspace the branch lives in.
 *
 * This replaced a list of every worktree the repository had. That list read as
 * the same question and was not: choosing an unrelated worktree put an agent to
 * work on a branch that had nothing to do with the Issue, and the branch — the
 * thing the person was actually deciding — was never on screen.
 */
function branchStep(
  services: FlowServices,
  item: GitHubItem,
  agent: AgentChoice,
  root: string,
): WizardStep {
  return async (input) => {
    const plan = await input.working(`Reading ${itemLabel(item)}…`, () =>
      services.assignmentBranch(gitHubItemUrl(item), root),
    );
    const wip = wipBranchForIssue(item.number);
    const answer = await input.ask({
      ...SHEET,
      title: `Where to work on ${itemLabel(item)}`,
      question: `Choose the branch the agent works on in ${folderName(root)}.`,
      // Every row is an answer to the question rather than a name to search
      // among, so they are all pinned and the field filters nothing: there is
      // no list here that typing could narrow.
      items: [],
      pinned: [
        ...existingBranchRows(plan, root),
        {
          id: NEW_WORKTREE,
          label: `New branch ${wip}`,
          detail: `A worktree of its own, beside ${folderName(root)}`,
          searchText: `new branch worktree ${wip}`,
        },
        {
          id: ROOT_CHECKOUT,
          label: "Work in the root checkout",
          detail: `${root} — taken as it stands, with nothing checked out`,
          searchText: `repository root ${root}`,
        },
      ],
      note: unreachableBranch(plan),
    });
    if (answer.id === OPEN_CHECKOUT && plan.checkedOutAt !== undefined) {
      return finishStep(services, item, agent, plan.checkedOutAt, undefined);
    }
    return finishStep(
      services,
      item,
      agent,
      root,
      answer.id === NEW_WORKTREE
        ? wip
        : answer.id === EXISTING_BRANCH
          ? plan.branch
          : undefined,
    );
  };
}

/**
 * The row for the branch this work already has, when there is one to offer.
 *
 * Three cases and one row: the branch is already checked out somewhere, so that
 * folder is what is offered; the branch can be had, so a worktree for it is;
 * or there is nothing to offer and the list starts at the new branch.
 */
function existingBranchRows(
  plan: AssignmentBranchWire,
  root: string,
): readonly PickerItem[] {
  const branch = plan.branch;
  if (branch === undefined) return [];
  if (plan.checkedOutAt !== undefined) {
    return [
      {
        id: OPEN_CHECKOUT,
        label:
          plan.checkedOutAt === root
            ? "Open the root checkout"
            : `Open ${folderName(plan.checkedOutAt)}`,
        detail: `${branch} is already checked out there`,
        searchText: `${branch} ${plan.checkedOutAt}`,
      },
    ];
  }
  if (!plan.reachable) return [];
  return [
    {
      id: EXISTING_BRANCH,
      label: `Check out ${branch} in a worktree`,
      detail: `The branch this work already has, beside ${folderName(root)}`,
      searchText: `${branch} checkout worktree`,
    },
  ];
}

/** The branch exists and is somewhere this clone cannot see. */
function unreachableBranch(plan: AssignmentBranchWire): ReactNode {
  if (plan.branch === undefined || plan.reachable) return undefined;
  return (
    <Wrong
      what={
        plan.fork === undefined
          ? `${plan.branch} is on neither this machine nor any remote this clone has.`
          : `${plan.branch} is in ${plan.fork}, which this clone has no remote for, so it cannot be checked out here.`
      }
    />
  );
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
  item: GitHubItem,
  agent: AgentChoice,
  reason: string,
): WizardStep {
  return async (input) => {
    // The folders this person already keeps projects in, and where they were
    // last told new ones go. The same rows the "Clone Project…" sheet offers,
    // built by the same function, because it is the same question.
    const parents = await input.working("Reading folders…", () =>
      services.cloneParentDirectories(),
    );
    const answer = await input.ask({
      ...SHEET,
      title: `Clone ${item.owner}/${item.repository}`,
      question: `${reason} Choose the folder to clone it into.`,
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
    return branchStep(services, item, agent, directory);
  };
}

/**
 * Everything the answers add up to, in one call to main.
 *
 * With one question left in it. A new branch starts from the remote's default
 * branch, which means fetching first, and a fetch can fail with the work still
 * perfectly possible: `origin` as of the last successful fetch is on disk. That
 * is a decision with consequences — a base that may be days old — so it is
 * asked rather than assumed, with git's own reason quoted, and the same call is
 * made again with the answer.
 */
function finishStep(
  services: FlowServices,
  item: GitHubItem,
  agent: AgentChoice,
  directory: string,
  branch: string | undefined,
  allowStaleBase = false,
): WizardStep {
  return async (input) => {
    try {
      await input.working(`Setting up ${itemLabel(item)}…`, () =>
        services.assignIssue({
          issueUrl: gitHubItemUrl(item),
          directory,
          branch,
          profileId: agent.profileId,
          actionId: agent.actionId,
          split: agent.split,
          allowStaleBase,
        }),
      );
    } catch (error: unknown) {
      if (toAppError(error).code !== "git_fetch_failed") throw error;
      return staleBaseStep(services, item, agent, directory, branch, error);
    }
    return undefined;
  };
}

/** The fetch failed: start from the copy on disk, or not at all. */
function staleBaseStep(
  services: FlowServices,
  item: GitHubItem,
  agent: AgentChoice,
  directory: string,
  branch: string | undefined,
  failure: unknown,
): WizardStep {
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
      ? finishStep(services, item, agent, directory, branch, true)
      : undefined;
  };
}
