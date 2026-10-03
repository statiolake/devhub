/**
 * Automatic actions: a Smart Button an Agent presses for itself.
 *
 * A Smart Button is offered while its trigger's condition holds and the Agent
 * is idle (`smartButtonTriggers`). A person may tick one of them as automatic
 * for one Agent, and from then on the moment that button would appear is the
 * moment its action is sent — review comments arriving on the pull request
 * are answered without anybody pressing "Address review comments".
 *
 * **Which.** Only the triggers that stand for something happening to the work
 * from outside, or for a step that follows every turn the same way:
 * `AUTOMATIC_TRIGGERS`. Opening a pull request and readying a draft are
 * decisions about when the work is done, and a branch is without a pull
 * request from its first commit, so firing those on their condition would make
 * the decision for the person the moment it could be made.
 *
 * **Per Agent, for this run of DevHub, off by default.** It is a standing
 * instruction to one Agent about one piece of work, so it lives on the Agent
 * (`Agent.automaticActions`) and not in the settings file; and it is not
 * restored after DevHub restarts, so an Agent never starts acting on its own
 * without somebody having said so since.
 *
 * **Once per event, not once per poll.** The condition is a state, and a
 * state goes on holding: the review threads stay unresolved after the Agent
 * has answered them, CI stays red until the next run has finished. Firing
 * whenever the condition held and the Agent was idle would send the same
 * sentence after every turn, for ever. So each trigger's condition is read as
 * a sequence of events — an *episode* begins each time it starts to hold, and
 * for review comments a rise in the count of unresolved threads is a new
 * event within one — and each event is acted on once. Ticking the
 * box while the condition already holds counts as such an event: it is sent
 * once, as soon as the Agent is free (so is an Agent that comes back with the
 * box ticked and its condition holding). An event a person already answered
 * by pressing the button is not sent.
 *
 * Nothing is sent to an Agent that is not idle or that already has something
 * waiting for it: the event is kept, and sent once the Agent is free. One
 * trigger at a time, in `ACTION_TRIGGERS` order, so the next one is decided
 * on the repository as the first left it — committing is what makes there be
 * something to push.
 */

import {
  ACTION_TRIGGERS,
  smartButtonTriggers,
  type AgentActionTrigger,
  type SmartButtonRepository,
} from "./agentActions.js";
import type { AgentStatus } from "./domain.js";

/** The triggers an action may be automatic for. See the module comment. */
export const AUTOMATIC_TRIGGERS: readonly AgentActionTrigger[] = [
  "commit",
  "push",
  "unresolved_review_comments",
  "ci_failing",
];

export function isAutomaticTrigger(trigger: AgentActionTrigger): boolean {
  return AUTOMATIC_TRIGGERS.includes(trigger);
}

/** What `AutomaticActions.observe` reads about one Agent. */
export interface AutomaticAgent {
  readonly agentId: string;
  readonly status: AgentStatus;
  /** Instructions already waiting for it (`AgentInjection.queued`). */
  readonly queued: number;
  /** The ids of the actions ticked as automatic for it. */
  readonly automaticActions: readonly string[];
  readonly repository: SmartButtonRepository | undefined;
}

/** An action as far as firing it goes. */
export interface AutomaticActionChoice {
  readonly id: string;
  readonly trigger: AgentActionTrigger;
}

/** One action to send to one Agent, now. */
export interface AutomaticFiring {
  readonly agentId: string;
  readonly actionId: string;
  readonly trigger: AgentActionTrigger;
}

interface TriggerState {
  holding: boolean;
  episode: number;
  /** The most unresolved review threads seen in this episode. */
  count: number;
  /** The pull request the condition is about, for the two that are. */
  pullRequest: number | undefined;
  /** The event last sent or answered, by `eventKey`. */
  handled: string | undefined;
}

export class AutomaticActions {
  readonly #states = new Map<string, Map<AgentActionTrigger, TriggerState>>();
  readonly #ticked = new Map<string, ReadonlySet<string>>();

