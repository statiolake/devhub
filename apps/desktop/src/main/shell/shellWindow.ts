/**
 * The one real window DevHub has, and the one owner of what is in it.
 *
 * It shows the App Shell page — sidebar, titlebar, agents — and hosts every
 * other part of DevHub as a `WebContentsView` child: one editor area per
 * Workspace, the notices, the questions. All of them are equal children. Where
 * each one goes is not decided here: it is `windowLayout()`'s answer, a pure
 * function of the projection, the window's size and the two appearance
 * settings that move the chrome, and this class is what applies that answer to
 * Electron and what keeps the one piece of state it needs (`LayoutState`).
 *
 * The page reports nothing about geometry. It used to measure the hole it
 * leaves for the editor and send the rectangle back, which made main's idea
 * of the layout a page's idea of the layout, one frame late, and made a window
 * resize a round trip through a renderer. The page is now *given* the hole.
 */

import { join } from "node:path";
import { electron } from "../electron.js";
import { sendLinksToTheBrowser } from "./externalLinks.js";
import {
	keyboardChild,
	terminalExtent,
	terminalSeam,
	terminalStacked,
	sidebarOverlayHolds,
	sidebarRect,
	surfaceRect,
	trafficLightPosition,
	windowLayout,
	workbenchRect,
	type ChildIdentity,
	type LayoutInput,
	type LayoutState,
} from "./windowLayout.js";
import type { TitleBarMode } from "../../model/config.js";
import {
	CHANNELS,
	type SidebarAreaWire,
	type SidebarPointerWire,
	type WorkbenchAreaWire,
} from "../../ipc/contract.js";
import { WINDOW_TITLES, type ShellWindowKind } from "../../ipc/windowTitles.js";
import { ChromeView } from "./chromeView.js";
import { supervisePage } from "./pageRecovery.js";
import { PickerView } from "./pickerView.js";
import { ToastsView } from "./toastsView.js";
import { TooltipView } from "./tooltipView.js";
import { shellThemeIfInstalled } from "./shellTheme.js";
import { scrimColor, type ShellPalette } from "../../ipc/palette.js";
import { NEOVIM_CHANNELS, type NeovimInset } from "../../ipc/neovim.js";
import {
	forwardedKey,
	LeftOption,
	overlayBounds,
	type KeyInput,
	type OverlaidPanes,
	type OverlayRect,
	type OverlayView,
} from "../editor/terminalNeovims.js";
import {
	workspaceOfTerminalPage,
	workspaceTerminalPageId,
} from "../../ipc/terminal.js";

/**
 * What the window asks of the Neovims drawn over terminal panes
 * (`editor/terminalNeovims.ts`): where the keys go, and what a key or a
 * focus in one of the two pages means.
 */
export interface TerminalNeovimHooks {
	keyboardOverlay(terminalId: string): string | undefined;
	overlayKey(key: string, input: KeyInput): "prefix" | "hand" | "pass";
	terminalKey(terminalId: string, input: KeyInput): "pass" | "redirect";
	overlayFocused(key: string): void;
	terminalFocused(terminalId: string): void;
	overlaid(terminalId: string): OverlaidPanes;
}

const NO_TERMINAL_NEOVIMS: TerminalNeovimHooks = {
	keyboardOverlay: () => undefined,
	overlayKey: () => "pass",
	terminalKey: () => "pass",
	overlayFocused: () => undefined,
	terminalFocused: () => undefined,
	overlaid: () => ({ panes: [], raised: false }),
};

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
		// that follows a colour theme cannot also show a system material
		// through its chrome, because the material follows the *system*
		// appearance and the theme does not. With a palette the window is
		// opaque and painted; without one it is the macOS sidebar material.
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

/** Which of the content area's views took the keyboard by itself. */
export type ContentFocus =
	| { readonly kind: "editor" }
	| { readonly kind: "agents" }
	| { readonly kind: "terminal"; readonly terminalId: string };

