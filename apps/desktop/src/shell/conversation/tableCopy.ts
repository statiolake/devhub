/**
 * A Markdown table of an answer, as text another program reads as a table:
 * CSV (RFC 4180) for a spreadsheet or a file, TSV for a paste into one.
 *
 * Read off the drawn table rather than the Markdown: what a cell says is what
 * the person sees — a link's text, inline code without its backticks, a formula
 * as it was typeset — and every row, the header first, in order.
 */

/** Each row of `table`, the header's included, as its cells' text. */
export function tableRows(table: HTMLTableElement): string[][] {
  return [...table.rows].map((row) =>
    [...row.cells].map((cell) => (cell.textContent ?? "").trim()),
  );
}

function csvField(text: string): string {
  return /[",\r\n]|^\s|\s$/u.test(text)
    ? `"${text.replace(/"/gu, '""')}"`
    : text;
}

/** `rows` as CSV: a field with a comma, a quote or a line break is quoted. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(csvField).join(",")).join("\r\n");
}

/** `rows` as TSV: a tab or a line break inside a cell is a space. */
export function toTsv(rows: readonly (readonly string[])[]): string {
  return rows
    .map((row) =>
      row.map((cell) => cell.replace(/[\t\r\n]+/gu, " ")).join("\t"),
    )
    .join("\n");
}
