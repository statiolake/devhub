/**
 * How a Workspace's content area is tiled: one tree of panes.
 *
 * The content area used to hold exactly one thing — a workbench, an Agent,
 * or the two side by side — and that is still what the selection decides.
 * What a person adds around it is terminals: `Cmd+Q V` puts a terminal to the
 * right of whatever pane has the keyboard, `Cmd+Q S` puts one below it, and
 * either can be done again inside the pane it made. So the area is a binary
 * tree of splits whose leaves are panes, and it is one tree for every kind of
 * pane rather than a terminal layer laid over the old arrangement:
 *
 * - **`content`** is the leaf the selection draws into. There is exactly one,
 *   always, and it is what the selection has always drawn: the workbench, an
 *   Agent, or both side by side (`SurfacePresentation`, `AppModel.resolveLayout`).
 *   Keeping that pair inside one leaf is deliberate — Back and Forward, `Cmd+Q
 *   Z`, `Cmd+Q Cmd+J` and every chord that reads "which half is in front" are
 *   about the selection, and none of them has to learn about terminals.
 * - **`terminal`** is a DevHub terminal: its own tmux session on the
 *   Workspace's machine, drawn by a view of its own.
 *
 * The tree is per Workspace, persisted with it, and the same whether the
 * Workspace or one of its Agents is selected — a terminal opened next to an
 * Agent is next to whatever that Workspace is showing, which is where the
 * person put it.
 *
 * Everything here is pure: a tree in, a tree (or an answer) out. The window
 * turns it into rectangles (`layoutRects`); the model keeps which tree each
 * Workspace has; `devhub --tell terminal list` asks it where each terminal is
 * relative to the Agent (`relativePositions`).
 *
 * # Orientation
 *
 * A split has an `axis`: `row` is side by side (`first` on the left), and
 * `column` is stacked (`first` on top). `ratio` is the share of the split's
 * own extent that `first` takes, along its axis. A path names a split by the
 * branches taken from the root to reach it — `""` is the root, `"10"` is the
 * root's second child's first child — which is what a seam is dragged by.
 */

/** Which way a split divides its rectangle. */
export type PaneAxis = "row" | "column";

/** Where a new pane goes, relative to the one it is split from. */
export type PaneSide = "right" | "below" | "left" | "above";

export const PANE_SIDES: readonly PaneSide[] = [
  "right",
  "below",
  "left",
  "above",
];

export type PaneLeaf =
  | { readonly kind: "content" }
  | { readonly kind: "terminal"; readonly terminalId: string };

export interface PaneSplit {
  readonly kind: "split";
  readonly axis: PaneAxis;
  /** `first`'s share of the split, along `axis`. */
  readonly ratio: number;
  readonly first: PaneNode;
  readonly second: PaneNode;
}

export type PaneNode = PaneLeaf | PaneSplit;

/** A split's address: one `0` (first) or `1` (second) per level. */
export type PanePath = string;

export const CONTENT_PANE: PaneLeaf = { kind: "content" };

/**
 * How small a pane may be dragged, as a share of its split.
 *
 * Wider than the workbench/Agent split's own bounds allow, because a split
 * here can be nested and its extent is already a share of a share; a tenth is
 * still a few lines of a terminal at a normal window size.
 */
export const PANE_MIN_RATIO = 0.1;
export const PANE_MAX_RATIO = 0.9;
/** A new split gives both panes the same room. */
export const PANE_DEFAULT_RATIO = 0.5;
/**
 * How deep the tree may go. Nothing a person does gets near it — sixteen
 * nested splits leave no pane a usable size — so it exists to bound what a
 * state file may ask for.
 */
export const PANE_MAX_DEPTH = 16;

/**
 * The tmux session a pane terminal is, by its id: `tm-<id>`, the way an
 * Agent's is `ag-<id>`. Said here, beside the rest of what a pane terminal
 * is, because the page's header names it and the tmux runtime creates it.
 */
export function paneTerminalSessionName(terminalId: string): string {
  return `tm-${terminalId}`;
}

export function terminalPane(terminalId: string): PaneLeaf {
  return { kind: "terminal", terminalId };
}

