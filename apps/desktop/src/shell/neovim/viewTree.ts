/**
 * A tree in a `gui.view` (`indent`): items carry a depth, DevHub indents
 * them and draws the guides down the rows — one per level, as an editor's
 * file tree does. The guide of the level the focused item is in is the
 * active one, over the run of rows under the same parent.
 */

export interface DepthItem {
  readonly depth?: number | undefined;
}

/** The active guide: its level and the first and last item it runs past. */
export interface ActiveGuide {
  readonly level: number;
  readonly from: number;
  readonly to: number;
}

/**
 * The guide of the focused item's level: from the first item after its
 * parent to the last item before the next one at the parent's depth or
 * less. None at depth 0 (no guide runs there) or with no item focused.
 */
export function activeGuide(
  items: readonly DepthItem[],
  focused: number,
): ActiveGuide | undefined {
  const depth = items[focused]?.depth;
  if (depth === undefined || depth < 1) return undefined;
  const level = depth - 1;
  const deep = (index: number) => (items[index]?.depth ?? 0) > level;
  let from = focused;
  while (from > 0 && deep(from - 1)) from -= 1;
  let to = focused;
  while (to < items.length - 1 && deep(to + 1)) to += 1;
  return { level, from, to };
}

/** The x of a level's guide in an item, in pixels from the item's padding edge. */
export function guideX(level: number, indent: number): number {
  return Math.round(level * indent + indent / 2);
}

/**
 * Where an item stands in Visual mode's selection, so the selected rows
 * are one band: its ends rounded, its joins square. None: not selected.
 */
export type BandPart = "only" | "first" | "middle" | "last";

export function bandPart(
  lines: readonly number[],
  index: number,
  visual: readonly [number, number] | undefined,
): BandPart | undefined {
  const line = lines[index];
  if (visual === undefined || line === undefined) return undefined;
  const inside = (l: number | undefined) =>
    l !== undefined && l >= visual[0] && l <= visual[1];
  if (!inside(line)) return undefined;
  const above = inside(lines[index - 1]);
  const below = inside(lines[index + 1]);
  return above && below ? "middle" : above ? "last" : below ? "first" : "only";
}
