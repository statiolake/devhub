/**
 * A layer: a child view of the window whose page draws over the others only
 * while it has something to show — the notices, the questions, the tooltip.
 *
 * The three are one kind of thing and are built and placed here once, so that
 * what was measured about one of them holds for all three:
 *
 * - The view is built once, at startup, never destroyed, and **never taken out
 *   of the window**. A view out of the window is a hidden page, and a hidden
 *   page paints nothing: whatever it was told as it left was never drawn, so
 *   it came back on a frame of what it showed before, and the first time it
 *   was shown after launch it had to lay out a 0×0 page first. What follows
 *   the content is *where* the view is — over the window, or parked in its
 *   corner (`parkedRect` in `windowLayout.ts`), still at a real size and still
 *   painting.
 * - Its page background is clear: whatever it does not draw is the live window
 *   seen through it.
 * - Every placement re-adds it, because re-adding an existing child moves it
 *   to the end of the list, which is the top of the stack. The owner places
 *   its children in order and this is that order arriving.
 *
 * What each layer does with the keyboard, and what it tells its page before it
 * moves, is its own; see `PickerView`, `ToastsView` and `TooltipView`.
 */

import { electron } from "../electron.js";
import { sendLinksToTheBrowser } from "./externalLinks.js";

/** A layer's page background while it is not dimming anything. */
export const CLEAR = "#00000000";

export class LayerView {
	readonly view: Electron.WebContentsView;
	private readonly pageUrl: string;
	private shown = false;

	constructor(preloadPath: string, pageUrl: string) {
		this.view = new electron.WebContentsView({
			webPreferences: {
				preload: preloadPath,
				sandbox: false,
				contextIsolation: true,
				nodeIntegration: false,
			},
		});
		this.view.setBackgroundColor(CLEAR);
		// A link in a layer leaves through the browser like every other link.
		// Every child page needs this — a page that forgets it can mint a
		// second window wearing DevHub's preload. See `externalLinks.ts`.
		sendLinksToTheBrowser(this.view.webContents);
		this.pageUrl = pageUrl;
	}

	/**
	 * Run the page. Not at construction: the window owns when its pages run,
	 * and runs them all at once, when everything they ask for exists — see
	 * `ShellWindow.openPage`.
	 */
	openPage(): void {
		void this.view.webContents.loadURL(this.pageUrl);
	}

	/**
	 * Put the view where the owner says: at `rect`, over the window when
	 * `shown`, parked when not. Either way it stays in the window and goes to
	 * the top of the stack.
	 */
	place(
		window: Electron.BrowserWindow,
		rect: Electron.Rectangle,
		shown: boolean,
	): void {
		this.view.setBounds(rect);
		window.contentView.addChildView(this.view);
		this.shown = shown;
	}

	/** Whether the layer is over the window right now, rather than parked. */
	isShown(): boolean {
		return this.shown;
	}

	contents(): Electron.WebContents | undefined {
		return this.view.webContents.isDestroyed()
			? undefined
			: this.view.webContents;
	}
}
