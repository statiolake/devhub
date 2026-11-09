/**
 * Where everything in the one window is, decided in one place.
 *
 * The window is a tree of `WebContentsView` children over one rectangle: the
 * App Shell page, one editor area per Workspace, the notices, the questions.
 * Every one of them needs a rectangle, a visibility and a place in the child
 * list, and those three answers have to agree with each other — a view shown
 * under another one is invisible for no visible reason, and a view sized after
 * it is shown wears its previous size for a frame.
 *
 * So there is one function that answers all three, and it is pure. It takes
 * the projection, the window's size and the two appearance settings that move
 * the chrome, and it returns the child list. Nothing measures anything: the
 * numbers below are the window's own, and the page is *given* the rectangle it
 * leaves for the editor rather than asked for it. That is the whole of what
 * this module exists to end — the page used to measure a hole it does not draw
 * and report it back, so main's idea of the layout was a page's idea of the
 * layout, one frame late, and a resize was a round trip.
 *
 * # The numbers
 *
 * They are the counterparts of the tokens in `shell/styles/tokens.css`, and
 * they are named after them. Both spellings exist because a stylesheet cannot
 * be read from main and main cannot lay out a flexbox; what stops them
 * drifting is that the page draws the editor's hole at the width *this*
 * module computed, so a disagreement about the sidebar is a disagreement about
 * a number neither side is free to invent.
 *
 * The window's own two — the title bar's height and the lights' span — are not
 * spelled twice at all. They are facts about the native window rather than
 * about any page, so they are said here once and every page is *told* them:
 * `chromeVariables` is written into each page's `<head>` as it is served
 * (`shellPageProtocol.ts`), and the stylesheets only read them.
 */

import type { TitleBarMode } from "../../model/config.js";
import {
	placeTerminal,
	placeTerminalBelow,
	type TerminalPlacement,
} from "../../model/agentTerminal.js";

/**
 * `--titlebar-height`: the band the traffic lights sit in, either chrome.
 *
 * A plain titled macOS window's own bar, measured rather than remembered: on
 * macOS 26 an `NSWindow` with `.titled` has a 32pt title bar with 14pt lights
 * whose frames start 9pt from the top and 9pt from the leading edge. (It was
 * 28pt before Tahoe; the number is the system's, not a taste.) DevHub's bar is
 * that bar, and the lights are placed from it — see `trafficLightPosition`.
 */
const TITLE_BAR_HEIGHT = 32;
/**
 * One traffic light's frame, square. Measured with the bar above: it is what
 * the lights' centre is worked out from, so it is the only other number the
 * placement is allowed to have.
 */
const TRAFFIC_LIGHT_SIZE = 14;
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
 * the bar shown the hole starts at y 33, not 32.)
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
 * cannot: outside this strip the pointer belongs to the editor or to the
 * Agent, so a grab area wider than the strip is a grab area that is silently
 * not there. The strip is the honest width instead.
 */
const SPLIT_DIVIDER = 6;
/**
 * `--sidebar-overlay-shadow`: the room past the floating Sidebar's trailing
 * edge that its shadow is drawn in.
 *
 * Compact mode's overlay is the rail growing to the right, the way a
 * browser's vertical tab bar floats its full width over the page while the
 * pointer is on the strip: the same left edge and the same top as the rail,
 * so nothing in it moves but its trailing edge. The shadow is the page's own
 * paint on that edge, so it has to be inside the view — and every pixel of a
 * view takes the pointer, transparent or not: a `WebContentsView` has no
 * hit-test region of its own. So this is exactly what the shadow needs and no
 * more: the page's shadow (`--sidebar-overlay-elevation` in
 * `sidebarPage.css`) is held to it by a test, and a press in it closes the
 * overlay at once (`useSidebarOverlay.ts`).
 */
const SIDEBAR_OVERLAY_SHADOW = 24;
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
 * Deliberately not "is an editor visible": `agent` and `none` are both "no
 * editor on screen" and they are different states of the page, and `split`
 * is an editor that is on screen *beside* something else. The page used to
 * answer this with one word over IPC (`ContentSurfaceWire`); it is the same
 * question, asked of the model where the answer already lives.
 *
 * The editor area is the Workspace's terminal page, with the Neovims in it
 * drawn over their panes (`docs/neovim-editor.md`).
 */
