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
 * invented would have nothing to fire it. Adding a Smart Button is adding a
 * trigger, its rule in `smartButtonTriggers` and its entry in
 * `BUILT_IN_ACTIONS` — the config schema does not move, and a person's
 * existing wording is untouched.
 *
 * Two things happen to a template before it is sent, and both are here so that
 * they cannot be done differently in two places: the variables are filled in,
 * and the skill notation is translated for whichever agent is being spoken to.
 */

import type { AgentStatusWire } from "../ipc/appShell.js";
import type { WorkspaceRepositoryWire } from "../ipc/contract.js";
import type { AgentProfileKind, ConfiguredAgentAction } from "./config.js";
import { errorWireAt, NamedFailure, withDetail } from "./wire.js";

/**
 * What makes DevHub say an action.
 *
 * There used to be one trigger — the Issue flow — and so there was one list of
 * actions and one set of variables, and neither had to say which was which.
 * Now there is assigning an Issue, and the Smart Buttons: the things an Agent
 * pane offers to say next while work is under way, each drawn only while its
 * own condition about the Workspace's repository holds (`smartButtonTriggers`).
 * A trigger is the thing that fires, the wording is the thing a person owns,
 * and the pair is the whole extension point.
 *
 * `issue` is also what an action DevHub has never heard of is treated as.
 * A person who works two ways — implement it, review it — writes a second
 * action and picks between them where the Issue flow asks; the Smart Buttons
 * have no picker, because a button *is* the choice.
 */
export type AgentActionTrigger =
  | "issue"
  | "commit"
  | "push"
  | "pull_request"
  | "draft_pull_request"
  | "unresolved_review_comments"
  | "ci_failing";

/**
 * Every trigger there is, in the order a person meets them.
 *
 * The list the config file's `[agent_actions.<trigger>]` keys are checked
 * against, the order the Settings tree draws its groups in, and the order the
 * Smart Buttons stand in — the order the work goes in, so the row never
 * reshuffles as conditions come and go. One list, so a trigger cannot be
 * spellable in the file and invisible in the window.
 */
export const ACTION_TRIGGERS: readonly AgentActionTrigger[] = [
  "issue",
  "commit",
  "push",
  "pull_request",
  "draft_pull_request",
  "unresolved_review_comments",
  "ci_failing",
];

/** Whether a trigger is a Smart Button's: every one but the Issue flow. */
export function isSmartButtonTrigger(trigger: AgentActionTrigger): boolean {
  return trigger !== "issue";
}

/**
 * What each trigger is, in one line, for the group headings in Settings.
 */
export const TRIGGER_NAMES: Readonly<Record<AgentActionTrigger, string>> = {
  issue: "Assigning an Issue",
  commit: "Uncommitted changes",
  push: "Commits to push",
  pull_request: "A branch with no pull request",
  draft_pull_request: "A draft pull request",
  unresolved_review_comments: "Unresolved review comments",
  ci_failing: "Failing CI",
};

/**
 * What the Smart Buttons read about a Workspace's repository.
 *
 * The Sidebar's projection (`WorkspaceRepositoryWire`), on the same two clocks:
 * nothing is asked of git or GitHub for a button. So a button appears within a
 * poll of the change that justifies it, and goes again on its own when the
 * next poll says the condition no longer holds.
 */
export type SmartButtonRepository = Pick<
  WorkspaceRepositoryWire,
  "branch" | "defaultBranch" | "dirty" | "ahead" | "pullRequest"
>;

/**
 * Which Smart Button triggers hold for an Agent, in `ACTION_TRIGGERS` order.
 *
 * Nothing unless the Agent is idle. A button is a sentence for the Agent's
 * next turn; while it is working, waiting on a question, finishing something
 * in the background, or unreadable, there is no next turn to offer one for —
 * and a message pressed then would queue behind the work and land on a
 * repository that has moved on. Hidden rather than disabled: a row of dead
 * buttons over a working Agent is noise about a moment that has not come.
 *
 * Then one rule per trigger:
 *
 *   - `commit`: there is something uncommitted.
 *   - `push`: there are commits the branch's upstream does not have.
 *   - `pull_request`: a branch that is not the trunk, with no pull request out
 *     from it. It does not wait for the branch to be pushed — the wording asks
 *     the Agent to push first if it has to. Not knowing which branch is the
 *     trunk means not offering it, the rule "DevHub cannot tell" gets
 *     everywhere else. A merged or closed pull request still counts as one:
 *     the button is for the branch that never had one, and a merged branch
 *     offering a second would be suggesting the work be done again.
 *   - `draft_pull_request`: the branch's pull request is a draft.
 *   - `unresolved_review_comments`: its pull request is open or a draft and
 *     has review conversations nobody resolved — or ones past the page the
 *     count was read from, which may be.
 *   - `ci_failing`: its pull request is open or a draft and CI says failing.
 */
