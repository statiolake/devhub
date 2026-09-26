/**
 * The one real window DevHub has, and the one owner of what is in it.
 *
 * It shows the App Shell page — sidebar, titlebar, agents — and hosts every
 * other part of DevHub as a `WebContentsView` child: one workbench per
 * Workspace, the notices, the questions. All of them are equal children. Where
 * each one goes is not decided here: it is `windowLayout()`'s answer, a pure
 * function of the projection, the window's size and the two appearance
 * settings that move the chrome, and this class is what applies that answer to
 * Electron and what keeps the one piece of state it needs (`LayoutState`).
 *
 * The page reports nothing about geometry. It used to measure the hole it
 * leaves for a workbench and send the rectangle back, which made main's idea
 * of the layout a page's idea of the layout, one frame late, and made a window
 * resize a round trip through a renderer. The page is now *given* the hole.
 */

import { join } from "node:path";
import { electron } from "../electron.js";
import { allowListenersFor } from "./appListenerCeiling.js";
import { sendLinksToTheBrowser } from "./externalLinks.js";
import {
	keyboardChild,
	onScreenEditor,
	sidebarRect,
	surfaceRect,
	trafficLightPosition,
	windowLayout,
	workbenchRect,
	type ChildIdentity,
	type LayoutInput,
	type AttachedPlacement,
	type LayoutRect,
	type LayoutState,
} from "./windowLayout.js";
import type { TitleBarMode } from "../../model/config.js";
import type { SidebarAreaWire, WorkbenchAreaWire } from "../../ipc/contract.js";
import { WINDOW_TITLES, type ShellWindowKind } from "../../ipc/windowTitles.js";
import { ChromeView } from "./chromeView.js";
import { PickerView } from "./pickerView.js";
import { ToastsView } from "./toastsView.js";
import { TooltipView } from "./tooltipView.js";
import { shellTheme } from "./shellTheme.js";
import { scrimColor, type ShellPalette } from "../../ipc/palette.js";
import type { WorkbenchView } from "./workbenchView.js";
import type { Landing } from "./chords.js";

/**
 * The one window's construction options.
 *
 * A pure function so the shape can be read — and tested — without an app.
 *
 * **The mode is not among the arguments, and that is the point.** DevHub's
 * title bar has to be the Sidebar's colour, in both themes, and a native
 * `titleBarStyle: "default"` bar cannot be: it is painted by the window server
 * in the system's colour, from a palette DevHub does not hold. So the bar is
 * drawn by the page, and the window is the same window either way — a
 * `hiddenInset` window, which is a transparent bar with the traffic lights
 * inset and no title text of its own. `shown` and `hidden` are then two
 * arrangements of the *page*, and the whole of the difference between them is
 * in `data-title-bar`. See `TitleBarMode`.
 *
 * The lights are placed, not left where `hiddenInset` drops them: centred in
 * the bar DevHub draws, from that bar's height (`trafficLightPosition`). The
 * bar is the same band in both chromes, so the placement is too.
 */
export function shellWindowOptions(
	preloadPath: string,
	palette: ShellPalette | undefined,
): Electron.BrowserWindowConstructorOptions {
	return {
		width: 1440,
		height: 900,
		minWidth: 720,
		minHeight: 480,
		title: WINDOW_TITLES.shell,
		titleBarStyle: "hiddenInset",
		trafficLightPosition: trafficLightPosition(),
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
	};
}

/**
 * A view VS Code attached to one of its workbenches, as this window holds it.
 *
 * It is a **sibling** of the workbench in the window's child list, placed by
 * the owner like every other child. It cannot be a child of the workbench's
 * own view: a `WebContentsView` nested inside another `WebContentsView` is not
 * composited at all on macOS with this Electron — its renderer runs and
 * reports itself visible, and nothing is ever painted — and `capturePage()`
 * does not include child views either, so nothing automated can see it. The
 * same view at the same rectangle under `window.contentView` draws and
 * animates. See `docs/window-and-pages.md`.
 *
 * Being a sibling is what makes the two fields below necessary. VS Code
 * measures in the workbench's own document and writes bounds straight onto the
 * view it created, so those calls are intercepted where the workbench hands
 * out its container (`WorkbenchView.contentView`) and kept here as a *wish*:
 * where it would like to be, in the workbench's coordinates, and whether it
 * would like to be drawn. `windowLayout()` turns the pair into a rectangle in
 * the window and a visibility, and `place`/`draw` — the view's own methods,
 * captured before they were wrapped — are how that answer is applied.
 */
export interface AttachedChild {
	/** The view itself, as it goes into the window's child list. */
	readonly view: Electron.View;
	/** Where VS Code last asked for it, in its workbench's own document. */
	local: LayoutRect;
	/** Whether VS Code wants it drawn. */
	wish: boolean;
	/** The view's own `setBounds`, before the container wrapped it. */
	readonly place: (rect: Electron.Rectangle) => void;
	/** The view's own `setVisible`. */
	readonly draw: (visible: boolean) => void;
}

/** One attached view, and which workbench opened it. */
interface AttachedEntry {
	readonly id: number;
	readonly owner: WorkbenchView;
	readonly child: AttachedChild;
}

export class ShellWindow {
	readonly window: Electron.BrowserWindow;
	/**
	 * The chrome this window was built with.
	 *
	 * Not a fact about the `BrowserWindow` — both modes build the same one —
	 * but a fact about what is on screen, which is decided once at launch and
	 * cannot be asked for afterwards. A reading of DevHub that does not say
	 * which of the two shapes was up cannot be compared with another. See
	 * `--metrics`.
	 */
	readonly titleBar: TitleBarMode;

