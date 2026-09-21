/**
 * The one invariant the view manager exists to keep.
 *
 * At most one workbench view is on screen, and if there is one it is the
 * topmost child — because sibling views paint in the order they were added, so
 * a view that is visible but underneath another is invisible for no reason the
 * code makes visible anywhere.
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
	setBackgroundColor(): void {}
	getBounds(): Electron.Rectangle | undefined {
		return this.bounds;
	}
	/**
	 * `WebContentsView extends View`, so a workbench's view is a container
	 * too — which is where VS Code's integrated Browser is attached. See
	 * `WorkbenchView.contentView`.
	 */
	readonly children: object[] = [];
	addChildView(child: object): void {
		const at = this.children.indexOf(child);
		if (at !== -1) this.children.splice(at, 1);
		this.children.push(child);
	}
	removeChildView(child: object): void {
		const at = this.children.indexOf(child);
		if (at !== -1) this.children.splice(at, 1);
	}
	destroyed = false;
	private readonly listeners = new Map<string, (() => void)[]>();
	readonly webContents = {
		id: nextId(),
		isDestroyed: () => this.destroyed,
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
		/**
		 * What main asked this workbench to do, in order.
		 *
		 * `vscode:runAction` is upstream's own door for main to raise a
		 * workbench command, and whether one was raised — and how many times —
		 * is exactly the question the terminal-on-arrival tests ask.
		 */
		sent: [] as { channel: string; payload: unknown }[],
		send: (channel: string, payload: unknown) => {
			this.webContents.sent.push({ channel, payload });
		},
		focus: () => {
			focused = this.webContents.id;
		},
		// One keyboard in the window, so "do I have it" is "was I the last one
		// told to take it". The modal layer asks this of itself before asking
		// for it again.
		isFocused: () => focused === this.webContents.id,
		devToolsFocused: false,
		isDevToolsFocused: () => this.webContents.devToolsFocused,
		loadURL: () => Promise.resolve(),
	};
}

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
	};
	/** Whether Electron has taken this window away — quitting does. */
	destroyed = false;
	isDestroyed(): boolean {
		return this.destroyed;
	}
	/**
	 * Whether DevHub is the app in front. It is half of what decides whether a
	 * workbench has the keyboard — see `ShellWindow.isSurfaceFocused` — and it
	 * is true here because these tests are all about a window being worked in.
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
	loadURL(): void {}
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

/**
 * What reached `electron.app`, as `event:windowId`.
 *
 * The delivery the workspace trust prompt and the git extension are built on;
 * see `WorkbenchView.announceFocusToTheApplication`. Recorded here because the
 * question these tests ask is *when* the shell says it, not what it says.
 */
const announced: string[] = [];

