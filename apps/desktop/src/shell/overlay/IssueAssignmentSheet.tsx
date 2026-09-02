/**
 * "Assign Issue": the five questions, as a wizard.
 *
 * Which Issue, which agent, which clone, one workspace or a worktree, which
 * branch — and each answer decides the next question, which is why this is a
 * chain of steps rather than five sheets that open each other. Escape goes back
 * one question the whole way down, because that is the runner's rule and no
 * step here had to be told about it.
 *
 * Two kinds of "that did not work" show up in the same place, the line under
 * the field, and they are different things. A URL that is not an Issue URL is
 * this file's business — the question simply has not been answered yet, so it
 * is asked again with what was typed still in the field. A clone git refused,
 * or a worktree whose directory is in the way, is main's, and the runner brings
 * it back to whichever step caused it.
 */

import { useMemo, useRef } from "react";
import type { AgentProfilesWire } from "../../ipc/appShell";
import {
  wipBranchForIssue,
  issueUrl,
  parseIssueUrl,
  type IssueReference,
} from "../../model/github";
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
import { githubCloneTarget } from "../../model/projects";
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
const USE_STALE_BASE = "devhub:use-stale-base";

function Wrong({ what }: { readonly what: string }) {
  return <span className="picker-note-failure">{what}</span>;
}

/** What every prompt in this flow has in common. */
const SHEET: Pick<WizardPrompt, "emptyNoMatch" | "emptyNoItems"> = {
  emptyNoMatch: "Nothing matches.",
  emptyNoItems: "Nothing to choose from.",
};

function issueLabel(issue: IssueReference): string {
  return `${issue.owner}/${issue.repository}#${String(issue.number)}`;
}

export function IssueAssignmentSheet({ onDismiss }: IssueAssignmentSheetProps) {
  const {
    agentProfiles,
    findIssueRepositories,
    cloneRepository,
    assignIssue,
    cloneParentDirectories,
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
        agentActions,
      }),
    [
      agentActions,
      assignIssue,
      cloneParentDirectories,
      cloneRepository,
      findIssueRepositories,
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
    const actions = await input.working("Reading settings…", () =>
      services.agentActions(),
    );
    const answer = await input.ask({
      ...SHEET,
      title: "Assign Issue",
      question:
        "Paste the GitHub Issue to work on, then choose what the agent should do with it.",
      placeholder: "Issue URL",
      initialQuery: typed,
      items: [],
      pinned:
        actions.length > 0
          ? actions.map((action) => ({
              id: `${ACTION_PREFIX}${action.id}`,
              label: action.displayName,
              detail: "Paste the URL of the GitHub Issue, then take this row",
            }))
          : [
              {
                id: ACCEPT_TYPED,
                label: "Use this Issue",
                detail:
                  "No actions are configured, so the agent starts and is told nothing",
              },
            ],
      note: wrong ? (
        <Wrong what="That is not a GitHub Issue URL." />
      ) : (
        "For example https://github.com/owner/repo/issues/128"
      ),
      emptyNoItems: "Paste an Issue URL.",
      emptyNoMatch: "Paste an Issue URL.",
    });
    const issue = parseIssueUrl(answer.query);
    if (!issue) return ask(input, answer.query, true);
    const actionId = answer.id.startsWith(ACTION_PREFIX)
      ? answer.id.slice(ACTION_PREFIX.length)
      : undefined;
    return agentStep(services, issue, actionId);
  };
  return (input) => ask(input, "", false);
}

