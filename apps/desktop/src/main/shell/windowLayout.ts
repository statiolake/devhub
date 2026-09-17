/**
 * Where everything in the one window is, decided in one place.
 *
 * The window is a tree of `WebContentsView` children over one rectangle: the
 * App Shell page, one workbench per Workspace, the notices, the questions.
 * Every one of them needs a rectangle, a visibility and a place in the child
 * list, and those three answers have to agree with each other — a view shown
 * under another one is invisible for no visible reason, and a view sized after
 * it is shown wears its previous size for a frame.
 *
 * So there is one function that answers all three, and it is pure. It takes
 * the projection, the window's size and the two appearance settings that move
 * the chrome, and it returns the child list. Nothing measures anything: the
 * numbers below are the window's own, and the page is *given* the rectangle it
 * leaves for the workbench rather than asked for it. That is the whole of what
 * this module exists to end — the page used to measure a hole it does not draw
 * and report it back, so main's idea of the layout was a page's idea of the
 * layout, one frame late, and a resize was a round trip.
 *
 * # The numbers
 *
 * They are the counterparts of the tokens in `shell/styles/tokens.css`, and
 * they are named after them. Both spellings exist because a stylesheet cannot
 * be read from main and main cannot lay out a flexbox; what stops them
 * drifting is that the page draws the workbench hole at the width *this*
 * module computed, so a disagreement about the sidebar is a disagreement about
 * a number neither side is free to invent.
 */

import type { TitleBarMode } from "../../model/config.js";

/** `--titlebar-height`: the band the traffic lights sit in, either chrome. */
const TITLE_BAR_HEIGHT = 38;
/** `--traffic-light-span`: how far the lights reach from the leading edge. */
const TRAFFIC_LIGHT_SPAN = 76;
/**
 * `--space-3`: the margin the rail leaves each side of its glyph column.
 *
 * It said `--sidebar-rail-width` and it was 14, which was a token that sized a
 * leading gutter rather than this margin, and 14 was not that token's value
 * either. So main gave the collapsed view 44px while the page drew a 40px
 * column inside it, and the rail's marks sat two pixels off the middle of
 * their own view — the one place in the Sidebar where being on the column is
 * the whole design. The page's number is `--sidebar-rail-collapsed-width`, and
 * this is the term it is written in.
 */
const SIDEBAR_RAIL_MARGIN = 12;
/** `--sidebar-glyph-width`, per density. */
const SIDEBAR_GLYPH_WIDTH = { compact: 16, comfortable: 18 } as const;
/**
 * The line between the content area and the title bar above it.
 *
 * The Sidebar's trailing hairline is *not* here: every pane is `border-box`,
 * so the Sidebar's border is inside its width and the content area starts at
 * exactly the width the Sidebar was given. The bar's is, because it is drawn
 * on the content area's own top edge — the one place a border adds to an
 * offset rather than being absorbed by one. (Measured against the page: with
 * the bar shown the hole starts at y 39, not 38.)
 */
const HAIRLINE = 1;
/**
 * `.split-divider`'s own width. The seam is an element, not a border.
 *
 * Six pixels rather than the one it paints, because the seam is also the thing
 * the split is dragged by and it is now the only strip of the content area no
 * child view covers. It used to be one pixel with a three-pixel hit area hung
 * off each side — an element reaching over its neighbours, which it could do
 * while both neighbours were boxes in the same document. Over a native view it
 * cannot: outside this strip the pointer belongs to the workbench or to the
 * Agent, so a grab area wider than the strip is a grab area that is silently
 * not there. The strip is the honest width instead.
 */
const SPLIT_DIVIDER = 6;
/** How far the notices sit from the window's corner. */
const TOASTS_MARGIN = 12;
/** Between a tooltip and the row it is about. */
const TOOLTIP_GAP = 6;
/** How close a tooltip may come to the window's own edges. */
const TOOLTIP_MARGIN = 4;

export type SidebarDensity = keyof typeof SIDEBAR_GLYPH_WIDTH;

export interface LayoutSize {
	readonly width: number;
	readonly height: number;
}

export interface LayoutRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/**
 * What the content area holds, as main reads it off the model.
 *
 * Deliberately not "is a workbench visible": `agent` and `none` are both "no
 * workbench on screen" and they are different states of the page, and `split`
 * is a workbench that is on screen *beside* something else. The page used to
 * answer this with one word over IPC (`ContentSurfaceWire`); it is the same
 * question, asked of the model where the answer already lives.
 */
