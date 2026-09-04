/**
 * "Go to…": every workspace and Agent, as one list.
 *
 * `Cmd+Q G`. Stepping (`Cmd+N`, `{`, `Shift+N`) is for the neighbour you can
 * see; this is for the one you can name, and past three or four workspaces it
 * is the only one of the two that scales.
 *
 * The same picker as everything else, so `Return` activates and
 * `Command-Return` mounts an Agent beside its workbench — the two gestures the
 * workspace picker already has, meaning the same two things. On a workspace row
 * the Command modifier means nothing and is ignored, exactly as it is
 * everywhere else a row has only one way to be taken; the footer says so rather
 * than the rows quietly differing.
 */

import { useMemo } from "react";
import { Picker, type PickerItem } from "../components/shell/Picker";
import { useAppShell } from "../useAppShell";

const EMPTY: readonly never[] = [];

export interface TabPickerSheetProps {
  readonly onDismiss: () => void;
}

/** `workspace:<id>` and `agent:<id>`, so one list can hold both kinds. */
function rowId(kind: "workspace" | "agent" | "global", id: string): string {
  return `${kind}:${id}`;
}

export function TabPickerSheet({ onDismiss }: TabPickerSheetProps) {
  const { state, dispatch } = useAppShell();
  // Before the first projection there is nothing to list. The sheet still
  // stands — it was asked for — and shows its own "nothing to go to" line.
  const workspaces =
    state.status === "ready" ? state.snapshot.workspaces : EMPTY;

  const items = useMemo((): readonly PickerItem[] => {
    const rows: PickerItem[] = [
      {
        id: rowId("global", "scratch"),
        label: "Scratch",
        detail: "The folderless workbench",
      },
    ];
    for (const workspace of workspaces) {
      rows.push({
        id: rowId("workspace", workspace.id),
        label: workspace.label,
        detail: workspace.selectedPath,
        // The path as well as the label, because two worktrees of one
        // repository are two rows whose labels differ by very little.
        searchText: `${workspace.label} ${workspace.root}`,
      });
      for (const agent of workspace.agents) {
        rows.push({
          id: rowId("agent", agent.id),
          label: agent.displayName,
          // Which workspace it is in, because an Agent's name says nothing
          // about where it is working and two workspaces may each have a
          // "Claude".
          detail: agent.activity
            ? `${workspace.label} — ${agent.activity}`
            : workspace.label,
          searchText: `${agent.displayName} ${workspace.label}`,
        });
      }
    }
    return rows;
  }, [workspaces]);

  return (
    <Picker
      title="Go to"
      question="Which workspace or agent do you want to look at?"
      items={items}
      emptyNoMatch="Nothing here matches that."
      note="⌘Return opens an agent beside its editor."
      onChoose={({ id, split }) => {
        const [kind, value] = id.split(":");
        if (kind === "agent") {
          void dispatch({
            type: "select_context",
            context: { kind: "agent", agentId: value },
            split,
          });
        } else if (kind === "workspace") {
          void dispatch({
            type: "select_context",
            context: { kind: "workspace", workspaceId: value },
          });
        } else {
          void dispatch({
            type: "select_context",
            context: { kind: "global" },
          });
        }
        onDismiss();
      }}
      onCancel={onDismiss}
    />
  );
}
