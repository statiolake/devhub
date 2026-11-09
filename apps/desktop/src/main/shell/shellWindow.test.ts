/**
 * The one window and its children: where the keyboard goes, the modal layer
 * above everything, and when DevHub may come to the front.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeView {
	visible = false;
	bounds: Electron.Rectangle | undefined;
	setBounds(bounds: Electron.Rectangle): void {
		this.bounds = bounds;
	}
	setVisible(visible: boolean): void {
		this.visible = visible;
	}
	getVisible(): boolean {
		return this.visible;
	}
	background: string | undefined;
	setBackgroundColor(color: string): void {
		this.background = color;
	}
	getBounds(): Electron.Rectangle | undefined {
		return this.bounds;
	}
	destroyed = false;
	private readonly listeners = new Map<string, (() => void)[]>();
	readonly webContents = {
		id: nextId(),
		isDestroyed: () => this.destroyed,
		getZoomFactor: () => 1,
		close: () => {
			this.destroyed = true;
			for (const listener of this.listeners.get("destroyed") ?? []) listener();
		},
		on: (event: string, listener: () => void) => {
			this.listeners.set(event, [
				...(this.listeners.get(event) ?? []),
				listener,
			]);
		},
		once: (event: string, listener: () => void) => {
			this.webContents.on(event, listener);
		},
		removeListener: () => undefined,
		/** Fire what Electron fires — the contents taking or losing DOM focus. */
		emit: (event: string) => {
			for (const listener of this.listeners.get(event) ?? []) listener();
		},
		setWindowOpenHandler: () => undefined,
		send: () => undefined,
		focus: () => {
			focused = this.webContents.id;
		},
		// One keyboard in the window, so "do I have it" is "was I the last one
		// told to take it". The modal layer asks this of itself before asking
		// for it again.
		isFocused: () => focused === this.webContents.id,
		devToolsFocused: false,
		isDevToolsFocused: () => this.webContents.devToolsFocused,
		loadURL: (url: string) => {
			loaded.push(url);
			return Promise.resolve();
		},
	};
}

/** Every page any view or window in these tests was told to run, in order. */
const loaded: string[] = [];

/** Which `webContents` was told to take the keyboard most recently. */
let focused: number | undefined;

let counter = 0;
function nextId(): number {
	counter += 1;
	return counter;
}

class FakeContentView {
	readonly children: FakeView[] = [];
	addChildView(view: FakeView): void {
		// Electron moves an existing child to the end rather than duplicating it.
		const at = this.children.indexOf(view);
		if (at !== -1) this.children.splice(at, 1);
		this.children.push(view);
	}
	removeChildView(view: FakeView): void {
		const at = this.children.indexOf(view);
		if (at !== -1) this.children.splice(at, 1);
	}
}

/** What a page asked to open in a new window, in order. */
type WindowOpenHandler = (details: {
	url: string;
}) => Electron.WindowOpenHandlerResponse;