export function smartButtonTriggers(
  status: AgentStatusWire,
  repository: SmartButtonRepository | undefined,
): readonly AgentActionTrigger[] {
  if (status !== "idle" || repository === undefined) return [];
  const pullRequest = repository.pullRequest;
  const live =
    pullRequest !== undefined &&
    (pullRequest.state === "open" || pullRequest.state === "draft");
  const holds: Readonly<Record<AgentActionTrigger, boolean>> = {
    issue: false,
    commit: repository.dirty === true,
    push: repository.ahead !== undefined && repository.ahead > 0,
    pull_request:
      pullRequest === undefined &&
      repository.branch !== undefined &&
      repository.defaultBranch !== undefined &&
      repository.branch !== repository.defaultBranch,
    draft_pull_request: pullRequest?.state === "draft",
    unresolved_review_comments:
      live &&
      (pullRequest.conversations.unresolved > 0 ||
        pullRequest.conversations.uncounted > 0),
    ci_failing: live && pullRequest.checks?.state === "failing",
  };
  return ACTION_TRIGGERS.filter((trigger) => holds[trigger]);
}

/**
 * The values a Smart Button's wording is filled from, out of the same
 * projection its condition was read from — so the message names the branch
 * and the pull request the person was looking at when they pressed it.
 *
 * Only what is known. A name with no value stays as written in the sentence
 * (`fillVariables`), which is a hole somebody can see.
 *
 * `UNRESOLVED` is a lower bound when some threads went uncounted, and says so
 * (`"100+"`): the count is of the first page only, and a bare number would be
 * merely what fitted.
 */
export function smartButtonValues(
  repository: SmartButtonRepository | undefined,
): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  if (repository?.branch !== undefined) values["BRANCH"] = repository.branch;
  const pullRequest = repository?.pullRequest;
  if (pullRequest !== undefined) {
    values["PR_URL"] = pullRequest.url;
    values["PR_NO"] = String(pullRequest.number);
    const { unresolved, uncounted } = pullRequest.conversations;
    values["UNRESOLVED"] =
      uncounted > 0 ? `${String(unresolved)}+` : String(unresolved);
    if (pullRequest.checks !== undefined) {
      values["FAILING"] = String(pullRequest.checks.failing);
    }
  }
  return values;
}

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
 * A property of the trigger and not of the wording: the Issue flow knows a URL
 * and a number, and a Smart Button fired from a Workspace knows the branch it
 * is standing on and the pull request out from it (`smartButtonValues`).
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
  draft_pull_request: ["PR_URL", "PR_NO", "BRANCH"],
  unresolved_review_comments: ["PR_URL", "PR_NO", "UNRESOLVED", "BRANCH"],
  ci_failing: ["PR_URL", "PR_NO", "BRANCH", "FAILING"],
};

/**
 * The wording DevHub ships for the Smart Buttons.
 *
 * Short, and in the language the Issue default is written in, because they say
 * one thing each and the person reading them is an agent already standing in
 * the repository. Everything about *when* to offer them is decided by the
 * Workspace's own state, so none of these has to describe a condition — the
 * button was only drawn because the condition held.
 */
const COMMIT_TEMPLATE = `ここまでの変更をコミットしてください。
関連する変更ごとに、意味のある単位に分けてください。
`;

const PUSH_TEMPLATE = `コミット済みの変更を {{BRANCH}} にプッシュしてください。
`;

const PULL_REQUEST_TEMPLATE = `{{BRANCH}} からプルリクエストを作成してください。
まだプッシュしていない場合は、先にプッシュしてください。
タイトルと説明は、このブランチでの変更内容から書いてください。
`;

const DRAFT_PULL_REQUEST_TEMPLATE = `ドラフトのプルリクエスト #{{PR_NO}} を仕上げてください。
{{PR_URL}}
{{BRANCH}} に残っている作業を終わらせてプッシュし、レビューできる状態になったら Ready for review にしてください。
`;

