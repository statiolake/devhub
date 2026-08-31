/**
 * "New Agent": pick the profile the agent starts from.
 *
 * The same picker as everything else, because it is the same question. It used
 * to be a plain list — no search field, arrows and Return only — which was
 * defensible while there were two profiles and indefensible as a rule: a
 * person cannot know, before they start typing, which of DevHub's lists will
 * answer them.
 *
 * What it needs — the profiles and how to dispatch — is the same projection the
 * sidebar reads, so it reads it the same way rather than being handed a copy
 * through the modal request.
 */

import type { AgentProfileKindWire } from "../../ipc/appShell";
import { useAppShell } from "../useAppShell";
import { Picker } from "../components/shell/Picker";

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
    <Picker
      title="New Agent"
      placeholder="New Agent"
      items={agentProfiles.profiles.map((profile) => {
        const kind = kindLabel(profile.kind);
        return {
          id: profile.id,
          label: profile.displayName,
          // A profile usually *is* its kind, and "Codex" under "Codex" says
          // nothing twice. The line is for the profiles that differ — a second
          // Claude with its own arguments, or a custom one whose status will
          // never be known.
          detail: kind === profile.displayName ? undefined : kind,
          searchText: `${profile.displayName} ${profile.kind}`,
        };
      })}
      emptyNoMatch="No agent profiles match."
      emptyNoItems={
        agentProfiles.availability === "unavailable"
          ? "Agent profiles are unavailable until the configuration is readable again."
          : "No agent profiles are enabled."
      }
      note={
        agentProfiles.availability === "degraded"
          ? "The configuration needs attention; these are the last profiles DevHub could confirm."
          : "The agent starts at the workspace root. ⌘Return opens it beside the editor."
      }
      onChoose={(choice) => {
        void dispatch({
          type: "request_create_agent",
          workspaceId,
          profileId: choice.id,
          split: choice.split,
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
