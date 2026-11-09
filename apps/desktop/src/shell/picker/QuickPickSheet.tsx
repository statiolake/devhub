/**
 * A program's question in DevHub's quick pick: Neovim's `vim.ui.select` and
 * `vim.ui.input` (`docs/native-picker.md`, "Quick pick").
 *
 * The program says what is asked and what the answers are; this is the
 * ordinary picker, so typing filters with the shared scorer, the arrows and
 * Ctrl-N / Ctrl-P move, Return answers and Escape cancels — the keys every
 * other question DevHub asks takes. The answer goes back to the program
 * (the row's index, or the text typed), which goes on from its callback.
 *
 * An input is the rule's "line of typing": no candidates, and the one row
 * that means what was typed.
 */

import { useMemo } from "react";
import { Picker, type PickerItem } from "../components/shell/Picker";
import type { QuickPickRequestWire } from "../../ipc/contract";

export interface QuickPickSheetProps {
  readonly request: QuickPickRequestWire;
  /** The row's index or the text typed; nothing when cancelled. */
  readonly onDismiss: (answer?: number | string) => void;
}

const TYPED = "devhub:quick-pick-typed";

export function QuickPickSheet({ request, onDismiss }: QuickPickSheetProps) {
  const items = useMemo(
    (): readonly PickerItem[] =>
      request.rows.map((row, index) => ({
        id: String(index),
        label: row.label,
        ...(row.detail === undefined ? {} : { detail: row.detail }),
      })),
    [request.rows],
  );
  const input = request.input;
  const pinned = useMemo(
    (): readonly PickerItem[] =>
      input === undefined ? [] : [{ id: TYPED, label: "Use what is typed" }],
    [input],
  );

  return (
    <Picker
      title={request.title}
      question={request.question}
      items={items}
      pinned={pinned}
      {...(input === undefined
        ? {
            emptyNoMatch: "Nothing matches that.",
            emptyNoItems: "There is nothing to choose.",
          }
        : { initialQuery: input.default })}
      onChoose={({ id, query }) => {
        onDismiss(id === TYPED ? query : Number(id));
      }}
      onCancel={() => {
        onDismiss();
      }}
    />
  );
}