/** An overlay's view that is its pane's cells. */
const NO_INSET: NeovimInset = { left: 0, top: 0, right: 0, bottom: 0 };

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

	/** Whether a chord's prefix is armed; see `chordArmedChanged`. */
	private chordArmed = false;
	/** A keyboard move held on this window's own page until the chord ends. */
	private keyboardWaitsForChord = false;
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
		// window's own page: there is no editor for it to name.
		keyboard: "editor",
	};

	/**
	 * The layer every DevHub modal is drawn on.
	 *
	 * It belongs to the window rather than to any page because it is a fact
	 * about the window's child list: the last child paints on top, and that is
	 * the whole of what makes a modal a modal here.
	 */
	/**
	 * The chrome children this window has beside its editor areas.
	 *
	 * All four are built here, at startup, and never destroyed. Ordering is
	 * what `layout()` establishes and it is fixed: the Sidebar, every
	 * editor area, the Agents, then `toasts`, then `picker` — a question about
	 * something is above a notice about something, and both are above the
	 * thing.
	 *
	 * `sidebar` and `agents` are `ChromeView`s rather than layers: they are
	 * always in the window and the only thing that moves is their rectangle
	 * and whether they are drawn. See `chromeView.ts`.
	 */
	readonly sidebar: ChromeView;
	readonly agents: ChromeView;
	/**
	 * The GUI Agents' conversations: a page of its own beside `agents`,
	 * laid where it is, so a transcript being drawn has a renderer of its own
	 * and the terminal Agents' keys never wait for it. It has the Agents
	 * page's preload — the same bridge, the conversation half of it used.
	 */
	readonly conversations: ChromeView;
	readonly toasts: ToastsView;
	readonly picker: PickerView;
	readonly tooltip: TooltipView;
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
	 * Told when one of the content area's views took the keyboard by itself —
	 * a click into a terminal pane, into the editor, into the Agent — so the
	 * model can know which pane `Cmd+Q X` and `Cmd+Q O` start from. See
	 * `AppController.paneFocused`.
	 */
	private contentFocused: (pane: ContentFocus) => void = () => undefined;
	/**
	 * One view per Agent terminal, by terminal id — every Agent's, shown or
	 * hidden, so that coming back to an Agent finds its terminal where it was,
	 * with its scrollback. Made and ended by `syncTerminalViews`.
	 */
	private readonly terminalViews = new Map<string, ChromeView>();
	/**
	 * The Orchestrator's board, not its GUI Agent's conversation beside it,
	 * is what took the keyboard last: the two are one half of the content
	 * area drawn by two views (`LayoutState.conversation`), and the keys go
	 * back where the person put them.
	 */
	private onBoard = false;
	/**
	 * The Neovim editor's area: one terminal page per Workspace whose editor
	 * area has been shown, by its editor key — `pane.html#ws:<workspace id>`,
	 * the Workspace's `ws-` tmux session, with every Neovim in it drawn over
	 * its pane (`docs/neovim-editor.md`). Made and ended by
	 * `syncEditorTerminals`; kept, hidden, while another Workspace is shown,
	 * so coming back finds it attached, with its scrollback.
	 */
	private readonly editorTerminals = new Map<string, ChromeView>();
	/**
	 * A Neovim started in a terminal pane, drawn over that pane: by its key
	 * (`neovim.html#tnv:<n>`), with its terminal and its rectangle in the
	 * terminal view. Made and ended by `syncTerminalNeovims`; placed right
	 * above its terminal, shown only while that is and tmux shows its pane.
	 */
	private readonly overlayViews = new Map<
		string,
		{
			readonly view: ChromeView;
			readonly terminalId: string;
			rect: OverlayRect | undefined;
			/** Its pane's rectangle when it was last shown (`overlayBounds`). */
			last: OverlayRect | undefined;
		}
	>();
	private terminalNeovims: TerminalNeovimHooks = NO_TERMINAL_NEOVIMS;
	/** Each editor terminal's page id (`ws:<workspace id>`), by the same editor key. */
	private readonly editorTerminalIds = new Map<string, string>();
	/** Where the pages are served from, for the terminal panes made later. */
	private readonly pageBase: string;
	private readonly panePreload: string;
	private readonly neovimPreload: string;

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
		this.pageBase = pageBase;
		this.panePreload = preloadFor("pane");
		this.neovimPreload = preloadFor("neovim");

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
		this.agents.contents()?.on("focus", () => {
			if (this.state.conversation === "beside-board") this.onBoard = true;
			this.contentFocused({ kind: "agents" });
		});
		this.conversations = new ChromeView(
			preloadFor("agents"),
			`${pageBase}/conversations.html`,
		);
		this.conversations.adopt(this.window);
		// The same half of the content area as the Agents view: the Agent.
		this.conversations.contents()?.on("focus", () => {
			this.onBoard = false;
			this.contentFocused({ kind: "agents" });
		});
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
			},
		});

		// A renderer gone or hung is reloaded, not left white. See
		// `pageRecovery.ts`.
		for (const [name, contents] of [
			["shell", this.window.webContents],
			["sidebar", this.sidebar.contents()],
			["agents", this.agents.contents()],
			["conversations", this.conversations.contents()],
			["toasts", this.toasts.contents()],
			["tooltip", this.tooltip.contents()],
			["questions", this.picker.contents()],
		] as const) {
			supervisePage(contents, name, isQuitting);
		}

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
		// front, which is not the same question as "what is on screen now" — an
		// editor that was revealed while the app was in the background would
		// be looked at while the keys went somewhere else. `focusSurface` is
		// already the one answer to that question, so it is asked again here
		// rather than a second rule being written for this case.
		this.window.on("focus", () => {
			this.focusSurface();
			this.windowFocusChanged(true);
		});

		// Going away is reported, not acted on: the keyboard stays exactly
		// where it is while the app is away.
		this.window.on("blur", () => {
			this.windowFocusChanged(false);
		});

		// macOS convention: closing the window does not end the app, and here it
		// must not even end the window. Every editor, terminal and agent lives
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
		this.conversations.openPage();
		this.toasts.openPage();
		this.tooltip.openPage();
		this.picker.openPage();
		for (const view of this.terminalViews.values()) view.openPage();
		for (const entry of this.overlayViews.values()) entry.view.openPage();
		for (const view of this.editorTerminals.values()) view.openPage();
		// A sheet is modal: any other contents of this window taking the
		// keyboard while one stands — a renderer focusing itself, which no
		// gate in main sees — gives it straight back. See
		// `PickerView.reclaimFrom`.
		for (const contents of [
			this.window.webContents,
			this.sidebar.contents(),
			this.agents.contents(),
			this.conversations.contents(),
			this.toasts.contents(),
			this.tooltip.contents(),
		]) {
			contents?.on("focus", () => this.picker.reclaimFrom(contents));
		}
	}

	/**
	 * Wear a palette that arrived after the window was created.
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

	//#region the terminal panes

	/**
	 * Make a view for every terminal pane there is, and end the ones whose
	 * terminal has gone.
	 *
	 * Called with the model's whole list on every projection. A view is made
	 * the first time its terminal appears and kept until it disappears — for
	 * whichever Agent — so a terminal is attached once and its scrollback
	 * survives switching away and back, the way the Agents' pool does.
	 */
	syncTerminalViews(terminalIds: readonly string[]): void {
		if (this.window.isDestroyed()) return;
		const wanted = new Set(terminalIds);
		let changed = false;
		for (const [id, view] of [...this.terminalViews]) {
			if (wanted.has(id)) continue;
			this.terminalViews.delete(id);
			view.dispose(this.window);
			changed = true;
		}
		for (const id of terminalIds) {
			if (this.terminalViews.has(id)) continue;
			const view = this.terminalPage(id, { kind: "terminal", terminalId: id });
			this.terminalViews.set(id, view);
			if (this.pageOpened) view.openPage();
			changed = true;
		}
		if (changed) this.layout();
	}

	/**
	 * A terminal page (`pane.html#<id>`): an Agent's terminal, or a
	 * Workspace's (`ws:<id>`). A click into it is `focus` taking the
	 * keyboard; a key tmux would only hand to a pane a Neovim is drawn over
	 * goes to that Neovim's page instead.
	 */
	private terminalPage(id: string, focus: ContentFocus): ChromeView {
		// Which terminal the page shows is its fragment: one page, one
		// entry, one preload, and an instance named the way a URL names
		// a place in a document.
		const view = new ChromeView(
			this.panePreload,
			`${this.pageBase}/pane.html#${encodeURIComponent(id)}`,
		);
		view.adopt(this.window);
		const contents = view.contents();
		supervisePage(contents, `terminal:${id}`, isQuitting);
		contents?.on("focus", () => {
			this.picker.reclaimFrom(contents);
			this.contentFocused(focus);
			this.terminalNeovims.terminalFocused(id);
		});
		const leftOption = new LeftOption();
		contents?.on("before-input-event", (event, input) => {
			const leftHeld = leftOption.note(input);
			if (this.terminalNeovims.terminalKey(id, input) !== "redirect") return;
			// A key tmux would only hand to the pane under a Neovim drawn
			// over it: the overlay takes the keys, this one first.
			event.preventDefault();
			this.focusSurface();
			const overlay = this.overlayViews.get(
				this.terminalNeovims.keyboardOverlay(id) ?? "",
			);
			const target = overlay?.view.contents();
			if (target !== undefined) {
				for (const forwarded of forwardedKey(input, leftHeld)) {
					target.sendInputEvent(forwarded);
				}
			}
		});
		return view;
	}

	/**
	 * Make the editor area's terminal page for every Workspace whose editor
	 * area has been shown with the Neovim editor, and end the ones whose
	 * Workspace has gone or went back to VS Code.
	 *
	 * Kept, like an Agent terminal's view, so that coming back to a Workspace
	 * finds its terminal attached and where it was rather than reattaching and
	 * reflowing. A click into one is the editor half taking the keyboard.
	 */
	syncEditorTerminals(
		entries: readonly {
			readonly editorKey: string;
			readonly workspaceId: string;
		}[],
	): void {
		if (this.window.isDestroyed()) return;
		const wanted = new Map(
			entries.map((entry) => [entry.editorKey, entry.workspaceId]),
		);
		let changed = false;
		for (const [key, view] of [...this.editorTerminals]) {
			if (wanted.has(key)) continue;
			this.editorTerminals.delete(key);
			this.editorTerminalIds.delete(key);
			view.dispose(this.window);
			changed = true;
		}
		for (const [key, workspaceId] of wanted) {
			if (this.editorTerminals.has(key)) continue;
			const id = workspaceTerminalPageId(workspaceId);
			const view = this.terminalPage(id, { kind: "editor" });
			this.editorTerminals.set(key, view);
			this.editorTerminalIds.set(key, id);
			if (this.pageOpened) view.openPage();
			changed = true;
		}
		if (changed) this.layout();
	}

	/** Register what the overlays' keys and focus are told to. */
	setTerminalNeovimHooks(hooks: TerminalNeovimHooks): void {
		this.terminalNeovims = hooks;
	}

	/**
	 * Make a page for every Neovim drawn over a terminal pane, end the ones
	 * whose Neovim has gone, and put each where its pane is. The keys move
	 * with it: into an overlay that has just become its terminal's, back into
	 * the terminal when it goes.
	 */
	syncTerminalNeovims(views: readonly OverlayView[]): void {
		if (this.window.isDestroyed()) return;
		const wanted = new Map(views.map((view) => [view.key, view]));
		for (const [key, entry] of [...this.overlayViews]) {
			if (wanted.has(key)) continue;
			this.overlayViews.delete(key);
			this.insetSaid.delete(key);
			entry.view.dispose(this.window);
		}
		for (const view of views) {
			const known = this.overlayViews.get(view.key);
			if (known !== undefined) {
				known.rect = view.rect;
				known.last = view.rect ?? known.last;
				continue;
			}
			const page = new ChromeView(
				this.neovimPreload,
				`${this.pageBase}/neovim.html#${encodeURIComponent(view.key)}`,
			);
			page.adopt(this.window);
			const contents = page.contents();
			supervisePage(contents, `neovim:${view.key}`, isQuitting);
			const key = view.key;
			const terminalId = view.terminalId;
			// Over a Workspace's terminal it is the editor half; over an
			// Agent's, that terminal.
			const focus: ContentFocus =
				workspaceOfTerminalPage(terminalId) === undefined
					? { kind: "terminal", terminalId }
					: { kind: "editor" };
			contents?.on("focus", () => {
				this.picker.reclaimFrom(contents);
				this.contentFocused(focus);
				this.terminalNeovims.overlayFocused(key);
			});
			contents?.on("before-input-event", (event, input) => {
				const answer = this.terminalNeovims.overlayKey(key, input);
				if (answer === "pass") return;
				// tmux's prefix: tmux's, as in any pane. The client is in its
				// prefix table now, and the terminal takes the next key. In
				// control mode the terminal's page is handed the prefix itself:
				// its client keeps its own place in tmux's key tables.
				event.preventDefault();
				this.focusSurface();
				if (answer !== "hand") return;
				const target = this.terminalPageContents(terminalId);
				for (const forwarded of forwardedKey(input)) {
					target?.sendInputEvent(forwarded);
				}
			});
			// A page that loads (again) starts with no inset: say it.
			contents?.on("did-finish-load", () => {
				const entry = this.overlayViews.get(key);
				if (entry !== undefined) this.sayInset(key, entry, true);
			});
			this.overlayViews.set(key, {
				view: page,
				terminalId,
				rect: view.rect,
				last: view.rect,
			});
			if (this.pageOpened) page.openPage();
		}
		this.layout();
		const keys = JSON.stringify([
			keyboardChild(this.layoutInput()),
			this.keyboardOverlayNow(),
		]);
		if (keys !== this.overlayKeyboardAnswer) {
			this.overlayKeyboardAnswer = keys;
			this.focusSurface();
		}
	}

	private overlayKeyboardAnswer = "";

	/** A terminal's page, an Agent's or a Workspace's (`ws:<id>`). */
	private terminalPageContents(
		terminalId: string,
	): Electron.WebContents | undefined {
		const agent = this.terminalViews.get(terminalId);
		if (agent !== undefined) return agent.contents();
		for (const [key, id] of this.editorTerminalIds) {
			if (id === terminalId) return this.editorTerminals.get(key)?.contents();
		}
		return undefined;
	}

	private keyboardOverlayNow(): string | undefined {
		const child = keyboardChild(this.layoutInput());
		const terminalId =
			child.kind === "terminal"
				? child.terminalId
				: child.kind === "neovim"
					? this.editorTerminalIds.get(child.editorKey)
					: undefined;
		return terminalId === undefined
			? undefined
			: this.terminalNeovims.keyboardOverlay(terminalId);
	}

	/**
	 * Each overlay of a terminal, where the terminal's view is at `rect`;
	 * then, while what the terminal's page draws over its panes is open (a
	 * prompt, a menu, a popup, the picker), the page again, above them: it
	 * draws that over the Neovims, and leaves their panes clear
	 * (`TerminalOverlaidWire`). Told to the page once it is placed.
	 */
	private placeOverlays(
		terminalId: string,
		rect: Electron.Rectangle,
		visible: boolean,
		page?: ChromeView,
	): void {
		for (const [key, entry] of this.overlayViews) {
			if (entry.terminalId !== terminalId) continue;
			entry.view.place(
				this.window,
				overlayBounds(rect, entry.rect, entry.last),
				visible && entry.rect !== undefined,
			);
			this.sayInset(key, entry);
		}
		if (page === undefined) return;
		const overlaid = this.terminalNeovims.overlaid(terminalId);
		if (visible && overlaid.raised) page.place(this.window, rect, true);
		const said = JSON.stringify(overlaid);
		if (this.overlaidSaid.get(terminalId) === said) return;
		this.overlaidSaid.set(terminalId, said);
		page.contents()?.send(CHANNELS.terminalOverlaid, overlaid);
	}

	/**
	 * Tell an overlay's page how much of its view is past its pane's cells
	 * (`NeovimInset`): where it is shown, or was last. Said when it changes,
	 * and again to a page that loaded (`force`).
	 */
	private sayInset(
		key: string,
		entry: {
			readonly view: ChromeView;
			readonly rect: OverlayRect | undefined;
			readonly last: OverlayRect | undefined;
		},
		force = false,
	): void {
		const inset = (entry.rect ?? entry.last)?.inset ?? NO_INSET;
		const said = JSON.stringify(inset);
		if (!force && this.insetSaid.get(key) === said) return;
		this.insetSaid.set(key, said);
		entry.view.contents()?.send(NEOVIM_CHANNELS.inset, inset);
	}

	/** What each overlay's page was last told by `sayInset`. */
	private readonly insetSaid = new Map<string, string>();

	/** What each terminal's page was last told by `placeOverlays`. */
	private readonly overlaidSaid = new Map<string, string>();

	/** Every terminal pane's page, for the audiences that tell pages things. */
	paneTerminalContents(): readonly Electron.WebContents[] {
		const all: Electron.WebContents[] = [];
		for (const view of [
			...this.terminalViews.values(),
			...this.editorTerminals.values(),
			...[...this.overlayViews.values()].map((entry) => entry.view),
		]) {
			const contents = view.contents();
			if (contents) all.push(contents);
		}
		return all;
	}

	/** Register the one reader of "a pane took the keyboard by itself". */
	onContentFocused(changed: (pane: ContentFocus) => void): void {
		this.contentFocused = changed;
	}

	/**
	 * Register the one reader of "the Sidebar's page started over": a reload,
	 * or its renderer gone. Whatever that page was holding — the floating
	 * Sidebar's widened view, above all — went with it, and a view left wide
	 * over the editor by a page that no longer knows it is would take the
	 * editor's clicks for nothing.
	 */
	onSidebarRestarted(restarted: () => void): void {
		const contents = this.sidebar.contents();
		if (!contents) return;
		contents.on("did-start-loading", restarted);
		contents.on("render-process-gone", restarted);
	}

	//#endregion

	/**
	 * Where the keyboard goes: to whatever is on screen.
	 *
	 * This window holds several web contents over one rectangle — the App Shell
	 * page, one `WebContentsView` per editor area — and hiding a view does not
	 * take the keyboard away from it. So a switch away from the Editor used to
	 * leave focus inside an editor nobody could see: typing went into an
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
	focusSurface(): void {
		if (this.window.isDestroyed()) return;
		this.placeTheKeyboard();
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
	 *   `focus()` on the editor 5ms later.
	 * - the window's own `focus` event, coming back from another app.
	 * - `PickerView.place`, when the last sheet goes.
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
		if (
			this.chordArmed &&
			contents !== this.window.webContents &&
			!contents.isFocused()
		) {
			// Mid-chord, the keyboard goes nowhere but this window's own page,
			// and the move it stood for waits for the chord to end. See
			// `chordArmedChanged`.
			this.keyboardWaitsForChord = true;
			this.window.webContents.focus();
			return;
		}
		contents.focus();
	}

	/**
	 * The chord prefix was armed or has stopped being (`keyboard.ts`).
	 *
	 * After the prefix the next stroke is DevHub's, and DevHub only sees a
	 * stroke that arrives in a web contents (`before-input-event`). So while
	 * the prefix is armed the keyboard stays where it is — where the prefix
	 * was just seen — or, if DevHub has to move it (the view that had it is
	 * being replaced, or one chosen before it existed is arriving), it goes to
	 * this window's own page, which is always there and never swapped. A page
	 * still loading cannot take a key. The move it stood for is made when the
	 * chord ends, after its command has run.
	 */
	chordArmedChanged(armed: boolean): void {
		this.chordArmed = armed;
		if (armed || !this.keyboardWaitsForChord) return;
		this.keyboardWaitsForChord = false;
		this.focusSurface();
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

	/** The modal layer's keyboard, placed through the same gate. */
	focusModal(contents: Electron.WebContents): void {
		this.placeKeyboardIn(contents);
	}

	/**
	 * The contents the keyboard belongs to.
	 *
	 * This is *not* "the editor that is drawn", which is what it used to ask.
	 * In a split both are drawn — that is what a split is — and the one the
	 * person selected is the Agent, because a split is only ever entered by
	 * asking for an Agent beside its editor. Reading visibility gave the
	 * keyboard to the editor on every reveal and on every window focus, so
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
			case "conversations": {
				// The Orchestrator's board and its GUI Agent are one half of the
				// content area in two views: the keys stay on the board while it
				// is what the person clicked into.
				const view =
					this.onBoard && this.state.conversation === "beside-board"
						? this.agents
						: this.conversations;
				return view.contents() ?? this.window.webContents;
			}
			case "terminal": {
				// A Neovim over the terminal's active pane takes its keys.
				const overlay = this.overlayViews
					.get(this.terminalNeovims.keyboardOverlay(identity.terminalId) ?? "")
					?.view.contents();
				return (
					overlay ??
					this.terminalViews.get(identity.terminalId)?.contents() ??
					this.window.webContents
				);
			}
			case "neovim": {
				// A Neovim over the Workspace terminal's active pane takes its keys.
				const terminalId = this.editorTerminalIds.get(identity.editorKey);
				const overlay = this.overlayViews
					.get(
						terminalId === undefined
							? ""
							: (this.terminalNeovims.keyboardOverlay(terminalId) ?? ""),
					)
					?.view.contents();
				return (
					overlay ??
					this.editorTerminals.get(identity.editorKey)?.contents() ??
					this.window.webContents
				);
			}
			case "toasts":
				return this.toasts.contents() ?? this.window.webContents;
			case "picker":
				return this.picker.contents() ?? this.window.webContents;
			case "tooltip":
				// There is nothing in a tooltip to type into, and
				// `keyboardChild` never names it. Reaching here means the one
				// answer to "where do the keys go" has started giving an answer
				// that is not a place DevHub can put them, which is a broken
				// invariant rather than a case to handle.
				throw new Error(
					`the keyboard cannot be put in the ${identity.kind} view`,
				);
		}
	}

	//#endregion

	//#region layout

	/**
	 * What the arrangement is, said by whoever holds the projection.
	 *
	 * The whole state at once, and the only way it moves. Two channels used to
	 * carry halves of it up from the page — a measured rectangle and a word for
	 * what was in the content area — and the second of those was answering two
	 * questions with one word: whether to draw the editor, and whether that
	 * editor is what is being typed into. In a split those have different
	 * answers, and they are two fields here.
	 */
	setLayoutState(state: LayoutState): void {
		const before = JSON.stringify(this.state);
		if (state.conversation !== "beside-board") this.onBoard = false;
		this.state = state;
		if (JSON.stringify(state) === before) return;
		this.layout();
		// Revealing a surface is a request to type into it, and only main can
		// take the keyboard off the view that had it.
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
	 * Told rather than asked, like the editor area and for the same reason.
	 */
	sidebarArea(): SidebarAreaWire {
		return sidebarRect(this.windowSize(), this.state);
	}

	/**
	 * Where the cursor is, for the floating Sidebar's page, which has lost
	 * sight of it: on the card or on its tooltip (`sidebarOverlayHolds`), and
	 * whether this window is in front. Read off the cursor, not off DOM
	 * events: a pointer that crossed into the tooltip's view, or a window
	 * that went to the back, is a leave as far as the page can tell.
	 */
	sidebarPointer(): SidebarPointerWire {
		const active = !this.window.isDestroyed() && this.window.isFocused();
		if (this.window.isDestroyed()) return { inside: false, active };
		const cursor = electron.screen.getCursorScreenPoint();
		const content = this.window.getContentBounds();
		const point = { x: cursor.x - content.x, y: cursor.y - content.y };
		return {
			inside: sidebarOverlayHolds(
				point,
				this.windowSize(),
				this.state,
				this.tooltip.placement(),
			),
			active,
		};
	}

	/**
	 * Where the page that asked for a context menu is, in the window: the
	 * Conversations view for a right-click in a GUI Agent's answer, the
	 * Agents view for one on the Orchestrator's board, the Sidebar for every
	 * other request (the only other page that asks).
	 */
	contextMenuOrigin(sender: Electron.WebContents): SidebarAreaWire {
		for (const view of [this.conversations, this.agents]) {
			const contents = view.contents();
			if (contents !== undefined && sender === contents) {
				const { x, y, width, height } = view.bounds();
				return { x, y, width, height };
			}
		}
		return this.sidebarArea();
	}

	/**
	 * The editor area's rectangle, and how wide the content area around it is.
	 *
	 * What the window's own page is told, and the whole of what it knows about
	 * where anything is. The second number is there so the page never has to
	 * ask its own document how wide the window is: a view's `innerWidth` is
	 * stale for a frame after main moves it, and the split ratio is a ratio of
	 * this width.
	 */
	workbenchArea(): WorkbenchAreaWire {
		const size = this.windowSize();
		const seam = terminalSeam(size, this.state);
		const extent = terminalExtent(size, this.state);
		const terminal = this.state.terminal;
		return {
			...workbenchRect(size, this.state),
			contentWidth: surfaceRect(size, this.state).width,
			...(seam === undefined || extent === undefined || terminal === undefined
				? {}
				: {
						terminalSeam: {
							...seam,
							terminalId: terminal.terminalId,
							share: terminal.share,
							stacked: terminalStacked(this.state),
							extent,
						},
					}),
		};
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
			shellThemeIfInstalled()?.palette().base ??
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
			toasts: this.toasts.contentSize(),
			picker: this.picker.isAsking(),
			tooltip: this.tooltip.placement(),
			terminals: [...this.terminalViews.keys()],
			neovims: [...this.editorTerminals.keys()],
		};
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
				// Sized while hidden, for the reason an editor is: a view
				// shown at the size it had when it was last hidden lays itself
				// out against that size first, and an xterm reflows visibly
				// when it catches up.
				this.agents.place(this.window, child.rect, false);
				continue;
			}
			if (child.identity.kind === "conversations" && !child.visible) {
				this.conversations.place(this.window, child.rect, false);
				continue;
			}
			if (child.identity.kind === "terminal" && !child.visible) {
				this.terminalViews
					.get(child.identity.terminalId)
					?.place(this.window, child.rect, false);
				this.placeOverlays(child.identity.terminalId, child.rect, false);
				continue;
			}
			if (child.identity.kind === "neovim" && !child.visible) {
				this.editorTerminals
					.get(child.identity.editorKey)
					?.place(this.window, child.rect, false);
				const terminalId = this.editorTerminalIds.get(child.identity.editorKey);
				if (terminalId !== undefined) {
					this.placeOverlays(terminalId, child.rect, false);
				}
				continue;
			}
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
				case "conversations":
					this.conversations.place(this.window, child.rect, child.visible);
					break;
				case "terminal":
					if (!child.visible) break;
					this.terminalViews
						.get(child.identity.terminalId)
						?.place(this.window, child.rect, true);
					// Right above it: under the notices and the questions.
					this.placeOverlays(
						child.identity.terminalId,
						child.rect,
						true,
						this.terminalViews.get(child.identity.terminalId),
					);
					break;
				case "neovim": {
					if (!child.visible) break;
					this.editorTerminals
						.get(child.identity.editorKey)
						?.place(this.window, child.rect, true);
					const terminalId = this.editorTerminalIds.get(
						child.identity.editorKey,
					);
					// Right above it: under the notices and the questions.
					if (terminalId !== undefined) {
						this.placeOverlays(
							terminalId,
							child.rect,
							true,
							this.editorTerminals.get(child.identity.editorKey),
						);
					}
					break;
				}
				case "toasts":
					this.toasts.place(child.rect, child.visible);
					break;
				case "picker":
					this.picker.place(child.rect, child.visible, this.scrim());
					break;
				case "tooltip":
					this.tooltip.place(child.rect, child.visible);
					break;
			}
		}

		// An overlay whose terminal was not drawn in this pass is not drawn.
		const drawnTerminals = new Set(
			children.flatMap((child) => {
				if (!child.visible) return [];
				if (child.identity.kind === "terminal") {
					return [child.identity.terminalId];
				}
				if (child.identity.kind !== "neovim") return [];
				const terminalId = this.editorTerminalIds.get(child.identity.editorKey);
				return terminalId === undefined ? [] : [terminalId];
			}),
		);
		for (const entry of this.overlayViews.values()) {
			if (!drawnTerminals.has(entry.terminalId)) {
				entry.view.place(this.window, entry.view.bounds(), false);
			}
		}

		// Where the keys go is a function of the same input, and it moves with
		// it — not only with the arrangement. An editor that was chosen
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
 * Asked by anything that reacts to something *ending*. Every page, every
 * terminal and every host ends when DevHub quits, and none of those endings is
 * news: there is no page left to tell and nothing left to restart.
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

/** The shell must exist before anything asks for it; not having one is a bug. */
export function shellWindow(): ShellWindow {
	if (!current) {
		throw new Error("the App Shell window has not been created yet");
	}
	return current;
}

export function shellWindowIfCreated(): ShellWindow | undefined {
	return current;
}