export function sameLeaf(left: PaneLeaf, right: PaneLeaf): boolean {
  if (left.kind === "content") return right.kind === "content";
  return right.kind === "terminal" && left.terminalId === right.terminalId;
}

export function clampPaneRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return PANE_DEFAULT_RATIO;
  return Math.min(PANE_MAX_RATIO, Math.max(PANE_MIN_RATIO, ratio));
}

/** Every leaf, in reading order: first before second, all the way down. */
export function paneLeaves(tree: PaneNode): readonly PaneLeaf[] {
  if (tree.kind !== "split") return [tree];
  return [...paneLeaves(tree.first), ...paneLeaves(tree.second)];
}

/** Every terminal in the tree, in reading order. */
export function paneTerminals(tree: PaneNode): readonly string[] {
  return paneLeaves(tree).flatMap((leaf) =>
    leaf.kind === "terminal" ? [leaf.terminalId] : [],
  );
}

export function hasLeaf(tree: PaneNode, leaf: PaneLeaf): boolean {
  return paneLeaves(tree).some((candidate) => sameLeaf(candidate, leaf));
}

function axisOf(side: PaneSide): PaneAxis {
  return side === "right" || side === "left" ? "row" : "column";
}

/** Whether the new pane is the split's `second` child. */
function addedSecond(side: PaneSide): boolean {
  return side === "right" || side === "below";
}

/**
 * Split `at` in two, putting `added` on `side` of it.
 *
 * `at` keeps its place in the tree and becomes one half of a new split there;
 * nothing else moves. A tree without `at` in it is returned as it was, and so
 * is one that already holds `added` — a pane is in a tree once.
 */
export function splitPane(
  tree: PaneNode,
  at: PaneLeaf,
  side: PaneSide,
  added: PaneLeaf,
  ratio: number = PANE_DEFAULT_RATIO,
): PaneNode {
  if (hasLeaf(tree, added) || !hasLeaf(tree, at)) return tree;
  if (depth(tree) >= PANE_MAX_DEPTH) return tree;
  const share = clampPaneRatio(ratio);
  const replace = (node: PaneNode): PaneNode => {
    if (node.kind === "split") {
      return {
        ...node,
        first: replace(node.first),
        second: replace(node.second),
      };
    }
    if (!sameLeaf(node, at)) return node;
    const second = addedSecond(side);
    return {
      kind: "split",
      axis: axisOf(side),
      // The ratio is always the *existing* pane's share, so a caller that
      // asks for 0.6 keeps 60% of the room wherever the new pane goes.
      ratio: second ? share : 1 - share,
      first: second ? node : added,
      second: second ? added : node,
    };
  };
  return replace(tree);
}

/**
 * Take a terminal out of the tree; its sibling takes the place of the split
 * that held them both. The content leaf is never removed — there is always
 * somewhere for the selection to draw.
 */
export function removePane(tree: PaneNode, leaf: PaneLeaf): PaneNode {
  if (leaf.kind === "content") return tree;
  const remove = (node: PaneNode): PaneNode | undefined => {
    if (node.kind !== "split") return sameLeaf(node, leaf) ? undefined : node;
    const first = remove(node.first);
    const second = remove(node.second);
    if (first === undefined) return second;
    if (second === undefined) return first;
    if (first === node.first && second === node.second) return node;
    return { ...node, first, second };
  };
  return remove(tree) ?? CONTENT_PANE;
}

/** The split at `path`, if there is one. */
export function splitAt(tree: PaneNode, path: PanePath): PaneSplit | undefined {
  let node: PaneNode = tree;
  for (const step of path) {
    if (node.kind !== "split") return undefined;
    node = step === "0" ? node.first : node.second;
  }
  return node.kind === "split" ? node : undefined;
}

export function isPanePath(value: string): boolean {
  return /^[01]{0,16}$/u.test(value);
}