class FakeWindow {
	private readonly children = new FakeContentView();
	/** Electron's answer once the window is gone, and the reason for it. */
	get contentView(): FakeContentView {
		if (this.destroyed) throw new Error("Object has been destroyed");
		return this.children;
	}
	windowOpenHandler: WindowOpenHandler | undefined;
	readonly navigationListeners: ((
		event: { preventDefault: () => void },
		url: string,
	) => void)[] = [];
	readonly webContents = {
		id: nextId(),
		send: () => undefined,
		focus: () => {
			focused = this.webContents.id;
		},
		isFocused: () => focused === this.webContents.id,
		devToolsFocused: false,
		isDevToolsFocused: () => this.webContents.devToolsFocused,
		setWindowOpenHandler: (handler: WindowOpenHandler) => {
			this.windowOpenHandler = handler;
		},
		on: (
			event: string,
			listener: (event: { preventDefault: () => void }, url: string) => void,
		) => {
			if (event === "will-navigate") this.navigationListeners.push(listener);
		},
		once: () => undefined,
		isDestroyed: () => false,
		getURL: () => "",
	};
	/** Whether Electron has taken this window away — quitting does. */
	destroyed = false;
	isDestroyed(): boolean {
		return this.destroyed;
	}
	/**
	 * Whether DevHub is the app in front. The keyboard is only ever placed
	 * within a window that is, and it is true here because these tests are
	 * all about a window being worked in.
	 */
	inFront = true;
	isFocused(): boolean {
		return this.inFront;
	}
	/** Whether the window was put away. `raiseFromAppActivation` asks. */
	visible = true;
	isVisible(): boolean {
		return this.visible;
	}
	getContentSize(): [number, number] {
		return [1440, 900];
	}
	loadURL(url: string): void {
		loaded.push(url);
	}
	once(): void {}
	/**
	 * Recorded rather than dropped, so a test can fire what Electron fires.
	 * The window's own `focus` and `blur` are how DevHub learns it has come
	 * forward or gone away, and a fake that swallowed them left the one
	 * transition that matters untestable.
	 */
	readonly listeners = new Map<string, (() => void)[]>();
	on(event: string, listener: () => void): void {
		this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
	}
	emit(event: string): void {
		for (const listener of this.listeners.get(event) ?? []) listener();
	}
	/**
	 * Everything that brings this window to the front, in order.
	 *
	 * The question every test below asks of a raise is whether it happened at
	 * all, so it is recorded rather than acted on.
	 */
	show(): void {
		this.visible = true;
		raised.push("show");
	}
	focus(): void {
		raised.push("focus");
	}
}

/** `show`/`focus`/`app.focus` — the whole of what puts DevHub in front. */
const raised: string[] = [];

/** Every URL handed to the system browser, in order. */
const openedExternally: string[] = [];

vi.mock("../electron.js", () => ({
	electron: {
		BrowserWindow: FakeWindow,
		WebContentsView: FakeView,
		app: {
			focus: () => {
				raised.push("app.focus");
			},
		},
		// What the questions' dim is read from. See `ShellWindow.scrim`.
		nativeTheme: {
			shouldUseDarkColors: false,
			prefersReducedTransparency: false,
			on: () => undefined,
			off: () => undefined,
		},
		shell: {
			openExternal: (url: string) => {
				openedExternally.push(url);
				return Promise.resolve();
			},
		},
	},
}));

const { ShellWindow, shellWindowOptions } = await import("./shellWindow.js");
const { WINDOW_TITLES } = await import("../../ipc/windowTitles.js");
type ShellPalette = import("../../ipc/palette.js").ShellPalette;
const { scrimColor } = await import("../../ipc/palette.js");
const { sidebarRect, trafficLightPosition } = await import("./windowLayout.js");

/** The size the fake window reports; see `getContentSize` above. */
const WINDOW_WIDTH = 1440;
const WINDOW_HEIGHT = 900;
type ShellWindow = InstanceType<typeof ShellWindow>;

const BASE = {
	titleBar: "hidden",
	density: "compact",
	sidebar: { width: 248, collapsed: false },
} as const;

function newShell(): ShellWindow {
	return new ShellWindow(
		"preload.js",
		"devhub-app://shell/index.html",
		undefined,
		"hidden",
	);
}

/** An Agent over the content area, holding the keys. */
function showAgent(shell: ShellWindow): void {
	shell.setLayoutState({
		...BASE,
		surface: { kind: "agent" },
		keyboard: "agents",
	});
}

/** The keyboard on the Sidebar, the Agent still on screen. */
function showSidebar(shell: ShellWindow): void {
	shell.setLayoutState({
		...BASE,
		surface: { kind: "agent" },
		keyboard: "sidebar",
	});
}

const idOf = (contents: unknown): number | undefined =>
	(contents as { id: number } | undefined)?.id;