	private readonly views: WorkbenchView[] = [];
	/**
	 * Which folder each workbench is showing — the one table there is.
	 *
	 * It used to be two: this list of views, and a map of folder to view id in
	 * the controller. Two registries of the same set is two things that can
	 * disagree about it, and the layout is a function of both — so the binding
	 * lives beside the views, next to everything else that is a fact about the
	 * window's children.
	 *
	 * Bound after the view exists rather than at `attach`: a workbench is
	 * created by VS Code's own open path, through the shim, and only the caller
	 * that asked for the open knows what it asked for.
	 */
	private readonly editorKeyByViewId = new Map<number, string>();
	/**
	 * Everything the workbenches have attached to themselves, in the order it
	 * arrived. See `AttachedChild`.
	 */
	private readonly attached: AttachedEntry[] = [];
	/** Names the attached views apart for the owner; never reused. */
	private attachedCounter = 0;
	/** `keyboardChild`'s answer as of the last `layout()`. */
	private keyboardAnswer: string | undefined;
	/**
	 * What the arrangement is, as the model says.
	 *
	 * The only mutable input to the layout that is not the window's own size.
	 * It is pushed in whole by whoever holds the projection
	 * (`AppController.publishLayoutState`), so there is no half of it that can
	 * be updated without the other.
	 */
	private state: LayoutState = {
		titleBar: "shown",
		density: "compact",
		sidebar: { width: 248, collapsed: false },
		surface: { kind: "none" },
		// Nothing is on screen yet, so this is the answer that resolves to the
		// window's own page: there is no workbench for it to name.
		keyboard: "editor",
	};
	/** The workbench on screen as of the last pass, to notice it changing. */
	private onScreen: string | undefined;

	/**
	 * The layer every DevHub modal is drawn on.
	 *
	 * It belongs to the window rather than to any page because it is a fact
	 * about the window's child list: the last child paints on top, and that is
	 * the whole of what makes a modal a modal here.
	 */
	/**
	 * The chrome children this window has beside its workbenches.
	 *
	 * All four are built here, at startup, and never destroyed. Ordering is
	 * what `layout()` establishes and it is fixed: the Sidebar, every
	 * workbench, the Agents, then `toasts`, then `picker` — a question about
	 * something is above a notice about something, and both are above the
	 * thing.
	 *
	 * `sidebar` and `agents` are `ChromeView`s rather than layers: they are
	 * always in the window and the only thing that moves is their rectangle
	 * and whether they are drawn. See `chromeView.ts`.
	 */
	readonly sidebar: ChromeView;
	readonly agents: ChromeView;
	readonly toasts: ToastsView;
	readonly picker: PickerView;
	readonly tooltip: TooltipView;
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
	 * Told when the window came forward or went away.
	 *
	 * The model needs this and cannot see it: a `WebContentsView` keeps its DOM
	 * focus while the window behind it is deactivated, so no page in this window
	 * can tell whether the person is in front of it. It is a fact only main
	 * holds, and this is how it leaves.
	 */
	private windowFocusChanged: (focused: boolean) => void = () => undefined;

	/**
	 * The App Shell page's URL, held until `openPage` runs it.
	 *
	 * Creating the window and running its pages are two facts, not one. The
	 * window has to exist early — the controller is built around it, and it
	 * paints in the restored palette while the rest of startup happens — but a
	 * page starts asking the moment it mounts (the Agents page for every
	 * running Agent's terminal), and a request that arrives before the handler
	 * that answers it is a pane reporting a failure that never happened. So
	 * the pages are run by whoever finished the things they will ask for; see
	 * `bootstrapShell`. *Every* page in the window: this used to hold back the
	 * App Shell page alone, while its children ran from their constructors, so
	 * an Agent restored at launch attached before the terminal handlers
	 * existed and came back disconnected.
	 */
	private readonly pageUrl: string;
	private pageOpened = false;

