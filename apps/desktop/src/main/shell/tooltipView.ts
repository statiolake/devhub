/**
 * The tooltip, one layer above everything it is a tooltip about.
 *
 * # Why it is not the Sidebar's any more
 *
 * It was sixteen `title` attributes, then a `<div>` in the Sidebar's own
 * document, and both failed in the same place for the same reason. A `title`
 * is Chromium's own popup raised inside a `WebContentsView`, and whether it
 * may paint outside that view's bounds is not this codebase's to decide. The
 * `<div>` that replaced it *was* this codebase's, which made the clipping
 * decidable — and the answer was that it is clipped, because the row that most
 * needs a tooltip is the glyph on a collapsed rail and that view is 44px wide
 * with a title bar, 76px without. `RowTooltip.tsx` measured a three-line
 * description into a 42px column 809px tall running off the top of the view,
 * and then refused to draw one below a readable width at all.
 *
 * That refusal was honest and it was the wrong shape. The sentence does not
 * need to be narrower; the box needs to not be inside the column. So it is a
 * child of the *window*, like the notices, and it may run out over the editor.
 *
 * # Why this view is the size of the tooltip and not the size of the window
 *
 * The notices' reason, unchanged (`toastsView.ts` records the measurement). A
 * `WebContentsView` is a native view whose hit testing is by rectangle: every
 * click inside its bounds is that view's, and a transparent pixel is still its
 * pixel. `BrowserWindow.setIgnoreMouseEvents` is the only mouse-ignoring API
 * Electron has and it is window-wide. On Electron 42.10.0 a `WebContentsView`
 * exposes `setBounds`, `setVisible`, `setBackgroundColor`, `setBorderRadius`
 * and `setLayout`, and nothing that takes it out of the hit test.
 *
 * So a window-sized transparent tooltip layer would be a window-sized hole in
 * the editor, and the only honest rectangle is the one the words are in. The
 * page measures its own box and says how big it is; this view is exactly that
 * big, where the owner says. With no tooltip up it is not in the window's
 * child list at all — a layer that is not there cannot take a click.
 *
 * # What this class holds and what it does not
 *
 * It holds the *request*: the text, the anchor in window coordinates, and the
 * side the row prefers. It does not hold a rectangle. Where the tooltip goes
 * is `windowLayout.ts`'s `tooltipRect`, which is pure and knows the window's
 * size; this is only the state that makes that function answerable, plus the
 * page it is drawn on.
 *
 * It never touches the keyboard, in either direction. There is nothing in a
 * tooltip to type into, `keyboardChild` never names it, and
 * `ShellWindow.contentsOf` throws rather than falling back if it ever does.
 * That is the whole of the difference between this layer and the picker, and
 * one more step than the notices — a notice can at least be dismissed with
 * Escape, so `ToastsView` has to hand focus back when it leaves holding it.
 */

import { electron } from "../electron.js";
import { CHANNELS, type TooltipLineWire } from "../../ipc/contract.js";
import { sendLinksToTheBrowser } from "./externalLinks.js";
import type {
	LayoutRect,
	TooltipPlacement,
	TooltipSide,
} from "./windowLayout.js";

/** How big the page says its box is, in the page's own pixels. */
export interface TooltipSize {
	readonly width: number;
	readonly height: number;
}

/** What the Sidebar asked for: some facts, about a rectangle, on a side. */
export interface TooltipRequest {
	readonly lines: readonly TooltipLineWire[];
	readonly anchor: LayoutRect;
	readonly prefer: TooltipSide;
}

export interface TooltipViewHost {
	readonly window: Electron.BrowserWindow;
	/** A tooltip went up, came down or changed size: lay the window out again. */
	tooltipChanged(): void;
}

export class TooltipView {
	private readonly view: Electron.WebContentsView;
	private present = false;
	private request: TooltipRequest | undefined;
	private size: TooltipSize = { width: 0, height: 0 };

	constructor(preloadPath: string, pageUrl: string) {
		this.view = new electron.WebContentsView({
			webPreferences: {
				preload: preloadPath,
				sandbox: false,
				contextIsolation: true,
				nodeIntegration: false,
			},
		});
		// Whatever the box does not cover is the live window seen through it:
		// the tooltip has rounded corners and a shadow, and a page background
		// here would be a grey rectangle around both.
		this.view.setBackgroundColor("#00000000");
		// Every child page needs this, and a page that forgets it can mint a
		// second window wearing DevHub's preload. A tooltip draws no links, but
		// the rule is about what the view *can* be made to do, not about what
		// this page happens to draw. See `externalLinks.ts`.
		sendLinksToTheBrowser(this.view.webContents);
		void this.view.webContents.loadURL(pageUrl);
	}