export type SurfaceArrangement =
	/** One workbench, the whole content area. */
	| { readonly kind: "editor"; readonly editorKey: string }
	/** A workbench and an Agent's pane, split at `ratio` of the area. */
	| {
			readonly kind: "split";
			readonly editorKey: string;
			readonly ratio: number;
	  }
	/** An Agent over the whole area: the workbenches stay built, none shown. */
	| { readonly kind: "agent" }
	/** Nothing to show — starting, restarting, or a folder that is gone. */
	| { readonly kind: "none" };

/**
 * Which child the keyboard belongs to.
 *
 * The other half of the question the page's one word used to answer, and the
 * reason it had to be two: in a split both panes are drawn, and the one the
 * person selected is the Agent — a split is only ever entered by asking for an
 * Agent beside its editor. Reading visibility gave the keys to the editor
 * every time.
 *
 * It used to be two words, `editor` and `page`, because everything that was
 * not a workbench was one document. `page` named the Sidebar and the Agent's
 * pane at once, and the page then sorted out which of them it meant — which is
 * the whole of what `focusHome.ts` was. Both are children of the window now,
 * so the answer names one of them.
 */
export type KeyboardHalf = "editor" | "agents" | "sidebar";

/** Everything about the arrangement that is not the window's own size. */
export interface LayoutState {
	readonly titleBar: TitleBarMode;
	readonly density: SidebarDensity;
	readonly sidebar: { readonly width: number; readonly collapsed: boolean };
	readonly surface: SurfaceArrangement;
	readonly keyboard: KeyboardHalf;
}

/** Whether the questions layer covers the window or one workbench. */
export type PickerScope = "none" | "window" | "workbench";

export interface LayoutInput {
	readonly windowSize: LayoutSize;
	readonly state: LayoutState;
	/** Every workbench that exists, by folder key, in the order it was made. */
	readonly editors: readonly string[];
	/** The workbench that has stopped to ask something, if one has. */
	readonly asking: string | undefined;
	/** How big the notices are, as the page measured its own stack. */
	readonly toasts: LayoutSize | undefined;
	readonly picker: PickerScope;
	/** The tooltip that is up, if one is. See `TooltipPlacement`. */
	readonly tooltip: TooltipPlacement | undefined;
}

/**
 * Which way a tooltip leans off the thing it is about.
 *
 * Two answers and not four, because it is two questions about the *row*
 * rather than four positions: a rail entry is a glyph with the sentence
 * beside it (`right`), and a row in the expanded column is a line of text
 * with the sentence under it (`below`). Where it actually lands is
 * `tooltipRect`'s, which flips and clamps — this is only which side is
 * preferred when there is room for either.
 */
export type TooltipSide = "right" | "below";

/**
 * Everything the owner needs to place a tooltip, and nothing the page keeps.
 *
 * The anchor is in the *window's* coordinates, which is the whole point of
 * this layer existing: the Sidebar's own box stops at its column, and a
 * tooltip that cannot leave that column is the tooltip this replaced. The
 * page converts its row's box once, against the rectangle the owner told it
 * it occupies (`sidebarAreaChanged`), and never against `window.screenX` or
 * its own `innerWidth` — both of which are a view's, and stale for a frame
 * after main moves it.
 *
 * `size` is the page's and only the page's: how big a sentence is depends on
 * how it wraps, which is the one thing here a renderer knows and main does
 * not. It arrives the way the notices' size does, and for the same reason —
 * see `tooltipView.ts`.
 */
export interface TooltipPlacement {
	readonly anchor: LayoutRect;
	readonly prefer: TooltipSide;
	readonly size: LayoutSize;
}

export type ChildIdentity =
	| { readonly kind: "shell" }
	| { readonly kind: "sidebar" }
	| { readonly kind: "agents" }
	| { readonly kind: "editor"; readonly editorKey: string }
	| { readonly kind: "toasts" }
	| { readonly kind: "picker" }
	| { readonly kind: "tooltip" };

export interface LayoutChild {
	readonly identity: ChildIdentity;
	readonly rect: LayoutRect;
	readonly visible: boolean;
}

/**
 * How wide the Sidebar's column is, hairline included.
 *
 * Collapsed it is a rail, and how wide a rail may be is a fact about the
 * *window*: with no title bar of DevHub's own the Sidebar carries the traffic
 * lights, and a rail narrower than their span would put the close button on a
 * workbench. With a bar above it the lights are up there and the rail is only
 * its glyph column with the leading inset on each side.
 */
