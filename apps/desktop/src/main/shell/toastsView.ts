/**
 * Where the application speaks, one layer above everything it is speaking
 * about.
 *
 * App-scoped notices — a failed intent, a `gh` that is not on the PATH, a
 * machine that stopped answering — used to be drawn by the App Shell page,
 * floating over the Sidebar's column. That placement was not a design; it was
 * the only column no native view is laid over, and `styles/toast.css` said so
 * out loud, along with the two cases it does not survive: a Sidebar collapsed
 * to its rail, and a Sidebar dragged under the stack's readable floor. It also
 * named the fix — the overlay view the modals already use — which is what this
 * is.
 *
 * # Why this view is the size of the notices and not the size of the window
 *
 * A `WebContentsView` is a native view. Its hit testing is by rectangle, not
 * by what the page inside it happens to have painted: every click inside its
 * bounds is that view's, and a transparent pixel is still its pixel.
 * `BrowserWindow.setIgnoreMouseEvents` is the only mouse-ignoring API Electron
 * has and it is window-wide — turning it on to let a click reach the editor
 * would let the same click reach through the editor too.
 *
 * Measured on Electron 42.10.0: `WebContentsView` exposes `setBounds`,
 * `setVisible`, `setBackgroundColor`, `setBorderRadius` and `setLayout`, and
 * nothing that takes it out of the hit test. So there is no arrangement in
 * which a window-sized transparent toasts view cannot eat a click aimed at the
 * workbench, and the only honest rectangle is the one the notices are actually
 * drawn in.
 *
 * The page therefore measures its own stack and says how big it is, and this
 * view is exactly that big, in the window's bottom-right corner. With nothing
 * to say the stack has no size, and this view is not in the window's child
 * list at all — the same rule the modal layer has kept since it was written,
 * and for the same reason: a layer that is not there cannot take a click.
 *
 * The view itself is created once, at startup, and never destroyed. Presence
 * in the child list and existence are two different facts; only the first one
 * follows the notices.
 */

import { electron } from "../electron.js";
import { sendLinksToTheBrowser } from "./externalLinks.js";

/** How big the page says its notices are, in the page's own pixels. */
export interface ToastsSize {
	readonly width: number;
	readonly height: number;
}

export interface ToastsViewHost {
	readonly window: Electron.BrowserWindow;
	/** The stack changed size, so the arrangement has to be decided again. */
	sizeChanged(): void;
	/**
	 * Put the keyboard back where it belongs, and say so.
	 *
	 * Only when this view had it. A notice is not modal — it arrives while the
	 * person is doing something else and must not take the keys — but a notice
	 * *can* be typed into, since Escape closes the one that has the focus. So
	 * the one case this has to answer is the stack emptying while one of its
	 * toasts was focused, which used to be `focusMainSurface()` inside the page
	 * and could only ever mean "somewhere in this document". The window already
	 * has the one answer to where the keys go.
	 */
	focusSurface(): void;
}

export class ToastsView {
	private readonly view: Electron.WebContentsView;
	private readonly pageUrl: string;
	private present = false;
	private size: ToastsSize = { width: 0, height: 0 };

	constructor(preloadPath: string, pageUrl: string) {
		this.view = new electron.WebContentsView({
			webPreferences: {
				preload: preloadPath,
				sandbox: false,
				contextIsolation: true,
				nodeIntegration: false,
			},
		});
		// Whatever the notices do not cover is the live window seen through
		// them: the stack has rounded corners and a shadow, and a page
		// background here would be a grey rectangle around both.
		this.view.setBackgroundColor("#00000000");
		// A link in a notice leaves through the browser like every other link.
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
	 * Set the host after construction.
	 *
	 * The window builds this view in its own constructor, so there is no
	 * window to hand it yet. Nothing is drawn before the page has anything to
	 * say, and nothing can have the keyboard before it is in the child list, so
	 * there is no window in which the host is needed and missing.
	 */
	private host: ToastsViewHost | undefined;
	adopt(host: ToastsViewHost): void {
		this.host = host;
	}

	/** The page measured its stack. Zero height means it has nothing to say. */
	setSize(size: ToastsSize): void {
		this.size = size;
		this.host?.sizeChanged();
	}

	/**
	 * How big the notices are — the one thing about this layer the page owns.
	 *
	 * Its size is its content and nothing else can know it; *where* that
	 * rectangle goes in the window is the layout owner's, like every other
	 * child's. See `windowLayout.ts`.
	 */
	contentSize(): ToastsSize | undefined {
		return this.size.width > 0 && this.size.height > 0 ? this.size : undefined;
	}

	/**
	 * Put the layer where the owner says, or take it out of the window.
	 *
	 * `undefined` is "there is nothing to say", and a layer that is not in the
	 * child list cannot take a click — which is the whole reason this view is
	 * the size of the notices and not the size of the window.
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
		// places its children in order and this is that order arriving.
		//
		// The keyboard is deliberately *not* placed here. A notice is not a
		// question; it arrives while the person is in the middle of something
		// and taking the keys from them would make every passing condition an
		// interruption. This is the whole of the difference between this layer
		// and the picker.
		host.window.contentView.addChildView(this.view);
		this.present = true;
	}

	private withdraw(): void {
		const host = this.host;
		if (!this.present || !host || host.window.isDestroyed()) return;
		// Asked before the view leaves, because a view that is gone reports
		// nothing: this is the "the stack emptied while a toast held the
		// keyboard" case, and it is the only reason this layer ever touches
		// focus.
		const held = this.view.webContents.isFocused();
		host.window.contentView.removeChildView(this.view);
		this.present = false;
		if (held) host.focusSurface();
	}

	/**
	 * The page that draws failures.
	 *
	 * `publishAudience.ts` says why a failure is told to this page and to no
	 * other, and why that is a smaller audience than a projection's.
	 */
	contents(): Electron.WebContents | undefined {
		return this.view.webContents.isDestroyed()
			? undefined
			: this.view.webContents;
	}

	/** Whether the layer is in the window's child list right now. */
	isPresent(): boolean {
		return this.present;
	}
}