  /**
   * Read every Agent's repository again, and say what to send.
   *
   * Called whenever what it reads may have moved — an Agent's status, the
   * repository status, a box ticked — and cheap enough to be called more
   * often than that: it remembers, and says each event once.
   */
  observe(
    agents: readonly AutomaticAgent[],
    actions: readonly AutomaticActionChoice[],
  ): readonly AutomaticFiring[] {
    const firings: AutomaticFiring[] = [];
    const present = new Set(agents.map((agent) => agent.agentId));
    for (const id of [...this.#states.keys()]) {
      if (!present.has(id)) {
        this.#states.delete(id);
        this.#ticked.delete(id);
      }
    }
    for (const agent of agents) {
      const keys = this.#advance(agent);
      const ticked = new Set(agent.automaticActions);
      const before = this.#ticked.get(agent.agentId) ?? new Set<string>();
      this.#ticked.set(agent.agentId, ticked);
      // A box ticked just now: the event standing at this moment, if any,
      // is news to it and is sent once, like any other.
      for (const actionId of ticked) {
        if (before.has(actionId)) continue;
        const trigger = actions.find(
          (action) => action.id === actionId,
        )?.trigger;
        if (trigger === undefined || !isAutomaticTrigger(trigger)) continue;
        this.#state(agent.agentId, trigger).handled = undefined;
      }
      if (agent.status !== "idle" || agent.queued > 0) continue;
      for (const trigger of AUTOMATIC_TRIGGERS) {
        const key = keys.get(trigger);
        const state = this.#state(agent.agentId, trigger);
        if (key === undefined || key === state.handled) continue;
        const chosen = actions.filter(
          (action) => action.trigger === trigger && ticked.has(action.id),
        );
        if (chosen.length === 0) continue;
        state.handled = key;
        for (const action of chosen) {
          firings.push({
            agentId: agent.agentId,
            actionId: action.id,
            trigger,
          });
        }
        break;
      }
    }
    return firings;
  }

  /**
   * A person sent this trigger's action themselves: the event standing now
   * has been answered, and is not sent again on its own.
   */
  answered(agentId: string, trigger: AgentActionTrigger): void {
    if (!isAutomaticTrigger(trigger)) return;
    const state = this.#state(agentId, trigger);
    if (state.holding) state.handled = eventKey(trigger, state);
  }

  /** Each automatic trigger's current event for this Agent, if it holds. */
  #advance(agent: AutomaticAgent): ReadonlyMap<AgentActionTrigger, string> {
    const keys = new Map<AgentActionTrigger, string>();
    // Nothing read about the repository yet, or not any more: no news either
    // way, so every condition stays where it was. Reading it as "nothing
    // holds" would end each episode, and the next reading would begin another
    // and send its action again.
    if (agent.repository === undefined) {
      for (const trigger of AUTOMATIC_TRIGGERS) {
        const state = this.#state(agent.agentId, trigger);
        if (state.holding) keys.set(trigger, eventKey(trigger, state));
      }
      return keys;
    }
    // The condition as a button would be drawn for it, whatever the Agent is
    // doing: an event that happens while it works is sent once it is idle.
    const holding = new Set(smartButtonTriggers("idle", agent.repository));
    const pullRequest = agent.repository.pullRequest?.number;
    for (const trigger of AUTOMATIC_TRIGGERS) {
      const state = this.#state(agent.agentId, trigger);
      // Another pull request is another event, even with no reading between
      // the two in which the condition did not hold.
      const about =
        trigger === "unresolved_review_comments" || trigger === "ci_failing"
          ? pullRequest
          : undefined;
      if (state.holding && state.pullRequest !== about) state.holding = false;
      state.pullRequest = about;
      if (!holding.has(trigger)) {
        state.holding = false;
        state.count = 0;
        continue;
      }
      if (!state.holding) {
        state.holding = true;
        state.episode += 1;
        state.count = 0;
      }
      if (trigger === "unresolved_review_comments") {
        const conversations = agent.repository?.pullRequest?.conversations;
        const count =
          (conversations?.unresolved ?? 0) + (conversations?.uncounted ?? 0);
        state.count = Math.max(state.count, count);
      }
      keys.set(trigger, eventKey(trigger, state));
    }
    return keys;
  }

  #state(agentId: string, trigger: AgentActionTrigger): TriggerState {
    let states = this.#states.get(agentId);
    if (states === undefined) {
      states = new Map();
      this.#states.set(agentId, states);
    }
    let state = states.get(trigger);
    if (state === undefined) {
      state = {
        holding: false,
        episode: 0,
        count: 0,
        pullRequest: undefined,
        handled: undefined,
      };
      states.set(trigger, state);
    }
    return state;
  }
}

/**
 * Which event a holding condition is: its episode, and for review comments
 * how many threads were unresolved at most — so more comments arriving on a
 * pull request that already had some is news, and threads being resolved is
 * not.
 */
function eventKey(trigger: AgentActionTrigger, state: TriggerState): string {
  return trigger === "unresolved_review_comments"
    ? `${String(state.episode)}:${String(state.count)}`
    : String(state.episode);
}

/** The triggers in the order the Settings and the box list them. */
export function automaticTriggersInOrder(): readonly AgentActionTrigger[] {
  return ACTION_TRIGGERS.filter(isAutomaticTrigger);
}
