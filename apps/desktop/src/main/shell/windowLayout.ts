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
/** `--sidebar-rail-width`: the inset the glyph column hangs off, each side. */
const SIDEBAR_RAIL_WIDTH = 14;
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
}

export type ChildIdentity =
	| { readonly kind: "shell" }
	| { readonly kind: "sidebar" }
	| { readonly kind: "agents" }
	| { readonly kind: "editor"; readonly editorKey: string }
	| { readonly kind: "toasts" }
	| { readonly kind: "picker" };

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
		: SIDEBAR_GLYPH_WIDTH[state.density] + 2 * SIDEBAR_RAIL_WIDTH;
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
 * The Sidebar's own rectangle: the leading column, under the bar if there is
 * one.
 *
 * The bar is not part of it. DevHub's title bar spans the whole window above
 * both columns and it is the window's drag handle, and a drag region is a
 * rectangle Electron hands to macOS rather than a hit test the page performs —
 * so it stays on the window's own page, which is under every child and is the
 * one surface no child is laid over. With `hidden` there is no bar, the
 * Sidebar carries the traffic lights itself, and this rectangle is the whole
 * height of the window; that is the arrangement the rail's floor exists for
 * (see `sidebarColumnWidth`).
 */
export function sidebarRect(
	windowSize: LayoutSize,
	state: LayoutState,
): LayoutRect {
	const bar = state.titleBar === "shown" ? TITLE_BAR_HEIGHT + HAIRLINE : 0;
	return {
		x: 0,
		y: bar,
		width: sidebarColumnWidth(state),
		height: Math.max(0, windowSize.height - bar),
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
 * the Agents, then the notices, then the questions. A notice about the
 * application is above the thing it is about, and a question is above the
 * notice. Nothing in this list is conditional on anything but content:
 * `toasts` and `picker` are in it exactly when they have something to draw,
 * because a layer that is not there cannot take a click.
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
