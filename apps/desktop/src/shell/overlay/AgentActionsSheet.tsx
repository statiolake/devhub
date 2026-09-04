/**
 * "Say something to this agent": which of the configured actions to send.
 *
 * `Cmd+Q A`. The buttons a workspace draws (`AgentShortcuts`) show only the
 * actions whose condition holds right now — commit when there is something to
 * commit, push when there is something to push. Somebody who has reached for a
 * chord is asking for the list itself, so this one is *every* enabled action
 * under every trigger, in the order Settings arranges them.
 *
 * What happens after the choice is not this sheet's business. It runs the same
 * `runAgentAction` the buttons run, so the wording still goes through the
 * review the action asks for (`confirm_before_send`), still fills in its
 * variables, and still waits for the agent's screen to settle. A second path
 * that queued text directly would be a second answer to "does this get looked
 * at first", and one of the two answers would eventually be wrong.
 */

import { useEffect, useState } from "react";
import type { AgentActionWire } from "../../ipc/contract";
import { TRIGGER_NAMES } from "../../model/agentActions";
import { Picker, type PickerItem } from "../components/shell/Picker";
import { useAppShell } from "../useAppShell";

export interface AgentActionsSheetProps {
  readonly agentId: string;
  readonly onDismiss: () => void;
}

export function AgentActionsSheet({
  agentId,
  onDismiss,
}: AgentActionsSheetProps) {
  const { agentActions, runAgentAction, reportFailure, state } = useAppShell();
  const [actions, setActions] = useState<readonly AgentActionWire[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    void agentActions().then((all) => {
      if (!live) return;
      setActions(all);
      setLoaded(true);
    }, reportFailure);
    return () => {
      live = false;
    };
  }, [agentActions, reportFailure]);

  const agent =
    state.status === "ready"
      ? state.snapshot.workspaces
          .flatMap((workspace) => workspace.agents)
          .find((candidate) => candidate.id === agentId)
      : undefined;

  const items: readonly PickerItem[] = actions.map(
    (action): PickerItem => ({
      id: action.id,
      label: action.displayName,
      // What fires it ordinarily, so a list that mixes all four triggers still
      // says which button each row is the keyboard version of.
      detail: TRIGGER_NAMES[action.trigger],
      searchText: `${action.displayName} ${TRIGGER_NAMES[action.trigger]}`,
    }),
  );

  return (
    <Picker
      title="Send to agent"
      question={
        agent
          ? `Which action should ${agent.displayName} be sent?`
          : "Which action should this agent be sent?"
      }
      items={items}
      busy={!loaded}
      emptyNoMatch="No configured action matches that."
      emptyNoItems="There are no agent actions configured. Settings ▸ Actions is where they are written."
      onChoose={({ id }) => {
        void runAgentAction(agentId, id).catch(reportFailure);
        onDismiss();
      }}
      onCancel={onDismiss}
    />
  );
}