vi.mock("../electron.js", () => ({
	electron: {
		BrowserWindow: FakeWindow,
		WebContentsView: FakeView,
		// Attaching and detaching a view move the listener ceiling on `app`
		// (see `appListenerCeiling.ts`). The number is that module's business
		// and is tested there; what this mock owes is an `app` to set it on,
		// without which every test that attaches a view throws before it
		// starts.
		app: {
			setMaxListeners: () => undefined,
			// A workbench's focus is announced here as well as on its own
			// window, because `app` is where VS Code reads it from. See
			// `WorkbenchView.announceFocusToTheApplication`; what it says is
			// asserted in that module's test.
			emit: (event: string, _details: unknown, window: { id: number }) => {
				announced.push(`${event}:${window.id}`);
			},
			focus: () => {
				raised.push("app.focus");
			},
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
const { WorkbenchView, asBrowserWindow } = await import("./workbenchView.js");
const { sidebarRect } = await import("./windowLayout.js");

/** The size the fake window reports; see `getContentSize` above. */
const WINDOW_WIDTH = 1440;
const WINDOW_HEIGHT = 900;
type ShellWindow = InstanceType<typeof ShellWindow>;
type WorkbenchView = InstanceType<typeof WorkbenchView>;

/**
 * The rectangle the layout owner computes for this window.
 *
 * 1440x900, no title bar of DevHub's own, a sidebar at its default width and
 * its hairline. Nothing measures it: see `windowLayout.ts`.
 */
const AREA = { x: 248, y: 0, width: 1192, height: 900 };

/** The folder each workbench in these tests is showing. */
const keys = new WeakMap<WorkbenchView, string>();
let keyCounter = 0;

/** Give a view a folder, which is what makes it a child the layout can name. */
function bind(shell: ShellWindow, view: WorkbenchView): string {
	keyCounter += 1;
	const key = `/folder/${String(keyCounter)}`;
	keys.set(view, key);
	shell.bindEditorKey(view.id, key);
	return key;
}

function keyOf(view: WorkbenchView): string {
	const key = keys.get(view);
	if (!key) throw new Error("that workbench was never bound to a folder");
	return key;
}

const BASE = {
	titleBar: "hidden",
	density: "compact",
	sidebar: { width: 248, collapsed: false },
} as const;

/** The selection resolves to this workbench, with the whole area. */
function show(shell: ShellWindow, view: WorkbenchView): void {
	shell.setLayoutState({
		...BASE,
		surface: { kind: "editor", editorKey: keyOf(view) },
		keyboard: "editor",
	});
}

/** The page has put something of its own over the area — an Agent, a wait. */
function showPage(shell: ShellWindow): void {
	shell.setLayoutState({
		...BASE,
		surface: { kind: "agent" },
		keyboard: "agents",
	});
}

/** An Agent beside this workbench: both drawn, the Agent holding the keys. */
function showSplit(shell: ShellWindow, view: WorkbenchView): void {
	shell.setLayoutState({
		...BASE,
		surface: { kind: "split", editorKey: keyOf(view), ratio: 0.5 },
		keyboard: "agents",
	});
}

describe("the shell window's workbench views", () => {
	let shell: ShellWindow;
	let a: WorkbenchView;
	let b: WorkbenchView;
	let c: WorkbenchView;

	beforeEach(() => {
		shell = new ShellWindow(
			"preload.js",
			"devhub-app://shell/index.html",
			undefined,
			"hidden",
		);
		a = new WorkbenchView(shell, {});
		b = new WorkbenchView(shell, {});
		c = new WorkbenchView(shell, {});
		for (const view of [a, b, c]) {
			shell.attach(view);
			bind(shell, view);
		}
	});

	function invariantHolds(expected: WorkbenchView | undefined): void {
		expect(shell.visibleViews()).toEqual(expected ? [expected] : []);
		if (expected) expect(shell.topmostView()).toBe(expected);
	}

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
		// Collapsed with no title bar, the rail is the traffic lights' span —
		// and it is exactly the case the old in-page tooltip refused to draw
		// in, because 76px is not a column a sentence fits in.
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

	it("shows nothing until the selection says what to show", () => {
		// Creating a workbench must not put it on screen: three of them open at
		// launch, and whichever finished last would otherwise take the screen.
		invariantHolds(undefined);
	});

	it("shows exactly the revealed view, on top, however often it changes", () => {
		for (const view of [a, b, c, a, c, b, b, a]) {
			show(shell, view);
			invariantHolds(view);
		}
	});

	it("sizes a view before it is shown, never after", () => {
		const boundsOf = (view: WorkbenchView): Electron.Rectangle | undefined =>
			(view.view as unknown as FakeView).bounds;

		show(shell, b);
		expect(boundsOf(b)).toEqual(AREA);
		invariantHolds(b);
	});

	it("moves every workbench when the sidebar does, with nothing measured", () => {
		const boundsOf = (view: WorkbenchView): Electron.Rectangle | undefined =>
			(view.view as unknown as FakeView).bounds;

		show(shell, b);
		shell.setLayoutState({
			...shell.layoutState(),
			sidebar: { width: 400, collapsed: false },
		});
		expect(boundsOf(b)).toEqual({ x: 400, y: 0, width: 1040, height: 900 });
		// The one behind it too: a view shown at the size it had when it was
		// hidden reflows visibly when it catches up.
		expect(boundsOf(a)).toEqual({ x: 400, y: 0, width: 1040, height: 900 });
		invariantHolds(b);
	});

	it("shows nothing while the page's own surface is the one on screen", () => {
		show(shell, a);
		showPage(shell);
		invariantHolds(undefined);

		show(shell, a);
		invariantHolds(a);
	});

	it("lets its views go after the window itself has gone", () => {
		// Quitting: Electron destroys the window, and every view's contents end
		// with it. Each one still leaves the table — but there is no window
		// left to take it out of, and asking one that has been destroyed for
		// its `contentView` is "Object has been destroyed", uncaught, in main.
		(shell.window as unknown as { destroyed: boolean }).destroyed = true;
		expect(() => {
			for (const view of [a, b, c]) view.webContents.close();
		}).not.toThrow();
		expect(shell.getViews()).toEqual([]);
	});

	it("cannot reveal a view whose contents are gone", () => {
		show(shell, a);
		// Killed from underneath, the way a crashed renderer goes: no call to
		// `destroy()`, so nothing tells the table on the way out except the
		// contents themselves ending. The table must not still contain it a
		// moment later — Electron answers a destroyed child with "can't add a
		// destroyed child view to a parent view", which is a true statement
		// about a table that should never have held it.
		a.webContents.close();
		expect(shell.visibleViews()).toEqual([]);

		shell.assertArrangement();
		expect(shell.visibleViews()).toEqual([]);
		expect(shell.topmostView()).not.toBe(a);
		expect(shell.revealedView()).toBeUndefined();

		// And the surviving views are still perfectly usable.
		show(shell, b);
		invariantHolds(b);
	});

	/**
	 * Focus follows the surface.
	 *
	 * Hiding a `WebContentsView` does not take the keyboard away from it, so
	 * the window kept delivering keys to a workbench nobody could see: typing
	 * went into an invisible editor, and the chord layer — which listens on
	 * whichever contents the keys arrive at — had nothing to listen to. That is
	 * the "the chord works once and then stops" report.
	 */
	describe("and where the keyboard goes", () => {
		/**
		 * The Agents' view — where the keyboard goes when an Agent is on
		 * screen. It used to be the window's own page, because the Agent's
		 * pane was drawn in that document; it is a child of its own now, and
		 * "the page has it" has stopped being a thing anybody can say.
		 */
		const page = () =>
			(shell.agents.contents() as unknown as { id: number } | undefined)?.id;
		const contentsOf = (view: WorkbenchView): number =>
			(view.webContents as unknown as { id: number }).id;

		beforeEach(() => {
			focused = undefined;
		});

		it("gives the keyboard to the workbench that is on screen", () => {
			show(shell, a);
			expect(focused).toBe(contentsOf(a));
			show(shell, b);
			expect(focused).toBe(contentsOf(b));
		});

		it("takes it off a hidden workbench and gives it to the page", () => {
			// The page is where a terminal and an Agent surface live, so this is
			// what makes typing go straight into the xterm with no click.
			show(shell, a);
			showPage(shell);
			expect(focused).toBe(page());
		});

		it("survives being asked over and over, from either end", () => {
			// Editor → Terminal → Editor → Terminal, which is the chord the
			// report says cannot be used twice in a row.
			show(shell, a);
			for (let round = 0; round < 3; round += 1) {
				showPage(shell);
				expect(focused).toBe(page());
				show(shell, a);
				expect(focused).toBe(contentsOf(a));
			}
		});

		it("leaves a workbench alone while the page's surface is on screen", () => {
			// A projection change re-reveals the selected Editor even while the
			// Terminal is showing. That must not pull the keyboard out of it.
			showPage(shell);
			focused = undefined;
			// A projection change that leaves the arrangement where it was must
			// not move the keyboard — and now it structurally cannot, because
			// what is on screen is one answer rather than two axes that can be
			// set apart from each other.
			shell.assertArrangement();
			expect(focused).toBeUndefined();
		});

		/**
		 * An Agent opened beside its editor keeps the keyboard.
		 *
		 * ⌘-clicking an Agent puts it next to the workbench rather than over it,
		 * so both are on screen — and the one the person chose is the Agent,
		 * because that is the only way a split is ever entered. Main used to
		 * read "is a workbench visible" for this and answered yes, so the editor
		 * took the keys: on the reveal, and again on every window focus, which
		 * is what made it look like the editor was stealing focus at random.
		 */
		it("leaves the keyboard with the page when an Agent is beside a workbench", () => {
			show(shell, a);
			expect(focused).toBe(contentsOf(a));

			showSplit(shell, a);
			expect(focused).toBe(page());

			// The workbench is still drawn — that is what a split is.
			invariantHolds(a);

			// And asking again does not hand it over either. This is the path the
			// report was about: the app was already arranged correctly, and every
			// window focus asks this same question again.
			focused = undefined;
			shell.focusSurface();
			expect(focused).toBe(page());

			// A projection change that changes nothing must not pull the
			// keyboard out of the Agent beside it either.
			focused = undefined;
			shell.assertArrangement();
			expect(focused).toBeUndefined();
		});

		it("gives it back to the workbench when the split is closed", () => {
			show(shell, a);
			showSplit(shell, a);
			expect(focused).toBe(page());
			show(shell, a);
			expect(focused).toBe(contentsOf(a));
		});

		const theWindow = () => shell.window as unknown as FakeWindow;
		/** The modal layer's own contents, once a sheet has put it on screen. */
		const layer = () =>
			(shell.picker.contents() as unknown as { id: number } | undefined)?.id;

		it("does not take the keyboard out of an open modal", () => {
			show(shell, a);
			shell.picker.openModal({ kind: "workspace-picker" });
			focused = undefined;
			showPage(shell);
			show(shell, b);
			// A dialog no key reaches is a dialog nobody can answer, so the
			// keyboard goes nowhere but the layer for as long as one stands.
			expect(focused).not.toBe(contentsOf(b));
			expect(focused).not.toBe(page());
		});

		it("gives the keyboard to the sheet, not to what is behind it", () => {
			show(shell, a);
			shell.picker.openModal({ kind: "workspace-picker" });
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
			show(shell, a);
			const id = shell.picker.openModal({ kind: "workspace-picker" });
			theWindow().inFront = false;
			theWindow().emit("blur");
			focused = undefined;

			theWindow().inFront = true;
			theWindow().emit("focus");
			expect(focused).toBe(layer());

			// And when the sheet goes, the surface has it again.
			shell.picker.closeModal(id);
			expect(focused).toBe(contentsOf(a));
		});

		/**
		 * `Cmd+Q J` going Agent → editor asks for the editor's shell.
		 *
		 * The command is the workbench's, so it is forwarded rather than
		 * reimplemented — and it is forwarded at the one moment the keyboard is
		 * placed, because a `terminal.focus` sent any earlier would focus a
		 * terminal in a view the keys are not going to.
		 */
		describe("and the terminal a selection asked for", () => {
			const runActions = (view: WorkbenchView): unknown[] =>
				(
					view.webContents as unknown as {
						sent: { channel: string; payload: unknown }[];
					}
				).sent
					.filter((one) => one.channel === "vscode:runAction")
					.map((one) => one.payload);

			it("is focused once the keyboard has landed in that workbench", () => {
				shell.focusTerminalOnArrival(keyOf(a));
				show(shell, a);
				expect(focused).toBe(contentsOf(a));
				expect(runActions(a)).toEqual([
					{ id: "workbench.action.terminal.focus", from: "menu" },
				]);
			});

			it("is not asked for by an ordinary selection", () => {
				show(shell, a);
				showPage(shell);
				show(shell, a);
				expect(runActions(a)).toEqual([]);
			});

			it("is asked for once, and not again on later placements", () => {
				shell.focusTerminalOnArrival(keyOf(a));
				show(shell, a);
				showPage(shell);
				show(shell, a);
				expect(runActions(a)).toHaveLength(1);
			});

			it("is dropped when the workbench it named is not there", () => {
				// Starting, restarting, or gone: there is no view to focus a
				// terminal in, and the selection still happens.
				shell.focusTerminalOnArrival("/folder/not-open");
				showPage(shell);
				expect(runActions(a)).toEqual([]);
				expect(runActions(b)).toEqual([]);
			});

			it("is dropped when the keyboard went somewhere else", () => {
				shell.focusTerminalOnArrival(keyOf(a));
				show(shell, b);
				expect(runActions(a)).toEqual([]);
				expect(runActions(b)).toEqual([]);
			});

			it("waits for nothing while the window is not in front", () => {
				// `placeKeyboardIn` declines outright there, so the keys never
				// arrived and there is nothing to have landed in.
				theWindow().inFront = false;
				shell.focusTerminalOnArrival(keyOf(a));
				show(shell, a);
				expect(runActions(a)).toEqual([]);
			});
		});
	});

	it("shows nothing when the revealed view goes away", () => {
		show(shell, c);
		shell.detach(c);
		invariantHolds(undefined);
	});
});

/**
 * The modal layer.
 *
 * Stacking is the point: a modal has to be above every workbench, and the only
 * thing in this window that is above a native view is another native view. So
 * the assertions here are about the window's child list and its bounds, not
 * about the calls that happen to produce them.
 */
describe("the shell window's modal layer", () => {
	let shell: ShellWindow;
	let editor: WorkbenchView;
	let other: WorkbenchView;

	const DIALOG = {
		kind: "workbench-dialog",
		surfaceKey: "workspace-editor:one",
		message: "Do you want to save the changes you made?",
		buttons: ["Save", "Don't Save", "Cancel"],
		defaultId: 0,
		cancelId: 2,
		tone: "warning",
	} as const;

	/**
	 * The modal layer, as a child of the window.
	 *
	 * Found by its contents rather than by elimination: every chrome child is
	 * in this list now, and "the one that is not a workbench" stopped naming
	 * one thing the moment the Sidebar and the Agents became views.
	 */
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

	beforeEach(() => {
		focused = undefined;
		shell = new ShellWindow(
			"preload.js",
			"devhub-app://shell/index.html",
			undefined,
			"hidden",
		);
		editor = new WorkbenchView(shell, {});
		other = new WorkbenchView(shell, {});
		for (const view of [editor, other]) {
			shell.attach(view);
			bind(shell, view);
		}
		shell.setSurfaceKeyResolver((view) =>
			view === editor ? "workspace-editor:one" : "workspace-editor:two",
		);
	});

	it("is not in the window at all while nothing is being asked", () => {
		show(shell, editor);
		expect(overlayChild()).toBeUndefined();
		expect(shell.picker.isPresent()).toBe(false);
	});

	it("is the topmost child for as long as a modal is open", () => {
		show(shell, editor);
		const id = shell.picker.openModal({ kind: "workspace-picker" });

		const children = shell.window.contentView.children as unknown as FakeView[];
		expect(overlayChild()).toBeDefined();
		expect(children[children.length - 1]).toBe(overlayChild());
		// And the workbench is still on screen underneath, not stood down.
		expect(shell.visibleViews()).toEqual([editor]);

		shell.picker.closeModal(id);
		expect(overlayChild()).toBeUndefined();
	});

	it("stays the topmost child through every later layout", () => {
		// The regression. `layout` raises the workbench on screen by re-adding
		// it, and it runs whenever anything about the arrangement moves — the
		// page re-measuring its content hole on a window resize or a sidebar
		// drag, another modal opening, the surface changing. The overlay used
		// to be raised only on the way in, so the first of those after a modal
		// opened put the editor back on top of the sheet: the picker still had
		// the keyboard, but the workbench was what was drawn and what took the
		// clicks, which reads exactly as an editor that activates itself.
		show(shell, editor);
		shell.picker.openModal({ kind: "workspace-picker" });
		const children = shell.window.contentView.children as unknown as FakeView[];

		shell.setLayoutState({
			...shell.layoutState(),
			sidebar: { width: 400, collapsed: false },
		});
		expect(children[children.length - 1]).toBe(overlayChild());

		shell.picker.openModal({ kind: "issue-assignment" });
		expect(children[children.length - 1]).toBe(overlayChild());

		show(shell, other);
		expect(children[children.length - 1]).toBe(overlayChild());

		showPage(shell);
		expect(children[children.length - 1]).toBe(overlayChild());
	});

	it("stays above a view the workbench opened inside itself", () => {
		// VS Code's integrated Browser is a `WebContentsView` nested inside the
		// workbench's own view rather than added beside it, which is the whole
		// of why the owner needs no new kind of child for it: the subtree moves
		// with the workbench, and every sibling the owner puts on top of the
		// workbench — the notices, the questions, the tooltip — is still on top
		// of everything in it.
		show(shell, editor);
		const browser = {} as Electron.View;
		asBrowserWindow(editor).contentView.addChildView(browser);

		shell.picker.openModal({ kind: "workspace-picker" });
		const children = shell.window.contentView.children as unknown as FakeView[];
		expect(children).not.toContain(browser);
		expect(children[children.length - 1]).toBe(overlayChild());

		// And a later layout moves the workbench without disturbing its subtree.
		shell.setLayoutState({
			...shell.layoutState(),
			sidebar: { width: 400, collapsed: false },
		});
		expect(children[children.length - 1]).toBe(overlayChild());
		expect(asBrowserWindow(editor).contentView.children).toEqual([browser]);
	});

	it("loses the nested view when the workbench it belongs to goes", () => {
		// Upstream's own teardown: `BrowserView.dispose` removes its view from
		// the same container it added it to, guarded by `isDestroyed()`. The
		// guard is why `contentView` throws rather than handing back a
		// container for a view that has ended.
		show(shell, editor);
		const browser = {} as Electron.View;
		const window = asBrowserWindow(editor);
		window.contentView.addChildView(browser);

		window.contentView.removeChildView(browser);
		expect(window.contentView.children).toEqual([]);

		editor.webContents.close();
		expect(window.isDestroyed()).toBe(true);
		expect(() => window.contentView).toThrow(/destroyed/);
	});

	it("covers the window for a DevHub modal and one workbench for its own", () => {
		show(shell, editor);
		const picker = shell.picker.openModal({ kind: "workspace-picker" });
		expect(overlayChild()?.getBounds()).toEqual({
			x: 0,
			y: 0,
			width: 1440,
			height: 900,
		});

		shell.picker.closeModal(picker);
		void shell.picker.ask(DIALOG);
		// The sidebar is outside this rectangle, which is what keeps it usable.
		expect(overlayChild()?.getBounds()).toEqual(AREA);
	});

	it("keeps the workbench being asked about on screen, whatever is selected", () => {
		show(shell, other);
		void shell.picker.ask(DIALOG);
		expect(shell.visibleViews()).toEqual([editor]);

		// Even when the page has its own surface in the viewport: a question
		// with no workbench under it cannot be answered.
		showPage(shell);
		expect(shell.visibleViews()).toEqual([editor]);
	});

	it("answers a question with the button pressed, and cancel when dismissed", async () => {
		const answered = shell.picker.ask(DIALOG);
		shell.picker.closeModal(shell.picker.askingId(), 1);
		expect(await answered).toBe(1);

		const dismissed = shell.picker.ask(DIALOG);
		shell.picker.closeModal(shell.picker.askingId());
		expect(await dismissed).toBe(DIALOG.cancelId);
	});

	it("replaces a question rather than stacking a second one on it", () => {
		shell.picker.openModal({ kind: "workspace-picker" });
		shell.picker.openModal({ kind: "workspace-picker" });
		expect(shell.picker.openModals()).toHaveLength(1);

		// A different workbench's question is a different question.
		void shell.picker.ask(DIALOG);
		void shell.picker.ask({ ...DIALOG, surfaceKey: "workspace-editor:two" });
		expect(shell.picker.openModals()).toHaveLength(3);
	});

	it("gives the keyboard back to the surface on screen when the last one goes", () => {
		show(shell, editor);
		const id = shell.picker.openModal({ kind: "workspace-picker" });
		shell.picker.closeModal(id);
		expect(focused).toBe(editor.webContents.id);

		// And to the Agents' view when an Agent is what is showing.
		showPage(shell);
		const next = shell.picker.openModal({ kind: "workspace-picker" });
		shell.picker.closeModal(next);
		expect(focused).toBe(
			(shell.agents.contents() as unknown as { id: number } | undefined)?.id,
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

/**
 * What the shell tells its workbenches about who has the keyboard.
 *
 * `WorkbenchView` holds the value and emits the transitions; this is the other
 * half — that the shell asks it to look again from every place that can change
 * the answer. The bug was never in the arithmetic. It was that nothing ever
 * did the asking, so `hostService.hasFocus` answered from whatever the view's
 * `webContents` happened to believe, which across an app switch was a stale
 * `true` that no event ever corrected — and a workspace trust prompt, which
 * waits for its window to have focus, waited.
 */
describe("the shell window's focus reporting", () => {
	let shell: ShellWindow;
	let window: FakeWindow;
	let a: WorkbenchView;
	let b: WorkbenchView;

	beforeEach(() => {
		shell = new ShellWindow(
			"preload.js",
			"devhub-app://shell/index.html",
			undefined,
			"hidden",
		);
		window = shell.window as unknown as FakeWindow;
		a = new WorkbenchView(shell, {});
		b = new WorkbenchView(shell, {});
		for (const view of [a, b]) {
			shell.attach(view);
			bind(shell, view);
		}
	});

	it("gives focus to the workbench it reveals, and to no other", () => {
		show(shell, a);
		expect(a.isFocused()).toBe(true);
		expect(b.isFocused()).toBe(false);

		show(shell, b);
		expect(a.isFocused()).toBe(false);
		expect(b.isFocused()).toBe(true);
	});

	it("tells a workbench when DevHub goes away, and when it comes back", () => {
		const events: string[] = [];
		a.on("focus", () => events.push("focus"));
		a.on("blur", () => events.push("blur"));

		show(shell, a);
		expect(events).toEqual(["focus"]);

		// The app switch. Nothing about the view's own contents changes here,
		// which is exactly why this had to be reported by the window.
		window.inFront = false;
		window.emit("blur");
		expect(a.isFocused()).toBe(false);
		expect(events).toEqual(["focus", "blur"]);

		window.inFront = true;
		window.emit("focus");
		expect(a.isFocused()).toBe(true);
		expect(events).toEqual(["focus", "blur", "focus"]);
	});

	it("tells the model too, starting with the answer as it stands", () => {
		// The model cannot see this for itself — a view keeps its DOM focus
		// while the window behind it is deactivated — and it needs it to know
		// whether anybody is looking at the Agent on screen. Registering
		// publishes the current answer, so the model does not start on an
		// assumption.
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

	it("takes focus off every workbench while the page's own surface is on screen", () => {
		show(shell, a);
		expect(a.isFocused()).toBe(true);

		// A terminal or an Agent lives in the page, not in a workbench.
		showPage(shell);
		expect(a.isFocused()).toBe(false);
		expect(b.isFocused()).toBe(false);

		show(shell, a);
		expect(a.isFocused()).toBe(true);
	});

	it("leaves a detached workbench believing nothing", () => {
		show(shell, a);
		expect(a.isFocused()).toBe(true);

		shell.detach(a);
		// It is off the table, so nothing will ever ask it again. If it kept the
		// `true` it had, it would keep it for the rest of its life.
		expect(a.isFocused()).toBe(false);
	});

	it("moves the keyboard before it reports where the keyboard is", () => {
		// What a workbench does with the report is go and read
		// `document.hasFocus()` in its own renderer, so a report sent before
		// `focus()` had moved anything would be answered with the state the
		// window was about to leave — and upstream latches, so the correction
		// never comes.
		const order: string[] = [];
		a.on("focus", () =>
			order.push(
				focused === a.webContents.id ? "focused then told" : "told first",
			),
		);

		show(shell, a);
		expect(order).toEqual(["focused then told"]);
	});

	it("says it again when the keyboard actually arrives in the renderer", () => {
		// The measured failure. `focus()` and the renderer's document taking
		// focus are not the same moment — 245ms apart, measured — and what a
		// workbench does with the announcement is go and read
		// `document.hasFocus()`. So the announcement made in the same tick as
		// `focus()` is answered "no", and without this one nothing corrects it:
		// a workbench is announced once, when its view is created, which is a
		// second and a half before its renderer reaches `Restored` and the
		// trust prompt starts listening.
		announced.length = 0;
		show(shell, a);
		expect(announced).toEqual([`browser-window-focus:${a.id}`]);

		a.webContents.emit("focus");
		expect(announced).toEqual([
			`browser-window-focus:${a.id}`,
			`browser-window-focus:${a.id}`,
		]);
	});

	it("says nothing again for a workbench the keyboard did not go to", () => {
		announced.length = 0;
		show(shell, a);
		announced.length = 0;

		// `b` is behind `a`. Its contents reporting DOM focus does not make it
		// the surface, and the one answer to that is `isSurfaceFocused`.
		b.webContents.emit("focus");
		expect(announced).toEqual([]);
	});

	it("says nothing again while a modal stands in front", () => {
		show(shell, a);
		shell.picker.openModal({ kind: "workspace-picker" });
		announced.length = 0;

		a.webContents.emit("focus");
		expect(announced).toEqual([]);
	});

	it("puts the keyboard back through the one path when the last modal goes", () => {
		show(shell, a);
		shell.picker.openModal({ kind: "workspace-picker" });
		expect(a.isFocused()).toBe(false);
		announced.length = 0;

		// Withdrawing used to focus the contents directly, which moved the
		// keyboard without anybody being told it had moved.
		shell.picker.closeWhere(() => true);
		expect(focused).toBe(a.webContents.id);
		expect(a.isFocused()).toBe(true);
		expect(announced).toEqual([`browser-window-focus:${a.id}`]);
	});

	it("still reports a workbench losing the keyboard to a modal it must not take back", () => {
		// The case that made the report unconditional in the first place: the
		// keyboard deliberately stays where the modal put it, and every
		// workbench still has to be told it no longer has it.
		show(shell, a);
		expect(a.isFocused()).toBe(true);

		shell.picker.openModal({ kind: "workspace-picker" });
		expect(a.isFocused()).toBe(false);
		expect(b.isFocused()).toBe(false);
	});
});

/**
 * When DevHub may come to the front, and when it may only move the keyboard.
 *
 * The two were one act — `reveal` placed the keyboard, and
 * `webContents.focus()` makes a window key on macOS — so everything that
 * revealed anything raised the window. A reveal follows every projection
 * change, so an Agent ticking, a HEAD moving or a workbench finishing its open
 * put DevHub in front of whatever the person was looking at; measured on an
 * idle instance, the window went to the background and DevHub called `focus()`
 * on the workbench five milliseconds later. The same one act is what put the
 * App Shell back over the Settings window, and what let a workbench activate
 * the application by asking for the keyboard on a hover.
 */
describe("when the shell window may come to the front", () => {
	let shell: ShellWindow;
	let window: FakeWindow;
	let a: WorkbenchView;
	let b: WorkbenchView;

	beforeEach(() => {
		raised.length = 0;
		focused = undefined;
		shell = new ShellWindow(
			"preload.js",
			"devhub-app://shell/index.html",
			undefined,
			"hidden",
		);
		window = shell.window as unknown as FakeWindow;
		a = new WorkbenchView(shell, {});
		b = new WorkbenchView(shell, {});
		for (const view of [a, b]) {
			shell.attach(view);
			bind(shell, view);
		}
	});

	it("moves the keyboard for VS Code's focusWindow, and raises nothing", () => {
		// `hostService.focus()` on a hover or a drag, arriving as
		// `CodeWindow.focus()` through the proxy. It is a request to type into
		// the workbench, and never a request to see DevHub.
		show(shell, a);
		focused = undefined;
		raised.length = 0;

		a.focus();
		expect(focused).toBe(a.webContents.id);
		expect(raised).toEqual([]);
	});

	it("does nothing at all for a workbench nobody is looking at", () => {
		show(shell, a);
		focused = undefined;

		// `b` is behind `a`. An extension in it calling `window.focus()` must
		// not change what is on screen.
		b.focus();
		expect(focused).toBeUndefined();
		expect(raised).toEqual([]);
	});

	it("declines to move the keyboard while another window is in front", () => {
		// The Settings window, an undocked Web Inspector, another application:
		// all of them are this one fact, and the shell no longer reaches across
		// to any of them. `focus()` here would have made this window key.
		show(shell, a);
		window.inFront = false;
		focused = undefined;

		show(shell, b);
		a.focus();
		b.focus();
		showPage(shell);
		show(shell, a);
		expect(focused).toBeUndefined();
		expect(raised).toEqual([]);
	});

	it("declines while a docked Web Inspector holds the keyboard", () => {
		// The one case the window's own focus cannot tell apart: the inspector
		// is a view onto these same contents, in this same window.
		show(shell, a);
		window.webContents.devToolsFocused = true;
		focused = undefined;

		show(shell, b);
		expect(focused).toBeUndefined();
	});

	it("places the keyboard when the window comes back, without raising", () => {
		// What makes declining safe rather than lossy: the answer is asked
		// again the moment the window is key, from the window's own event.
		show(shell, a);
		window.inFront = false;
		window.emit("blur");
		focused = undefined;
		raised.length = 0;

		window.inFront = true;
		window.emit("focus");
		expect(focused).toBe(a.webContents.id);
		expect(raised).toEqual([]);
	});

	it("raises when a command line asks for DevHub", () => {
		window.inFront = false;
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
		show(shell, a);
		focused = undefined;
		shell.picker.openModal({ kind: "workspace-picker" });
		expect(focused).not.toBe(a.webContents.id);
		expect(raised).toEqual([]);

		shell.picker.closeWhere(() => true);
		window.inFront = false;
		focused = undefined;
		shell.picker.openModal({ kind: "workspace-picker" });
		expect(focused).toBeUndefined();
	});

	it("re-announces a workbench's focus without moving or raising anything", () => {
		// The repeat added for the workspace trust prompt says the answer
		// again; it must not be a second way of taking the front.
		show(shell, a);
		focused = undefined;
		raised.length = 0;
		announced.length = 0;

		a.webContents.emit("focus");
		expect(announced).toEqual([`browser-window-focus:${a.id}`]);
		expect(raised).toEqual([]);
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