export type SurfaceArrangement =
	/** One Workspace's editor area, the whole content area. */
	| {
			readonly kind: "editor";
			readonly editorKey: string;
	  }
	/** An editor area and an Agent's pane, split at `ratio` of the area. */
	| {
			readonly kind: "split";
			readonly editorKey: string;
			readonly ratio: number;
	  }
	/** An Agent over the whole area: the editor areas stay built, none shown. */
	| { readonly kind: "agent" }
	/** Nothing to show — starting, or a folder that is gone. */
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
 * not the editor was one document. `page` named the Sidebar and the Agent's
 * pane at once, and the page then sorted out which of them it meant — which is
 * the whole of what `focusHome.ts` was. Both are children of the window now,
 * so the answer names one of them.
 */
export type KeyboardHalf =
	| "editor"
	| "agents"
	| "sidebar"
	/** The Agent's terminal, beside it (`model/agentTerminal.ts`). */
	| { readonly terminal: string };

/** Everything about the arrangement that is not the window's own size. */
export interface LayoutState {
	readonly titleBar: TitleBarMode;
	readonly density: SidebarDensity;
	readonly sidebar: {
		readonly width: number;
		readonly collapsed: boolean;
		/**
		 * The page is floating the expanded Sidebar over the content: compact
		 * mode under the pointer, or the moment it lands as compact mode is
		 * turned off (`useSidebarOverlay.ts`). Only the Sidebar's own view
		 * moves for it — see `sidebarRect` — and absent is no overlay.
		 */
		readonly overlay?: boolean;
	};
	readonly surface: SurfaceArrangement;
	readonly keyboard: KeyboardHalf;
	/**
	 * The Agent terminal drawn with the Agent `surface` shows, and the share
	 * it takes: of the content width right of a full Agent, or of the split's
	 * right half's height under its Agent. Absent is no terminal; the
	 * editor alone shows no Agent and so never one. See
	 * `model/agentTerminal.ts`.
	 */
	readonly terminal?: { readonly terminalId: string; readonly share: number };
	/**
	 * The Agent on screen is a GUI Agent, whose conversation the
	 * Conversations view draws rather than the Agents view: over the Agents'
	 * whole rectangle (`whole`), or right of the Orchestrator's board, which
	 * the Agents view goes on drawing (`beside-board`). Absent, the Agents
	 * view is the Agent's: a terminal Agent, the board alone, or none.
	 *
	 * Two renderers, so that a conversation being drawn — a long transcript
	 * is seconds of a renderer's thread — never holds the terminal Agents'
	 * keys (docs/process-model.md, phase 6).
	 */
	readonly conversation?: "whole" | "beside-board";
}

export interface LayoutInput {
	readonly windowSize: LayoutSize;
	readonly state: LayoutState;
	/** How big the notices are, as the page measured its own stack. */
	readonly toasts: LayoutSize | undefined;
	/** Whether a question is standing: it covers the window. */
	readonly picker: boolean;
	/** The tooltip that is up, if one is. See `TooltipPlacement`. */
	readonly tooltip: TooltipPlacement | undefined;
	/**
	 * Every Agent terminal that has a view, by id, whichever Agent it is.
	 * Optional so that every caller from before terminal panes still reads;
	 * absent is none.
	 */
	readonly terminals?: readonly string[];
	/**
	 * The Neovim editor: every Workspace's terminal page (its editor area)
	 * that has a view, by its Workspace's editor key, drawn in the editor's
	 * rectangle — the whole content area, or a split's left half. See
	 * `docs/neovim-editor.md`. Optional so that every caller from before it
	 * still reads; absent is none.
	 */
	readonly neovims?: readonly string[];
}

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
	readonly size: LayoutSize;
}

export type ChildIdentity =
	| { readonly kind: "shell" }
	| { readonly kind: "sidebar" }
	| { readonly kind: "agents" }
	/** The GUI Agents' conversations, laid where the Agents view is. */
	| { readonly kind: "conversations" }
	/** An Agent's terminal, with its Agent — see `model/agentTerminal.ts`. */
	| { readonly kind: "terminal"; readonly terminalId: string }
	/**
	 * The Neovim editor's area for a Workspace: its terminal page, the
	 * Neovims over its panes placed with it (`docs/neovim-editor.md`).
	 */
	| { readonly kind: "neovim"; readonly editorKey: string }
	| { readonly kind: "toasts" }
	| { readonly kind: "picker" }
	| { readonly kind: "tooltip" };

export interface LayoutChild {
	readonly identity: ChildIdentity;
	readonly rect: LayoutRect;
	readonly visible: boolean;
}

