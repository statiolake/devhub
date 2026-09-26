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
 * to say the stack has no size, and the view is parked, all but one pixel
 * outside the window — the rule every layer keeps; see `layerView.ts`.
 */

import { LayerView } from "./layerView.js";

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
	private readonly layer: LayerView;
	private size: ToastsSize = { width: 0, height: 0 };

	constructor(preloadPath: string, pageUrl: string) {
		// Whatever the notices do not cover is the live window seen through
		// them: the stack has rounded corners and a shadow, and a page
		// background here would be a grey rectangle around both. The layer's
		// background is clear for that reason.
		this.layer = new LayerView(preloadPath, pageUrl);
	}

	/** Run the page. See `LayerView.openPage`. */
	openPage(): void {
		this.layer.openPage();
	}

	/**
	 * Set the host after construction.
	 *
	 * The window builds this view in its own constructor, so there is no
	 * window to hand it yet. Nothing is placed before the window lays itself
	 * out, and nothing can have the keyboard before it is placed, so there is
	 * no window in which the host is needed and missing.
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
	 * Put the layer where the owner says: over the window when `shown`,
	 * parked when there is nothing to say.
	 *
	 * The keyboard is deliberately *not* placed here. A notice is not a
	 * question; it arrives while the person is in the middle of something and
	 * taking the keys from them would make every passing condition an
	 * interruption. This is the whole of the difference between this layer
	 * and the picker.
	 */
	place(rect: Electron.Rectangle, shown: boolean): void {
		const host = this.host;
		if (!host || host.window.isDestroyed()) return;
		// This is the "the stack emptied while a toast held the keyboard" case,
		// and it is the only reason this layer ever touches focus. A parked
		// page must not keep the keys — the one pixel of it in the window is
		// nothing anyone can see typing into.
		const held = !shown && this.layer.view.webContents.isFocused();
		this.layer.place(host.window, rect, shown);
		if (held) host.focusSurface();
	}

	/**
	 * The page that draws failures.
	 *
	 * `publishAudience.ts` says why a failure is told to this page and to no
	 * other, and why that is a smaller audience than a projection's.
	 */
	contents(): Electron.WebContents | undefined {
		return this.layer.contents();
	}

	/** Whether the notices are over the window right now, rather than parked. */
	isPresent(): boolean {
		return this.layer.isShown();
	}
}
