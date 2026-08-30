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
	};
}

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
		shell = new ShellWindow("preload.js", "devhub-app://shell/index.html");
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

	it("shows nothing when the revealed view goes away", () => {
		shell.reveal(c);
		shell.detach(c);
		invariantHolds(undefined);
	});
});
