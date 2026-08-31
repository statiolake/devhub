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
		send: () => undefined,
		focus: () => {
			focused = this.webContents.id;
		},
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

class FakeWindow {
	readonly contentView = new FakeContentView();
	readonly webContents = {
		id: nextId(),
		send: () => undefined,
		focus: () => {
			focused = this.webContents.id;
		},
	};
	isDestroyed(): boolean {
		return false;
	}
	getContentSize(): [number, number] {
		return [1440, 900];
	}
	loadURL(): void {}
	once(): void {}
	on(): void {}
	show(): void {}
}

vi.mock("../electron.js", () => ({
	electron: {
		BrowserWindow: FakeWindow,
		WebContentsView: FakeView,
	},
}));

const { ShellWindow } = await import("./shellWindow.js");
const { WorkbenchView } = await import("./workbenchView.js");
type ShellWindow = InstanceType<typeof ShellWindow>;
type WorkbenchView = InstanceType<typeof WorkbenchView>;

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
		);
		shell.setContentRect({ x: 248, y: 38, width: 1192, height: 837 });
		a = new WorkbenchView(shell, {});
		b = new WorkbenchView(shell, {});
		c = new WorkbenchView(shell, {});
		for (const view of [a, b, c]) shell.attach(view);
	});

	function invariantHolds(expected: WorkbenchView | undefined): void {
		expect(shell.visibleViews()).toEqual(expected ? [expected] : []);
		if (expected) expect(shell.topmostView()).toBe(expected);
	}

	it("shows nothing until the selection says what to show", () => {
		// Creating a workbench must not put it on screen: three of them open at
		// launch, and whichever finished last would otherwise take the screen.
		invariantHolds(undefined);
	});

	it("shows exactly the revealed view, on top, however often it changes", () => {
		for (const view of [a, b, c, a, c, b, b, a]) {
			shell.reveal(view);
			invariantHolds(view);
		}
	});

	it("sizes a view before it is shown, never after", () => {
		const boundsOf = (view: WorkbenchView): Electron.Rectangle | undefined =>
			(view.view as unknown as FakeView).bounds;

		shell.reveal(b);
		expect(boundsOf(b)).toEqual({ x: 248, y: 38, width: 1192, height: 837 });

		shell.setContentRect({ x: 100, y: 20, width: 800, height: 600 });
		expect(boundsOf(b)).toEqual({ x: 100, y: 20, width: 800, height: 600 });
		invariantHolds(b);
	});

	it("shows nothing while the page's own surface is the one on screen", () => {
		shell.reveal(a);
		shell.setNativeSurfaceVisible(false);
		invariantHolds(undefined);

		shell.setNativeSurfaceVisible(true);
		invariantHolds(a);
	});

	it("cannot reveal a view whose contents are gone", () => {
		shell.reveal(a);
		// Killed from underneath, the way a crashed renderer goes: no call to
		// `destroy()`, so nothing tells the table on the way out except the
		// contents themselves ending. The table must not still contain it a
		// moment later — Electron answers a destroyed child with "can't add a
		// destroyed child view to a parent view", which is a true statement
		// about a table that should never have held it.
		a.webContents.close();
		expect(shell.visibleViews()).toEqual([]);

		shell.reveal(a);
		expect(shell.visibleViews()).toEqual([]);
		expect(shell.topmostView()).not.toBe(a);
		expect(shell.revealedView()).toBeUndefined();

		// And the surviving views are still perfectly usable.
		shell.reveal(b);
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
		const page = () => shell.window.webContents.id;
		const contentsOf = (view: WorkbenchView): number =>
			(view.webContents as unknown as { id: number }).id;

		beforeEach(() => {
			focused = undefined;
		});

		it("gives the keyboard to the workbench that is on screen", () => {
			shell.reveal(a);
			expect(focused).toBe(contentsOf(a));
			shell.reveal(b);
			expect(focused).toBe(contentsOf(b));
		});

		it("takes it off a hidden workbench and gives it to the page", () => {
			// The page is where a terminal and an Agent surface live, so this is
			// what makes typing go straight into the xterm with no click.
			shell.reveal(a);
			shell.setNativeSurfaceVisible(false);
			expect(focused).toBe(page());
		});

		it("survives being asked over and over, from either end", () => {
			// Editor → Terminal → Editor → Terminal, which is the chord the
			// report says cannot be used twice in a row.
			shell.reveal(a);
			for (let round = 0; round < 3; round += 1) {
				shell.setNativeSurfaceVisible(false);
				expect(focused).toBe(page());
				shell.setNativeSurfaceVisible(true);
				expect(focused).toBe(contentsOf(a));
			}
		});

		it("leaves a workbench alone while the page's surface is on screen", () => {
			// A projection change re-reveals the selected Editor even while the
			// Terminal is showing. That must not pull the keyboard out of it.
			shell.setNativeSurfaceVisible(false);
			focused = undefined;
			shell.reveal(a);
			expect(focused).toBe(page());
		});

		it("does not take the keyboard out of an open modal", () => {
			shell.reveal(a);
			shell.modals.openModal({ kind: "workspace-picker" });
			focused = undefined;
			shell.setNativeSurfaceVisible(false);
			shell.reveal(b);
			// A dialog no key reaches is a dialog nobody can answer.
			expect(focused).toBeUndefined();
		});
	});

	it("shows nothing when the revealed view goes away", () => {
		shell.reveal(c);
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

	function overlayChild(): FakeView | undefined {
		const children = shell.window.contentView.children as unknown as FakeView[];
		const views = shell.getViews().map((view) => view.view);
		return children.find((child) => !views.includes(child as never));
	}

	beforeEach(() => {
		focused = undefined;
		shell = new ShellWindow(
			"preload.js",
			"devhub-app://shell/index.html",
			undefined,
		);
		shell.setContentRect({ x: 248, y: 38, width: 1192, height: 837 });
		editor = new WorkbenchView(shell, {});
		other = new WorkbenchView(shell, {});
		for (const view of [editor, other]) shell.attach(view);
		shell.setSurfaceKeyResolver((view) =>
			view === editor ? "workspace-editor:one" : "workspace-editor:two",
		);
	});

	it("is not in the window at all while nothing is being asked", () => {
		shell.reveal(editor);
		expect(overlayChild()).toBeUndefined();
		expect(shell.modals.isPresent()).toBe(false);
	});

	it("is the topmost child for as long as a modal is open", () => {
		shell.reveal(editor);
		const id = shell.modals.openModal({ kind: "workspace-picker" });

		const children = shell.window.contentView.children as unknown as FakeView[];
		expect(overlayChild()).toBeDefined();
		expect(children[children.length - 1]).toBe(overlayChild());
		// And the workbench is still on screen underneath, not stood down.
		expect(shell.visibleViews()).toEqual([editor]);

		shell.modals.closeModal(id);
		expect(overlayChild()).toBeUndefined();
	});

	it("covers the window for a DevHub modal and one workbench for its own", () => {
		shell.reveal(editor);
		const picker = shell.modals.openModal({ kind: "workspace-picker" });
		expect(overlayChild()?.getBounds()).toEqual({
			x: 0,
			y: 0,
			width: 1440,
			height: 900,
		});

		shell.modals.closeModal(picker);
		void shell.modals.ask(DIALOG);
		// The sidebar is outside this rectangle, which is what keeps it usable.
		expect(overlayChild()?.getBounds()).toEqual({
			x: 248,
			y: 38,
			width: 1192,
			height: 837,
		});
	});

	it("keeps the workbench being asked about on screen, whatever is selected", () => {
		shell.reveal(other);
		void shell.modals.ask(DIALOG);
		expect(shell.visibleViews()).toEqual([editor]);

		// Even when the page says its own surface is the one in the viewport:
		// a question with no workbench under it cannot be answered.
		shell.setNativeSurfaceVisible(false);
		expect(shell.visibleViews()).toEqual([editor]);
	});

	it("answers a question with the button pressed, and cancel when dismissed", async () => {
		const answered = shell.modals.ask(DIALOG);
		shell.modals.closeModal(shell.modals.askingId(), 1);
		expect(await answered).toBe(1);

		const dismissed = shell.modals.ask(DIALOG);
		shell.modals.closeModal(shell.modals.askingId());
		expect(await dismissed).toBe(DIALOG.cancelId);
	});

	it("replaces a question rather than stacking a second one on it", () => {
		shell.modals.openModal({ kind: "workspace-picker" });
		shell.modals.openModal({ kind: "workspace-picker" });
		expect(shell.modals.openModals()).toHaveLength(1);

		// A different workbench's question is a different question.
		void shell.modals.ask(DIALOG);
		void shell.modals.ask({ ...DIALOG, surfaceKey: "workspace-editor:two" });
		expect(shell.modals.openModals()).toHaveLength(3);
	});

	it("gives the keyboard back to the surface on screen when the last one goes", () => {
		shell.reveal(editor);
		const id = shell.modals.openModal({ kind: "workspace-picker" });
		shell.modals.closeModal(id);
		expect(focused).toBe(editor.webContents.id);

		// And to the page when the page is what is showing.
		shell.setNativeSurfaceVisible(false);
		const next = shell.modals.openModal({ kind: "workspace-picker" });
		shell.modals.closeModal(next);
		expect(focused).toBe(shell.window.webContents.id);
	});
});
