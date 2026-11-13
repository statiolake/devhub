/**
 * The Tokens table as it is drawn: its columns per view, sorted by the
 * chosen one, with what is folded left out.
 *
 * Pure, so the order and the folding are tested without a page.
 */

import {
  formatCost,
  formatRate,
  formatTokens,
  type TokenRowWire,
  type TokenTotalsWire,
  type TokenView,
} from "../ipc/tokenUsage";

export type TokenColumnKey =
  | "input"
  | "cacheRead"
  | "cacheWrite"
  | "output"
  | "total"
  | "weightedInput"
  | "hitRate"
  | "cost";

export interface TokenColumn {
  readonly key: TokenColumnKey;
  readonly label: string;
  /** What the heading's tooltip says the column is. */
  readonly title: string;
  readonly value: (totals: TokenTotalsWire) => number;
  readonly text: (totals: TokenTotalsWire) => string;
}

const cacheWrite = (t: TokenTotalsWire) => t.cacheWrite5m + t.cacheWrite1h;

export const TOKEN_COLUMNS: Readonly<
  Record<TokenView, readonly TokenColumn[]>
> = {
  raw: [
    {
      key: "input",
      label: "Input",
      title: "Input neither read from the cache nor written to it",
      value: (t) => t.input,
      text: (t) => formatTokens(t.input),
    },
    {
      key: "cacheRead",
      label: "Cache read",
      title: "Input read from the prompt cache",
      value: (t) => t.cacheRead,
      text: (t) => formatTokens(t.cacheRead),
    },
    {
      key: "cacheWrite",
      label: "Cache write",
      title: "Input written to the prompt cache (5-minute and 1-hour)",
      value: cacheWrite,
      text: (t) => formatTokens(cacheWrite(t)),
    },
    {
      key: "output",
      label: "Output",
      title: "Tokens generated",
      value: (t) => t.output,
      text: (t) => formatTokens(t.output),
    },
    {
      key: "total",
      label: "Total",
      title: "All input processed, cache included, and output",
      value: (t) => t.total,
      text: (t) => formatTokens(t.total),
    },
  ],
  weighted: [
    {
      key: "weightedInput",
      label: "Weighted in",
      title:
        "Input as tokens at base input price: cache reads at the model's read price, writes at 1.25× (5 min) and 2× (1 h)",
      value: (t) => t.weightedInput,
      text: (t) =>
        t.weightedInput === 0 && t.unpricedTokens > 0
          ? "—"
          : formatTokens(t.weightedInput),
    },
    {
      key: "output",
      label: "Output",
      title: "Tokens generated",
      value: (t) => t.output,
      text: (t) => formatTokens(t.output),
    },
    {
      key: "hitRate",
      label: "Hit rate",
      title: "Cache reads of all input",
      value: (t) => t.hitRate ?? -1,
      text: (t) => formatRate(t.hitRate),
    },
    {
      key: "cost",
      label: "Est. cost",
      title:
        "Estimated at Anthropic's API list price. A Claude plan is not billed this.",
      value: (t) => t.cost,
      text: (t) =>
        t.cost === 0 && t.unpricedTokens > 0 ? "—" : formatCost(t.cost),
    },
  ],
};

/** Each view's column a table is first sorted by. */
export const DEFAULT_SORT: Readonly<Record<TokenView, TokenColumnKey>> = {
  raw: "total",
  weighted: "cost",
};

export interface TokenSort {
  readonly key: TokenColumnKey;
  readonly ascending: boolean;
}

export function columnOf(view: TokenView, key: TokenColumnKey): TokenColumn {
  return (
    TOKEN_COLUMNS[view].find((column) => column.key === key) ??
    TOKEN_COLUMNS[view].find((column) => column.key === DEFAULT_SORT[view])!
  );
}

export function sortTokenRows(
  rows: readonly TokenRowWire[],
  view: TokenView,
  sort: TokenSort,
): TokenRowWire[] {
  const value = columnOf(view, sort.key).value;
  return [...rows].sort(
    (a, b) =>
      (sort.ascending ? 1 : -1) * (value(a.totals) - value(b.totals)) ||
      b.totals.total - a.totals.total ||
      a.label.localeCompare(b.label),
  );
}

export interface VisibleTokenRow {
  readonly row: TokenRowWire;
  readonly depth: number;
  readonly open: boolean;
  readonly parentId: string | undefined;
}

/** The rows as drawn: every row folded unless opened (`opened`). */
export function visibleTokenRows(
  rows: readonly TokenRowWire[],
  view: TokenView,
  sort: TokenSort,
  opened: ReadonlySet<string>,
): VisibleTokenRow[] {
  const out: VisibleTokenRow[] = [];
  for (const row of sortTokenRows(rows, view, sort)) {
    const open = row.children.length > 0 && opened.has(row.id);
    out.push({ row, depth: 0, open, parentId: undefined });
    if (open)
      for (const child of sortTokenRows(row.children, view, sort))
        out.push({ row: child, depth: 1, open: false, parentId: row.id });
  }
  return out;
}
