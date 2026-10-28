/**
 * A Markdown table of an answer: a box of its own that scrolls sideways
 * rather than widening the transcript, and copies as a table.
 *
 * A quiet copy button sits over the table's corner while the pointer is on
 * it (or the keyboard is in it) and puts the table on the clipboard as CSV
 * (`tableCopy.ts`). A right-click offers _Copy as CSV_ and _Copy as TSV_ —
 * TSV is what a spreadsheet takes as cells when pasted. A right-click on
 * text selected in the table is left to the page.
 */

import { useRef, type ReactNode } from "react";
import { useConversationActions } from "./ConversationContext";
import { CopyButton } from "./CopyButton";
import { usePreviewMenu } from "./PreviewFigure";
import { tableRows, toCsv, toTsv } from "./tableCopy";

export const TABLE_MENU = [
  { id: "copy-csv", label: "Copy as CSV" },
  { id: "copy-tsv", label: "Copy as TSV" },
] as const;

export function Table({ children }: { readonly children?: ReactNode }) {
  const { writeClipboard } = useConversationActions();
  const table = useRef<HTMLTableElement>(null);
  const copy = (format: (rows: string[][]) => string) => () =>
    writeClipboard(
      table.current === null ? "" : format(tableRows(table.current)),
    );
  const onContextMenu = usePreviewMenu([
    { ...TABLE_MENU[0], run: copy(toCsv) },
    { ...TABLE_MENU[1], run: copy(toTsv) },
  ]);
  return (
    <div className="conversation-table-block" onContextMenu={onContextMenu}>
      <div className="conversation-table">
        <table ref={table}>{children}</table>
      </div>
      <span className="conversation-table-actions">
        <CopyButton copy={copy(toCsv)} label="Copy as CSV" />
      </span>
    </div>
  );
}
