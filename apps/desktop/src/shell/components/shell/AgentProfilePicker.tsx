/**
 * "Which agent profile?", wherever it is asked.
 *
 * Two flows ask it — the sidebar's `+`, which starts an Agent in a Workspace
 * that is already open, and the workspace picker's Command gesture, which
 * starts one in the Workspace it is about to open — and they are the same
 * question about the same list. A second copy of it would be a list that could
 * drift: one of them would gain a profile's kind under its name, or lose the
 * sentence about a configuration that needs attention, and a person cannot
 * know which of the two they are looking at.
 *
 * So the rows, what the query matches, and what the sheet says when there is
 * nothing to offer live here, once. What a caller varies is what a caller
 * genuinely knows and this cannot: what it is asking for, where the question
 * sits in its flow, what the Command modifier means to it, and what to do with
 * the answer.
 */

import type { AgentProfileKindWire } from "../../../ipc/appShell";
import { useAppShell } from "../../useAppShell";
import { Picker } from "./Picker";
import type { ReactNode } from "react";

export interface AgentProfilePickerProps {
  /** What this list is for, and why it is being asked now. */
  readonly question: string;
  /** Which question this is, for a flow that asks more than one. */
  readonly step?: number;
  /**
   * What the footer says while the profiles are trustworthy — which is where
   * a caller says what its Command gesture does, because only the caller
   * knows. A configuration that needs attention says so instead: that is news
   * about the list itself, and it outranks anything about the keys.
   */
  readonly hint: ReactNode;
  readonly onChoose: (profileId: string, split: boolean) => void;
  readonly onCancel: () => void;
}

export function AgentProfilePicker({
  question,
  step,
  hint,
  onChoose,
  onCancel,
}: AgentProfilePickerProps) {
  const { agentProfiles } = useAppShell();

  return (
    <Picker
      title="New Agent"
      question={question}
      step={step}
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
          : hint
      }
      onChoose={(choice) => {
        onChoose(choice.id, choice.split);
      }}
      onCancel={onCancel}
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
    // Deliberately narrower than "Cursor". DevHub reads Cursor's busy and
    // waiting screens but never claims its prompt is free, so a person picking
    // this profile should know the row will not go quiet-and-ready the way the
    // other two do — it goes to `?` instead.
    case "cursor":
      return "Cursor — busy and waiting only";
    case "custom":
      return "Other — no status detection";
  }
}