/**
 * Where the window's traffic lights go: centred in the title bar, and as far
 * from the leading edge as from the top.
 *
 * Derived, never tuned. Electron centres the lights in a band of their own
 * height plus twice `y`, so `y` is what puts their middle on the bar's middle
 * line — the bar's height changes and they follow. `x` is the same inset,
 * which is where a plain titled window keeps them (9pt each way on a 32pt
 * bar). Left to `hiddenInset` alone they sat at Electron's fixed (12, 11),
 * which centred them in a 36pt band under a 38pt bar: a pixel high, and a
 * second number nobody here owned.
 */
export function trafficLightPosition(): { x: number; y: number } {
	const inset = (TITLE_BAR_HEIGHT - TRAFFIC_LIGHT_SIZE) / 2;
	return { x: inset, y: inset };
}

/**
 * The window's chrome geometry as the custom properties the pages read.
 *
 * Every page is served with these in its `<head>` (`shellPageProtocol.ts`),
 * which is how a page knows how tall the bar is without keeping a copy of the
 * number: `tokens.css` reads `--titlebar-height` and `--traffic-light-span`
 * and declares neither.
 */
export function chromeVariables(): ReadonlyArray<readonly [string, string]> {
	return [
		["--titlebar-height", `${TITLE_BAR_HEIGHT}px`],
		["--traffic-light-span", `${TRAFFIC_LIGHT_SPAN}px`],
		["--sidebar-overlay-shadow", `${SIDEBAR_OVERLAY_SHADOW}px`],
	];
}

/**
 * How wide the Sidebar's column is, hairline included.
 *
 * Collapsed it is a rail, and how wide a rail may be is a fact about the
 * *window*: with no title bar of DevHub's own the Sidebar carries the traffic
 * lights, and a rail narrower than their span would put the close button on a
 * editor. With a bar above it the lights are up there and the rail is only
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
 * narrower than their span would put the close button on an editor.
 *
 * **The overlay is the one time this is not the column.** While the page
 * floats the expanded Sidebar over the content (`state.sidebar.overlay`), the
 * view is widened to the card it draws — the expanded width from the same
 * left edge, and the room its shadow takes — and nothing else moves: the content area is
 * still laid out from `sidebarColumnWidth`, which an overlay does not change,
 * so the editor and the Agent keep their rectangles to the pixel. The view
 * is sized to the card and not to the window because every pixel of a view
 * takes the pointer, transparent or not; the card is all that should.
 */
export function sidebarRect(
	windowSize: LayoutSize,
	state: LayoutState,
): LayoutRect {
	const band =
		state.titleBar === "shown" ? TITLE_BAR_HEIGHT + HAIRLINE : TITLE_BAR_HEIGHT;
	const column = sidebarColumnWidth(state);
	const width =
		state.sidebar.overlay === true
			? Math.max(
					column,
					Math.min(
						windowSize.width,
						Math.round(state.sidebar.width) + SIDEBAR_OVERLAY_SHADOW,
					),
				)
			: column;
	return {
		x: 0,
		y: band,
		width,
		height: Math.max(0, windowSize.height - band),
	};
}

/**
 * Where the Sidebar's visible trailing edge is, in the window: the docked
 * column's or the rail's width, or — while it floats — the card's full width.
 *
 * The card's *full* width even while it is still growing out of the rail: a
 * tooltip placed against it is outside the card in every frame of the growth
 * rather than overtaken by it, and it is already where the edge comes to
 * rest. A tooltip is only ever about a row in this column, so this is the line
 * no tooltip may be placed across (`tooltipRect`).
 */
export function sidebarTrailingEdge(
	windowSize: LayoutSize,
	state: LayoutState,
): number {
	const column = sidebarColumnWidth(state);
	if (state.sidebar.overlay !== true) return column;
	return Math.max(
		column,
		Math.min(windowSize.width, Math.round(state.sidebar.width)),
	);
}

/**
 * Whether a pointer at `point` (window coordinates) is still somewhere the
 * floating Sidebar belongs to: on the card — the rail is its leading part —
 * or on the tooltip one of its rows raised, which is its own view beside it.
 *
 * Asked by the Sidebar's page when the pointer has left its document and the
 * grace is up (`useSidebarOverlay.ts`). The page cannot answer it: a pointer
 * that went onto the tooltip, or out of a window that is not in front, looks
 * exactly the same from inside the page as a pointer that went away. Main
 * reads the cursor instead of trusting a leave event across view boundaries.
 * The room the shadow is drawn in is *not* the card: a pointer there has
 * left.
 */