	constructor(
		preloadDirectory: string,
		pageUrl: string,
		palette: ShellPalette | undefined,
		titleBar: TitleBarMode,
	) {
		this.titleBar = titleBar;
		this.state = { ...this.state, titleBar };
		// One preload per page, named after the page. What a page can spell is
		// what its own preload exposes and nothing else — see
		// `ipc/contract.ts`, where each page's bridge is an interface of its
		// own, and `preload/bridge.ts`, which is shared as source rather than
		// as a file because a sandboxed preload cannot `require` a chunk.
		const preloadFor = (page: ShellWindowKind) =>
			join(preloadDirectory, `${page}.js`);
		this.window = new electron.BrowserWindow(
			shellWindowOptions(preloadFor("shell"), palette),
		);

		sendLinksToTheBrowser(this.window.webContents);

		// Every child page is a file beside the App Shell page's own, served by
		// the same scheme out of the same directory. One entry each, and no
		// `?window=` role for either: which page a view is showing is decided
		// by which page main loads into it.
		const pageBase = pageUrl.slice(0, pageUrl.lastIndexOf("/"));

		// DevHub names this window, and only DevHub. Electron hands a page's
		// `document.title` to its window by default, which would let the
		// window's own page — which has no idea what is on screen — overwrite
		// a name that says which Workspace and which file are being worked on.
		this.window.on("page-title-updated", (event) => {
			event.preventDefault();
		});

		// Built before anything can ask for them, and their pages run with the
		// window's own in `openPage`. Creation used to be the first modal's
		// job, and the first modal of a session was drawn on a page that had
		// not run yet.
		this.sidebar = new ChromeView(
			preloadFor("sidebar"),
			`${pageBase}/sidebar.html`,
		);
		this.sidebar.adopt(this.window);
		this.agents = new ChromeView(
			preloadFor("agents"),
			`${pageBase}/agents.html`,
		);
		this.agents.adopt(this.window);
		this.toasts = new ToastsView(
			preloadFor("toasts"),
			`${pageBase}/toasts.html`,
		);
		this.toasts.adopt({
			window: this.window,
			sizeChanged: () => {
				this.layout();
			},
			focusSurface: () => this.focusSurface(),
		});
		// Built at startup like every other child, and never lazily. A tooltip
		// is asked for at the moment a pointer stops moving; a view created
		// then would have a page still loading when the sentence arrived, and
		// the first tooltip of a session would be the one that did not appear.
		this.tooltip = new TooltipView(
			preloadFor("tooltip"),
			`${pageBase}/tooltip.html`,
		);
		this.tooltip.adopt({
			window: this.window,
			tooltipChanged: () => {
				this.layout();
			},
		});
		this.picker = new PickerView(
			preloadFor("picker"),
			`${pageBase}/picker.html`,
		);
		this.picker.adopt({
			window: this.window,
			focusSurface: () => this.focusSurface(),
			focusModal: (contents) => this.focusModal(contents),
			modalsChanged: () => {
				// A question coming up takes the tooltip down, and it has to be
				// said here rather than left to the pointer. The Sidebar hides
				// its tooltip when the pointer leaves the row, which covers a
				// question opened by clicking something — but a question opened
				// from the keyboard, with the pointer still resting on a row,
				// leaves the pointer exactly where it was. Measured: the
				// tooltip stayed up and stood over the sheet.
				//
				// So it is the window's rule, decided where the modal set is
				// known, and it is one direction only: a tooltip is about a row
				// behind a modal the person has to answer first, which makes it
				// a sentence about something they cannot act on.
				this.tooltip.hide();
				this.layout();
				// A modal owns the keyboard while it stands, so every workbench
				// loses focus when one opens and the one on screen gets it back
				// when the last one goes.
				this.publishFocus();
			},
		});

		this.pageUrl = pageUrl;
		this.window.once("ready-to-show", () => this.window.show());
		this.window.on("resize", () => this.layout());
		// Light or dark, or Reduce Transparency, changing under a question
		// changes its dim. See `scrim`.
		const appearanceChanged = (): void => {
			this.layout();
		};
		electron.nativeTheme.on("updated", appearanceChanged);
		this.window.once("closed", () => {
			electron.nativeTheme.off("updated", appearanceChanged);
		});

		// Coming back to DevHub puts the keyboard where it belongs.
		//
		// macOS restores focus to whatever held it when the app was last in
		// front, which is not the same question as "what is on screen now" — a
		// workbench that was revealed while the app was in the background would
		// be looked at while the keys went somewhere else. `focusSurface` is
		// already the one answer to that question, so it is asked again here
		// rather than a second rule being written for this case.
		this.window.on("focus", () => {
			this.focusSurface();
			this.windowFocusChanged(true);
		});

		// Going away is as much a fact about a workbench's focus as coming back,
		// and it is the half nothing was reporting. A `WebContentsView` keeps
		// its DOM focus when the window behind it is deactivated, so the
		// workbench went on believing it had the keyboard for as long as DevHub
		// was in the background — which is what made a workbench act on a focus
		// it did not have, and made coming back emit nothing, because as far as
		// the workbench was concerned nothing had changed. `focusSurface` is not
		// the right answer here: the keyboard should stay exactly where it is
		// while the app is away, and only the *reporting* of it changes.
		this.window.on("blur", () => {
			this.publishFocus();
			this.windowFocusChanged(false);
		});

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

	/**
	 * Runs every page in the window: its own and each child's, together.
	 * Calling it twice is a bug, not a reload.
	 */
	openPage(): void {
		if (this.pageOpened) {
			throw new Error("the App Shell page has already been opened");
		}
		this.pageOpened = true;
		void this.window.loadURL(this.pageUrl);
		this.sidebar.openPage();
		this.agents.openPage();
		this.toasts.openPage();
		this.tooltip.openPage();
		this.picker.openPage();
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
		// The questions' dim follows the palette's half; see `scrim`.
		this.layout();
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
		// A workbench arrives with helper processes of its own, and each of
		// those puts a listener on `electron.app`. See `appListenerCeiling`.
		allowListenersFor(this.views.length);
		this.window.contentView.addChildView(view.view);
		view.view.setBounds(this.workbenchRect());
		view.view.setVisible(false);
		// A view whose contents are gone is not a view. It leaves this table the
		// instant that happens, before anything can be asked to lay it out or
		// raise it — Electron answers that with "can't add a destroyed child
		// view to a parent view", which is a true statement about a table that
		// should never have still contained it. The view says so itself, from
		// the one teardown every ending of it runs (`WorkbenchView.end`), so
		// that leaving this table and dropping its subscriptions are the same
		// moment rather than two listeners racing to be first.
		//
		// A workbench renames itself whenever its active editor changes; that
		// is the Editor's half of the window's name arriving.
		view.webContents.on("page-title-updated", () => {
			this.titleChanged();
		});
		// The keyboard actually arriving, as opposed to main having asked for
		// it. These two facts are not the same moment and the gap is where the
		// workspace trust prompt was lost; `WorkbenchView.focusConfirmed` is
		// where the whole of the reasoning is written down. The answer itself
		// is still the one `isSurfaceFocused` computes — this only says when
		// it is worth saying again.
		view.webContents.on("focus", () => {
			this.publishFocus();
			view.focusConfirmed();
		});
		view.webContents.on("blur", () => {
			this.publishFocus();
		});
	}

	detach(view: WorkbenchView): void {
		const index = this.views.indexOf(view);
		if (index === -1) {
			return;
		}
		this.views.splice(index, 1);
		// Whatever this workbench opened inside itself goes with it, and goes
		// first: they are siblings in the window's child list, so nothing takes
		// them out of it when the workbench leaves except this.
		this.detachChildrenOf(view);
		// The binding is deliberately *not* dropped here. "There is no view for
		// this folder any more" and "DevHub let this folder's workbench go" are
		// two different facts, and the supervisor tells a crash from a close by
		// asking whether the binding still names the view that died. It is
		// unbound by whoever decided to let it go, which is the whole of what
		// deciding to let it go means.
		allowListenersFor(this.views.length);
		shellTheme().forgetWindow(view.id);
		// Every view goes when the window goes, and by then there is no window
		// left to take them out of: Electron answers a child-view call on a
		// destroyed window with "Object has been destroyed", which is how
		// quitting DevHub ended in an uncaught exception in main. The
		// bookkeeping above is still true and still has to happen; what is
		// below is about a window on screen, and there is none.
		if (this.window.isDestroyed()) {
			return;
		}
		this.window.contentView.removeChildView(view.view);
		this.layout();
		// The view that left is told too, and told first: it is off the table
		// now, so nothing else would ever ask it again, and a workbench that
		// was detached while it held the keyboard would keep believing it does.
		view.focusStateChanged();
		this.publishFocus();
	}

	getViews(): readonly WorkbenchView[] {
		return this.views;
	}

	//#endregion

	//#region the views a workbench attaches to itself

	/**
	 * Take a view a workbench opened into the window, as a sibling of it.
	 *
	 * Called from `WorkbenchView.contentView`'s container, which is what VS
	 * Code believes is the window's own content view. Adding the same view
	 * twice is not an error and not a duplicate: upstream's `BrowserView`
	 * re-adds its view whenever it thinks it has moved window, and the child
	 * list order is this class's answer rather than the caller's, re-stated on
	 * every `layout()`.
	 */
	attachChild(owner: WorkbenchView, child: AttachedChild): void {
		if (this.attached.some((entry) => entry.child.view === child.view)) return;
		this.attachedCounter += 1;
		this.attached.push({ id: this.attachedCounter, owner, child });
		if (this.window.isDestroyed()) return;
		this.window.contentView.addChildView(child.view);
		// Never drawn where it happens to have been left: it is placed by the
		// owner, on the next pass, and until then it is not on screen.
		child.draw(false);
		this.layout();
	}

	/** Let one go again — the browser editor closing, or moving away. */
	detachChild(view: Electron.View): void {
		const index = this.attached.findIndex((entry) => entry.child.view === view);
		if (index === -1) return;
		this.attached.splice(index, 1);
		if (this.window.isDestroyed()) return;
		this.window.contentView.removeChildView(view);
		this.layout();
	}

	/** What a workbench has attached, for the container it hands VS Code. */
	attachedChildren(owner: WorkbenchView): readonly Electron.View[] {
		return this.attached
			.filter((entry) => entry.owner === owner)
			.map((entry) => entry.child.view);
	}

	/**
	 * A workbench ending takes everything it opened with it.
	 *
	 * The views themselves are VS Code's to destroy — `BrowserView.dispose`
	 * closes their contents when the window they belong to closes. What is
	 * this class's is that they stop being children of the window the instant
	 * the workbench does, so that nothing is laid out against a workbench that
	 * is no longer in the list.
	 */
	private detachChildrenOf(owner: WorkbenchView): void {
		for (const entry of [...this.attached]) {
			if (entry.owner !== owner) continue;
			this.attached.splice(this.attached.indexOf(entry), 1);
			if (this.window.isDestroyed()) continue;
			this.window.contentView.removeChildView(entry.child.view);
		}
	}

	/** The view the owner named, if it is still attached. */
	private attachedEntry(id: number): AttachedEntry | undefined {
		return this.attached.find((entry) => entry.id === id);
	}

	/** The owner's view of what is attached, for `layoutInput`. */
	private attachedPlacements(): readonly AttachedPlacement[] {
		const placements: AttachedPlacement[] = [];
		for (const entry of this.attached) {
			if (entry.owner.isDestroyed()) continue;
			const editorKey = this.editorKeyOf(entry.owner);
			// A workbench that has not been told what folder it is showing is
			// not in the layout's list of editors, so nothing it opened can be
			// placed against it yet. It is swept hidden by `layout()`.
			if (editorKey === undefined) continue;
			placements.push({
				id: entry.id,
				editorKey,
				rect: entry.child.local,
				visible: entry.child.wish,
			});
		}
		return placements;
	}

	//#endregion

	//#region the views

	/**
	 * Say which folder a workbench is showing.
	 *
	 * The one table, written by the one caller that knows: a view is made by VS
	 * Code's own open path and arrives here through the shim with nothing said
	 * about what was asked for.
	 */
	bindEditorKey(viewId: number, editorKey: string): void {
		this.editorKeyByViewId.set(viewId, editorKey);
		this.layout();
	}

	/** Forget a binding without ending the view — a view that died, replaced. */
	unbindEditorKey(editorKey: string): void {
		for (const [viewId, key] of [...this.editorKeyByViewId]) {
			if (key === editorKey) this.editorKeyByViewId.delete(viewId);
		}
	}

	editorKeyOf(view: WorkbenchView): string | undefined {
		return this.editorKeyByViewId.get(view.id);
	}

	/**
	 * The id bound to a folder, whether or not that view is still alive.
	 *
	 * Separate from `viewForEditorKey` because they answer different
	 * questions: this one is "what did DevHub open for this folder", which a
	 * supervisor watching a view die has to be able to ask about the view that
	 * just died.
	 */
	editorViewId(editorKey: string): number | undefined {
		for (const [viewId, key] of this.editorKeyByViewId) {
			if (key === editorKey) return viewId;
		}
		return undefined;
	}

	/** Every folder bound to a view, alive or not, with that view's id. */
	editorBindings(): readonly (readonly [string, number])[] {
		return [...this.editorKeyByViewId].map(([viewId, key]) => [key, viewId]);
	}

	/** The workbench showing a folder, if one is built and still alive. */
	viewForEditorKey(editorKey: string): WorkbenchView | undefined {
		for (const [viewId, key] of this.editorKeyByViewId) {
			if (key !== editorKey) continue;
			const view = this.getViewById(viewId);
			if (view && !view.isDestroyed()) return view;
		}
		return undefined;
	}

	/** Every folder that has a workbench, in the order they were built. */
	editorKeys(): readonly string[] {
		return this.views
			.filter((view) => !view.isDestroyed())
			.map((view) => this.editorKeyByViewId.get(view.id))
			.filter((key): key is string => key !== undefined);
	}

	getViewById(id: number): WorkbenchView | undefined {
		return this.views.find((view) => view.id === id);
	}

	/**
	 * The view those contents belong to, asked for by the contents themselves.
	 *
	 * A view's id is not its contents' id — see `WorkbenchView.id` — so this is
	 * the only way to go from one to the other, and the two questions stay two
	 * methods rather than one method with a number that means either.
	 */
	getViewByContents(contents: Electron.WebContents): WorkbenchView | undefined {
		return this.views.find((view) => view.webContents === contents);
	}

	/**
	 * Ask the arrangement again — VS Code's `show`, `moveTop` and `focus`.
	 *
	 * It used to *put that workbench on screen*, which made whichever of them
	 * VS Code happened to touch the one being looked at. What is on screen is a
	 * function of the selection and nothing else, so this is a request to run
	 * the same decision again rather than a request to win it: a deselected
	 * workspace's extension calling `window.focus()` must not change what the
	 * person is looking at, and a workbench that has just finished loading must
	 * not take the screen from the one that was asked for.
	 */
	assertArrangement(): void {
		this.layout();
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
	 * Window-level focus is not touched here, and cannot be: `placeKeyboardIn`
	 * declines outright while any other window is in front. Whether DevHub
	 * should come to the front is a different question with one answer,
	 * `raise`, and only the paths that carry a person's intent ask it.
	 */
	focusSurface(landing?: Landing): void {
		if (this.window.isDestroyed()) return;
		this.placeTheKeyboard();
		// Reported after the keyboard has been placed, never before, and
		// reported in every case — including the ones `placeTheKeyboard`
		// declines, because a modal standing up is precisely when every
		// workbench stops having focus.
		//
		// The order is not cosmetic. A workbench hears about this as an
		// `electron.app` focus event (see `WorkbenchView`), and what upstream
		// does with that event is go and read `document.hasFocus()` in the
		// renderer — so an announcement sent before `focus()` had moved
		// anything would be answered with the state it was about to leave.
		this.publishFocus();
		if (landing === "terminal") this.landInTerminal();
	}

	/**
	 * The shell of the workbench the keyboard has just been placed in, for a
	 * move that lands there (`Landing` in `chords.ts`).
	 *
	 * Asked by the placement that ends the move and by nothing later, so there
	 * is nothing to keep between the asking and the landing: the move changed
	 * the model, the model published the arrangement, and the keyboard was
	 * placed, all before this line. When the keys did not arrive in a
	 * workbench — the move landed on an Agent, the workbench is starting or
	 * gone, a question is standing, DevHub is not in front — there is no shell
	 * of anything to focus, and the landing is simply not had; the move still
	 * happened.
	 */
	private landInTerminal(): void {
		const view = this.views.find(
			(candidate) =>
				!candidate.isDestroyed() && this.isSurfaceFocused(candidate),
		);
		if (!view) return;
		// The workbench's own command, forwarded over upstream's own door for
		// main (`vscode:runAction`) — the same one `Cmd+Q T` goes through. It
		// creates a terminal when there is none, which is what a person asking
		// for the shell of an editor that has not had one wants.
		view.webContents.send("vscode:runAction", {
			id: "workbench.action.terminal.focus",
			from: "menu",
		});
	}

	/** The half of `focusSurface` that actually moves the keyboard. */
	private placeTheKeyboard(): void {
		// A modal owns the keyboard for as long as it stands; it is on top of
		// everything this method can see, and taking focus out of it would leave
		// a dialog on screen that no key reaches. This is a question about
		// *which* contents, not about whether DevHub may take the front, which
		// is why it is here and not in `mayPlaceTheKeyboard` — the modal layer
		// places its own keyboard through the same gate.
		//
		// It is placed *in* the layer rather than left alone. Standing aside
		// read as "the modal already has it", and that was not the same fact:
		// coming back to DevHub with a sheet standing arrives here through the
		// window's `focus` event, macOS having restored the keyboard to
		// whatever held it before — measured, the App Shell page — and standing
		// aside left the sheet on screen with the keys going behind it.
		if (this.picker.isPresent()) {
			const modal = this.picker.contents();
			if (modal) this.placeKeyboardIn(modal);
			return;
		}
		this.placeKeyboardIn(this.focusTarget());
	}

	/**
	 * Move the keyboard into one of this window's contents — the one gate, and
	 * the only place in DevHub that calls `webContents.focus()`.
	 *
	 * `webContents.focus()` on macOS does not only move DOM focus: it makes
	 * the window those contents belong to the key window, which activates
	 * DevHub. So every caller of it is a caller that can put the App Shell
	 * window in front of whatever the person was actually looking at, and this
	 * window is asked to put the keyboard back a great deal more often than
	 * anybody would want to be interrupted:
	 *
	 * - `setLayoutState`, which follows every projection change — an Agent
	 *   ticking, a HEAD moving, a workspace finishing its open. Measured on an
	 *   idle instance: the window went to the background and DevHub called
	 *   `focus()` on the workbench 5ms later.
	 * - the window's own `focus` event, coming back from another app.
	 * - `PickerView.place`, when the last sheet goes.
	 * - `WorkbenchView.focus`, which is VS Code's `hostService.focus()` →
	 *   `nativeHostMainService.focusWindow` → `CodeWindow.focus()` arriving
	 *   through the proxy. VS Code calls it on hover and on drag
	 *   (`workbench/browser/dnd.ts`), on `window.focus()` from an extension,
	 *   on `workbench.action.focusWindow`, and from
	 *   `enableWindowFocusOnElementFocus` whenever anything inside a workbench
	 *   focuses an element while the workbench does not have the keyboard.
	 * - `WorkbenchView.moveTop` and `show`, which are `windowsMainService`'s
	 *   open and focus paths, and which reach `reveal` above.
	 *
	 * Not one of those is a person asking DevHub to come forward. So none of
	 * them may: the keyboard is placed *within the window that already has
	 * focus*, and while anything else is in front — another app, the Settings
	 * window, an undocked Web Inspector — this does nothing at all. The one
	 * way DevHub comes forward is `raise`, and after a raise the window's own
	 * `focus` event asks this again, which is what makes declining safe rather
	 * than lossy.
	 *
	 * This subsumes two guards written for single symptoms of it. The Settings
	 * window (`4a260bf`) is somebody else's window and is now covered by being
	 * somebody else's window. An undocked Web Inspector is a window too. The
	 * *docked* inspector is the one case the window's own focus cannot
	 * distinguish — it is a view onto these same contents in this same
	 * window — so it keeps a line of its own.
	 */
	private placeKeyboardIn(contents: Electron.WebContents): void {
		if (!this.mayPlaceTheKeyboard()) return;
		contents.focus();
	}

	/** Whether moving the keyboard would be moving it, rather than raising. */
	private mayPlaceTheKeyboard(): boolean {
		if (this.window.isDestroyed()) return false;
		if (!this.window.isFocused()) return false;
		if (this.window.webContents.isDevToolsFocused()) return false;
		return true;
	}

	/**
	 * The one place DevHub brings its own window to the front.
	 *
	 * Raising is a person's decision, never the app's, so this is called from
	 * the paths that carry one and from nowhere else: a `devhub` command line
	 * (`AppController.activateFromCli`, `openFromCli`, `addAgentFromCli`), and
	 * the Dock or Cmd-Tab activating DevHub itself while its window is put
	 * away (`raiseFromAppActivation`). Everything else places the keyboard
	 * through `placeKeyboardIn` and leaves the front alone.
	 *
	 * The keyboard is not placed here. The window's own `focus` event does
	 * that, once macOS has actually made it key — asking in the same tick as
	 * `focus()` asks before the activation has landed.
	 */
	raise(): void {
		if (this.window.isDestroyed()) return;
		this.window.show();
		this.window.focus();
		electron.app.focus({ steal: true });
	}

	/**
	 * macOS activated DevHub — the Dock icon, Cmd-Tab, `open -b`.
	 *
	 * Only a window that was put away needs anything from this. `activate` is
	 * every activation of the *application*, including the one a click on the
	 * Settings window causes when DevHub was not in front, and answering that
	 * by raising a different window than the one clicked is how Settings
	 * became impossible to reach (`4a260bf`). macOS has already brought the
	 * clicked window forward, and a Dock click brings every visible window
	 * forward on its own.
	 */
	raiseFromAppActivation(): void {
		if (this.window.isDestroyed() || this.window.isVisible()) return;
		this.raise();
	}

	/**
	 * VS Code asking for the keyboard on behalf of one workbench.
	 *
	 * `CodeWindow.focus()` for a workbench arrives here through the proxy. It
	 * is a request to type into that workbench, never a request to activate
	 * DevHub, and it is only honoured for the workbench that is on screen: a
	 * deselected workspace's extension calling `window.focus()` must not
	 * change what the person is looking at.
	 */
	focusWorkbench(view: WorkbenchView): void {
		if (this.focusTarget() !== view.webContents) return;
		this.focusSurface();
	}

	/** The modal layer's keyboard, placed through the same gate. */
	focusModal(contents: Electron.WebContents): void {
		this.placeKeyboardIn(contents);
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
	 * the editor. `LayoutState.keyboard` is the other half of the arrangement
	 * for exactly that reason, and `keyboardChild` is where the two are read
	 * together — one answer, in the same place the layout is decided.
	 */
	focusTarget(): Electron.WebContents {
		return this.contentsOf(keyboardChild(this.layoutInput()));
	}

	/** A child of the layout, as the contents the keyboard can be put in. */
	private contentsOf(identity: ChildIdentity): Electron.WebContents {
		switch (identity.kind) {
			case "shell":
				return this.window.webContents;
			case "sidebar":
				return this.sidebar.contents() ?? this.window.webContents;
			case "agents":
				return this.agents.contents() ?? this.window.webContents;
			case "toasts":
				return this.toasts.contents() ?? this.window.webContents;
			case "picker":
				return this.picker.contents() ?? this.window.webContents;
			case "editor":
				return (
					this.viewForEditorKey(identity.editorKey)?.webContents ??
					this.window.webContents
				);
			case "tooltip":
			case "attached":
				// There is nothing in a tooltip to type into, and a view a
				// workbench opened inside itself takes the keyboard from VS
				// Code rather than from DevHub — the browser is focused by the
				// editor that owns it. `keyboardChild` names neither. Reaching
				// here means the one answer to "where do the keys go" has
				// started giving an answer that is not a place DevHub can put
				// them, which is a broken invariant rather than a case to
				// handle.
				throw new Error(
					`the keyboard cannot be put in the ${identity.kind} view`,
				);
		}
	}

	/**
	 * Whether a workbench is the one being typed into — the whole question, and
	 * the only place it is answered.
	 *
	 * A workbench is a `WebContentsView`, not a window, so `webContents`'
	 * own idea of focus is about DOM focus inside itself and knows nothing
	 * about the two facts that actually decide it: whether DevHub is the app in
	 * front, and which of this window's several contents `focusSurface` put the
	 * keyboard in. Asked on its own it says "focused" for a workbench sitting
	 * behind an Agent's terminal, and for one in a window the person switched
	 * away from an hour ago.
	 *
	 * So it is composed from the same state the focus itself is a function of.
	 * `focusTarget` is already the single answer to "where do the keys go", and
	 * this is the same answer read back — which is what makes "the workbench
	 * believes it has focus" and "the workbench has focus" the same sentence
	 * rather than two that drift.
	 *
	 * A modal takes it from everybody: it owns the keyboard for as long as it
	 * stands, which is exactly what `focusSurface` refuses to override.
	 */
	isSurfaceFocused(view: WorkbenchView): boolean {
		if (this.window.isDestroyed() || view.isDestroyed()) return false;
		if (!this.window.isFocused()) return false;
		if (this.picker.isPresent()) return false;
		return this.focusTarget() === view.webContents;
	}

	/**
	 * Tell every workbench to look again at whether it has the keyboard.
	 *
	 * Called from everywhere that can change the answer, rather than from the
	 * places that happen to be convenient: the window coming forward or going
	 * away, the surface moving, a modal opening or closing, a view leaving. A
	 * workbench cannot see any of those for itself — that is the whole reason
	 * `hostService.hasFocus` was wrong — so nothing may quietly skip this.
	 */
	private publishFocus(): void {
		for (const view of [...this.views]) {
			view.focusStateChanged();
		}
	}

	/** The view on screen, if there is one and it still exists. */
	revealedView(): WorkbenchView | undefined {
		const editorKey = onScreenEditor(this.layoutInput());
		return editorKey === undefined
			? undefined
			: this.viewForEditorKey(editorKey);
	}

	isRevealed(view: WorkbenchView): boolean {
		return this.revealedView() === view;
	}

	//#endregion

	//#region layout

	/**
	 * What the arrangement is, said by whoever holds the projection.
	 *
	 * The whole state at once, and the only way it moves. Two channels used to
	 * carry halves of it up from the page — a measured rectangle and a word for
	 * what was in the content area — and the second of those was answering two
	 * questions with one word: whether to draw a workbench, and whether that
	 * workbench is what is being typed into. In a split those have different
	 * answers, and they are two fields here.
	 */
	setLayoutState(state: LayoutState): void {
		const before = JSON.stringify(this.state);
		this.state = state;
		if (JSON.stringify(state) === before) return;
		this.layout();
		// Revealing a surface is a request to type into it, and only main can
		// take the keyboard off the workbench view that had it.
		this.focusSurface();
	}

	/** What the arrangement is now — read back by whoever composes the page's. */
	layoutState(): LayoutState {
		return this.state;
	}

	/**
	 * Register the one reader of "is DevHub the window in front".
	 *
	 * Registering it publishes the current answer, so the reader starts in step
	 * with the window rather than with whatever it assumed.
	 */
	onWindowFocusChanged(changed: (focused: boolean) => void): void {
		this.windowFocusChanged = changed;
		changed(!this.window.isDestroyed() && this.window.isFocused());
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
		this.layout();
	}

	/**
	 * The rectangle a workbench is laid into, for a caller outside this class.
	 *
	 * VS Code asks a window for its bounds, and this is the honest answer for a
	 * workbench: the hole the App Shell page leaves for it. It is computed, not
	 * measured — see `windowLayout.ts`.
	 */
	workbenchRect(): LayoutRect {
		return workbenchRect(this.windowSize(), this.state);
	}

	/**
	 * The workbench's rectangle, and how wide the content area around it is.
	 *
	 * What the window's own page is told, and the whole of what it knows about
	 * where anything is. The second number is there so the page never has to
	 * ask its own document how wide the window is: a view's `innerWidth` is
	 * stale for a frame after main moves it, and the split ratio is a ratio of
	 * this width.
	 */
	/**
	 * The Sidebar's own rectangle, for the Sidebar.
	 *
	 * A page cannot work this out and must not try. `window.screenX` is the
	 * screen's and needs the window's origin subtracted back off;
	 * `documentElement`'s box is the view's own and is stale for a while after
	 * main moves it — measured, the collapsed Sidebar went on answering 249
	 * for seconds after being narrowed to 76. The Sidebar needs it for exactly
	 * one thing: saying where one of its rows is *in the window*, so that a
	 * tooltip can be placed against the window rather than against the column.
	 *
	 * Told rather than asked, like the workbench area and for the same reason.
	 */
	sidebarArea(): SidebarAreaWire {
		return sidebarRect(this.windowSize(), this.state);
	}

	workbenchArea(): WorkbenchAreaWire {
		return {
			...this.workbenchRect(),
			contentWidth: surfaceRect(this.windowSize(), this.state).width,
		};
	}

	boundsOf(_view: WorkbenchView): Electron.Rectangle {
		return this.workbenchRect();
	}

	/**
	 * The dim behind a question, in the half of the palette the pages are
	 * wearing: the theme's when there is one, and otherwise the system's,
	 * which is what `color-scheme: light dark` resolves to on a page served
	 * without one.
	 */
	private scrim(): string {
		const theme = electron.nativeTheme;
		const base =
			shellTheme().palette()?.base ??
			(theme.shouldUseDarkColors ? "dark" : "light");
		return scrimColor(base, theme.prefersReducedTransparency);
	}

	private windowSize(): { width: number; height: number } {
		if (this.window.isDestroyed()) return { width: 0, height: 0 };
		const [width, height] = this.window.getContentSize();
		return { width, height };
	}

	/** Everything the layout is a function of, gathered in one place. */
	private layoutInput(): LayoutInput {
		return {
			windowSize: this.windowSize(),
			state: this.state,
			editors: this.editorKeys(),
			asking: this.askingEditorKey(),
			toasts: this.toasts.contentSize(),
			picker: this.picker.scope(),
			tooltip: this.tooltip.placement(),
			attached: this.attachedPlacements(),
		};
	}

	/**
	 * Which workbench is on screen, for a reader outside this class.
	 *
	 * The view itself cannot answer it: `WorkbenchView.isVisible` is about the
	 * *window* being shown and deliberately stays true for a workbench nobody
	 * has selected (see its comment — VS Code opens DevTools by itself if a
	 * loaded window says it is neither visible nor minimized). Which one is
	 * on screen is the layout's answer, so this is where it is read.
	 */
	onScreenViewId(): number | undefined {
		return this.revealedView()?.id;
	}

	/**
	 * The folder whose workbench has stopped to ask the person something.
	 *
	 * The question names a surface key, which is the model's name for the
	 * workbench; the layout speaks in folders, which is the window's. This is
	 * the one place the two are joined.
	 */
	private askingEditorKey(): string | undefined {
		const asking = this.picker.askingSurfaceKey();
		if (asking === undefined) return undefined;
		const view = this.views.find(
			(candidate) =>
				!candidate.isDestroyed() && this.surfaceKeyOfView(candidate) === asking,
		);
		return view === undefined ? undefined : this.editorKeyOf(view);
	}

	/**
	 * Put every child where the owner says it goes.
	 *
	 * The order of the list *is* the z-order, and it is established the one way
	 * Electron offers: re-adding an existing child moves it to the end of the
	 * child list, which is the top of the stack. So the visible children are
	 * re-added in order, lowest first, on every pass. Bounds are set before
	 * visibility and the shown children last of all — a view made visible
	 * before it is sized shows its previous size for a frame.
	 *
	 * The App Shell page is the first child in the list and the only one that
	 * is not a `WebContentsView`: it is the window's own page, which is always
	 * under every child view and always the whole window. Nothing to apply, and
	 * it is in the list because the layout has to be able to say the keyboard
	 * belongs to it.
	 */
	layout(): void {
		if (this.window.isDestroyed()) {
			return;
		}
		const children = windowLayout(this.layoutInput());
		// Bounds first, and every child that is not drawn hidden, before
		// anything is shown: a view made visible before it is sized shows its
		// previous size for a frame.
		for (const child of children) {
			if (child.identity.kind === "agents" && !child.visible) {
				// Sized while hidden, for the reason a workbench is: a view
				// shown at the size it had when it was last hidden lays itself
				// out against that size first, and an xterm reflows visibly
				// when it catches up.
				this.agents.place(this.window, child.rect, false);
				continue;
			}
			if (child.identity.kind === "attached") {
				const entry = this.attachedEntry(child.identity.id);
				if (!entry) continue;
				entry.child.place(child.rect);
				if (!child.visible) entry.child.draw(false);
				continue;
			}
			if (child.identity.kind !== "editor") continue;
			const view = this.viewForEditorKey(child.identity.editorKey);
			if (!view) continue;
			view.view.setBounds(child.rect);
			if (!child.visible) view.view.setVisible(false);
		}
		// Anything attached that the owner said nothing about is not on screen:
		// a view opened by a workbench that has not been bound to a folder yet,
		// which is the one case the list cannot name. Absence from the list is
		// how the owner says "not drawn", here as everywhere else.
		const placed = new Set(
			children
				.map((child) =>
					child.identity.kind === "attached" ? child.identity.id : undefined,
				)
				.filter((id): id is number => id !== undefined),
		);
		for (const entry of this.attached) {
			if (!placed.has(entry.id)) entry.child.draw(false);
		}
		// A workbench that exists but has not been told what folder it is
		// showing yet is still a child of this window, and still has to be
		// sized: it would otherwise sit at its creation bounds until the open
		// that made it came back, which is a whole workbench start's worth of
		// wrong size. It is never the one on screen.
		const rect = this.workbenchRect();
		for (const view of this.views) {
			if (view.isDestroyed() || this.editorKeyOf(view) !== undefined) continue;
			view.view.setBounds(rect);
			view.view.setVisible(false);
		}
		// The children, in the list's own order, lowest first. That
		// order *is* the z-order and this is the one way Electron offers to
		// establish it: re-adding an existing child moves it to the end of the
		// child list, which is the top of the stack.
		for (const child of children) {
			switch (child.identity.kind) {
				case "shell":
					// The window's own page: always under every child view and
					// always the whole window. It is in the list because the
					// layout has to be able to say the keyboard belongs to it.
					break;
				case "sidebar":
					this.sidebar.place(this.window, child.rect, child.visible);
					break;
				case "agents":
					this.agents.place(this.window, child.rect, child.visible);
					break;
				case "toasts":
					this.toasts.place(child.rect, child.visible);
					break;
				case "picker":
					this.picker.place(child.rect, child.visible, this.scrim());
					break;
				case "tooltip":
					this.tooltip.place(child.rect, child.visible);
					break;
				case "editor": {
					if (!child.visible) break;
					const view = this.viewForEditorKey(child.identity.editorKey);
					if (!view) break;
					this.window.contentView.addChildView(view.view);
					view.view.setVisible(true);
					break;
				}
				case "attached": {
					if (!child.visible) break;
					const entry = this.attachedEntry(child.identity.id);
					if (!entry) break;
					this.window.contentView.addChildView(entry.child.view);
					entry.child.draw(true);
					break;
				}
			}
		}

		// A different workbench on screen is a different file in the window's
		// name and a different colour theme for the shell. Said here, once,
		// because this is the one place that decides it — it used to be said by
		// `reveal`, which was one of several ways it could change.
		const onScreen = onScreenEditor(this.layoutInput());
		if (onScreen !== this.onScreen) {
			this.onScreen = onScreen;
			this.titleChanged();
			shellTheme().selectionChanged();
		}

		// Where the keys go is a function of the same input, and it moves with
		// it — not only with the arrangement. A workbench that was chosen
		// before it existed (a folder just opened, one on another machine, one
		// being rebuilt) changes the answer by arriving, and nothing else
		// would put the keyboard in it: it went to the window's own page while
		// there was nothing else, and stayed there. Asked only when the answer
		// changed, so a pass that moves nothing about the keyboard — a
		// tooltip, a resize — never takes it out of wherever the person put it.
		const keyboard = JSON.stringify(keyboardChild(this.layoutInput()));
		if (keyboard !== this.keyboardAnswer) {
			this.keyboardAnswer = keyboard;
			this.focusSurface();
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

/**
 * Whether DevHub is on its way out.
 *
 * Asked by anything that reacts to something *ending*. Every workbench, every
 * terminal and every host ends when DevHub quits, and none of those endings is
 * news: there is no page left to tell and nothing left to restart. Without it,
 * a workbench dying on the way out was reported as a crash and scheduled for
 * a restart into a shell that no longer existed.
 */
export function isQuitting(): boolean {
	return quitting;
}

export function createShellWindow(
	preloadDirectory: string,
	pageUrl: string,
	palette: ShellPalette | undefined,
	titleBar: TitleBarMode,
): ShellWindow {
	if (current) {
		throw new Error("the App Shell window already exists");
	}
	current = new ShellWindow(preloadDirectory, pageUrl, palette, titleBar);
	return current;
}

/** Runs every page in the App Shell window, once everything they ask for exists. */
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
