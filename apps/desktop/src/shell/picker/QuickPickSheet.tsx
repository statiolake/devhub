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
 * The heading band is the question: the program's prompt is what the sheet
 * has to say first, so it is the title, and who is asking ("Neovim") is not
 * drawn — the person just asked it, in the editor in front of them. An input
 * is the field alone, and Return answers with what is in it: no list, and no
 * row that means "what was typed".
 */

import { useMemo } from "react";
import { Picker, type PickerItem } from "../components/shell/Picker";
import type { QuickPickRequestWire } from "../../ipc/contract";

export interface QuickPickSheetProps {
  readonly request: QuickPickRequestWire;
  /** The row's index or the text typed; nothing when cancelled. */
  readonly onDismiss: (answer?: number | string) => void;
}

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
  // A program that asks nothing in words is only who it is.
  const asked =
    request.question.trim() === "" ? request.title : request.question;

  return (
    <Picker
      title={asked}
      question={undefined}
      items={items}
      {...(input === undefined
        ? {
            emptyNoMatch: "Nothing matches that.",
            emptyNoItems: "There is nothing to choose.",
          }
        : {
            initialQuery: input.default,
            onTyped: (text: string) => {
              onDismiss(text);
            },
          })}
      onChoose={({ id }) => {
        onDismiss(Number(id));
      }}
      onCancel={() => {
        onDismiss();
      }}
    />
  );
}