	/**
	 * Set the host after construction.
	 *
	 * The window builds this view in its own constructor, so there is no
	 * window to hand it yet. Nothing is drawn before the Sidebar asks for a
	 * tooltip, which cannot happen before the Sidebar's own page has loaded.
	 */
	private host: TooltipViewHost | undefined;
	adopt(host: TooltipViewHost): void {
		this.host = host;
	}

	/**
	 * Raise a tooltip, or replace the one that is up.
	 *
	 * Replacing rather than stacking is the "one tooltip for the whole tree"
	 * rule arriving from the page — and it is worth noting that this class
	 * could not break it if it tried: there is one view and one request, so
	 * two tooltips at once is not a state it can represent.
	 *
	 * The size is *not* cleared here. A tooltip replacing another is the
	 * ordinary case — the pointer moved from one row to the next — and
	 * clearing it would take the view out of the window for the frame between
	 * the text arriving and the page reporting its new box, which reads as a
	 * flicker. The size that is there is the previous sentence's, which is
	 * wrong by a few pixels for one frame; absence would be wrong by the whole
	 * tooltip.
	 */
	show(request: TooltipRequest): void {
		this.request = request;
		this.send({ lines: request.lines });
		this.host?.tooltipChanged();
	}

	/** Take it down. The pointer left, or something moved under it. */
	hide(): void {
		if (this.request === undefined) return;
		this.request = undefined;
		// The page is told first so that it stops drawing, and it answers with
		// a size of zero — but this view leaves the window on *this* call
		// rather than on that answer. A tooltip that lingered until a renderer
		// replied would linger for exactly as long as the renderer was busy.
		this.send(undefined);
		this.size = { width: 0, height: 0 };
		this.host?.tooltipChanged();
	}

	/** The page measured its box. Zero means it is drawing nothing. */
	setSize(size: TooltipSize): void {
		this.size = size;
		this.host?.tooltipChanged();
	}

	/**
	 * Everything the owner needs to place this layer, or nothing.
	 *
	 * Both halves have to be true: a tooltip has to have been asked for, and
	 * the page has to have drawn it. Between those two moments there is a
	 * request with no size, and a view placed then would be a zero-sized
	 * rectangle — which is not harmful but is not the tooltip either.
	 */
	placement(): TooltipPlacement | undefined {
		const request = this.request;
		if (!request) return undefined;
		if (this.size.width <= 0 || this.size.height <= 0) return undefined;
		return { anchor: request.anchor, prefer: request.prefer, size: this.size };
	}

	/**
	 * Put the layer where the owner says, or take it out of the window.
	 *
	 * `undefined` is "there is no tooltip", and a layer that is not in the
	 * child list cannot take a click — which is the whole reason this view is
	 * the size of the words and not the size of the window.
	 */
	place(rect: Electron.Rectangle | undefined): void {
		const host = this.host;
		if (!host || host.window.isDestroyed()) return;
		if (!rect) {
			this.withdraw();
			return;
		}
		this.view.setBounds(rect);
		// Re-added on every pass, because re-adding an existing child moves it
		// to the end of the list, which is the top of the stack. The owner
		// places its children in order and this is that order arriving — and
		// this one is last, so anything that lays the window out again leaves
		// the tooltip on top rather than under the thing it appeared over.
		//
		// The keyboard is deliberately never touched. There is nothing here to
		// type into.
		host.window.contentView.addChildView(this.view);
		this.present = true;
	}

	private withdraw(): void {
		const host = this.host;
		if (!this.present || !host || host.window.isDestroyed()) return;
		host.window.contentView.removeChildView(this.view);
		this.present = false;
	}

	/** The page, for the palette and for anything else addressed to it. */
	contents(): Electron.WebContents | undefined {
		return this.view.webContents.isDestroyed()
			? undefined
			: this.view.webContents;
	}

	/** Whether the layer is in the window's child list right now. */
	isPresent(): boolean {
		return this.present;
	}

	private send(
		content: { readonly lines: readonly TooltipLineWire[] } | undefined,
	): void {
		const contents = this.contents();
		if (!contents) return;
		contents.send(CHANNELS.tooltipText, content);
	}
}
