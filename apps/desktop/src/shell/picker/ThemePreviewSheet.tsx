/**
 * Theme: Preview… — every colour theme DevHub can wear, worn while the
 * cursor is on it.
 *
 * The rows arrive from main (`AppController.openThemePreview`), the theme
 * worn now first, so the sheet opens on what is already on screen. Moving
 * through the list tells main which row is under the cursor and main wears
 * that theme at once — the window, the editors, the terminals and the
 * managed Neovims — for the moment only. Return keeps it for the session
 * (never written to `settings.toml`); Escape puts back what was worn before.
 */

import { useCallback, useMemo } from "react";
import { Picker, type PickerItem } from "../components/shell/Picker";
import type { ThemePreviewRowWire } from "../../ipc/contract";
import { devhub } from "./client";

export interface ThemePreviewSheetProps {
  readonly rows: readonly ThemePreviewRowWire[];
  readonly current: number;
  /** The index of the row chosen, or nothing when the sheet was cancelled. */
  readonly onDismiss: (chosen?: number) => void;
}

export function ThemePreviewSheet({
  rows,
  current,
  onDismiss,
}: ThemePreviewSheetProps) {
  const items = useMemo((): readonly PickerItem[] => {
    const all = rows.map((row, index) => ({
      id: String(index),
      label: row.label,
      detail: row.detail,
      searchText: `${row.label} ${row.name}`,
    }));
    const first = all[current];
    return first ? [first, ...all.filter((item) => item !== first)] : all;
  }, [rows, current]);

  const onActiveChange = useCallback(
    (item: PickerItem | undefined) => {
      const row = item ? rows[Number(item.id)] : undefined;
      if (row) void devhub().previewColorTheme(row.name);
    },
    [rows],
  );

  return (
    <Picker
      title="Preview Theme"
      question="Which colour theme should DevHub wear for this session?"
      items={items}
      emptyNoMatch="No theme matches that."
      emptyNoItems="No colour theme is installed."
      note="Return keeps it until DevHub restarts or the settings are applied; Escape goes back. Settings are not changed."
      onActiveChange={onActiveChange}
      onChoose={({ id }) => {
        onDismiss(Number(id));
      }}
      onCancel={() => {
        onDismiss();
      }}
    />
  );
}