export function sidebarColumnWidth(state: LayoutState): number {
	if (!state.sidebar.collapsed) return Math.round(state.sidebar.width);
	return state.titleBar === "hidden"
		? TRAFFIC_LIGHT_SPAN
		: SIDEBAR_GLYPH_WIDTH[state.density] + 2 * SIDEBAR_RAIL_MARGIN;
}

/**
 * The content area: everything that is not the Sidebar and not the title bar.
 *
 * The bar exists in exactly one of the two chromes. With it the area starts
 * below it and carries the hairline that continues the Sidebar's trailing
 * edge; without it the Sidebar keeps that band clear at its own top instead
 * and the area is the whole window's height.
 */
export function surfaceRect(
	windowSize: LayoutSize,
	state: LayoutState,
): LayoutRect {
	const bar = state.titleBar === "shown" ? TITLE_BAR_HEIGHT + HAIRLINE : 0;
	const x = sidebarColumnWidth(state);
	return {
		x,
		y: bar,
		width: Math.max(0, windowSize.width - x),
		height: Math.max(0, windowSize.height - bar),
	};
}

/**
 * The Sidebar's own rectangle: the leading column, under the band the window
 * is dragged by.
 *
 * **The band is never part of it, in either chrome.** A drag region is not a
 * hit test the page performs: Electron collects the region's rectangles from
 * layout and hands them to macOS, which takes the mouse before any page sees
 * it — and it collects them from the *window's own* web contents. Whether a
 * region declared inside a `WebContentsView` composes into that handle at all
 * is not something this codebase can decide or check, so it does not depend on
 * it: the handle is drawn on the window's own page, which is the
 * `BrowserWindow`'s own contents and is under every child.
 *
 * With `shown` that is the title bar, spanning the whole window above both
 * columns, and this rectangle starts under it and its hairline. With `hidden`
 * there is no bar — but there are still the traffic lights, and something has
 * to be draggable around them, so the same band is left to the window's page
 * over this column and the Sidebar starts under it. It used to be the
 * Sidebar's own, declared as `-webkit-app-region: drag` on the pane and opted
 * out of by everything in it that does something; that rule also carried the
 * "a scrollbar inside a drag rectangle moves the window" gotcha, and both are
 * gone with it.
 *
 * The rail's floor is still about the lights (see `sidebarColumnWidth`): they
 * are drawn over this column whether or not the band belongs to it, and a rail
 * narrower than their span would put the close button on a workbench.
 */
export function sidebarRect(
	windowSize: LayoutSize,
	state: LayoutState,
): LayoutRect {
	const band =
		state.titleBar === "shown" ? TITLE_BAR_HEIGHT + HAIRLINE : TITLE_BAR_HEIGHT;
	return {
		x: 0,
		y: band,
		width: sidebarColumnWidth(state),
		height: Math.max(0, windowSize.height - band),
	};
}

/**
 * The rectangle the Agents' view is laid into.
 *
 * The whole content area when an Agent covers it, and the trailing share of it
 * when one is open beside its editor — the workbench's rectangle, the seam,
 * and then this. The seam itself belongs to neither: it is a real element on
 * the window's own page, in the one strip no child covers, which is what keeps
 * the pixels the pointer meets and the pixels the eye sees the same pixels.
 *
 * Computed whether or not an Agent is on screen, for the same reason a
 * workbench is: a view shown at the size it had when it was last hidden lays
 * itself out against that size first, and an xterm reflows visibly when it
 * catches up.
 */
export function agentsRect(
	windowSize: LayoutSize,
	state: LayoutState,
): LayoutRect {
	const surface = surfaceRect(windowSize, state);
	if (state.surface.kind !== "split") return surface;
	const workbench = workbenchRect(windowSize, state);
	const x = workbench.x + workbench.width + SPLIT_DIVIDER;
	return {
		...surface,
		x,
		width: Math.max(0, surface.x + surface.width - x),
	};
}

/**
 * The rectangle the workbench is laid into — the hole the page leaves.
 *
 * The whole content area, or the leading share of it when an Agent is beside
 * it. It is computed here whether or not a workbench is on screen, because the
 * page draws its own states in the same rectangle and both have to be the
 * same rectangle.
 */
export function workbenchRect(
	windowSize: LayoutSize,
	state: LayoutState,
): LayoutRect {
	const surface = surfaceRect(windowSize, state);
	if (state.surface.kind !== "split") return surface;
	const available = Math.max(0, surface.width - SPLIT_DIVIDER);
	return {
		...surface,
		width: Math.max(0, Math.round(available * state.surface.ratio)),
	};
}