describe("the shell window's children", () => {
	let shell: ShellWindow;

	beforeEach(() => {
		shell = newShell();
	});

	/**
	 * The Sidebar's own rectangle is main's number, not the page's.
	 *
	 * The page needs it to say where one of its rows is *in the window*, so
	 * that a tooltip is placed against the window rather than against the
	 * column. It must not work it out for itself: `window.screenX` is the
	 * screen's, and a view's own box is stale for a while after main moves it
	 * — measured, the collapsed Sidebar went on answering 249 for seconds
	 * after being narrowed to 76. So this asserts the number moves with the
	 * layout and is the same one the layout used.
	 */
	it("tells the Sidebar its own rectangle, and moves it when the column does", () => {
		expect(shell.sidebarArea()).toEqual(
			sidebarRect(
				{ width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
				shell.layoutState(),
			),
		);

		shell.setLayoutState({
			...shell.layoutState(),
			sidebar: { width: 248, collapsed: true },
		});
		// Collapsed with no title bar, the rail is the traffic lights' span.
		expect(shell.sidebarArea().width).toBe(76);
		expect(shell.sidebarArea().x).toBe(0);
	});

	/**
	 * A question coming up takes the tooltip down.
	 *
	 * The Sidebar hides its own when the pointer leaves the row, which covers
	 * a question opened by clicking something. It does not cover one opened
	 * from the keyboard with the pointer still resting on a row — measured on
	 * a running instance, the tooltip stayed up and stood over the sheet. So
	 * it is the window's rule, decided where the modal set is known.
	 */
	it("takes the tooltip down when a question comes up", () => {
		shell.tooltip.show({
			lines: [{ text: "widget", style: "name" }],
			anchor: { x: 14, y: 120, width: 16, height: 24 },
		});
		shell.tooltip.setSize({ width: 220, height: 34 });
		expect(shell.tooltip.isPresent()).toBe(true);

		shell.picker.openModal({ kind: "workspace-picker" });
		expect(shell.tooltip.isPresent()).toBe(false);
	});

	it("gives the keyboard to the child the arrangement names", () => {
		focused = undefined;
		showAgent(shell);
		expect(focused).toBe(idOf(shell.agents.contents()));
		showSidebar(shell);
		expect(focused).toBe(idOf(shell.sidebar.contents()));
	});

	it("lets the window go without throwing", () => {
		(shell.window as unknown as FakeWindow).destroyed = true;
		expect(() => {
			shell.layout();
			shell.focusSurface();
		}).not.toThrow();
	});
});

describe("the shell window's modal layer", () => {
	let shell: ShellWindow;
	const layer = () => idOf(shell.picker.contents());

	/** The modal layer, as a child of the window, found by its contents. */
	function overlayChild(): FakeView | undefined {
		const children = shell.window.contentView.children as unknown as FakeView[];
		const contents = shell.picker.contents();
		return contents === undefined
			? undefined
			: children.find(
					(child) =>
						(child.webContents as unknown) === (contents as unknown) &&
						child.visible !== undefined,
				);
	}

	/**
	 * The highest child that is over the window. A parked layer — the notices
	 * or the tooltip with nothing to show — is in the list and above
	 * everything, but it is all but one pixel outside the window.
	 */
	function topmostOverWindow(): FakeView | undefined {
		const children = shell.window.contentView.children as unknown as FakeView[];
		return children.findLast(
			(child) => JSON.stringify(child.getBounds()) !== JSON.stringify(PARKED),
		);
	}

	beforeEach(() => {
		focused = undefined;
		shell = newShell();
		showAgent(shell);
	});

	/** One pixel inside the window's bottom-right corner, at its size. */
	const PARKED = { x: 1439, y: 899, width: 1440, height: 900 };

	it("waits in the window's corner while nothing is being asked", () => {
		// Never taken out of the window: a view that is not in it is a hidden
		// page, which paints nothing — so the first question after launch
		// waited for a first layout and every later one opened on a frame of
		// the previous sheet. All but one pixel is outside, and takes no
		// click, and it is clear there.
		expect(overlayChild()?.getBounds()).toEqual(PARKED);
		expect(overlayChild()?.background).toBe("#00000000");
		expect(shell.picker.isPresent()).toBe(false);
	});

	it("dims with its own background, in the half of the palette on screen", () => {
		// The page lays out a frame or two after its view is resized, and what
		// it has not painted yet is the view's background. A dim drawn by the
		// page left an undimmed strip along the edges as the window grew.
		shell.picker.openModal({ kind: "workspace-picker" });
		expect(overlayChild()?.background).toBe(scrimColor("light", false));
	});

	it("covers the window for as long as a modal is open, on top", () => {
		const id = shell.picker.openModal({ kind: "workspace-picker" });
		expect(overlayChild()?.getBounds()).toEqual({
			x: 0,
			y: 0,
			width: WINDOW_WIDTH,
			height: WINDOW_HEIGHT,
		});
		expect(topmostOverWindow()).toBe(overlayChild());

		shell.picker.closeModal(id);
		expect(overlayChild()?.getBounds()).toEqual(PARKED);
		expect(shell.picker.isPresent()).toBe(false);
	});

	it("stays the topmost child through every later layout", () => {
		// `layout` re-adds every child in order whenever anything about the
		// arrangement moves; the layer used to be raised only on the way in,
		// so the first of those after a modal opened put the content back on
		// top of the sheet.
		shell.picker.openModal({ kind: "workspace-picker" });

		shell.setLayoutState({
			...shell.layoutState(),
			sidebar: { width: 400, collapsed: false },
		});
		expect(topmostOverWindow()).toBe(overlayChild());

		shell.picker.openModal({ kind: "issue-assignment" });
		expect(topmostOverWindow()).toBe(overlayChild());

		showSidebar(shell);
		expect(topmostOverWindow()).toBe(overlayChild());
	});

	it("gives the keyboard to the sheet, and keeps it there while one stands", () => {
		shell.picker.openModal({ kind: "workspace-picker" });
		expect(focused).toBe(layer());
		// A dialog no key reaches is a dialog nobody can answer.
		showSidebar(shell);
		expect(focused).toBe(layer());
	});

	/**
	 * Coming back to DevHub with a sheet standing.
	 *
	 * macOS restores the keyboard to whatever held it before the app went
	 * away — measured on an isolated instance, the App Shell page — and the
	 * window's own `focus` event is the only thing that runs. It used to
	 * stand aside for the modal layer, which read as "the modal already has
	 * it" and was not the same fact: the sheet came back unreachable from
	 * the keyboard, and clicking into it was the only way on.
	 */
	it("puts the keyboard back in the sheet when the window comes forward", () => {
		const window = shell.window as unknown as FakeWindow;
		const id = shell.picker.openModal({ kind: "workspace-picker" });
		window.inFront = false;
		window.emit("blur");
		focused = undefined;

		window.inFront = true;
		window.emit("focus");
		expect(focused).toBe(layer());

		// And when the sheet goes, the surface has it again.
		shell.picker.closeModal(id);
		expect(focused).toBe(idOf(shell.agents.contents()));
	});

	it("answers a choice with what was chosen, and -1 when dismissed", async () => {
		const chosen = shell.picker.choose({
			kind: "recently-closed",
			rows: [],
		} as never);
		const [first] = shell.picker.openModals();
		shell.picker.closeModal(first!.id, 2);
		expect(await chosen).toBe(2);

		const dismissed = shell.picker.choose({
			kind: "recently-closed",
			rows: [],
		} as never);
		const [second] = shell.picker.openModals();
		shell.picker.closeModal(second!.id);
		expect(await dismissed).toBe(-1);
	});
});

describe("the pages in the shell window", () => {
	/**
	 * Every page in the window asks main for something the moment it mounts —
	 * the Agents page for its terminals above all — and main answers those
	 * only once its runtimes are up. A page that runs earlier than that is
	 * refused by an IPC handler that does not exist yet ("No handler
	 * registered for 'devhub:terminal:attach'"), and the Agent restored at
	 * launch came back saying its terminal was not connected. So no page in
	 * the window runs at construction, and every one of them runs at
	 * `openPage`, together.
	 */
	it("runs none of them before openPage, and all of them at it", () => {
		loaded.length = 0;
		const shell = new ShellWindow(
			"preload.js",
			"devhub-app://shell/index.html",
			undefined,
			"hidden",
		);
		expect(loaded).toEqual([]);
		shell.openPage();
		expect([...loaded].sort()).toEqual(
			[
				"devhub-app://shell/agents.html",
				"devhub-app://shell/conversations.html",
				"devhub-app://shell/index.html",
				"devhub-app://shell/picker.html",
				"devhub-app://shell/sidebar.html",
				"devhub-app://shell/toasts.html",
				"devhub-app://shell/tooltip.html",
			].sort(),
		);
	});
});

describe("links out of the App Shell page", () => {
	let shell: ShellWindow;

	beforeEach(() => {
		openedExternally.length = 0;
		shell = new ShellWindow(
			"preload.js",
			"devhub-app://shell/index.html",
			undefined,
			"hidden",
		);
	});

	const fake = (): FakeWindow => shell.window as unknown as FakeWindow;

	function navigate(url: string): boolean {
		let prevented = false;
		for (const listener of fake().navigationListeners) {
			listener({ preventDefault: () => (prevented = true) }, url);
		}
		return prevented;
	}

	it("sends a page's window.open to the browser and mints no window", () => {
		// xterm's stock OSC 8 handler is a `window.open`, and Electron's default
		// answer to one is a new BrowserWindow wearing DevHub's preload with a
		// stranger's page inside it. There is no such window.
		const answer = fake().windowOpenHandler?.({
			url: "https://example.com/docs",
		});
		expect(answer).toEqual({ action: "deny" });
		expect(openedExternally).toEqual(["https://example.com/docs"]);
	});

	it("sends a navigation away from the shell's own scheme to the browser", () => {
		expect(navigate("https://example.com/docs")).toBe(true);
		expect(openedExternally).toEqual(["https://example.com/docs"]);
	});

	it("refuses a bare window.open without troubling the browser", () => {
		// `window.open()` with no URL asks for a blank window to write into.
		// There is no such window here, and `about:blank` is not a link.
		const answer = fake().windowOpenHandler?.({ url: "about:blank" });
		expect(answer).toEqual({ action: "deny" });
		expect(openedExternally).toEqual([]);
	});

	it("leaves the shell's own page alone", () => {
		expect(navigate("devhub-app://shell/index.html?window=overlay")).toBe(
			false,
		);
		expect(openedExternally).toEqual([]);
	});
});

describe("the shell window's focus reporting", () => {
	it("tells the model, starting with the answer as it stands", () => {
		// The model cannot see this for itself — a view keeps its DOM focus
		// while the window behind it is deactivated — and it needs it to know
		// whether anybody is looking at the Agent on screen. Registering
		// publishes the current answer, so the model does not start on an
		// assumption.
		const shell = newShell();
		const window = shell.window as unknown as FakeWindow;
		const reported: boolean[] = [];
		window.inFront = true;
		shell.onWindowFocusChanged((focused) => reported.push(focused));
		expect(reported).toEqual([true]);

		window.inFront = false;
		window.emit("blur");
		window.inFront = true;
		window.emit("focus");
		expect(reported).toEqual([true, false, true]);
	});
});

/**
 * When DevHub may come to the front, and when it may only move the keyboard.
 *
 * The two were one act — `reveal` placed the keyboard, and
 * `webContents.focus()` makes a window key on macOS — so everything that
 * revealed anything raised the window. A reveal follows every projection
 * change, so an Agent ticking or a HEAD moving put DevHub in front of whatever
 * the person was looking at; measured on an idle instance, the window went to
 * the background and DevHub called `focus()` five milliseconds later. The
 * same one act is what put the App Shell back over the Settings window.
 */
describe("when the shell window may come to the front", () => {
	let shell: ShellWindow;
	let window: FakeWindow;

	beforeEach(() => {
		raised.length = 0;
		focused = undefined;
		shell = newShell();
		window = shell.window as unknown as FakeWindow;
	});

	it("declines to move the keyboard while another window is in front", () => {
		// The Settings window, an undocked Web Inspector, another application:
		// all of them are this one fact, and the shell no longer reaches across
		// to any of them. `focus()` here would have made this window key.
		showAgent(shell);
		window.inFront = false;
		focused = undefined;

		showSidebar(shell);
		showAgent(shell);
		expect(focused).toBeUndefined();
		expect(raised).toEqual([]);
	});

	it("declines while a docked Web Inspector holds the keyboard", () => {
		// The one case the window's own focus cannot tell apart: the inspector
		// is a view onto these same contents, in this same window.
		showAgent(shell);
		window.webContents.devToolsFocused = true;
		focused = undefined;

		showSidebar(shell);
		expect(focused).toBeUndefined();
	});

	it("places the keyboard when the window comes back, without raising", () => {
		// What makes declining safe rather than lossy: the answer is asked
		// again the moment the window is key, from the window's own event.
		showAgent(shell);
		window.inFront = false;
		window.emit("blur");
		focused = undefined;
		raised.length = 0;

		window.inFront = true;
		window.emit("focus");
		expect(focused).toBe(idOf(shell.agents.contents()));
		expect(raised).toEqual([]);
	});

	it("raises when a command line asks for DevHub", () => {
		window.inFront = false;
		focused = undefined;
		shell.raise();
		expect(raised).toEqual(["show", "focus", "app.focus"]);
		// Not the keyboard: macOS has not made the window key yet, and the
		// window's own `focus` event is what asks once it has.
		expect(focused).toBeUndefined();
	});

	it("raises on an app activation only for a window that was put away", () => {
		window.visible = false;
		shell.raiseFromAppActivation();
		expect(raised).toEqual(["show", "focus", "app.focus"]);

		// A visible window needs nothing: macOS has already brought forward
		// whichever window was clicked, and that may be the Settings window.
		raised.length = 0;
		shell.raiseFromAppActivation();
		expect(raised).toEqual([]);
	});

	it("opens a modal without raising, and not at all from behind", () => {
		showAgent(shell);
		shell.picker.openModal({ kind: "workspace-picker" });
		expect(raised).toEqual([]);

		shell.picker.closeWhere(() => true);
		window.inFront = false;
		focused = undefined;
		shell.picker.openModal({ kind: "workspace-picker" });
		expect(focused).toBeUndefined();
	});
});

/**
 * There is one window, and the chrome mode is not one of its arguments.
 *
 * DevHub's title bar has to be the Sidebar's colour, which a native bar cannot
 * be, so the bar is drawn by the page and the window is a `hiddenInset` one in
 * both modes. That is worth a test of its own: an option builder that took the
 * mode again would be a second place the two chromes could differ, and the
 * whole point is that there is exactly one — `data-title-bar`, in the page.
 */
describe("shellWindowOptions", () => {
	it("builds the same transparent-bar window whatever the mode says", () => {
		expect(shellWindowOptions("preload.js", undefined)).toMatchObject({
			titleBarStyle: "hiddenInset",
			title: WINDOW_TITLES.shell,
		});
	});

	it("places the traffic lights from the bar's height, not where hiddenInset drops them", () => {
		expect(
			shellWindowOptions("preload.js", undefined).trafficLightPosition,
		).toEqual(trafficLightPosition());
	});

	it("does not take the mode at all", () => {
		// The signature is the assertion: two arguments, neither of them the
		// chrome. A third would mean the window had started to care again.
		expect(shellWindowOptions).toHaveLength(2);
	});

	it("still decides its material by whether there is a palette", () => {
		expect(shellWindowOptions("preload.js", undefined).vibrancy).toBe(
			"sidebar",
		);
		const painted = shellWindowOptions("preload.js", {
			canvas: "#101010",
		} as ShellPalette);
		expect(painted.vibrancy).toBeUndefined();
		expect(painted.backgroundColor).toBe("#101010");
	});
});
