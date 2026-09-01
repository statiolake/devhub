/**
 * The one real window DevHub has.
 *
 * It shows the App Shell page — sidebar, titlebar, error area — and hosts every
 * workbench as a `WebContentsView` laid into the content rectangle the page
 * reports. There is one way to put a workbench on screen (`reveal`) and one
 * way to size it (`layout`); the page never positions anything itself.
 */

import { electron } from "../electron.js";
import { sendLinksToTheBrowser } from "./externalLinks.js";
import type { ContentRect, ContentSurfaceWire } from "../../ipc/contract.js";
import { WINDOW_TITLES } from "../../ipc/windowTitles.js";
import { ModalOverlay } from "./modalOverlay.js";
import { shellTheme } from "./shellTheme.js";
import type { ShellPalette } from "../../ipc/palette.js";
import type { WorkbenchView } from "./workbenchView.js";

export class ShellWindow {
	readonly window: Electron.BrowserWindow;

	private readonly views: WorkbenchView[] = [];
	private revealed: WorkbenchView | undefined;
	private contentRect: ContentRect | undefined;
	/**
	 * What the page has put in the content area, as the page last said.
	 *
	 * The viewport hosts two kinds of Surface, and a native view over the same
	 * rectangle would cover DOM: this is what says whether the workbench view is
	 * drawn at all, and — separately — whether it is the thing being typed into.
	 * See `ContentSurfaceWire`: they are two questions, and answering both with
	 * "is a workbench visible" is what took the keyboard away from an Agent
	 * opened beside its editor.
	 */
	private contentSurface: ContentSurfaceWire = "workbench";
	/**
	 * The layer every DevHub modal is drawn on.
	 *
	 * It belongs to the window rather than to any page because it is a fact
	 * about the window's child list: the last child paints on top, and that is
	 * the whole of what makes a modal a modal here.
	 */
	readonly modals: ModalOverlay;
	/** How the surface key of the workbench on screen is looked up. */
	private surfaceKeyOfView: (view: WorkbenchView) => string | undefined = () =>
		undefined;
	/**
	 * Told when anything this class knows that the window's name depends on has
	 * moved: which workbench is on screen, and what a workbench calls itself.
	 * The rest of the name comes from the model, so the name itself is composed
	 * by whoever has both (`shellTitle.ts`).
	 */
	private titleChanged: () => void = () => undefined;

	/**
	 * The App Shell page's URL, held until `openPage` runs it.
	 *
	 * Creating the window and running its page are two facts, not one. The
	 * window has to exist early — the controller is built around it, and it
	 * paints in the restored palette while the rest of startup happens — but the
	 * page starts asking for its terminal the moment it mounts, and a request
	 * that arrives before the handler that answers it is a pane reporting a
	 * failure that never happened. So the page is opened by whoever finished the
	 * things it will ask for; see `bootstrapShell`.
	 */
	private readonly pageUrl: string;
	private pageOpened = false;