/** Which agent starts on it. */
function agentStep(
  services: FlowServices,
  issue: IssueReference,
  actionId: string | undefined,
): WizardStep {
  return async (input) => {
    const answer = await input.ask({
      ...SHEET,
      title: `Agent for ${issueLabel(issue)}`,
      question: `Which agent should start on ${issueLabel(issue)}?`,
      placeholder: "Agent",
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
    return repositoryStep(services, issue, {
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
  issue: IssueReference,
  agent: AgentChoice,
): WizardStep {
  return async (input) => {
    const repositories = await input.working(
      `Looking for ${issue.owner}/${issue.repository}…`,
      () => services.findIssueRepositories(issueUrl(issue)),
    );
    if (repositories.length === 0) {
      return cloneDestinationStep(services, issue, agent, nothingCloned(issue));
    }
    const only = repositories.length === 1 ? repositories[0] : undefined;
    if (only) return locationStep(services, issue, agent, only);
    const answer = await input.ask({
      ...SHEET,
      title: `Which ${issue.owner}/${issue.repository}`,
      question: `This machine has more than one clone of ${issue.owner}/${issue.repository}. Choose the one to work in, or clone it again somewhere else.`,
      placeholder: "Repository",
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
          detail: `Clone ${issue.owner}/${issue.repository} again, somewhere else`,
        },
      ],
      emptyNoItems: `No clone of ${issue.owner}/${issue.repository} was found.`,
      emptyNoMatch: "No repository matches.",
    });
    if (answer.id === CLONE_ELSEWHERE) {
      return cloneDestinationStep(
        services,
        issue,
        agent,
        `${issue.owner}/${issue.repository} is being cloned again rather than worked on where it already is.`,
      );
    }
    const chosen = repositories.find(
      (repository) => repository.mainWorktree === answer.id,
    );
    return chosen
      ? locationStep(services, issue, agent, chosen)
      : cloneDestinationStep(services, issue, agent, nothingCloned(issue));
  };
}

/** "the repository itself", "and 2 worktrees" — what a repository row says. */
/** Why a clone is being asked about when nobody asked for one. */
function nothingCloned(issue: IssueReference): string {
  return `No clone of ${issue.owner}/${issue.repository} was found on this machine, so it has to be cloned before the agent can start.`;
}

function worktreeCount(places: number): string {
  const others = places - 1;
  if (others <= 0) return "No worktrees";
  return others === 1 ? "1 worktree" : `${String(others)} worktrees`;
}

/**
 * Where in the repository the work happens.
 *
 * One question with every answer in it: the repository itself, each worktree it
 * already has, and a new worktree. They belong together because they are the
 * same decision — *which checkout do I want* — and a person who keeps three
 * worktrees of one repository was previously asked to pick one directory and
 * then, separately, whether they wanted a different one.
 *
 * The worktrees are git's list rather than the search's, so one made by hand in
 * a folder no source looks at is offered like any other.
 */
function locationStep(
  services: FlowServices,
  issue: IssueReference,
  agent: AgentChoice,
  repository: IssueRepository,
): WizardStep {
  return async (input) => {
    const answer = await input.ask({
      ...SHEET,
      title: `Where to work on ${issueLabel(issue)}`,
      question: `Choose the checkout of ${repository.mainWorktree} the agent works in — the repository itself, a worktree it already has, or a new one.`,
      placeholder: "Where to work",
      items: repository.worktrees.map((worktree) => ({
        id: worktree.path,
        label: worktree.path,
        searchText: `${worktree.path} ${worktree.branch ?? ""}`,
        detail: worktree.isMainWorktree
          ? `The repository · ${worktree.branch ?? "detached"}`
          : `Worktree · ${worktree.branch ?? "detached"}`,
      })),
      pinned: [
        {
          id: NEW_WORKTREE,
          label: "New worktree",
          detail: `A branch of its own, in a folder beside ${repository.mainWorktree}`,
        },
      ],
      emptyNoItems: "This repository is checked out nowhere.",
      emptyNoMatch: "Nowhere matches. A new worktree is still an answer.",
    });
    return finishStep(
      services,
      issue,
      agent,
      // A new worktree is measured from the repository; an existing one is
      // simply opened where it is.
      answer.id === NEW_WORKTREE ? repository.mainWorktree : answer.id,
      // The branch is not asked for. It is `feature/128-wip`, made now so work
      // can start now, and the agent is told to rename it once it knows what
      // the work is — that instruction is in the action's message, which is a
      // setting (see `model/agentActions.ts`). A picker of branch names here
      // was a question nobody could answer yet: the good name is the one you
      // have after reading the Issue, not before.
      answer.id === NEW_WORKTREE ? wipBranchForIssue(issue.number) : undefined,
    );
  };
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
  issue: IssueReference,
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
      title: `Clone ${issue.owner}/${issue.repository}`,
      question: `${reason} Choose the folder to clone it into.`,
      placeholder: "Parent folder",
      // No starting value: the field is a filter over the rows now, and a path
      // typed into it before anything is chosen would hide the list it is
      // meant to search. Where projects go is a *row* — main puts it there when
      // the sources imply no folders of their own.
      items: cloneParentItems(parents, issue.repository),
      pinned: [cloneTypedItem(issue.repository)],
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
    const target = githubCloneTarget(issue.owner, issue.repository);
    // The owner and name came out of an Issue URL that parsed, so a name GitHub
    // could not have is DevHub having got its own parsing wrong. It goes to the
    // root handler rather than being turned into something to retype.
    if (target.kind !== "clone") {
      throw new Error(
        `the Issue's repository is not a name GitHub could have: ${target.reason}`,
      );
    }
    const directory = await input.working(
      `Cloning ${issue.owner}/${issue.repository}…`,
      () => services.cloneRepository(target.url, destination),
    );
    // A repository that has just been cloned is checked out in exactly one
    // place, so the location question is asked over that one place and a new
    // worktree — which is the same question everybody else gets, from the same
    // step, rather than a second arrangement of it.
    return locationStep(services, issue, agent, {
      mainWorktree: directory,
      worktrees: [{ path: directory, isMainWorktree: true }],
    });
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
  issue: IssueReference,
  agent: AgentChoice,
  directory: string,
  branch: string | undefined,
  allowStaleBase = false,
): WizardStep {
  return async (input) => {
    try {
      await input.working(`Setting up ${issueLabel(issue)}…`, () =>
        services.assignIssue({
          issueUrl: issueUrl(issue),
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
      return staleBaseStep(services, issue, agent, directory, branch, error);
    }
    return undefined;
  };
}

/** The fetch failed: start from the copy on disk, or not at all. */
function staleBaseStep(
  services: FlowServices,
  issue: IssueReference,
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
      placeholder: "Start the branch anyway?",
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
      ? finishStep(services, issue, agent, directory, branch, true)
      : undefined;
  };
}
