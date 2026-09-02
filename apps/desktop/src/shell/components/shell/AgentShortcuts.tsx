/**
 * The three things a workspace can offer to say next.
 *
 * Committing, pushing, and opening a pull request are the moves that come up
 * over and over while work is under way, and each of them is a sentence the
 * person would otherwise type into the agent by hand. So DevHub offers them —
 * but only ever as *the same act the Issue flow performs*: it fills in a
 * template the person owns and queues it for the agent. There is no git run
 * here and no GitHub call. What the agent does with the sentence is the agent's
 * business, which is the whole reason this is a message rather than a command.
 *
 * **A button is drawn only when its condition holds**, and the conditions come
 * from what the Sidebar already knows about the workspace — the same projection
 * on the same two clocks, so a button appears within a couple of seconds of the
 * change that justifies it and never sooner:
 *
 *   - Commit, when there is something uncommitted.
 *   - Push, when there are commits the branch's upstream does not have.
 *   - Open a pull request, when there is nothing to push and no pull request
 *     out from the branch.
 *
 * The last one asks two more things than it looks like it does. It needs an
 * upstream, because a branch nobody has pushed has nothing to open a pull
 * request from; and it needs to know this branch is not the trunk, because
 * offering to open a pull request from `main` is a button that cannot do
 * anything useful. Not knowing which branch is the trunk means not offering
 * it — the same rule "DevHub cannot tell" gets everywhere else.
 *
 * A pull request that was merged or closed still counts as one being there.
 * That is deliberate: the shortcut is for the branch that has never had one,
 * and a merged branch offering to open a second pull request would be
 * suggesting the work be done again.
 */

import { useEffect, useState } from "react";
import type { AgentSnapshot } from "../../../ipc/appShell";
import type {
  AgentActionTriggerWire,
  AgentActionWire,
  WorkspaceRepositoryWire,
} from "../../../ipc/contract";
import { Glyph, type GlyphName } from "../sidebar/icons";
import { useAppShell } from "../../useAppShell";

/**
 * Which shortcuts this workspace is offering, in the order they happen.
 *
 * Commit, then push, then open — the order the work goes in, so the column
 * never reshuffles as conditions come and go. Exported because it is the whole
 * of the rule, and a rule this small is worth testing on its own rather than
 * through a rendered pane.
 */
export function offeredShortcuts(
  repository: WorkspaceRepositoryWire | undefined,
): readonly AgentActionTriggerWire[] {
  if (!repository) return [];
  const offered: AgentActionTriggerWire[] = [];
  if (repository.dirty === true) offered.push("commit");
  if (repository.ahead !== undefined && repository.ahead > 0) {
    offered.push("push");
  }
  if (
    repository.ahead === 0 &&
    repository.pullRequest === undefined &&
    repository.branch !== undefined &&
    repository.defaultBranch !== undefined &&
    repository.branch !== repository.defaultBranch
  ) {
    offered.push("pull_request");
  }
  return offered;
}

const MARK: Readonly<Record<AgentActionTriggerWire, GlyphName>> = {
  issue: "issueOpen",
  commit: "commit",
  push: "push",
  pull_request: "pullRequest",
};

/**
 * Why a shortcut cannot be pressed, or nothing when it can.
 *
 * One rule for all three, keyed to one fact: an agent whose screen nothing can
 * read has no idle to wait for, so a message queued for it would sit in the
 * queue forever. Saying that on the button is the difference between a control
 * that is off and a control that is broken.
 */
function unavailableReason(agent: AgentSnapshot): string | undefined {
  return agent.status === "unknown"
    ? "DevHub cannot read this agent's screen, so it cannot tell when it is safe to type"
    : undefined;
}

export function AgentShortcuts({
  agent,
  repository,
}: {
  readonly agent: AgentSnapshot;
  readonly repository: WorkspaceRepositoryWire | undefined;
}) {
  const { agentActions, runAgentAction, reportFailure } = useAppShell();
  const [actions, setActions] = useState<readonly AgentActionWire[]>([]);

  // The wording is a setting, so it is read from main rather than known here.
  // It is read once: a person who edits their actions is editing a file, and
  // the window is reloaded when the configuration changes.
  useEffect(() => {
    let live = true;
    void agentActions().then((loaded) => {
      if (live) setActions(loaded);
    }, reportFailure);
    return () => {
      live = false;
    };
  }, [agentActions, reportFailure]);

  const blocked = unavailableReason(agent);
  // Only the shortcuts whose condition holds *and* which have wording behind
  // them. A person who deleted the commit action from their configuration has
  // decided DevHub should not offer it, and a button with nothing to say would
  // be a button that fails when pressed.
  const offered = offeredShortcuts(repository).flatMap((trigger) => {
    const action = actions.find((candidate) => candidate.trigger === trigger);
    return action ? [{ trigger, action }] : [];
  });
  if (offered.length === 0) return null;

  return (
    <div className="agent-shortcuts">
      {offered.map(({ trigger, action }) => (
        <button
          key={trigger}
          className="agent-shortcut"
          type="button"
          disabled={blocked !== undefined}
          title={
            blocked ?? `${action.displayName} — sent to ${agent.displayName}`
          }
          onClick={() => {
            void runAgentAction(agent.id, action.id).catch(reportFailure);
          }}
        >
          <Glyph name={MARK[trigger]} />
          <span className="agent-shortcut-label">{action.displayName}</span>
        </button>
      ))}
      {/* What became of pressing one. The queue is the only honest place to
          read that from: a message is not sent when the button is pressed, it
          is held until the agent's screen settles, and a button that claimed
          otherwise would be lying about where the text is. */}
      {agent.injection.queued > 0 ? (
        <p className="agent-shortcuts-note" role="status">
          {agent.injection.queued === 1
            ? "Waiting for a prompt to send it"
            : `Waiting for a prompt to send ${String(agent.injection.queued)} messages`}
        </p>
      ) : null}
      {/* A send that failed. It stays until one succeeds, which is the queue's
          own rule, and it is drawn here because this is where the person asked
          for it to go. */}
      {agent.injection.lastFailure !== undefined ? (
        <p className="agent-shortcuts-failure" role="alert">
          {agent.injection.lastFailure}
        </p>
      ) : null}
    </div>
  );
}