/** Move the seam at `path`. A path that names no split changes nothing. */
export function resizePane(
  tree: PaneNode,
  path: PanePath,
  ratio: number,
): PaneNode {
  if (splitAt(tree, path) === undefined) return tree;
  const share = clampPaneRatio(ratio);
  const walk = (node: PaneNode, rest: string): PaneNode => {
    if (node.kind !== "split") return node;
    if (rest.length === 0) {
      return node.ratio === share ? node : { ...node, ratio: share };
    }
    return rest[0] === "0"
      ? { ...node, first: walk(node.first, rest.slice(1)) }
      : { ...node, second: walk(node.second, rest.slice(1)) };
  };
  return walk(tree, path);
}

/**
 * Put a terminal somewhere else: take it out, then split `onto` on `side`
 * with it. Dropping a pane on itself, or on a pane that is not in the tree,
 * changes nothing.
 */
export function movePane(
  tree: PaneNode,
  moving: PaneLeaf,
  onto: PaneLeaf,
  side: PaneSide,
): PaneNode {
  if (moving.kind === "content" || sameLeaf(moving, onto)) return tree;
  if (!hasLeaf(tree, moving) || !hasLeaf(tree, onto)) return tree;
  return splitPane(removePane(tree, moving), onto, side, moving);
}

/** Exchange two leaves' places; the splits around them stay as they were. */
export function swapPanes(
  tree: PaneNode,
  left: PaneLeaf,
  right: PaneLeaf,
): PaneNode {
  if (sameLeaf(left, right)) return tree;
  if (!hasLeaf(tree, left) || !hasLeaf(tree, right)) return tree;
  const walk = (node: PaneNode): PaneNode => {
    if (node.kind === "split") {
      return { ...node, first: walk(node.first), second: walk(node.second) };
    }
    if (sameLeaf(node, left)) return right;
    if (sameLeaf(node, right)) return left;
    return node;
  };
  return walk(tree);
}

/** Drop every terminal the predicate does not keep. */
export function keepTerminals(
  tree: PaneNode,
  keep: (terminalId: string) => boolean,
): PaneNode {
  let next = tree;
  for (const id of paneTerminals(tree)) {
    if (!keep(id)) next = removePane(next, terminalPane(id));
  }
  return next;
}

function depth(tree: PaneNode): number {
  if (tree.kind !== "split") return 0;
  return 1 + Math.max(depth(tree.first), depth(tree.second));
}

export function samePaneTree(left: PaneNode, right: PaneNode): boolean {
  if (left.kind === "split" || right.kind === "split") {
    return (
      left.kind === "split" &&
      right.kind === "split" &&
      left.axis === right.axis &&
      left.ratio === right.ratio &&
      samePaneTree(left.first, right.first) &&
      samePaneTree(left.second, right.second)
    );
  }
  return sameLeaf(left, right);
}

//#region rectangles

export interface PaneRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PlacedPane {
  readonly leaf: PaneLeaf;
  readonly rect: PaneRect;
}

/** One divider: the strip between a split's two halves. */
export interface PlacedSeam {
  readonly path: PanePath;
  readonly axis: PaneAxis;
  readonly ratio: number;
  /** The strip itself, `gap` wide. */
  readonly rect: PaneRect;
  /** The whole split it divides — what a drag's ratio is a ratio of. */
  readonly extent: PaneRect;
}

export interface PaneRects {
  readonly panes: readonly PlacedPane[];
  readonly seams: readonly PlacedSeam[];
}

/**
 * Where every pane and every seam goes inside `area`.
 *
 * `gap` is the seam's width. With `round` the rectangles are whole pixels and
 * tile `area` exactly — what the window lays native views into; without it
 * they are exact fractions, which is what a question about *where* a pane is
 * wants (`relativePositions`).
 */