/** Where the notices sit: their own size, in the window's bottom corner. */
function toastsRect(windowSize: LayoutSize, size: LayoutSize): LayoutRect {
	const width = Math.min(Math.round(size.width), windowSize.width);
	const height = Math.min(Math.round(size.height), windowSize.height);
	return {
		x: Math.max(0, windowSize.width - width - TOASTS_MARGIN),
		y: Math.max(0, windowSize.height - height - TOASTS_MARGIN),
		width,
		height,
	};
}

/**
 * Hold `value` inside `[low, high]`.
 *
 * `low` is itself held under `high` first, because the two can cross: a
 * tooltip as big as the window has no position that is both a margin in from
 * the leading edge and a margin in from the trailing one, and being inside the
 * window is the rule that matters. Without this a full-window tooltip was
 * placed at the margin and hung off the far edge by exactly that much.
 */
function clamp(value: number, low: number, high: number): number {
	return Math.max(Math.min(low, high), Math.min(value, high));
}

/**
 * Where a tooltip goes: beside the row it is about, inside the window.
 *
 * This is the placement that used to be done inside the Sidebar's own
 * document, against the Sidebar's own box — which is why it could not be done
 * at all on a rail. The arithmetic is the same shape; what changed is the box
 * it is against. It is the *window* now, so the sentence runs out over the
 * editor the way a tooltip is supposed to, and "does it fit" stopped being a
 * question about a 40px column.
 *
 * Three rules, in order:
 *
 * - **The preferred side**, which is about the row and not about the window:
 *   beside a glyph, or under a line of text. See `TooltipSide`.
 * - **Flip** when that side has no room — to the other side of the anchor,
 *   not to a squeezed version of the same side. A tooltip is one rectangle
 *   with one width, and narrowing it to fit is how a sentence becomes a
 *   ribbon.
 * - **Clamp** to the window, which is the last word. A flip can still land
 *   out of bounds when the anchor is itself near an edge, and off-window is
 *   the one result that is never readable.
 *
 * The cross-axis is aligned with the anchor's leading edge and then clamped,
 * so a tooltip beside a row starts level with that row — the eye has one line
 * to follow from the glyph to the words.
 */
export function tooltipRect(
	windowSize: LayoutSize,
	placement: TooltipPlacement,
): LayoutRect {
	const { anchor, prefer, size } = placement;
	// Never wider or taller than the window itself: everything below is
	// about *where* it goes, and a rectangle bigger than the window has no
	// position that is inside it.
	const width = Math.min(Math.round(size.width), windowSize.width);
	const height = Math.min(Math.round(size.height), windowSize.height);
	const lastX = Math.max(0, windowSize.width - width - TOOLTIP_MARGIN);
	const lastY = Math.max(0, windowSize.height - height - TOOLTIP_MARGIN);

	if (prefer === "right") {
		const right = anchor.x + anchor.width + TOOLTIP_GAP;
		// Flipped to the anchor's leading side when the trailing side would
		// run past the window's edge.
		const x = right > lastX ? anchor.x - TOOLTIP_GAP - width : right;
		return {
			x: clamp(x, TOOLTIP_MARGIN, lastX),
			y: clamp(anchor.y, TOOLTIP_MARGIN, lastY),
			width,
			height,
		};
	}
	const below = anchor.y + anchor.height + TOOLTIP_GAP;
	// Flipped above the row when there is no room under it — the last row's
	// tooltip is as readable as the first's.
	const y = below > lastY ? anchor.y - TOOLTIP_GAP - height : below;
	return {
		x: clamp(anchor.x, TOOLTIP_MARGIN, lastX),
		y: clamp(y, TOOLTIP_MARGIN, lastY),
		width,
		height,
	};
}

/**
 * Which workbench is on screen, if any.
 *
 * A workbench waiting for an answer outranks the selection: the question is
 * about *that* workbench, and answering "do you want to save?" against a blank
 * pane — or against another workspace — is not an arrangement anybody can act
 * on. It outranks the arrangement too, so a question asked by a workbench the
 * person has navigated away from is still shown against the thing it is about.
 */
export function onScreenEditor(input: LayoutInput): string | undefined {
	if (input.asking !== undefined && input.editors.includes(input.asking)) {
		return input.asking;
	}
	const surface = input.state.surface;
	if (surface.kind !== "editor" && surface.kind !== "split") return undefined;
	return input.editors.includes(surface.editorKey)
		? surface.editorKey
		: undefined;
}