	constructor(
		preloadPath: string,
		pageUrl: string,
		palette: ShellPalette | undefined,
	) {
		this.window = new electron.BrowserWindow({
			width: 1440,
			height: 900,
			minWidth: 720,
			minHeight: 480,
			title: WINDOW_TITLES.shell,
			// The Tauri app's chrome: the page paints the titlebar band itself
			// over the window's own material, and the traffic lights sit on the
			// sidebar rather than above it.
			titleBarStyle: "hiddenInset",
			// The window's material and its background are the same decision as
			// the page's `data-window-material`, made in the same breath: a shell
			// that follows the Workbench's colour theme cannot also show a system
			// material through its chrome, because the material follows the
			// *system* appearance and the theme does not. With a palette the
			// window is opaque and painted; without one it is the macOS sidebar
			// material, as it was before any workbench ever ran.
			vibrancy: palette ? undefined : "sidebar",
			backgroundColor: palette ? palette.canvas : "#00000000",
			show: false,
			webPreferences: {
				preload: preloadPath,
				sandbox: false,
				contextIsolation: true,
				nodeIntegration: false,
			},
		});

		sendLinksToTheBrowser(this.window.webContents);

		// DevHub names this window, and only DevHub. Electron hands a page's
		// `document.title` to its window by default, which would let the App
		// Shell page — served from the same `index.html` as the Settings
		// window, and with no idea what is on screen — overwrite a name that
		// says which Workspace and which file are being worked on.
		this.window.on("page-title-updated", (event) => {
			event.preventDefault();
		});

		this.modals = new ModalOverlay(
			{
				window: this.window,
				workbenchRect: () => this.currentRect(),
				focusTarget: () => this.focusTarget(),
				modalsChanged: () => {
					this.layout();
				},
			},
			preloadPath,
			`${pageUrl}?window=overlay`,
		);

		this.pageUrl = pageUrl;
		this.window.once("ready-to-show", () => this.window.show());
		this.window.on("resize", () => this.layout());

		// Coming back to DevHub puts the keyboard where it belongs.
		//
		// macOS restores focus to whatever held it when the app was last in
		// front, which is not the same question as "what is on screen now" — a
		// workbench that was revealed while the app was in the background would
		// be looked at while the keys went somewhere else. `focusSurface` is
		// already the one answer to that question, so it is asked again here
		// rather than a second rule being written for this case.
		this.window.on("focus", () => this.focusSurface());

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

	/** Runs the page. Calling it twice is a bug, not a reload. */
	openPage(): void {
		if (this.pageOpened) {
			throw new Error("the App Shell page has already been opened");
		}
		this.pageOpened = true;
		void this.window.loadURL(this.pageUrl);
	}

	/**
	 * Wear a palette the Workbench reported after the window was created.
	 *
	 * Only the window itself: the pages are told over IPC and set the same
	 * variables the page was served with. This is the frame around them — the
	 * colour behind a resize, and the material that must be gone once there is
	 * a theme to follow.
	 */
	applyPalette(palette: ShellPalette): void {
		if (this.window.isDestroyed()) return;
		this.window.setVibrancy(null);
		this.window.setBackgroundColor(palette.canvas);
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
		// A view whose contents are gone is not a view. It leaves the table the
		// instant that happens, before anything can be asked to lay it out or
		// raise it — Electron answers that with "can't add a destroyed child
		// view to a parent view", which is a true statement about a table that
		// should never have still contained it.
		view.webContents.once("destroyed", () => {
			this.detach(view);
		});
		// A workbench renames itself whenever its active editor changes; that
		// is the Editor's half of the window's name arriving.
		view.webContents.on("page-title-updated", () => {
			this.titleChanged();
		});
	}

	detach(view: WorkbenchView): void {
		const index = this.views.indexOf(view);
		if (index === -1) {
			return;
		}
		this.views.splice(index, 1);
		this.window.contentView.removeChildView(view.view);
		shellTheme().forgetWindow(view.id);
		if (this.revealed === view) {
			// Not "some other view": nothing is on screen until the selection
			// says what is, exactly as at startup.
			this.revealed = undefined;
			this.titleChanged();
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
		if (!this.views.includes(view) || view.isDestroyed()) return;
		this.revealed = view;
		this.layout();
		// A different workbench on screen is a different file in the name.
		this.titleChanged();
		// Which workbench is on screen is which theme the shell wears.
		shellTheme().selectionChanged();
		this.focusSurface();
	}

	/**
	 * Where the keyboard goes: to whatever is on screen.
	 *
	 * This window holds several web contents over one rectangle — the App Shell
	 * page, one `WebContentsView` per workbench — and hiding a view does not
	 * take the keyboard away from it. So a switch away from the Editor used to
	 * leave focus inside a workbench nobody could see: typing went into an
	 * invisible editor, the terminal underneath never received a key, and the
	 * chord layer's `before-input-event` was listening on contents the window
	 * was no longer delivering to. That is why a chord could not be used twice
	 * in a row — the first one moved the surface and left focus nowhere usable,
	 * and the second had nothing to arrive at.
	 *
	 * It is deliberately not the caller's decision. `focusTarget` already
	 * answers "what is on screen" for the modal layer, and every caller asking
	 * that question separately is how the two got to disagree. So focus is a
	 * function of the same state the layout is a function of, moved by the two
	 * calls that change it (`reveal`, `setNativeSurfaceVisible`) and by nothing
	 * else.
	 *
	 * Window-level focus is not touched here. Whether DevHub should come to the
	 * front is a different question with different answers — a chord is typed
	 * into an app that is already frontmost; a `devhub` command from a terminal
	 * is not — and the paths that mean it say so themselves.
	 */
	focusSurface(): void {
		if (this.window.isDestroyed()) return;
		// An open Web Inspector keeps the keyboard. It is a window onto these
		// same contents, so unlike the Settings window it is not protected by
		// simply belonging to somebody else — and a rule that quietly pulled
		// focus back out of it every time a surface was revealed is how a
		// debugging session becomes impossible to hold.
		//
		// Deliberately not a check on whether this window is focused: a reveal
		// raised by the `devhub` command line happens *before* the window is
		// brought to the front, and would then never place the keyboard at all.
		if (this.window.webContents.isDevToolsFocused()) return;
		// A modal owns the keyboard for as long as it stands; it is on top of
		// everything this method can see, and taking focus out of it would leave
		// a dialog on screen that no key reaches.
		if (this.modals.isPresent()) return;
		this.focusTarget().focus();
	}

	/**
	 * The contents the keyboard belongs to: the workbench the person is working
	 * in, or the App Shell page — which is where a terminal and an Agent surface
	 * live, so "the workbench is not what was selected" and "the page has it" are
	 * the same fact.
	 *
	 * This is *not* "the workbench that is drawn", which is what it used to ask.
	 * In a split both are drawn — that is what a split is — and the one the
	 * person selected is the Agent, because a split is only ever entered by
	 * asking for an Agent beside its editor. Reading visibility gave the
	 * keyboard to the workbench on every reveal and on every window focus, so
	 * coming back to DevHub with an Agent open beside its editor put the keys in
	 * the editor. `ContentSurfaceWire` is the page's answer to which of the two
	 * it is, and this is the only place that reads that half of it.
	 */
	focusTarget(): Electron.WebContents {
		const asking = this.askingView();
		if (asking) return asking.webContents;
		if (this.contentSurface !== "workbench") return this.window.webContents;
		return this.liveRevealed()?.webContents ?? this.window.webContents;
	}

	/** The view on screen, if there is one and it still exists. */
	revealedView(): WorkbenchView | undefined {
		return this.revealed?.isDestroyed() === false ? this.revealed : undefined;
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

	/** The page says what it has put in the content area. */
	setContentSurface(surface: ContentSurfaceWire): void {
		if (this.contentSurface === surface) {
			return;
		}
		this.contentSurface = surface;
		this.layout();
		// Revealing a surface is a request to type into it. The page focuses
		// the xterm inside itself; only main can take the keyboard off the
		// workbench view that had it.
		this.focusSurface();
	}

	/** Register the one reader of "the window may need a new name". */
	onTitleChanged(changed: () => void): void {
		this.titleChanged = changed;
	}

	/** What the workbench on screen calls itself, if there is one. */
	revealedTitle(): string | undefined {
		return this.revealedView()?.webContents.getTitle();
	}

	/**
	 * How to name the workbench a view is showing.
	 *
	 * The model owns surface keys and this class owns views; the overlay needs
	 * to ask "is the workbench this question belongs to the one on screen?",
	 * and this is the one place the two are joined.
	 */
	setSurfaceKeyResolver(
		resolve: (view: WorkbenchView) => string | undefined,
	): void {
		this.surfaceKeyOfView = resolve;
		this.modals.reposition();
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

	/** The workbench the selection resolves to, whether or not it is shown. */
	private liveRevealed(): WorkbenchView | undefined {
		const revealed = this.revealed;
		if (!revealed || revealed.isDestroyed()) return undefined;
		return this.views.includes(revealed) ? revealed : undefined;
	}

	/**
	 * The workbench that is actually on screen.
	 *
	 * A workbench waiting for an answer outranks the selection: the question is
	 * about *that* workbench, and answering "do you want to save?" against a
	 * blank pane — or against another workspace — is not an arrangement anybody
	 * can act on. Everything outside its rectangle stays live, so the sidebar
	 * and the rest of the app are still usable while it stands.
	 *
	 * Otherwise it is whatever the selection resolves to, unless the page is
	 * showing a Surface of its own over the same rectangle.
	 */
	private onScreenView(): WorkbenchView | undefined {
		const asking = this.askingView();
		if (asking) return asking;
		if (this.contentSurface === "page") return undefined;
		return this.liveRevealed();
	}

	/**
	 * The workbench that has stopped to ask the person something, if one has.
	 *
	 * It outranks both the layout and the selection, and it does so for the same
	 * reason in both: a question about *that* workbench has to be shown against
	 * it and answered into it. Every other rule about what is on screen and
	 * where the keyboard is starts by asking this.
	 */
	private askingView(): WorkbenchView | undefined {
		const asking = this.modals.askingSurfaceKey();
		if (asking === undefined) return undefined;
		return this.views.find(
			(candidate) =>
				!candidate.isDestroyed() && this.surfaceKeyOfView(candidate) === asking,
		);
	}

	layout(): void {
		if (this.window.isDestroyed()) {
			return;
		}
		const bounds = this.currentRect();
		// A destroyed view is skipped rather than special-cased at each call:
		// there is no arrangement in which touching one is right.
		const live = this.views.filter((view) => !view.isDestroyed());
		const onScreen = this.onScreenView();
		// Bounds first, then visibility, and the shown one last of all: a view
		// made visible before it is sized shows its previous size for a frame.
		for (const view of live) {
			view.view.setBounds(bounds);
			if (view !== onScreen) view.view.setVisible(false);
		}
		if (onScreen) {
			// Re-adding an existing child moves it to the end of the list, which
			// is the top of the stack. Nothing else establishes that order.
			this.window.contentView.addChildView(onScreen.view);
			onScreen.view.setVisible(true);
		}
		// The modal layer is last, always: whatever this just decided about the
		// workbench, a question about it is above it.
		this.modals.reposition();
	}

	/**
	 * The invariant this class exists to keep: at most one workbench view is
	 * on screen, and if there is one it is the topmost child.
	 *
	 * Exposed so a test can assert it rather than assert the calls that
	 * happen to establish it today.
	 */
	visibleViews(): readonly WorkbenchView[] {
		return this.views.filter(
			(view) => !view.isDestroyed() && view.view.getVisible(),
		);
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
	palette: ShellPalette | undefined,
): ShellWindow {
	if (current) {
		throw new Error("the App Shell window already exists");
	}
	current = new ShellWindow(preloadPath, pageUrl, palette);
	return current;
}

/** Runs the App Shell page, once everything it will ask for exists. */
export function openShellPage(): void {
	shellWindow().openPage();
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
