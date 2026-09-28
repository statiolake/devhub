/**
 * "New Agent": a new session of one of the profiles, or an earlier session
 * that ran in this Workspace's folder, to go on with.
 *
 * The same picker as everything else, because it is the same question. The
 * list itself is `AgentProfilePicker`, shared with Assign Issue and with the
 * workspace picker's Command gesture. What is left here is the only part that
 * differs: the Workspace is already open, so its folder is where the earlier
 * sessions are read, and the answer is dispatched straight at it.
 */

import type { WorkspacePlaceWire } from "../../ipc/contract";
import type { WorkspaceWire } from "../../ipc/appShell";
import { usePicker } from "./PickerContext";
import { AgentProfilePicker } from "../components/shell/AgentProfilePicker";

export interface AgentPickerSheetProps {
  readonly workspaceId: string;
  readonly onDismiss: () => void;
}

export function AgentPickerSheet({
  workspaceId,
  onDismiss,
}: AgentPickerSheetProps) {
  const { dispatch, state } = usePicker();
  const workspace =
    state.status === "ready"
      ? state.snapshot.workspaces.find(
          (candidate) => candidate.id === workspaceId,
        )
      : undefined;

  return (
    <AgentProfilePicker
      title="New Agent"
      question="Start a new session, or go on with one of this workspace's earlier ones."
      hint="The agent starts at the workspace root. ⌘Return opens it beside the editor; ⌥Return opens it as the other of TUI and GUI."
      // Until the projection has arrived there is no folder to read, and the
      // New rows are the whole of the answer.
      sessionsIn={workspace === undefined ? undefined : placeOf(workspace)}
      onChoose={(choice) => {
        void dispatch({
          type: "request_create_agent",
          workspaceId,
          profileId: choice.profileId,
          split: choice.split,
          presentation: choice.presentation,
          ...(choice.resume === undefined ? {} : { resume: choice.resume }),
        });
        onDismiss();
      }}
      onCancel={onDismiss}
    />
  );
}

/** Where a Workspace is: its folder, on its machine. */
function placeOf(workspace: WorkspaceWire): WorkspacePlaceWire {
  return workspace.location.kind === "ssh"
    ? { kind: "ssh", host: workspace.location.host, path: workspace.root }
    : { kind: "local", path: workspace.root };
}