/**
 * Which child the keys go to — by identity, not by contents.
 *
 * A standing question owns the keyboard for as long as it stands; it is on top
 * of everything and taking focus out of it would leave a dialog on screen that
 * no key reaches. Otherwise it is the workbench on screen, unless the page has
 * put something of its own over the same rectangle.
 */
export function keyboardChild(input: LayoutInput): ChildIdentity {
	if (input.picker !== "none") return { kind: "picker" };
	if (input.asking !== undefined && input.editors.includes(input.asking)) {
		return { kind: "editor", editorKey: input.asking };
	}
	if (input.state.keyboard === "sidebar") return { kind: "sidebar" };
	if (input.state.keyboard === "agents") {
		// Only where there is one to type into. An Agent's view is drawn for an
		// `agent` or a `split` arrangement and for nothing else, and handing
		// the keys to a view that is not in the window is the invisible-focus
		// bug this whole redesign exists to end — so anything else falls to
		// the window's own page, which is always there.
		return agentsVisible(input.state) ? { kind: "agents" } : { kind: "shell" };
	}
	const editorKey = onScreenEditor(input);
	return editorKey === undefined
		? { kind: "shell" }
		: { kind: "editor", editorKey };
}

/** Whether an Agent is drawn at all: over the content area, or beside it. */
function agentsVisible(state: LayoutState): boolean {
	return state.surface.kind === "agent" || state.surface.kind === "split";
}

/**
 * The window's children, in the order they are stacked.
 *
 * The order *is* the z-order, lowest first: the window's own page, the
 * Sidebar, then every workbench with the one on screen last among them, then
 * the Agents, then the notices, then the questions, then the tooltip. A
 * notice about the application is above the thing it is about, a question is
 * above the notice, and the tooltip is above all of them because it is the
 * only child that neither takes a click nor hides anything. Nothing in this
 * list is conditional on anything but content: `toasts`, `picker` and
 * `tooltip` are in it exactly when they have something to draw, because a
 * layer that is not there cannot take a click.
 *
 * `sidebar` and `agents` are always in it, because both exist for the life of
 * the window and neither is ever a layer over anything: they are columns
 * beside the workbench, so their being present costs nothing and their
 * ordering against each other never comes up.
 */
export function windowLayout(input: LayoutInput): readonly LayoutChild[] {
	const { windowSize, state } = input;
	const shellRect: LayoutRect = {
		x: 0,
		y: 0,
		width: windowSize.width,
		height: windowSize.height,
	};
	const editorRect = workbenchRect(windowSize, state);
	const onScreen = onScreenEditor(input);

	const children: LayoutChild[] = [
		{ identity: { kind: "shell" }, rect: shellRect, visible: true },
		// Always there, and always under everything else that is drawn over
		// the content area: the Sidebar is the one child that is never covered
		// and never absent, so nothing above it in this list can be wrong
		// about it. Collapsed it is a rail rather than gone — `collapsed` is a
		// width, not a visibility.
		{
			identity: { kind: "sidebar" },
			rect: sidebarRect(windowSize, state),
			visible: true,
		},
	];
	// Every workbench is sized, whether or not it is drawn: a view that is
	// shown at the size it had when it was last hidden lays itself out against
	// that size first, and VS Code reflows visibly when it catches up.
	for (const editorKey of input.editors) {
		if (editorKey === onScreen) continue;
		children.push({
			identity: { kind: "editor", editorKey },
			rect: editorRect,
			visible: false,
		});
	}
	if (onScreen !== undefined) {
		children.push({
			identity: { kind: "editor", editorKey: onScreen },
			rect: editorRect,
			visible: true,
		});
	}
	// One view for every Agent there is, showing the selected one. It is drawn
	// exactly when a workbench is not — or beside one, which is what a split
	// is — so "one of {the Agents, a workbench} is on the content area" is a
	// property of this list rather than a rule somebody has to keep.
	children.push({
		identity: { kind: "agents" },
		rect: agentsRect(windowSize, state),
		visible: agentsVisible(state),
	});
	if (input.toasts && input.toasts.width > 0 && input.toasts.height > 0) {
		children.push({
			identity: { kind: "toasts" },
			rect: toastsRect(windowSize, input.toasts),
			visible: true,
		});
	}
	if (input.picker !== "none") {
		children.push({
			identity: { kind: "picker" },
			// A workbench's question covers that workbench and nothing else, so
			// the Sidebar and every other workspace stay visible *and*
			// clickable. Everything else is the application asking.
			rect: input.picker === "workbench" ? editorRect : shellRect,
			visible: true,
		});
	}
	// Above everything, the questions included. Not because a tooltip may
	// stand over a modal — it may not, and in practice cannot: a question
	// covers the window, which takes the pointer off the row that raised the
	// tooltip, and the page hides it before the sheet is drawn. It is on top
	// because it is the one child that is never anything but a few words to
	// read: it takes no click (it is never in the list unless it has
	// something to say, and what it says is the size of what it draws), it
	// takes no keys, and nothing is ever meant to be seen *through* it. A
	// layer with nothing behind it to protect is a layer with no reason to be
	// underneath anything.
	if (input.tooltip) {
		children.push({
			identity: { kind: "tooltip" },
			rect: tooltipRect(windowSize, input.tooltip),
			visible: true,
		});
	}
	return children;
}

