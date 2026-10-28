/**
 * "Send to Agent…": which of the Workspace's Agents gets the editor's
 * selection, or a new one from which profile.
 *
 * The rows arrive from main already in order — the choice made last time
 * first, so Return takes it again (`main/shell/sendToAgent.ts`) — and the
 * sheet answers with the index of the one chosen, as the command palette
 * does. The ordinary picker: typing filters, the arrows move, Return
 * chooses and Escape closes.
 */

import { useMemo } from "react";
import { Picker, type PickerItem } from "../components/shell/Picker";
import type { SendToAgentRowWire } from "../../ipc/contract";

export interface SendToAgentSheetProps {
  readonly rows: readonly SendToAgentRowWire[];
  /** The index of the row chosen, or nothing when the sheet was cancelled. */
  readonly onDismiss: (chosen?: number) => void;
}

export function SendToAgentSheet({ rows, onDismiss }: SendToAgentSheetProps) {
  const items = useMemo(
    (): readonly PickerItem[] =>
      rows.map((row, index) => ({
        id: String(index),
        label: row.label,
        detail: row.detail,
        searchText: `${row.label} ${row.detail}`,
      })),
    [rows],
  );

  return (
    <Picker
      title="Send to Agent"
      question="Which Agent should the selection go to? It is put in the Agent's input box, not sent."
      items={items}
      emptyNoMatch="No Agent or profile matches that."
      emptyNoItems="This Workspace has no Agents and no profile to start one from."
      onChoose={({ id }) => {
        onDismiss(Number(id));
      }}
      onCancel={() => {
        onDismiss();
      }}
    />
  );
}
