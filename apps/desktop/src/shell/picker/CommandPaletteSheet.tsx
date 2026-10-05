/**
 * Every DevHub command, by name — `Cmd+Q :`.
 *
 * The VS Code command palette's shape on DevHub's own registry. **Nothing here
 * is written down**: the rows arrive from main, built from `model/commands.ts`
 * and the chords actually in effect (`model/commandPalette.ts`), already
 * narrowed to the commands that would do something now and with the recently
 * run ones first. The sheet only draws them and says which was chosen — by its
 * index, as the modal's response — and main runs it through the same path its
 * chord takes, so the palette and the keys cannot disagree.
 *
 * The ordinary picker, so typing filters with the shared scorer, the arrows
 * and Ctrl-N / Ctrl-P move, Return runs and Escape closes.
 */

import { useMemo } from "react";
import { Picker, type PickerItem } from "../components/shell/Picker";
import type { CommandPaletteRowWire } from "../../ipc/contract";
import { paletteSearchText } from "../../model/commandPalette";

export interface CommandPaletteSheetProps {
  readonly rows: readonly CommandPaletteRowWire[];
  /** The index of the row chosen, or nothing when the sheet was cancelled. */
  readonly onDismiss: (chosen?: number) => void;
}

export function CommandPaletteSheet({
  rows,
  onDismiss,
}: CommandPaletteSheetProps) {
  const items = useMemo(
    (): readonly PickerItem[] =>
      rows.map((row, index) => ({
        id: String(index),
        label: row.title,
        searchText: paletteSearchText(row),
        ...(row.recent ? { detail: "recently used" } : {}),
        accessory: () =>
          row.chords.length === 0 ? null : (
            <span className="chord-help-keys">
              {row.chords.map((chord) => (
                <kbd key={chord}>{chord}</kbd>
              ))}
            </span>
          ),
      })),
    [rows],
  );

  return (
    <Picker
      title="Commands"
      question="Which DevHub command do you want to run?"
      items={items}
      emptyNoMatch="No command matches that."
      emptyNoItems="Nothing can be run here."
      onChoose={({ id }) => {
        onDismiss(Number(id));
      }}
      onCancel={() => {
        onDismiss();
      }}
    />
  );
}