export function sidebarOverlayHolds(
	point: { readonly x: number; readonly y: number },
	windowSize: LayoutSize,
	state: LayoutState,
	tooltip: TooltipPlacement | undefined,
): boolean {
	const view = sidebarRect(windowSize, state);
	const card: LayoutRect = {
		...view,
		width: Math.min(view.width, Math.round(state.sidebar.width)),
	};
	if (within(point, card)) return true;
	return (
		tooltip !== undefined &&
		within(
			point,
			tooltipRect(windowSize, tooltip, sidebarTrailingEdge(windowSize, state)),
		)
	);
}

function within(
	point: { readonly x: number; readonly y: number },
	rect: LayoutRect,
): boolean {
	return (
		point.x >= rect.x &&
		point.x < rect.x + rect.width &&
		point.y >= rect.y &&
		point.y < rect.y + rect.height
	);
}

/**
 * Where the Agent and its terminal go in the window, when one is shown.
 *
 * The terminal is only ever on screen with its Agent, so where it goes is
 * where the Agent is. A full Agent gives it its share of the content area
 * (`surfaceRect`) on the right; a split's Agent — the right half — gives it
 * its share of that half's height at the bottom, the editor keeping the whole
 * left half. Either way the seam is as wide as the editor/Agent split's
 * own, for the same reason: a seam is the strip no view covers, which is the
 * only place the window's own page can draw a divider the pointer can grab.
 * The editor alone has no Agent and so no terminal. With nothing in the
 * content area — starting, an editor being rebuilt, a folder that is gone —
 * the page's own state fills the whole of it, and the terminal waits hidden
 * rather than framing an empty room.
 */
export function terminalPlacement(
	windowSize: LayoutSize,
	state: LayoutState,
): TerminalPlacement | undefined {
	const extent = terminalExtent(windowSize, state);
	if (extent === undefined || state.terminal === undefined) return undefined;
	return (terminalStacked(state) ? placeTerminalBelow : placeTerminal)(
		extent,
		state.terminal.share,
		SPLIT_DIVIDER,
	);
}

/**
 * What the terminal shares with its Agent — the rectangle its divider's share
 * is a share of: the whole content area beside a full Agent, a split's right
 * half under its Agent. Nothing when no terminal is on screen.
 */
export function terminalExtent(
	windowSize: LayoutSize,
	state: LayoutState,
): LayoutRect | undefined {
	if (state.terminal === undefined) return undefined;
	if (state.surface.kind === "agent") return surfaceRect(windowSize, state);
	if (state.surface.kind === "split") return splitAgentHalf(windowSize, state);
	return undefined;
}

/** Whether the terminal on screen is under its Agent rather than right of it. */
export function terminalStacked(state: LayoutState): boolean {
	return state.surface.kind === "split";
}

/**
 * The selection's own pane: the content area, less the terminal right of a
 * full Agent. Everything the selection draws — the editor, the Agent, the
 * two side by side — is laid inside this; a split's terminal is inside the
 * Agent's half instead (`agentsRect`).
 */
export function contentRect(
	windowSize: LayoutSize,
	state: LayoutState,
): LayoutRect {
	const placement =
		state.surface.kind === "agent"
			? terminalPlacement(windowSize, state)
			: undefined;
	return placement?.content ?? surfaceRect(windowSize, state);
}

/** The seam between the Agent and its terminal, for the window's own page. */
export function terminalSeam(
	windowSize: LayoutSize,
	state: LayoutState,
): LayoutRect | undefined {
	return terminalPlacement(windowSize, state)?.seam;
}

/**
 * The rectangle the Agents' view is laid into.
 *
 * The whole content area when an Agent covers it (less its terminal on the
 * right), and the trailing share of it when one is open beside its editor —
 * the editor's rectangle, the seam, and then this, less its terminal at
 * the bottom. The seam itself belongs to neither: it is a real element on
 * the window's own page, in the one strip no child covers, which is what keeps
 * the pixels the pointer meets and the pixels the eye sees the same pixels.
 *
 * Computed whether or not an Agent is on screen, for the same reason a
 * editor is: a view shown at the size it had when it was last hidden lays
 * itself out against that size first, and an xterm reflows visibly when it
 * catches up.
 */
export function agentsRect(
	windowSize: LayoutSize,
	state: LayoutState,
): LayoutRect {
	if (state.surface.kind !== "split") return contentRect(windowSize, state);
	return (
		terminalPlacement(windowSize, state)?.content ??
		splitAgentHalf(windowSize, state)
	);
}