const UNRESOLVED_REVIEW_COMMENTS_TEMPLATE = `プルリクエスト #{{PR_NO}} のレビューコメントに対応してください。
{{PR_URL}}
未解決のコメントが {{UNRESOLVED}} 件あります。対応した変更は {{BRANCH}} にコミットしてプッシュしてください。
`;

const CI_FAILING_TEMPLATE = `プルリクエスト #{{PR_NO}} の CI が失敗しています。原因を調べて直してください。
{{PR_URL}}
失敗しているチェックは {{FAILING}} 件です。修正は {{BRANCH}} にコミットしてプッシュしてください。
`;

/**
 * Every action DevHub ships, with what fires it and whether it is shown first.
 *
 * The list the config's defaults are built from and the list a trigger is
 * looked up in, so a built-in action cannot exist in one and not the other.
 * An id that is not here is an Issue action somebody wrote, which is the
 * extension point working as intended.
 *
 * **Why `confirmBeforeSend` differs between them.** A Smart Button is the
 * whole sentence: "Commit the changes" is what the button says and what it
 * sends, and a review sheet in front of it asks a person to approve the text
 * on the button they just pressed. That is not a safeguard, it is a second click — and it is the click that teaches
 * people to press Enter through sheets without reading them. Anybody who wants
 * to say something more particular types it, which is the same keystroke the
 * sheet would have cost.
 *
 * The Issue action keeps its sheet, because its text is not on the button. It
 * is a filled-in template about a specific Issue — a number, a title, a branch
 * — assembled from something DevHub read, and seeing what is about to be sent
 * is the only place a wrong Issue can be caught before an Agent starts working
 * on it.
 */
export const BUILT_IN_ACTIONS: readonly {
  readonly id: string;
  readonly displayName: string;
  readonly template: string;
  readonly trigger: AgentActionTrigger;
  readonly confirmBeforeSend: boolean;
}[] = [
  {
    id: DEFAULT_ACTION_ID,
    displayName: "Work on the Issue",
    template: ISSUE_ASSIGNMENT_TEMPLATE,
    trigger: "issue",
    confirmBeforeSend: true,
  },
  {
    id: "commit_changes",
    displayName: "Commit the changes",
    template: COMMIT_TEMPLATE,
    trigger: "commit",
    confirmBeforeSend: false,
  },
  {
    id: "push_commits",
    displayName: "Push the commits",
    template: PUSH_TEMPLATE,
    trigger: "push",
    confirmBeforeSend: false,
  },
  {
    id: "open_pull_request",
    displayName: "Open a pull request",
    template: PULL_REQUEST_TEMPLATE,
    trigger: "pull_request",
    confirmBeforeSend: false,
  },
  {
    id: "ready_draft_pull_request",
    displayName: "Get the draft PR ready",
    template: DRAFT_PULL_REQUEST_TEMPLATE,
    trigger: "draft_pull_request",
    confirmBeforeSend: false,
  },
  {
    id: "address_review_comments",
    displayName: "Address review comments",
    template: UNRESOLVED_REVIEW_COMMENTS_TEMPLATE,
    trigger: "unresolved_review_comments",
    confirmBeforeSend: false,
  },
  {
    id: "fix_ci",
    displayName: "Fix CI",
    template: CI_FAILING_TEMPLATE,
    trigger: "ci_failing",
    confirmBeforeSend: false,
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

/**
 * The whole of what is sent: the wording, filled in, in the agent's dialect.
 *
 * A wording that comes to nothing — a template somebody left empty in
 * `settings.toml` — is refused here, naming the action, because there is
 * nothing to send and the person pressed a button expecting something to be.
 */
export function renderAgentAction(
  action: Pick<ConfiguredAgentAction, "id" | "display_name" | "template">,
  values: Readonly<Record<string, string>>,
  kind: AgentProfileKind,
): string {
  const text = applySkillNotation(fillVariables(action.template, values), kind);
  if (text.trim().length === 0) {
    throw new AgentActionEmpty(
      `The agent action “${action.display_name}” (${action.id}) has no wording: its template in settings.toml comes to nothing, so there is nothing to send.`,
    );
  }
  return text;
}

/** An agent action whose wording comes to nothing (`renderAgentAction`). */
export class AgentActionEmpty extends NamedFailure {
  constructor(reason: string) {
    super(withDetail(errorWireAt("agent_action_empty"), reason));
    this.name = "AgentActionEmpty";
  }
}