export function sameRect(left: LayoutRect, right: LayoutRect): boolean {
	return (
		left.x === right.x &&
		left.y === right.y &&
		left.width === right.width &&
		left.height === right.height
	);
}

export function sameIdentity(
	left: ChildIdentity,
	right: ChildIdentity,
): boolean {
	if (left.kind !== right.kind) return false;
	return left.kind !== "editor" || right.kind !== "editor"
		? true
		: left.editorKey === right.editorKey;
}

//#region reconciling the child list against the projection

/**
 * What the owner has to do to the child list for the projection to be true.
 *
 * The list of workbenches used to be decided inside the open path itself —
 * a hundred lines of interleaved judgement about wanted sets, supervisor
 * verdicts, ordering and backoff. Split in two, the part that is a *decision*
 * is this pure function and the part that is *state* stays with the supervisor
 * and the timers, which are passed in as answers rather than asked here.
 *
 * `create` is ordered with the selected workbench first, because that is the
 * one somebody is waiting for; the rest follow in the projection's own order.
 */
export interface EditorReconcileInput {
	/** Every folder the projection says should have a workbench. */
	readonly wanted: readonly string[];
	/** Every folder that has one now. */
	readonly existing: readonly string[];
	/** The workbench the selection resolves to, if any. */
	readonly selected: string | undefined;
	/** Folders the supervisor has stopped trying for. */
	readonly gaveUp: readonly string[];
	/** Folders parked by the supervisor — given up on, and no longer wanted. */
	readonly parked: readonly string[];
	/** Folders waiting out a restart backoff. */
	readonly waiting: readonly string[];
}

export interface EditorReconcilePlan {
	/** Folders to open a workbench for, the selected one first. */
	readonly create: readonly string[];
	/** Folders whose workbench is to be destroyed. */
	readonly dispose: readonly string[];
	/**
	 * Folders whose give-up is to be held rather than acted on again.
	 *
	 * A Workspace whose workbench was given up on becomes `unavailable`, which
	 * takes it out of `wanted`: the verdict is parked so that the count is not
	 * lost, and forgotten when a person brings the folder back with Retry or
	 * Locate…. "Was out, and is back" is exactly "a person asked again", read
	 * off the projection rather than hooked onto the intent.
	 */
	readonly park: readonly string[];
	readonly forget: readonly string[];
}

export function reconcileEditors(
	input: EditorReconcileInput,
): EditorReconcilePlan {
	const wanted = new Set(input.wanted);
	const parked = new Set(input.parked);
	const waiting = new Set(input.waiting);
	const gaveUp = new Set(input.gaveUp);

	const dispose = input.existing.filter((folder) => !wanted.has(folder));
	const park = input.gaveUp.filter(
		(folder) => !wanted.has(folder) && !parked.has(folder),
	);
	const forget = input.gaveUp.filter(
		(folder) => wanted.has(folder) && parked.has(folder),
	);
	// A folder the supervisor has given up on, and one whose restart is waiting
	// out its backoff, are both already answered. Asking again here is what
	// turned a bounded supervisor into a retry per projection tick — which
	// after a wake is the reconcile cadence, and which is what flickered.
	// A verdict being forgotten in this same pass is a person having asked
	// again, so it is not one of those.
	const openable = input.wanted.filter(
		(folder) =>
			!waiting.has(folder) && (!gaveUp.has(folder) || forget.includes(folder)),
	);
	const create =
		input.selected === undefined || !openable.includes(input.selected)
			? openable
			: [
					input.selected,
					...openable.filter((folder) => folder !== input.selected),
				];
	return { create, dispose, park, forget };
}

//#endregion