/**
 * How wide the Orchestrator's board is in an Agents view `width` wide: its
 * `width: clamp(380px, 46%, 720px)` in `shell/agents/orchestrator.css`,
 * which this has to say the same as.
 */
export function orchestratorBoardWidth(width: number): number {
	return Math.round(Math.min(720, Math.max(380, width * 0.46)));
}

/**
 * The rectangle the Conversations view is laid into: the Agents' own, or
 * the part of it right of the Orchestrator's board.
 */
export function conversationsRect(
	windowSize: LayoutSize,
	state: LayoutState,
): LayoutRect {
	const agents = agentsRect(windowSize, state);
	if (state.conversation !== "beside-board") return agents;
	const board = Math.min(agents.width, orchestratorBoardWidth(agents.width));
	return { ...agents, x: agents.x + board, width: agents.width - board };
}

/** A split's whole right half: the Agent, and its terminal under it if any. */
function splitAgentHalf(
	windowSize: LayoutSize,
	state: LayoutState,
): LayoutRect {
	const surface = contentRect(windowSize, state);
	const editor = workbenchRect(windowSize, state);
	const x = editor.x + editor.width + SPLIT_DIVIDER;
	return {
		...surface,
		x,
		width: Math.max(0, surface.x + surface.width - x),
	};
}

/**
 * The rectangle the editor area is laid into — the hole the page leaves.
 *
 * The whole content area, or the leading share of it when an Agent is beside
 * it. It is computed here whether or not an editor is on screen, because the
 * page draws its own states in the same rectangle and both have to be the
 * same rectangle.
 */
