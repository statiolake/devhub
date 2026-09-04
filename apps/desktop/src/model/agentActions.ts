/**
 * What DevHub says to an Agent on the person's behalf.
 *
 * Starting an Agent on an Issue is DevHub typing the first message: "read this
 * Issue and implement it", with the URL. That sentence is a *setting*, because
 * it is the person's own instructions to their own agent — how they want work
 * started, which skill to invoke, what to call the branch — and no wording
 * DevHub ships is right for everybody.
 *
 * **Actions are built in; their wording is configured.** DevHub decides that
 * there is such a thing as "assigning an Issue" and when it happens; the config
 * decides what gets said. That is the whole shape of the extension point, and
 * it is the shape because the alternative does not work: an action a person
 * invented would have nothing to fire it. Adding the commit and push buttons
 * that are coming is adding entries to `AGENT_ACTIONS` and the code that
 * triggers them — the config schema does not move, and a person's existing
 * wording is untouched.
 *
 * Two things happen to a template before it is sent, and both are here so that
 * they cannot be done differently in two places: the variables are filled in,
 * and the skill notation is translated for whichever agent is being spoken to.
 */

import type { AgentProfileKind } from "./config.js";

/**
 * What makes DevHub say an action.
 *
 * There used to be one trigger — the Issue flow — and so there was one list of
 * actions and one set of variables, and neither had to say which was which.
 * There are four now: assigning an Issue, and the three shortcuts a workspace
 * offers while work is under way. A trigger is the thing that fires, the
 * wording is the thing a person owns, and the pair is the whole extension
 * point.
 *
 * `issue` is also what an action DevHub has never heard of is treated as.
 * A person who works two ways — implement it, review it — writes a second
 * action and picks between them where the Issue flow asks; the shortcuts have
 * no picker, because a button *is* the choice.
 */
export type AgentActionTrigger = "issue" | "commit" | "push" | "pull_request";

/**
 * Every trigger there is, in the order a person meets them.
 *
 * The list the config file's `[agent_actions.<trigger>]` keys are checked
 * against and the order the Settings tree draws its groups in. One list, so a
 * trigger cannot be spellable in the file and invisible in the window.
 */
export const ACTION_TRIGGERS: readonly AgentActionTrigger[] = [
  "issue",
  "commit",
  "push",
  "pull_request",
];

/**
 * What each trigger is, in one line, for the group headings in Settings.
 */
export const TRIGGER_NAMES: Readonly<Record<AgentActionTrigger, string>> = {
  issue: "Assigning an Issue",
  commit: "Commit button",
  push: "Push button",
  pull_request: "Pull request button",
};

/**
 * The action DevHub ships for the Issue flow, and the id it ships it under.
 */
export const DEFAULT_ACTION_ID = "issue_assignment";

/**
 * The Issue assignment prompt.
 *
 * It asks for the branch by name because the branch is the whole of the link
 * between a workspace and its Issue (see `issueNumberFromBranch`): DevHub makes
 * `feature/128-wip` so that work can start immediately, and the Agent is asked
 * to rename it to something that says what it is. Nothing enforces that — it is
 * a sentence to a program that reads sentences — which is exactly why it has to
 * be editable.
 */
const ISSUE_ASSIGNMENT_TEMPLATE = `このIssueを読み、実装をしてください。
{{ISSUE_URL}}
ブランチ名は feature/{{ISSUE_NO}}-<short-name> としてデフォルトブランチから切ってください。
feature/{{ISSUE_NO}}-wip となっている場合は、適切な名前に変えてください。
`;

export const DEFAULT_ACTION_NAME = "Work on the Issue";

export const DEFAULT_ACTION_TEMPLATE = ISSUE_ASSIGNMENT_TEMPLATE;

/**
 * The names a template may use, without the braces, per trigger.
 *
 * A property of the trigger and not of the wording, which is what the single
 * global list was waiting to become: the Issue flow knows a URL and a number,
 * and a shortcut fired from a workspace row knows the branch it is standing on.
 * Offering `{{ISSUE_URL}}` on a commit button would be offering a hole that is
 * never filled.
 *
 * Committing is offered nothing, and that is not an oversight: it happens
 * entirely inside the working tree, and the branch's name is not a fact the
 * sentence needs. Naming a variable that the shipped wording has no use for
 * would be advertising a hole for somebody to type.
 */
export const ACTION_VARIABLES: Readonly<
  Record<AgentActionTrigger, readonly string[]>