export function layoutRects(
  tree: PaneNode,
  area: PaneRect,
  gap: number,
  round = true,
): PaneRects {
  const panes: PlacedPane[] = [];
  const seams: PlacedSeam[] = [];
  const snap = (value: number): number => (round ? Math.round(value) : value);
  const walk = (node: PaneNode, rect: PaneRect, path: string): void => {
    if (node.kind !== "split") {
      panes.push({ leaf: node, rect });
      return;
    }
    const along = node.axis === "row" ? rect.width : rect.height;
    const available = Math.max(0, along - gap);
    const firstSize = Math.max(0, snap(available * node.ratio));
    const secondSize = Math.max(0, along - firstSize - gap);
    if (node.axis === "row") {
      walk(node.first, { ...rect, width: firstSize }, `${path}0`);
      seams.push({
        path,
        axis: node.axis,
        ratio: node.ratio,
        rect: { ...rect, x: rect.x + firstSize, width: Math.min(gap, along) },
        extent: rect,
      });
      walk(
        node.second,
        { ...rect, x: rect.x + firstSize + gap, width: secondSize },
        `${path}1`,
      );
    } else {
      walk(node.first, { ...rect, height: firstSize }, `${path}0`);
      seams.push({
        path,
        axis: node.axis,
        ratio: node.ratio,
        rect: { ...rect, y: rect.y + firstSize, height: Math.min(gap, along) },
        extent: rect,
      });
      walk(
        node.second,
        { ...rect, y: rect.y + firstSize + gap, height: secondSize },
        `${path}1`,
      );
    }
  };
  walk(tree, area, "");
  return { panes, seams };
}

const UNIT: PaneRect = { x: 0, y: 0, width: 1, height: 1 };
const EPSILON = 1e-9;

function unitRects(tree: PaneNode): readonly PlacedPane[] {
  return layoutRects(tree, UNIT, 0, false).panes;
}

/** Which sides of `reference` a rectangle lies on, wholly. */
function sidesOf(rect: PaneRect, reference: PaneRect): PaneSide[] {
  const sides: PaneSide[] = [];
  if (rect.x >= reference.x + reference.width - EPSILON) sides.push("right");
  if (rect.x + rect.width <= reference.x + EPSILON) sides.push("left");
  if (rect.y >= reference.y + reference.height - EPSILON) sides.push("below");
  if (rect.y + rect.height <= reference.y + EPSILON) sides.push("above");
  return sides;
}

/** How far `rect` is from `reference` in the direction of `side`. */
function gapTowards(side: PaneSide, rect: PaneRect, reference: PaneRect) {
  switch (side) {
    case "right":
      return rect.x - (reference.x + reference.width);
    case "left":
      return reference.x - (rect.x + rect.width);
    case "below":
      return rect.y - (reference.y + reference.height);
    case "above":
      return reference.y - (rect.y + rect.height);
  }
}

/** How much the two share across the direction of `side`. */
function overlapAcross(side: PaneSide, rect: PaneRect, reference: PaneRect) {
  if (side === "right" || side === "left") {
    return (
      Math.min(rect.y + rect.height, reference.y + reference.height) -
      Math.max(rect.y, reference.y)
    );
  }
  return (
    Math.min(rect.x + rect.width, reference.x + reference.width) -
    Math.max(rect.x, reference.x)
  );
}

/**
 * The pane the keyboard goes to from `from`, moving towards `side`: the
 * nearest leaf wholly on that side that faces it, the one sharing the most
 * edge with it when two are as near. Nothing when there is none — the edge of
 * the area does not wrap.
 */
export function neighbourPane(
  tree: PaneNode,
  from: PaneLeaf,
  side: PaneSide,
): PaneLeaf | undefined {
  const placed = unitRects(tree);
  const origin = placed.find((pane) => sameLeaf(pane.leaf, from));
  if (origin === undefined) return undefined;
  let best: { leaf: PaneLeaf; gap: number; overlap: number } | undefined;
  for (const pane of placed) {
    if (sameLeaf(pane.leaf, from)) continue;
    if (!sidesOf(pane.rect, origin.rect).includes(side)) continue;
    const overlap = overlapAcross(side, pane.rect, origin.rect);
    if (overlap <= EPSILON) continue;
    const gap = gapTowards(side, pane.rect, origin.rect);
    if (
      best === undefined ||
      gap < best.gap - EPSILON ||
      (Math.abs(gap - best.gap) <= EPSILON && overlap > best.overlap + EPSILON)
    ) {
      best = { leaf: pane.leaf, gap, overlap };
    }
  }
  return best?.leaf;
}

