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

import { useMemo } from "react";
import type { AgentProfilesWire } from "../../ipc/appShell";
import {
  branchNameForIssue,
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
import type { IssueClone } from "../client";
import { useAppShell } from "../useAppShell";

export interface IssueAssignmentSheetProps {
  readonly onDismiss: () => void;
}

/** Rows that do something rather than name something that already exists. */
const CLONE_ELSEWHERE = "devhub:clone-elsewhere";
const ACCEPT_TYPED = "devhub:accept-typed";
const SAME_WORKSPACE = "devhub:same-workspace";
const NEW_WORKTREE = "devhub:new-worktree";
const NEW_BRANCH = "devhub:new-branch";

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
    listBranches,
    assignIssue,
    projectDefaultDirectory,
  } = useAppShell();

  const start = useMemo<WizardStep>(
    () =>
      issueUrlStep({
        agentProfiles,
        findIssueClones,
        cloneRepository,
        listBranches,
        assignIssue,
        projectDefaultDirectory,
      }),
    [
      agentProfiles,
      assignIssue,
      cloneRepository,
      findIssueClones,
      listBranches,
      projectDefaultDirectory,
    ],
  );

  return <Wizard start={start} onFinished={onDismiss} />;
}

interface FlowServices {
  readonly agentProfiles: AgentProfilesWire;
  readonly findIssueClones: (url: string) => Promise<readonly IssueClone[]>;
  readonly cloneRepository: (url: string, parent: string) => Promise<string>;
  readonly listBranches: (directory: string) => Promise<readonly string[]>;
  readonly assignIssue: (request: {
    readonly issueUrl: string;
    readonly directory: string;
    readonly branch?: string;
    readonly profileId: string;
    readonly split: boolean;
  }) => Promise<unknown>;
  readonly projectDefaultDirectory: () => Promise<string>;
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
      items: services.agentProfiles.profiles.map((profile) => ({
        id: profile.id,
        label: profile.displayName,
        searchText: `${profile.displayName} ${profile.kind}`,
      })),
      note: "⌘Return opens the agent beside the editor.",
      emptyNoItems:
        services.agentProfiles.availability === "unavailable"
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
 * Always a question, even when there is exactly one answer or none at all. A
 * step that decided for itself when to appear would be a step Escape could not
 * come back to: the person would press it and land two questions earlier, or
 * on the same question again, depending on something they cannot see.
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
    const parent = await input.working("Reading settings…", () =>
      services.projectDefaultDirectory(),
    );
    const answer = await input.ask({
      ...SHEET,
      title: `Clone ${issue.owner}/${issue.repository}`,
      placeholder: "Parent folder",
      initialQuery: parent,
      items: [],
      pinned: [
        {
          id: ACCEPT_TYPED,
          label: "Clone into this folder",
          detail: `The clone lands in this folder as ${issue.repository}`,
        },
      ],
      emptyNoItems: "Where should the clone go?",
      emptyNoMatch: "Where should the clone go?",
    });
    // A URL rather than the SSH form: it is the one that works without the
    // person's keys being set up, and git rewrites it if their config says to.
    const directory = await input.working(
      `Cloning ${issue.owner}/${issue.repository}…`,
      () =>
        services.cloneRepository(
          `https://github.com/${issue.owner}/${issue.repository}.git`,
          answer.query,
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
    return answer.id === NEW_WORKTREE
      ? branchStep(services, issue, agent, directory)
      : finishStep(services, issue, agent, directory, undefined);
  };
}

/**
 * Which branch the worktree holds.
 *
 * The field starts at `feature/{issue}-` and the person types the rest, which
 * is the naming convention the sidebar reads back for branches DevHub did not
 * make. Taking an existing branch checks it out; taking "New Branch…" makes
 * one named whatever is in the field.
 */
function branchStep(
  services: FlowServices,
  issue: IssueReference,
  agent: AgentChoice,
  directory: string,
): WizardStep {
  return async (input) => {
    const branches = await input.working("Reading branches…", () =>
      services.listBranches(directory),
    );
    const suggested = branchNameForIssue(issue.number);
    const answer = await input.ask({
      ...SHEET,
      title: `Branch for ${issueLabel(issue)}`,
      placeholder: "Branch",
      initialQuery: suggested,
      items: branches.map((branch) => ({ id: branch, label: branch })),
      pinned: [
        {
          id: NEW_BRANCH,
          label: "New Branch…",
          detail: "Create the branch named in the field",
        },
      ],
      // Where it lands is `{repo}_{branch}` beside the repository, but the
      // repository here may itself be a worktree — the folder is measured from
      // the main one — so the note says the rule rather than a path that could
      // be wrong.
      note: "The worktree goes beside the repository, named for the branch.",
      emptyNoItems: "This repository has no branches yet.",
      emptyNoMatch: "No branch matches. Return makes one with this name.",
    });
    const branch = answer.id === NEW_BRANCH ? answer.query : answer.id;
    return finishStep(services, issue, agent, directory, branch);
  };
}

/** Everything the answers add up to, in one call to main. */
function finishStep(
  services: FlowServices,
  issue: IssueReference,
  agent: AgentChoice,
  directory: string,
  branch: string | undefined,
): WizardStep {
  return async (input) => {
    await input.working(`Setting up ${issueLabel(issue)}…`, () =>
      services.assignIssue({
        issueUrl: issueUrl(issue),
        directory,
        branch,
        profileId: agent.profileId,
        split: agent.split,
      }),
    );
    return undefined;
  };
}