> = {
  issue: ["ISSUE_URL", "ISSUE_NO"],
  commit: [],
  push: ["BRANCH"],
  pull_request: ["BRANCH"],
};

/**
 * The wording DevHub ships for the three shortcuts.
 *
 * Short, and in the language the Issue default is written in, because they say
 * one thing each and the person reading them is an agent already standing in
 * the repository. Everything about *when* to offer them is decided by the
 * workspace's own state, so none of these has to describe a condition — the
 * button was only drawn because the condition held.
 */
const COMMIT_TEMPLATE = `ここまでの変更をコミットしてください。
関連する変更ごとに、意味のある単位に分けてください。
`;

const PUSH_TEMPLATE = `コミット済みの変更を {{BRANCH}} にプッシュしてください。
`;

const PULL_REQUEST_TEMPLATE = `{{BRANCH}} からプルリクエストを作成してください。
タイトルと説明は、このブランチでの変更内容から書いてください。
`;

/**
 * Every action DevHub ships, with what fires it.
 *
 * The list the config's defaults are built from and the list a trigger is
 * looked up in, so a built-in action cannot exist in one and not the other.
 * An id that is not here is an Issue action somebody wrote, which is the
 * extension point working as intended.
 */
export const BUILT_IN_ACTIONS: readonly {
  readonly id: string;
  readonly displayName: string;
  readonly template: string;
  readonly trigger: AgentActionTrigger;
}[] = [
  {
    id: DEFAULT_ACTION_ID,
    displayName: "Work on the Issue",
    template: ISSUE_ASSIGNMENT_TEMPLATE,
    trigger: "issue",
  },
  {
    id: "commit_changes",
    displayName: "Commit the changes",
    template: COMMIT_TEMPLATE,
    trigger: "commit",
  },
  {
    id: "push_commits",
    displayName: "Push the commits",
    template: PUSH_TEMPLATE,
    trigger: "push",
  },
  {
    id: "open_pull_request",
    displayName: "Open a pull request",
    template: PULL_REQUEST_TEMPLATE,
    trigger: "pull_request",
  },
];

/**
 * What fired an action DevHub shipped, by its id.
 *
 * Only for reading a configuration written before the trigger was spelled in
 * the file, where the id was the only thing that said which action an entry
 * was. Anywhere else the trigger is data: see `ConfiguredAgentAction`.
 */
export function triggerOf(id: string): AgentActionTrigger {
  return (
    BUILT_IN_ACTIONS.find((action) => action.id === id)?.trigger ?? "issue"
  );
}

/**
 * `{{NAME}}`, replaced.
 *
 * A name with no value is left as it was written rather than becoming an empty
 * string: a template that says `{{ISSUE_NO}}` and gets nothing is a template
 * DevHub misread, and a prompt with a hole where the number should be is easier
 * to see than one that quietly lost it.
 */
export function fillVariables(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/gu, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole,
  );
}

/**
 * How each agent is asked to run a skill.
 *
 * A template is written once and may be sent to any of them, so the notation in
 * it is DevHub's — a line beginning `$name` means "run the skill called name" —
 * and this is where it becomes the notation that agent actually reads. Claude
 * Code spells it `/name`; Codex spells it `$name`, which is where the notation
 * came from; every other agent gets the line exactly as it was written,
 * because guessing a syntax for a program nobody has confirmed is how a prompt
 * turns into a command that means something else.
 *
 * "Every other agent" is `custom` and `cursor`, and the two are here for
 * different reasons. `custom` names a program DevHub knows nothing about.
 * Cursor DevHub can now read the *screen* of, but reading a screen says nothing
 * about how that CLI spells a skill, and this file has no capture to answer it
 * from — so the safe answer is the literal one. Having a manifest is not the
 * same as knowing the dialect, and the moment those two are treated as one
 * question is the moment a sentence becomes a slash command.
 *
 * Only at the start of a line. `$HOME` in the middle of a sentence is a
 * variable somebody is talking about, and a price is not a skill.
 */
export function applySkillNotation(
  text: string,
  kind: AgentProfileKind,
): string {
  if (kind !== "claude") return text;
  return text.replace(/^\$(?=[A-Za-z][A-Za-z0-9_-]*)/gmu, "/");
}

/** The whole of what is sent: the wording, filled in, in the agent's dialect. */
export function renderAgentAction(
  template: string,
  values: Readonly<Record<string, string>>,
  kind: AgentProfileKind,
): string {
  return applySkillNotation(fillVariables(template, values), kind);
}
