/**
 * The one real window DevHub has.
 *
 * It shows the App Shell page — sidebar, titlebar, error area — and hosts every
 * workbench as a `WebContentsView` laid into the content rectangle the page
 * reports. There is one way to put a workbench on screen (`reveal`) and one
 * way to size it (`layout`); the page never positions anything itself.
 */

import { electron } from "../electron.js";
import type { ContentRect } from "../../ipc/contract.js";
import type { WorkbenchView } from "./workbenchView.js";

export class ShellWindow {
	readonly window: Electron.BrowserWindow;

	private readonly views: WorkbenchView[] = [];
	private revealed: WorkbenchView | undefined;
	private contentRect: ContentRect | undefined;
	/**
	 * Whether the native view is the thing on screen.
	 *
	 * The viewport hosts two kinds of Surface and only one mechanism can be on
	 * top: a terminal or an Agent is DOM inside the page, and a native view over
	 * the same rectangle would cover it. The page says which it is showing, and
	 * this is that answer.
	 */
	private nativeSurfaceVisible = true;
	/** A modal in the page outranks the workbench for the same rectangle. */
	private modalOpen = false;

	constructor(preloadPath: string, pageUrl: string) {
		this.window = new electron.BrowserWindow({
			width: 1440,
			height: 900,
			minWidth: 720,
			minHeight: 480,
			title: "DevHub",
			// The Tauri app's chrome: the page paints the titlebar band itself
			// over the window's own material, and the traffic lights sit on the
			// sidebar rather than above it.
			titleBarStyle: "hiddenInset",
			vibrancy: "sidebar",
			backgroundColor: "#00000000",
			show: false,
			webPreferences: {
				preload: preloadPath,
				sandbox: false,
				contextIsolation: true,
				nodeIntegration: false,
			},
		});

		this.window.loadURL(pageUrl);
		this.window.once("ready-to-show", () => this.window.show());
		this.window.on("resize", () => this.layout());

		// macOS convention: closing the window does not end the app, and here it
		// must not even end the window. Every workbench, terminal and agent lives
		// inside this one window; destroying it to rebuild it on the next dock
		// click would throw all of that away and start it again. So the window
		// hides, keeping its views, and comes back exactly as it was.
		//
		// Quitting is the Quit item or the Command-Q chord, and that is the only
		// path that ends anything.
		this.window.on("close", (event) => {
			if (quitting) return;
			event.preventDefault();
			this.window.hide();
		});
		this.window.on("closed", () => {
			current = undefined;
		});
	}

	//#region the views

	/**
	 * Take ownership of a new workbench view — without putting it on screen.
	 *
	 * A view used to reveal itself here, which made *creation* decide what is
	 * shown. Once workbenches are started at launch that is plainly wrong: three
	 * of them finish opening in whatever order they finish in, and the last one
	 * wins the screen no matter which workspace the person selected. Worse, it
	 * wins it before it has painted, which is the white content area.
	 *
	 * What is on screen is a function of the selection and nothing else, so it
	 * is `reveal` — called by whoever knows the selection — that decides.
	 */
	attach(view: WorkbenchView): void {
		this.views.push(view);
		this.window.contentView.addChildView(view.view);
		view.view.setBounds(this.currentRect());
		view.view.setVisible(false);
	}

	detach(view: WorkbenchView): void {
		const index = this.views.indexOf(view);
		if (index === -1) {
			return;
		}
		this.views.splice(index, 1);
		this.window.contentView.removeChildView(view.view);
		if (this.revealed === view) {
			// Not "some other view": nothing is on screen until the selection
			// says what is, exactly as at startup.
			this.revealed = undefined;
		}
		this.layout();
	}

	getViews(): readonly WorkbenchView[] {
		return this.views;
	}

	getViewById(id: number): WorkbenchView | undefined {
		return this.views.find((view) => view.id === id);
	}

	/**
	 * Put one workbench on screen, and no other.
	 *
	 * The whole of it happens here, in this order, synchronously: the view is
	 * sized to the current content rectangle *before* it is shown, so it never
	 * appears at stale bounds; it is brought to the top of the child list,
	 * because sibling views paint in order and a shown view under another one
	 * is invisible for no visible reason; and every other view is hidden. Doing
	 * any of that in a later tick is what leaves a frame — or a session — of
	 * the wrong thing on screen.
	 */
	reveal(view: WorkbenchView): void {
		if (!this.views.includes(view)) return;
		this.revealed = view;
		this.layout();
	}

