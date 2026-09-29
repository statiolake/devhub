/**
 * "New Agent": a new session of one of the profiles, or an earlier session
 * that ran in this Workspace's folder, to go on with.
 *
 * The same picker as everything else, because it is the same question. The
 * list itself is `AgentProfilePicker`, shared with Assign Issue and with the
 * workspace picker's Command gesture. What is left here is the only part that
 * differs: the Workspace is already open, so its folder is where the earlier
 * sessions are read, and the answer is dispatched straight at it. Assign Issue
 * asks the same question the same way (`WorkspaceAgentPicker`), once it has
 * opened the Issue's folder.
 */

import type { ReactNode } from "react";
import type { WorkspacePlaceWire } from "../../ipc/contract";
import type { WorkspaceWire } from "../../ipc/appShell";
import { usePicker } from "./PickerContext";
import {
  AgentProfilePicker,
  type AgentChoice,
} from "../components/shell/AgentProfilePicker";

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
    <WorkspaceAgentPicker
      title="New Agent"
      // Until the projection has arrived there is no folder to read, and the
      // New rows are the whole of the answer.
      place={workspace === undefined ? undefined : placeOf(workspace)}
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

export interface WorkspaceAgentPickerProps {
  /** "New Agent", or what the agent is for — the one thing that differs. */
  readonly title: string;
  /** The Workspace's folder, on its machine, whose earlier sessions are offered. */
  readonly place: WorkspacePlaceWire | undefined;
  /** Which question this is, when it is one of a flow's. */
  readonly step?: number;
  /** Why the last attempt to start the one chosen did not work. */
  readonly failure?: string;
  readonly onChoose: (choice: AgentChoice) => void;
  readonly onCancel: () => void;
}

/**
 * "Which agent, in this Workspace?" — New Agent's question, and Assign Issue's
 * once its folder is open. One question with one wording: an Issue changes
 * what the agent is told after it starts, not what starting one looks like.
 */
export function WorkspaceAgentPicker({
  title,
  place,
  step,
  failure,
  onChoose,
  onCancel,
}: WorkspaceAgentPickerProps) {
  const hint: ReactNode =
    failure === undefined ? (
      "The agent starts at the workspace root. ⌘Return opens it beside the editor; ⌥Return opens it as the other of TUI and GUI."
    ) : (
      <span className="picker-note-failure">{failure}</span>
    );
  return (
    <AgentProfilePicker
      title={title}
      question="Start a new session, or go on with one of this workspace's earlier ones."
      step={step}
      hint={hint}
      sessionsIn={place}
      onChoose={onChoose}
      onCancel={onCancel}
    />
  );
}

/** Where a Workspace is: its folder, on its machine. */
function placeOf(workspace: WorkspaceWire): WorkspacePlaceWire {
  return workspace.location.kind === "ssh"
    ? { kind: "ssh", host: workspace.location.host, path: workspace.root }
    : { kind: "local", path: workspace.root };
}
