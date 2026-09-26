/**
 * A layer that is only ever as big as what it is saying.
 *
 * The rule this pins is not about layout. A `WebContentsView` is a native view
 * and its hit testing is by rectangle: every click inside its bounds belongs
 * to it, painted or not, and Electron 42 gives a view no way to stand aside
 * (`WebContentsView` has `setBounds`, `setVisible`, `setBackgroundColor`,
 * `setBorderRadius` and `setLayout`, and nothing else — measured). So a layer
 * that is bigger than the notices is a hole in the editor underneath it, and a
 * layer that stays over the window with nothing to say is a permanent one.
 *
 * Nor is it ever taken out of the window: a view out of it is a hidden page
 * that paints nothing, so it would come back on a frame of the notice it last
 * showed. With nothing to say it is parked, all but one pixel outside the
 * window's corner (`parkedRect`).
 *
 * Which makes these the assertions worth having: the bounds are the reported
 * size, and nothing to say means parked — never removed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeWebContents {
	focused = false;
	on(): this {
		return this;
	}
	loadURL(): Promise<void> {
		return Promise.resolve();
	}
	setWindowOpenHandler(): void {}
	isDestroyed(): boolean {
		return false;
	}
	isFocused(): boolean {
		return this.focused;
	}
}

class FakeWebContentsView {
	readonly webContents = new FakeWebContents();
	bounds: Electron.Rectangle | undefined;
	setBounds(bounds: Electron.Rectangle): void {
		this.bounds = bounds;
	}
	setBackgroundColor(): void {}
}

vi.mock("../electron.js", () => ({
	electron: {
		WebContentsView: FakeWebContentsView,
		shell: { openExternal: () => undefined },
	},
}));

const { ToastsView } = await import("./toastsView.js");
const { windowLayout } = await import("./windowLayout.js");
type LayoutChild = import("./windowLayout.js").LayoutChild;

/**
 * Where the layout owner would put this layer, for the size it now reports.
 *
 * The same function the window uses, asked with this test's window size, so
 * what is asserted below is the placement DevHub actually makes rather than a
 * second copy of the arithmetic.
 */
function placementFor(toasts: InstanceType<typeof ToastsView>): LayoutChild {
	const children = windowLayout({
		windowSize: { width: 1000, height: 800 },
		state: {
			titleBar: "hidden",
			density: "compact",
			sidebar: { width: 248, collapsed: false },
			surface: { kind: "none" },
			keyboard: "agents",
		},
		editors: [],
		asking: undefined,
		attached: [],
		toasts: toasts.contentSize(),
		picker: "none",
		tooltip: undefined,
	});
	const child = children.find((each) => each.identity.kind === "toasts");
	if (!child) throw new Error("the notices are not in the child list");
	return child;
}

/** Place the layer where the window would. */
function layOut(toasts: InstanceType<typeof ToastsView>): void {
	const child = placementFor(toasts);
	toasts.place(child.rect, child.visible);
}

/** One pixel inside this test window's bottom-right corner, at its size. */
const PARKED = { x: 999, y: 799, width: 1000, height: 800 };

describe("the notice layer", () => {
	let toasts: InstanceType<typeof ToastsView>;
	let children: string[];
	let returned: number;

	beforeEach(() => {
		children = [];
		returned = 0;
		toasts = new ToastsView("preload.js", "devhub-app://shell/toasts.html");
		toasts.adopt({
			sizeChanged: () => {
				layOut(toasts);
			},
			window: {
				isDestroyed: () => false,
				getContentSize: () => [1000, 800],
				contentView: {
					addChildView: () => children.push("added"),
					removeChildView: () => children.push("removed"),
				},
			} as unknown as Electron.BrowserWindow,
			focusSurface: () => {
				returned += 1;
			},
		});
	});

	const view = () =>
		(toasts as unknown as { layer: { view: FakeWebContentsView } }).layer.view;

	it("waits in the window's corner while there is nothing to say", () => {
		layOut(toasts);
		expect(toasts.isPresent()).toBe(false);
		expect(view().bounds).toEqual(PARKED);
		expect(children).toEqual(["added"]);
	});

	it("is exactly the size the page reported, in the window's corner", () => {
		toasts.setSize({ width: 320, height: 96 });
		expect(toasts.isPresent()).toBe(true);
		expect(view().bounds).toEqual({
			x: 1000 - 320 - 12,
			y: 800 - 96 - 12,
			width: 320,
			height: 96,
		});
	});

	it("never grows past the window, however long the sentence is", () => {
		toasts.setSize({ width: 4000, height: 3000 });
		expect(view().bounds).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
	});

	it("is parked, never taken out of the window, when the last notice goes", () => {
		toasts.setSize({ width: 320, height: 96 });
		toasts.setSize({ width: 0, height: 0 });
		expect(toasts.isPresent()).toBe(false);
		expect(view().bounds).toEqual(PARKED);
		expect(children).toEqual(["added", "added"]);
	});

	/**
	 * A notice is not a question. It arrives while the person is in the middle
	 * of something, and taking the keyboard from them would make every passing
	 * condition an interruption. This is the whole of the difference between
	 * this layer and the picker.
	 */
	it("does not take the keyboard when a notice arrives", () => {
		toasts.setSize({ width: 320, height: 96 });
		expect(view().webContents.focused).toBe(false);
		expect(returned).toBe(0);
	});

	/**
	 * The one case it touches focus at all: the stack emptied while one of its
	 * toasts was being typed into. Escape closes the toast that has the focus,
	 * so this is the ordinary way the last one goes.
	 */
	it("hands the keyboard back when it leaves holding it", () => {
		toasts.setSize({ width: 320, height: 96 });
		view().webContents.focused = true;
		toasts.setSize({ width: 0, height: 0 });
		expect(returned).toBe(1);
	});

	it("does not disturb the keyboard when it leaves without it", () => {
		toasts.setSize({ width: 320, height: 96 });
		toasts.setSize({ width: 0, height: 0 });
		expect(returned).toBe(0);
	});

	/**
	 * Re-added on every pass, because re-adding an existing child is what moves
	 * it to the top of the stack. Anything that lays the window out again — a
	 * resize, a reveal, a modal opening — has to leave the notices above the
	 * workbench, and raising them once would not.
	 */
	it("raises itself again on every pass, not only on the one it arrived on", () => {
		toasts.setSize({ width: 320, height: 96 });
		layOut(toasts);
		layOut(toasts);
		expect(children).toEqual(["added", "added", "added"]);
	});
});