/** Where one terminal is, as seen from the reference pane. */
export interface RelativePosition {
  readonly terminalId: string;
  /**
   * Every side of the reference the terminal lies wholly on — `["right"]`,
   * or two for a pane that is off a corner (`["right", "below"]`). Empty
   * only for a pane that overlaps the reference, which a tree cannot make.
   */
  readonly sides: readonly PaneSide[];
  /**
   * The same, in the words a person uses: `right`, `below`, `right, top` —
   * the second word saying which one it is when several share a side.
   */
  readonly description: string;
  /** It touches the reference: nothing else stands between them. */
  readonly adjacent: boolean;
  /** Where it is in the area, as fractions of it. */
  readonly rect: PaneRect;
}

/** Top/bottom for panes stacked on a left or right side, left/right otherwise. */
function qualifier(
  side: PaneSide,
  rect: PaneRect,
  peers: readonly PaneRect[],
): string | undefined {
  if (peers.length < 2) return undefined;
  const vertical = side === "right" || side === "left";
  const centre = (one: PaneRect) =>
    vertical ? one.y + one.height / 2 : one.x + one.width / 2;
  const ordered = [...peers].sort((a, b) => centre(a) - centre(b));
  const index = ordered.findIndex((one) => one === rect);
  if (index === 0) return vertical ? "top" : "left";
  if (index === ordered.length - 1) return vertical ? "bottom" : "right";
  return "middle";
}

/**
 * Where every terminal is relative to `reference` — the pane the Agent asking
 * is drawn in, which is the content leaf.
 *
 * Measured on the tree's own proportions, not on pixels: "the terminal on the
 * right" is a fact about the arrangement, and it is the same fact at any
 * window size.
 */
export function relativePositions(
  tree: PaneNode,
  reference: PaneLeaf = CONTENT_PANE,
): readonly RelativePosition[] {
  const placed = unitRects(tree);
  const origin = placed.find((pane) => sameLeaf(pane.leaf, reference));
  if (origin === undefined) return [];
  const terminals = placed.flatMap((pane) =>
    pane.leaf.kind === "terminal" && !sameLeaf(pane.leaf, reference)
      ? [{ terminalId: pane.leaf.terminalId, rect: pane.rect }]
      : [],
  );
  type Placed = (typeof terminals)[number];
  const sides = new Map<Placed, PaneSide[]>(
    terminals.map((pane) => [pane, sidesOf(pane.rect, origin.rect)]),
  );
  // Peers share a primary side, so "right, top" and "right, bottom" are told
  // apart among the panes on the right and nowhere else.
  const primary = (pane: Placed) => sides.get(pane)?.[0];
  return terminals.map((pane) => {
    const own = sides.get(pane) ?? [];
    const first = own[0];
    const peers =
      first === undefined
        ? []
        : terminals
            .filter((other) => primary(other) === first)
            .map((other) => other.rect);
    const extra =
      own.length > 1
        ? own.slice(1)
        : first === undefined
          ? []
          : [qualifier(first, pane.rect, peers)].filter(
              (word): word is string => word !== undefined,
            );
    const adjacent =
      first !== undefined &&
      Math.abs(gapTowards(first, pane.rect, origin.rect)) <= EPSILON &&
      overlapAcross(first, pane.rect, origin.rect) > EPSILON;
    return {
      terminalId: pane.terminalId,
      sides: own,
      description: [first ?? "overlapping", ...extra].join(", "),
      adjacent,
      rect: pane.rect,
    };
  });
}

export type PaneResolution =
  | { readonly kind: "found"; readonly terminalId: string }
  | { readonly kind: "none" }
  | {
      readonly kind: "ambiguous";
      readonly candidates: readonly RelativePosition[];
    };

/**
 * "The terminal on the right", answered.
 *
 * `query` is a side, optionally with the qualifier `relativePositions` words
 * (`right`, `right top`, `right,bottom`). Of the terminals on that side, the
 * nearest one wins; several equally near (two stacked on the right, both
 * touching the Agent) are ambiguous unless the qualifier picks one — and an
 * ambiguous answer names them all, so whoever asked can say which.
 */
