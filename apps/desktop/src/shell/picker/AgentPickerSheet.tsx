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
 * already open, so the answer is dispatched straight at it — and so its
 * earlier sessions can be listed, which is the second question "Resume a
 * session…" asks.
 */

import { useMemo, useState } from "react";
import type { AgentPresentationWire } from "../../ipc/appShell";
import { usePicker } from "./PickerContext";
import { AgentProfilePicker } from "../components/shell/AgentProfilePicker";
import {
  SessionPicker,
  type SessionSource,
} from "../components/shell/SessionPicker";

export interface AgentPickerSheetProps {
  readonly workspaceId: string;
  readonly onDismiss: () => void;
}

export function AgentPickerSheet({
  workspaceId,
  onDismiss,
}: AgentPickerSheetProps) {
  const { dispatch } = usePicker();
  const [resuming, setResuming] = useState<{
    readonly profileId: string;
    readonly presentation: AgentPresentationWire;
  }>();

  if (resuming !== undefined) {
    return (
      <PastSessionSheet
        workspaceId={workspaceId}
        profileId={resuming.profileId}
        onChoose={(session, split) => {
          void dispatch({
            type: "request_create_agent",
            workspaceId,
            profileId: resuming.profileId,
            split,
            presentation: resuming.presentation,
            resume: session,
          });
          onDismiss();
        }}
        onCancel={onDismiss}
      />
    );
  }

  return (
    <AgentProfilePicker
      question="Which agent profile should the new agent start from?"
      hint="The agent starts at the workspace root. ⌘Return opens it beside the editor; ⌥Return opens it as the other of TUI and GUI."
      onChoose={(profileId, split, presentation) => {
        void dispatch({
          type: "request_create_agent",
          workspaceId,
          profileId,
          split,
          presentation,
        });
        onDismiss();
      }}
      onResume={(profileId, presentation) =>
        setResuming({ profileId, presentation })
      }
      onCancel={onDismiss}
    />
  );
}

/**
 * Which earlier session, newest first — read on the Workspace's machine when
 * the question is asked (`SessionPicker`).
 */
function PastSessionSheet({
  workspaceId,
  profileId,
  onChoose,
  onCancel,
}: {
  readonly workspaceId: string;
  readonly profileId: string;
  readonly onChoose: (session: string, split: boolean) => void;
  readonly onCancel: () => void;
}) {
  const { listPastSessions, previewPastSession, agentProfiles } = usePicker();
  const source: SessionSource = useMemo(
    () => ({
      list: (scope) => listPastSessions(workspaceId, profileId, scope),
      preview: (session, cwd) =>
        previewPastSession(workspaceId, profileId, session, cwd),
    }),
    [listPastSessions, previewPastSession, workspaceId, profileId],
  );
  const profile = agentProfiles.profiles.find(
    (candidate) => candidate.id === profileId,
  );
  return (
    <SessionPicker
      title="Resume a Session"
      question="Which earlier session should the new agent go on with?"
      step={2}
      cli={profile?.displayName ?? profileId}
      source={source}
      hint="⌘Return opens it beside the editor."
      onChoose={onChoose}
      onCancel={onCancel}
    />
  );
}
