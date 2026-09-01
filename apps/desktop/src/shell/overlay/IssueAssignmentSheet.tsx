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
import type { IssueClone } from "../client";
import { toAppError } from "../failure";
import { useAppShell } from "../useAppShell";

export interface IssueAssignmentSheetProps {
  readonly onDismiss: () => void;
}

/** Rows that do something rather than name something that already exists. */
const CLONE_ELSEWHERE = "devhub:clone-elsewhere";
const ACCEPT_TYPED = "devhub:accept-typed";
const SAME_WORKSPACE = "devhub:same-workspace";
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
    findIssueClones,
    cloneRepository,
    assignIssue,
    cloneParentDirectories,
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
        findIssueClones,
        cloneRepository,
        assignIssue,
        cloneParentDirectories,
      }),
    [assignIssue, cloneParentDirectories, cloneRepository, findIssueClones],
  );

  return <Wizard start={start} onFinished={onDismiss} />;
}

interface FlowServices {
  readonly agentProfiles: () => AgentProfilesWire;
  readonly findIssueClones: (url: string) => Promise<readonly IssueClone[]>;
  readonly cloneRepository: (url: string, parent: string) => Promise<string>;
  readonly assignIssue: (request: {
    readonly issueUrl: string;
    readonly directory: string;
    readonly branch?: string;
    readonly profileId: string;
    readonly split: boolean;
    readonly allowStaleBase?: boolean;
  }) => Promise<unknown>;
  readonly cloneParentDirectories: () => Promise<readonly string[]>;
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
    const answer = await input.ask({
      ...SHEET,
      title: "Assign Issue",
      placeholder: "Issue URL",
      initialQuery: typed,
      items: [],
      pinned: [
        {
          id: ACCEPT_TYPED,
          label: "Use this Issue",
          detail: "Paste the URL of the GitHub Issue to work on",
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
    return agentStep(services, issue);
  };
  return (input) => ask(input, "", false);
}

/** Which agent starts on it. */
function agentStep(services: FlowServices, issue: IssueReference): WizardStep {
  return async (input) => {
    const answer = await input.ask({
      ...SHEET,
      title: `Agent for ${issueLabel(issue)}`,
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
    return cloneStep(services, issue, {
      profileId: answer.id,
      split: answer.split,
    });
  };
}

interface AgentChoice {
  readonly profileId: string;
  readonly split: boolean;
}

/**
 * Which clone of the repository.
 *
 * Asked only when there is something to ask. One clone is not a choice — a
 * picker with a single row is a keystroke asking the person to confirm what
 * DevHub already knows — so it is taken and the flow moves on. Nought or
 * several is a real question, and it is put.
 *
 * This used to always ask, on the reasoning that a step which decides for
 * itself is a step Escape cannot come back to. That was true of the runner and
 * is not any more: a step that asks nothing is no longer a place the stack
 * remembers, so Escape from the question after this one reaches the question
 * before it. See `runWizard`.
 */
function cloneStep(
  services: FlowServices,
  issue: IssueReference,
  agent: AgentChoice,
): WizardStep {
  return async (input) => {
    const clones = await input.working(
      `Looking for ${issue.owner}/${issue.repository}…`,
      () => services.findIssueClones(issueUrl(issue)),
    );
    const only = clones.length === 1 ? clones[0] : undefined;
    if (only) return arrangementStep(services, issue, agent, only.path);
    const answer = await input.ask({
      ...SHEET,
      title: `Where to work on ${issueLabel(issue)}`,
      placeholder: "Repository",
      items: clones.map((clone) => ({
        id: clone.path,
        label: clone.path,
        searchText: clone.path,
        detail: clone.isMainWorktree
          ? clone.branch
          : `worktree · ${clone.branch ?? "detached"}`,
      })),
      pinned: [
        {
          id: CLONE_ELSEWHERE,
          label: "Clone…",
          detail: `Clone ${issue.owner}/${issue.repository} and work in it`,
        },
      ],
      emptyNoItems: `No clone of ${issue.owner}/${issue.repository} was found.`,
      emptyNoMatch: "No clone matches.",
    });
    return answer.id === CLONE_ELSEWHERE
      ? cloneDestinationStep(services, issue, agent)
      : arrangementStep(services, issue, agent, answer.id);
  };
}

/** Where a clone goes, and then the clone itself. */
function cloneDestinationStep(
  services: FlowServices,
  issue: IssueReference,
  agent: AgentChoice,
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
    // A URL rather than the SSH form: it is the one that works without the
    // person's keys being set up, and git rewrites it if their config says to.
    const directory = await input.working(
      `Cloning ${issue.owner}/${issue.repository}…`,
      () =>
        services.cloneRepository(
          `https://github.com/${issue.owner}/${issue.repository}.git`,
          destination,
        ),
    );
    return arrangementStep(services, issue, agent, directory);
  };
}

/** This workspace, or a worktree of it. */
function arrangementStep(
  services: FlowServices,
  issue: IssueReference,
  agent: AgentChoice,
  directory: string,
): WizardStep {
  return async (input) => {
    const answer = await input.ask({
      ...SHEET,
      title: `Work on ${issueLabel(issue)}`,
      placeholder: "How to work on it",
      items: [
        {
          id: SAME_WORKSPACE,
          label: "In this workspace",
          detail: directory,
          searchText: "workspace here same",
        },
        {
          id: NEW_WORKTREE,
          label: "In a new worktree",
          detail: "A branch of its own, in a folder beside the repository",
          searchText: "worktree branch new",
        },
      ],
    });
    return finishStep(
      services,
      issue,
      agent,
      directory,
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