export function resolvePane(
  tree: PaneNode,
  query: string,
  reference: PaneLeaf = CONTENT_PANE,
): PaneResolution {
  const words = query
    .toLowerCase()
    .split(/[\s,]+/u)
    .filter((word) => word.length > 0);
  const side = words[0] as PaneSide | undefined;
  if (side === undefined || !PANE_SIDES.includes(side)) return { kind: "none" };
  const rest = words.slice(1);
  const positions = relativePositions(tree, reference).filter((position) =>
    position.sides.includes(side),
  );
  const placed = unitRects(tree);
  const origin = placed.find((pane) => sameLeaf(pane.leaf, reference));
  if (origin === undefined || positions.length === 0) return { kind: "none" };
  const matching =
    rest.length === 0
      ? positions
      : positions.filter((position) => {
          const described = position.description.split(", ").slice(1);
          return rest.every((word) => described.includes(word));
        });
  if (matching.length === 0) return { kind: "none" };
  if (matching.length === 1) {
    return { kind: "found", terminalId: matching[0]!.terminalId };
  }
  const distance = (position: RelativePosition) =>
    gapTowards(side, position.rect, origin.rect);
  const nearest = Math.min(...matching.map(distance));
  const closest = matching.filter(
    (position) => distance(position) <= nearest + EPSILON,
  );
  if (closest.length === 1) {
    return { kind: "found", terminalId: closest[0]!.terminalId };
  }
  return { kind: "ambiguous", candidates: closest };
}

//#endregion

//#region records

/** The tree as `state.json` writes it. */
export type PaneNodeRecord =
  | { readonly kind: "content" }
  | { readonly kind: "terminal"; readonly terminal_id: string }
  | {
      readonly kind: "split";
      readonly axis: PaneAxis;
      readonly ratio: number;
      readonly first: PaneNodeRecord;
      readonly second: PaneNodeRecord;
    };

export function paneRecord(tree: PaneNode): PaneNodeRecord {
  switch (tree.kind) {
    case "content":
      return { kind: "content" };
    case "terminal":
      return { kind: "terminal", terminal_id: tree.terminalId };
    case "split":
      return {
        kind: "split",
        axis: tree.axis,
        ratio: tree.ratio,
        first: paneRecord(tree.first),
        second: paneRecord(tree.second),
      };
  }
}

export class PaneRecordError extends Error {
  constructor(readonly where: string) {
    super(`${where} is not a pane layout DevHub wrote`);
    this.name = "PaneRecordError";
  }
}

/**
 * Read a tree back, refusing anything this module could not have written:
 * exactly one content leaf, no terminal twice, ratios in range, and no deeper
 * than `PANE_MAX_DEPTH`.
 */
export function paneFromRecord(value: unknown, where = "panes"): PaneNode {
  const seen = new Set<string>();
  let contents = 0;
  const read = (node: unknown, at: string, level: number): PaneNode => {
    if (level > PANE_MAX_DEPTH) throw new PaneRecordError(at);
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      throw new PaneRecordError(at);
    }
    const record = node as Record<string, unknown>;
    switch (record["kind"]) {
      case "content":
        contents += 1;
        return CONTENT_PANE;
      case "terminal": {
        const id = record["terminal_id"];
        if (typeof id !== "string" || id.length === 0 || seen.has(id)) {
          throw new PaneRecordError(`${at}.terminal_id`);
        }
        seen.add(id);
        return terminalPane(id);
      }
      case "split": {
        const axis = record["axis"];
        const ratio = record["ratio"];
        if (axis !== "row" && axis !== "column") {
          throw new PaneRecordError(`${at}.axis`);
        }
        if (
          typeof ratio !== "number" ||
          !Number.isFinite(ratio) ||
          ratio < PANE_MIN_RATIO ||
          ratio > PANE_MAX_RATIO
        ) {
          throw new PaneRecordError(`${at}.ratio`);
        }
        return {
          kind: "split",
          axis,
          ratio,
          first: read(record["first"], `${at}.first`, level + 1),
          second: read(record["second"], `${at}.second`, level + 1),
        };
      }
      default:
        throw new PaneRecordError(`${at}.kind`);
    }
  };
  const tree = read(value, where, 0);
  if (contents !== 1) throw new PaneRecordError(where);
  return tree;
}

//#endregion
