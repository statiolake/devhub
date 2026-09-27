/**
 * The column of subagents beside the conversation, as sizes and folds: how
 * wide the column is, how the open panes share its height, and which panes
 * are folded to their header. Drawn by `SubagentColumn`; every change to it
 * is one of the functions here, so a sash dragged, a key pressed on it and a
 * double-click all move the same numbers by the same rule.
 *
 * It lives as long as the conversation's surface does (a pane's own, in
 * memory), and says nothing about which subagents are listed: that is
 * `listedSubagents`. It
 * keeps sizes and folds only for the listed ones (`withPanesOf`): a pane that
 * leaves takes its own with it, and comes back at an ordinary size, open.
 */

import type { EntryId } from "../../model/conversation";

/** The narrowest the column is dragged to. */
export const MIN_COLUMN_PX = 280;
/** The narrowest the conversation beside the column is left. */
export const MIN_CONVERSATION_PX = 400;
/** The lowest an open pane in the column is dragged to. */
export const MIN_PANE_PX = 96;
/** How far one arrow key moves a sash. */
export const SASH_STEP_PX = 16;

export interface ColumnState {
  /** The column's width in px, or undefined for its default share. */
  readonly width: number | undefined;
  /**
   * The share of the column's height each open pane takes, as flex weights.
   * Empty until a sash is moved: every pane then takes an equal share.
   */
  readonly weights: ReadonlyMap<EntryId, number>;
  /** The panes folded to their header, keeping their place in the column. */
  readonly folded: ReadonlySet<EntryId>;
}

export const INITIAL_COLUMN: ColumnState = {
  width: undefined,
  weights: new Map(),
  folded: new Set(),
};

/**
 * A width for the column, kept between its own least and the most that
 * leaves the conversation its least, in a row `across` px wide.
 */
export function clampColumnWidth(width: number, across: number): number {
  return Math.max(MIN_COLUMN_PX, Math.min(width, across - MIN_CONVERSATION_PX));
}

export function withWidth(
  state: ColumnState,
  width: number,
  across: number,
): ColumnState {
  return { ...state, width: clampColumnWidth(width, across) };
}

export function withDefaultWidth(state: ColumnState): ColumnState {
  return { ...state, width: undefined };
}

/**
 * A pane's share of the column's height. One that has none yet (it joined
 * after a sash was moved) takes the mean of the others', so it arrives at an
 * ordinary size rather than a sliver or the whole column.
 */
export function weightOf(state: ColumnState, id: EntryId): number {
  const own = state.weights.get(id);
  if (own !== undefined) return own;
  if (state.weights.size === 0) return 1;
  let sum = 0;
  for (const weight of state.weights.values()) sum += weight;
  return sum / state.weights.size;
}

export interface MeasuredPane {
  readonly id: EntryId;
  /** Its height as drawn, in px. */
  readonly height: number;
}

/**
 * The sash between the open panes `above` and `below` (indices into `open`,
 * the open panes in the column's order, as drawn) moved by `delta` px, down
 * being positive. The two panes trade height and neither goes under its
 * least; every other pane keeps the height it has. The heights become the
 * weights, so the panes keep their proportions as the column grows.
 */
export function withSashMoved(
  state: ColumnState,
  open: readonly MeasuredPane[],
  above: number,
  below: number,
  delta: number,
): ColumnState {
  const upper = open[above];
  const lower = open[below];
  if (!upper || !lower || above >= below) {
    throw new Error(`no sash lies between open panes ${above} and ${below}`);
  }
  const together = upper.height + lower.height;
  // Too little room for both at their least: nothing gives way.
  if (together < 2 * MIN_PANE_PX) return state;
  const upperHeight = Math.max(
    MIN_PANE_PX,
    Math.min(upper.height + delta, together - MIN_PANE_PX),
  );
  const weights = new Map(state.weights);
  for (const pane of open) weights.set(pane.id, pane.height);
  weights.set(upper.id, upperHeight);
  weights.set(lower.id, together - upperHeight);
  return { ...state, weights };
}

/** Every pane back to an equal share of the column's height. */
export function withEqualHeights(state: ColumnState): ColumnState {
  return { ...state, weights: new Map() };
}

export function withFold(
  state: ColumnState,
  id: EntryId,
  folded: boolean,
): ColumnState {
  const next = new Set(state.folded);
  if (folded) next.add(id);
  else next.delete(id);
  return { ...state, folded: next };
}

/**
 * The column holding only the panes `listed`: a pane that has left takes its
 * share and its fold with it, and the panes that stay keep theirs, so they
 * share the room it leaves in the proportions they had. The same state when
 * nothing has left.
 */
export function withPanesOf(
  state: ColumnState,
  listed: ReadonlySet<EntryId>,
): ColumnState {
  const gone = (id: EntryId) => !listed.has(id);
  const weightsGone = [...state.weights.keys()].some(gone);
  const foldsGone = [...state.folded].some(gone);
  if (!weightsGone && !foldsGone) return state;
  return {
    ...state,
    weights: new Map([...state.weights].filter(([id]) => listed.has(id))),
    folded: new Set([...state.folded].filter((id) => listed.has(id))),
  };
}

/**
 * The sashes of a column, given which of its panes are open: one between
 * each two open panes that follow one another, drawn on top of the lower.
 * A folded pane has no height to give, so it sits between them unmoved.
 */
export function sashesOf(open: readonly boolean[]): readonly Sash[] {
  const openAt = open.flatMap((isOpen, index) => (isOpen ? [index] : []));
  return openAt.slice(1).map((before, lower) => ({
    before,
    above: lower,
    below: lower + 1,
  }));
}

export interface Sash {
  /** The pane (its index in the column) the sash is drawn above. */
  readonly before: number;
  /** The open panes it moves, as indices among the open panes. */
  readonly above: number;
  readonly below: number;
}