	isRevealed(view: WorkbenchView): boolean {
		return this.revealed === view;
	}

	//#endregion

	//#region layout

	/** The page measures its own content area and tells main where it is. */
	setContentRect(rect: ContentRect): void {
		this.contentRect = rect;
		this.layout();
	}

	/** The page says whether the workbench view is the Surface on screen. */
	setNativeSurfaceVisible(visible: boolean): void {
		if (this.nativeSurfaceVisible === visible) {
			return;
		}
		this.nativeSurfaceVisible = visible;
		this.layout();
	}

	/**
	 * The page has a modal open, or no longer does.
	 *
	 * A native view paints above this document unconditionally, so a modal the
	 * page draws would be invisible behind a workbench while still holding the
	 * keyboard. Standing the view down for as long as the modal is up is the
	 * only arrangement in which the person can see what they are answering.
	 */
	setModalOpen(open: boolean): void {
		if (this.modalOpen === open) {
			return;
		}
		this.modalOpen = open;
		this.layout();
	}

	boundsOf(_view: WorkbenchView): Electron.Rectangle {
		return this.currentRect();
	}

	private currentRect(): Electron.Rectangle {
		if (this.contentRect) {
			return {
				x: Math.round(this.contentRect.x),
				y: Math.round(this.contentRect.y),
				width: Math.round(this.contentRect.width),
				height: Math.round(this.contentRect.height),
			};
		}

		// Until the page has measured itself, the whole content area is the
		// honest answer: a zero-sized view would make the workbench lay itself
		// out against nothing and never recover.
		const [width, height] = this.window.getContentSize();
		return { x: 0, y: 0, width, height };
	}

	layout(): void {
		if (this.window.isDestroyed()) {
			return;
		}
		const bounds = this.currentRect();
		const onScreen =
			this.nativeSurfaceVisible && !this.modalOpen ? this.revealed : undefined;
		// Bounds first, then visibility, and the shown one last of all: a view
		// made visible before it is sized shows its previous size for a frame.
		for (const view of this.views) {
			view.view.setBounds(bounds);
			if (view !== onScreen) view.view.setVisible(false);
		}
		if (onScreen) {
			// Re-adding an existing child moves it to the end of the list, which
			// is the top of the stack. Nothing else establishes that order.
			this.window.contentView.addChildView(onScreen.view);
			onScreen.view.setVisible(true);
		}
	}

	/**
	 * The invariant this class exists to keep: at most one workbench view is
	 * on screen, and if there is one it is the topmost child.
	 *
	 * Exposed so a test can assert it rather than assert the calls that
	 * happen to establish it today.
	 */
	visibleViews(): readonly WorkbenchView[] {
		return this.views.filter((view) => view.view.getVisible());
	}

	topmostView(): WorkbenchView | undefined {
		const children = this.window.contentView.children;
		for (let index = children.length - 1; index >= 0; index -= 1) {
			const match = this.views.find((view) => view.view === children[index]);
			if (match) return match;
		}
		return undefined;
	}

	//#endregion
}

let current: ShellWindow | undefined;

/**
 * Whether the application is on its way out.
 *
 * The shell window refuses to close right up until this is true, which is what
 * makes the red button a hide and Quit a quit.
 */
let quitting = false;

/** Called once, when the app has decided to quit. */
export function beginQuit(): void {
	quitting = true;
}

export function createShellWindow(
	preloadPath: string,
	pageUrl: string,
): ShellWindow {
	if (current) {
		throw new Error("the App Shell window already exists");
	}
	current = new ShellWindow(preloadPath, pageUrl);
	return current;
}

/** The shell must exist before any workbench does; not having one is a bug. */
export function shellWindow(): ShellWindow {
	if (!current) {
		throw new Error("the App Shell window has not been created yet");
	}
	return current;
}

export function shellWindowIfCreated(): ShellWindow | undefined {
	return current;
}