export function workbenchRect(
	windowSize: LayoutSize,
	state: LayoutState,
): LayoutRect {
	const surface = contentRect(windowSize, state);
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
 * The most room a tooltip may take in this window: all of it, less the margin
 * `tooltipRect` keeps from each edge.
 *
 * Told to the page with the facts (`TooltipContentWire.room`), so a box that
 * would not fit wraps to this width and stops at this height *on the page*.
 * Clamping only here, after the page measured, would make the view smaller
 * than what it draws, and the difference is the scrollbar the view's own
 * document shows for it.
 */
export function tooltipRoom(windowSize: LayoutSize): LayoutSize {
	return {
		width: Math.max(0, windowSize.width - 2 * TOOLTIP_MARGIN),
		height: Math.max(0, windowSize.height - 2 * TOOLTIP_MARGIN),
	};
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
 * **Beside the row, and never under it.** The rows are stacked, so a box under
 * one is a box over the next: the thing a person's pointer is already moving
 * towards is covered by the answer to what they just pointed at, and they have
 * to dodge it to click. Out to the side there is an editor, which is the one
 * direction in this window with room to spare. It used to be a question the
 * row answered — beside a glyph on the rail, under a line of text in the
 * expanded column — and the expanded column's answer was the one that covered
 * the next row.
 *
 * Two rules, in order:
 *
 * - **Flip** to the anchor's leading side when the trailing side has no room —
 *   not to a squeezed version of the same side. A tooltip is one rectangle
 *   with one width, and narrowing it to fit is how a sentence becomes a
 *   ribbon.
 * - **Clamp** to the window, which is the last word. A flip can still land out
 *   of bounds when the anchor is itself near an edge, and off-window is the
 *   one result that is never readable. A box too wide for either side of the
 *   row ends against the window's trailing edge, still beside the row.
 *
 * The cross-axis is the anchor's own top, clamped, so the box starts level
 * with the row and the eye has one line to follow from the mark to the words.
 * A row near the foot of the window moves the box *up* — it is the only
 * direction the clamp can move it — so nothing is ever placed below the row
 * it is about.
 *
 * **Outside the Sidebar, and never over its rows.** Given the Sidebar's
 * visible trailing edge (`column`, see `sidebarTrailingEdge`), the box starts
 * past it, whatever inside the row it is about — an Issue mark half way along
 * a row used to put its sentence over the rest of that row and the rows below.
 * There is no flip then: the leading side is the rows. Only the window's own
 * edge can bring it back over them, in a window too narrow for both.
 */
export function tooltipRect(
	windowSize: LayoutSize,
	placement: TooltipPlacement,
	column?: number,
): LayoutRect {
	const { anchor, size } = placement;
	// Never wider or taller than the window itself: everything below is
	// about *where* it goes, and a rectangle bigger than the window has no
	// position that is inside it.
	const width = Math.min(Math.round(size.width), windowSize.width);
	const height = Math.min(Math.round(size.height), windowSize.height);
	const lastX = Math.max(0, windowSize.width - width - TOOLTIP_MARGIN);
	const lastY = Math.max(0, windowSize.height - height - TOOLTIP_MARGIN);

	if (column !== undefined) {
		return {
			x: clamp(
				Math.max(anchor.x + anchor.width, column) + TOOLTIP_GAP,
				TOOLTIP_MARGIN,
				lastX,
			),
			y: clamp(anchor.y, TOOLTIP_MARGIN, lastY),
			width,
			height,
		};
	}
	const right = anchor.x + anchor.width + TOOLTIP_GAP;
	// Flipped to the anchor's leading side when the trailing side would run
	// past the window's edge.
	const x = right > lastX ? anchor.x - TOOLTIP_GAP - width : right;
	return {
		x: clamp(x, TOOLTIP_MARGIN, lastX),
		y: clamp(anchor.y, TOOLTIP_MARGIN, lastY),
		width,
		height,
	};
}

/** Which Workspace's terminal is in the editor area, if any. */
export function onScreenNeovim(input: LayoutInput): string | undefined {
	const surface = input.state.surface;
	if (surface.kind !== "editor" && surface.kind !== "split") return undefined;
	return (input.neovims ?? []).includes(surface.editorKey)
		? surface.editorKey
		: undefined;
}

/**
 * What is in the editor area as a child the keyboard can go to: the
 * terminal page the Neovim editor's area shows.
 */
function editorChild(input: LayoutInput): ChildIdentity | undefined {
	const terminalKey = onScreenNeovim(input);
	return terminalKey === undefined
		? undefined
		: { kind: "neovim", editorKey: terminalKey };
}

/**
 * Which child the keys go to — by identity, not by contents.
 *
 * A standing question owns the keyboard for as long as it stands; it is on top
 * of everything and taking focus out of it would leave a dialog on screen that
 * no key reaches. Otherwise it is the editor on screen, unless the page has
 * put something of its own over the same rectangle.
 */
export function keyboardChild(input: LayoutInput): ChildIdentity {
	if (input.picker) return { kind: "picker" };
	if (input.state.keyboard === "sidebar") return { kind: "sidebar" };
	const keyboard = input.state.keyboard;
	if (typeof keyboard === "object") {
		// Only a terminal that is on screen: one whose view exists, in the
		// tiling that is drawn. Anything else falls to what the selection
		// would have had, rather than to a view nobody can see.
		const placed =
			(input.terminals ?? []).includes(keyboard.terminal) &&
			input.state.terminal?.terminalId === keyboard.terminal &&
			terminalPlacement(input.windowSize, input.state) !== undefined;
		if (placed) return { kind: "terminal", terminalId: keyboard.terminal };
		const editor = editorChild(input);
		if (editor !== undefined && input.state.surface.kind !== "agent") {
			return editor;
		}
		return agentsVisible(input.state)
			? agentChild(input.state)
			: { kind: "shell" };
	}
	if (input.state.keyboard === "agents") {
		// Only where there is one to type into. An Agent's view is drawn for an
		// `agent` or a `split` arrangement and for nothing else, and handing
		// the keys to a view that is not in the window is the invisible-focus
		// bug this whole redesign exists to end — so anything else falls to
		// the window's own page, which is always there.
		return agentsVisible(input.state)
			? agentChild(input.state)
			: { kind: "shell" };
	}
	return editorChild(input) ?? { kind: "shell" };
}

/** Which of the two views the Agent on screen is drawn in. */
function agentChild(state: LayoutState): ChildIdentity {
	return state.conversation === undefined
		? { kind: "agents" }
		: { kind: "conversations" };
}

/** Whether an Agent is drawn at all: over the content area, or beside it. */
function agentsVisible(state: LayoutState): boolean {
	return state.surface.kind === "agent" || state.surface.kind === "split";
}

/**
 * Where a layer waits while it has nothing to show: the size of the window,
 * overlapping it by one pixel — the bottom-right corner, which the window's
 * rounded corner does not draw.
 *
 * A layer is a child that draws over the others only while it has something
 * to say — the notices, the questions, the tooltip. None of them is ever taken
 * out of the window; each is either over it or parked here. Both halves were
 * measured to matter (an isolated instance, a CDP screencast of the layer's
 * own page, main's calls logged beside it):
 *
 * - Taken out of the window, the page is hidden, and a hidden page paints
 *   nothing. What it was told as it left — the empty set of sheets, no
 *   tooltip — was never drawn, so the layer's last frame still held the
 *   previous content and the next one opened on a frame of it: a question on
 *   the previous sheet, a tooltip on the previous row's sentence. Never yet
 *   in the window, the page is 0×0 and hidden, so the first one after launch
 *   waited for a first layout of the whole page before anything was drawn —
 *   the late sheet, and a first tooltip 140 ms behind its row where every
 *   later one took 5.
 * - Placed entirely outside the window, Chromium counts the view occluded and
 *   hides the page just the same (`visibilityState` went to `hidden` and the
 *   page stayed 0×0). One pixel inside keeps it visible.
 *
 * Parked here, the page's last frame is always what it was last told, laid
 * out at least as large as it will be shown, so bringing it over the window
 * is only a move — a notice or a tooltip is drawn at its page's origin, so
 * the smaller rectangle it is shown in is the corner of a frame already
 * drawn. The one pixel it covers is the one no click reaches, and an empty
 * layer's page has nothing under that pixel to answer a pointer.
 */
export function parkedRect(windowSize: LayoutSize): LayoutRect {
	return {
		x: windowSize.width - 1,
		y: windowSize.height - 1,
		width: windowSize.width,
		height: windowSize.height,
	};
}

/**
 * A layer's entry in the child list: over the window at `rect` while it has
 * something to show, parked while it has nothing. Always in the list — see
 * `parkedRect`. `visible` is whether it is over the window.
 */
function layer(
	identity: ChildIdentity,
	windowSize: LayoutSize,
	rect: LayoutRect | undefined,
): LayoutChild {
	return {
		identity,
		rect: rect ?? parkedRect(windowSize),
		visible: rect !== undefined,
	};
}

/**
 * The window's children, in the order they are stacked.
 *
 * The order *is* the z-order, lowest first: the window's own page, the
 * Sidebar, then every editor area with the one on screen last among them,
 * then the Agents, then the notices, then the questions, then the tooltip. A
 * notice about the application is above the thing it is about, a question is
 * above the notice, and the tooltip is above all of them because it is the
 * only child that neither takes a click nor hides anything. Nothing in this
 * list is conditional on anything but content, and not even that decides who
 * is *in* it: `toasts`, `picker` and `tooltip` are layers, always in it, over
 * the window exactly when they have something to draw and parked otherwise —
 * see `parkedRect`.
 *
 * `sidebar` and `agents` are always in it, because both exist for the life of
 * the window: they are columns beside the editor, so their being present
 * costs nothing and their ordering against each other never comes up. The one
 * exception is compact mode's floating Sidebar (`state.sidebar.overlay`),
 * which is over the content by definition — so for as long as it floats the
 * Sidebar is moved from the bottom of the stack to just under the layers.
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

	const sidebar: LayoutChild = {
		identity: { kind: "sidebar" },
		rect: sidebarRect(windowSize, state),
		visible: true,
	};
	const overlay = state.sidebar.overlay === true;
	const children: LayoutChild[] = [
		{ identity: { kind: "shell" }, rect: shellRect, visible: true },
		// Always there, and always under everything else that is drawn over
		// the content area: the Sidebar is the one child that is never covered
		// and never absent, so nothing above it in this list can be wrong
		// about it. Collapsed it is a rail rather than gone — `collapsed` is a
		// width, not a visibility. Floating, it is the exception, and it is
		// placed with the content instead (below).
		...(overlay ? [] : [sidebar]),
	];
	// The Neovim editor's terminal pages: every one sized whether or not it
	// is drawn, the one on screen last. A view that is shown at the size it
	// had when it was last hidden lays itself out against that size first,
	// and reflows visibly when it catches up.
	const onScreenNeovimKey = onScreenNeovim(input);
	for (const editorKey of input.neovims ?? []) {
		if (editorKey === onScreenNeovimKey) continue;
		children.push({
			identity: { kind: "neovim", editorKey },
			rect: editorRect,
			visible: false,
		});
	}
	if (onScreenNeovimKey !== undefined) {
		children.push({
			identity: { kind: "neovim", editorKey: onScreenNeovimKey },
			rect: editorRect,
			visible: true,
		});
	}
	// One view for every Agent there is, showing the selected one. It is drawn
	// exactly when an editor is not — or beside one, which is what a split
	// is — so "one of {the Agents, an editor} is on the content area" is a
	// property of this list rather than a rule somebody has to keep.
	//
	// Two views: the Agents view draws the terminal Agents and the
	// Orchestrator's board, the Conversations view the GUI Agents. Both are
	// always sized; the one with the Agent on screen is drawn — and both for
	// the Orchestrator with a GUI Agent, the conversation right of the board
	// and so above the Agents view.
	children.push({
		identity: { kind: "agents" },
		rect: agentsRect(windowSize, state),
		visible: agentsVisible(state) && state.conversation !== "whole",
	});
	children.push({
		identity: { kind: "conversations" },
		rect: conversationsRect(windowSize, state),
		visible: agentsVisible(state) && state.conversation !== undefined,
	});
	// Every Agent terminal that has a view: the one on screen at the right,
	// and every other one hidden at the content area's size, so that coming
	// back to its Agent is a move rather than a reflow. It is a tile beside
	// the editor and the Agent, never over them, so where it sits among
	// those two in the stack is never seen; above both and below every layer
	// is the one place that is right whatever they are.
	const placement = terminalPlacement(windowSize, state);
	for (const terminalId of input.terminals ?? []) {
		const shown =
			placement !== undefined && state.terminal?.terminalId === terminalId;
		children.push({
			identity: { kind: "terminal", terminalId },
			rect: shown ? placement.terminal : surfaceRect(windowSize, state),
			visible: shown,
		});
	}
	// The floating Sidebar is over the content — every editor area, the
	// Agents and the terminals — because that is what
	// floating means, and under every layer, because a notice, a question and
	// a tooltip are above everything that is the window's own.
	if (overlay) children.push(sidebar);
	children.push(
		layer(
			{ kind: "toasts" },
			windowSize,
			input.toasts && input.toasts.width > 0 && input.toasts.height > 0
				? toastsRect(windowSize, input.toasts)
				: undefined,
		),
	);
	// A question is the application asking, and covers the window.
	children.push(
		layer({ kind: "picker" }, windowSize, input.picker ? shellRect : undefined),
	);
	// Above everything, the questions included. Not because a tooltip may
	// stand over a modal — it may not, and in practice cannot: a question
	// covers the window, which takes the pointer off the row that raised the
	// tooltip, and the page hides it before the sheet is drawn. It is on top
	// because it is the one child that is never anything but a few words to
	// read: it takes no click (it is parked unless it has something to say,
	// and what it says is the size of what it draws), it
	// takes no keys, and nothing is ever meant to be seen *through* it. A
	// layer with nothing behind it to protect is a layer with no reason to be
	// underneath anything.
	children.push(
		layer(
			{ kind: "tooltip" },
			windowSize,
			input.tooltip
				? tooltipRect(
						windowSize,
						input.tooltip,
						sidebarTrailingEdge(windowSize, state),
					)
				: undefined,
		),
	);
	return children;
}

/**
 * Whether moving a view that is on screen from `from` to `to` shows its old
 * picture in the wrong place.
 *
 * A view's picture is its page's last frame, and a frame is drawn for one
 * size. Moved without being resized, the same frame is drawn at the new
 * place in the same compositor frame as every other view: the move is exact.
 * Resized where it stands, the old frame is drawn where it was, clipped or
 * with a margin, until the page draws at the new size: nothing is anywhere
 * it was not. Moved *and* resized, the old frame is drawn at the new place
 * until the page catches up — the Sidebar collapsing drew the whole
 * conversation 209px to the left of where it had been and of where it was
 * going, for one to three frames. Only that case is held back
 * (`ShellWindow.layout`, `docs/motion.md`).
 */
export function movesStalePicture(from: LayoutRect, to: LayoutRect): boolean {
	const moved = from.x !== to.x || from.y !== to.y;
	const resized = from.width !== to.width || from.height !== to.height;
	return moved && resized;
}

/**
 * Where a view waits, at the size it is going to have, while its page draws
 * at that size: off the window but for its first pixel in the far corner, as
 * a parked layer is (`parkedRect`), so it is still a view on screen and still
 * painting. Once its page has drawn there, it is moved to its place at the
 * same size, which is exact (`movesStalePicture`).
 */
export function stagingRect(
	windowSize: LayoutSize,
	size: LayoutSize,
): LayoutRect {
	return {
		x: windowSize.width - 1,
		y: windowSize.height - 1,
		width: size.width,
		height: size.height,
	};
}
