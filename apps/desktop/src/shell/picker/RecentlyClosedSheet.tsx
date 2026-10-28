/**
 * What was closed lately, newest first — `Recently Closed…` in the command
 * palette, the list behind `Cmd+Q Shift+T`.
 *
 * The rows arrive from main, built from the stack it keeps
 * (`model/recentlyClosed.ts`); the sheet only draws them and says which was
 * chosen, by its index, and main reopens that one exactly as the chord would
 * reopen the newest.
 */

import { useMemo } from "react";
import { Picker, type PickerItem } from "../components/shell/Picker";
import type { RecentlyClosedRowWire } from "../../ipc/contract";

export interface RecentlyClosedSheetProps {
  readonly rows: readonly RecentlyClosedRowWire[];
  /** The index of the row chosen, or nothing when the sheet was cancelled. */
  readonly onDismiss: (chosen?: number) => void;
}

export function RecentlyClosedSheet({
  rows,
  onDismiss,
}: RecentlyClosedSheetProps) {
  const items = useMemo(
    (): readonly PickerItem[] =>
      rows.map((row, index) => ({
        id: String(index),
        label: row.title,
        detail: row.detail,
        searchText: row.title,
      })),
    [rows],
  );

  return (
    <Picker
      title="Recently Closed"
      question="Which closed Agent or Workspace do you want back?"
      items={items}
      emptyNoMatch="Nothing closed matches that."
      emptyNoItems="Nothing has been closed."
      onChoose={({ id }) => {
        onDismiss(Number(id));
      }}
      onCancel={() => {
        onDismiss();
      }}
    />
  );
}
