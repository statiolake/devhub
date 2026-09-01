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

/** The actions DevHub knows how to take. One, so far. */
export type AgentActionId = "issue_assignment";

export interface AgentActionDefinition {
  readonly id: AgentActionId;
  /** What the Settings list calls it. */
  readonly displayName: string;
  /** When DevHub sends it, in one sentence. */
  readonly description: string;
  /** The names a template may use, without the braces. */
  readonly variables: readonly string[];
  readonly defaultTemplate: string;
}

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

export const AGENT_ACTIONS: readonly AgentActionDefinition[] = [
  {
    id: "issue_assignment",
    displayName: "Issue assignment",
    description:
      "Sent to the agent that Assign Issue starts, once its workspace is open.",
    variables: ["ISSUE_URL", "ISSUE_NO"],
    defaultTemplate: ISSUE_ASSIGNMENT_TEMPLATE,
  },
];

export function agentAction(
  id: AgentActionId,
): AgentActionDefinition | undefined {
  return AGENT_ACTIONS.find((action) => action.id === id);
}

/** Is this one of the actions DevHub has, rather than a typo in the file? */
export function isAgentActionId(value: string): value is AgentActionId {
  return AGENT_ACTIONS.some((action) => action.id === value);
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
 * came from; an agent DevHub has no manifest for gets the line exactly as it
 * was written, because guessing a syntax for a program nobody has described is
 * how a prompt turns into a command that means something else.
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
