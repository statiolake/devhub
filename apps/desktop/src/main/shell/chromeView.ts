/**
 * A child of the window that is always there: the Sidebar, and the Agents.
 *
 * The notices and the questions are layers — they are *over* something, they
 * are in the window's child list only while they have something to say, and a
 * layer that is not there cannot take a click. These two are not layers. They
 * are columns beside the workbench, they exist for the whole life of the
 * window, and the only thing that moves is their rectangle and whether they
 * are drawn. So they are one class with one method, and nothing about presence
 * or withdrawal is in it.
 *
 * What each of them *is* is decided by which page main loads into it, and by
 * nothing else — no `?window=` role, no props, no shared provider. Everything
 * a page in one of these needs is in that page's own header.
 */

import { electron } from "../electron.js";
import { sendLinksToTheBrowser } from "./externalLinks.js";

export class ChromeView {
	private readonly view: Electron.WebContentsView;
	private readonly pageUrl: string;

	constructor(preloadPath: string, pageUrl: string) {
		this.view = new electron.WebContentsView({
			webPreferences: {
				preload: preloadPath,
				sandbox: false,
				contextIsolation: true,
				nodeIntegration: false,
			},
		});
		// Drawn from the first frame at the window's own colour rather than at
		// Chromium's white: these two cover a large part of the window and a
		// white flash on every launch is the whole chrome blinking.
		this.view.setBackgroundColor("#00000000");
		// A link leaves through the browser, like every other link in DevHub.
		// Every child page needs this, and a page that forgets it can mint a
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
	 * Put the view where the owner says, and draw it or do not.
	 *
	 * Bounds before visibility, and re-added on every pass: re-adding an
	 * existing child moves it to the end of the child list, which is the top
	 * of the stack, and the owner's list order *is* the z-order.
	 */
	place(
		window: Electron.BrowserWindow,
		rect: Electron.Rectangle,
		visible: boolean,
	): void {
		if (window.isDestroyed() || this.view.webContents.isDestroyed()) return;
		this.view.setBounds(rect);
		if (!visible) {
			this.view.setVisible(false);
			return;
		}
		window.contentView.addChildView(this.view);
		this.view.setVisible(true);
	}

	/** Put it in the window's child list without drawing it, once, at start. */
	adopt(window: Electron.BrowserWindow): void {
		if (window.isDestroyed()) return;
		window.contentView.addChildView(this.view);
		this.view.setVisible(false);
	}

	contents(): Electron.WebContents | undefined {
		return this.view.webContents.isDestroyed()
			? undefined
			: this.view.webContents;
	}

	/** Whether this view is drawn right now — read back by a test. */
	isVisible(): boolean {
		return !this.view.webContents.isDestroyed() && this.view.getVisible();
	}
}
