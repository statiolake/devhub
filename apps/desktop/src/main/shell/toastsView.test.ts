/**
 * A layer that is only ever as big as what it is saying.
 *
 * The rule this pins is not about layout. A `WebContentsView` is a native view
 * and its hit testing is by rectangle: every click inside its bounds belongs
 * to it, painted or not, and Electron 42 gives a view no way to stand aside
 * (`WebContentsView` has `setBounds`, `setVisible`, `setBackgroundColor`,
 * `setBorderRadius` and `setLayout`, and nothing else — measured). So a layer
 * that is bigger than the notices is a hole in the editor underneath it, and a
 * layer that stays in the window with nothing to say is a permanent one.
 *
 * Which makes these the two assertions worth having: the bounds are the
 * reported size, and nothing to say means gone.
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

describe("the notice layer", () => {
	let toasts: InstanceType<typeof ToastsView>;
	let children: string[];
	let returned: number;

	beforeEach(() => {
		children = [];
		returned = 0;
		toasts = new ToastsView("preload.js", "devhub-app://shell/toasts.html");
		toasts.adopt({
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

	const view = () => (toasts as unknown as { view: FakeWebContentsView }).view;

	it("is not in the window at all while there is nothing to say", () => {
		toasts.reposition();
		expect(toasts.isPresent()).toBe(false);
		expect(children).toEqual([]);
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

	it("leaves the window when the last notice goes", () => {
		toasts.setSize({ width: 320, height: 96 });
		toasts.setSize({ width: 0, height: 0 });
		expect(toasts.isPresent()).toBe(false);
		expect(children).toEqual(["added", "removed"]);
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
		toasts.reposition();
		toasts.reposition();
		expect(children).toEqual(["added", "added", "added"]);
	});
});
