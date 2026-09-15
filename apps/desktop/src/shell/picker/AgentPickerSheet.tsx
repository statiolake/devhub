/**
 * "New Agent": pick the profile the agent starts from.
 *
 * The same picker as everything else, because it is the same question. It used
 * to be a plain list — no search field, arrows and Return only — which was
 * defensible while there were two profiles and indefensible as a rule: a
 * person cannot know, before they start typing, which of DevHub's lists will
 * answer them.
 *
 * The list itself is `AgentProfilePicker`, shared with the workspace picker's
 * Command gesture, which asks this same question one step before the Workspace
 * exists. What is left here is the only part that differs: the Workspace is
 * already open, so the answer is dispatched straight at it.
 */

import { useAppShell } from "../useAppShell";
import { AgentProfilePicker } from "../components/shell/AgentProfilePicker";

export interface AgentPickerSheetProps {
  readonly workspaceId: string;
  readonly onDismiss: () => void;
}

export function AgentPickerSheet({
  workspaceId,
  onDismiss,
}: AgentPickerSheetProps) {
  const { dispatch } = useAppShell();

  return (
    <AgentProfilePicker
      question="Which agent profile should the new agent start from?"
      hint="The agent starts at the workspace root. ⌘Return opens it beside the editor."
      onChoose={(profileId, split) => {
        void dispatch({
          type: "request_create_agent",
          workspaceId,
          profileId,
          split,
        });
        onDismiss();
      }}
      onCancel={onDismiss}
    />
  );
}
