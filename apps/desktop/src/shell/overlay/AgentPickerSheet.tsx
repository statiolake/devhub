/**
 * "New Agent": pick the profile the agent starts from.
 *
 * The sheet is the sidebar's, drawn one layer up so a workbench cannot paint
 * over it. What it needs — the profiles and how to dispatch — is the same
 * projection the sidebar reads, so it reads it the same way rather than being
 * handed a copy through the modal request.
 */

import type { AgentProfileKindWire } from "../../ipc/appShell";
import { useAppShell } from "../useAppShell";
import { ChooseSheet } from "../components/shell/ChooseSheet";

export interface AgentPickerSheetProps {
  readonly workspaceId: string;
  readonly onDismiss: () => void;
}

export function AgentPickerSheet({
  workspaceId,
  onDismiss,
}: AgentPickerSheetProps) {
  const { agentProfiles, dispatch } = useAppShell();

  return (
    <ChooseSheet
      title="New Agent"
      message="The agent starts at the workspace root."
      options={agentProfiles.profiles.map((profile) => ({
        id: profile.id,
        label: profile.displayName,
        detail: kindLabel(profile.kind),
      }))}
      empty={
        agentProfiles.availability === "unavailable"
          ? "Agent profiles are unavailable until the configuration is readable again."
          : "No agent profiles are enabled."
      }
      note={
        agentProfiles.availability === "degraded"
          ? "The configuration needs attention; these are the last profiles DevHub could confirm."
          : undefined
      }
      onChoose={(profileId) => {
        void dispatch({
          type: "request_create_agent",
          workspaceId,
          profileId,
        });
        onDismiss();
      }}
      onCancel={onDismiss}
    />
  );
}

/**
 * The one line under a profile's name: whose screen it draws.
 *
 * A `custom` profile has no manifest, so its status will stay `?` for the life
 * of the Agent. Saying so here is where a person can still change their mind
 * about which profile to start.
 */
function kindLabel(kind: AgentProfileKindWire): string {
  switch (kind) {
    case "codex":
      return "Codex";
    case "claude":
      return "Claude";
    case "custom":
      return "Other — no status detection";
  }
}
