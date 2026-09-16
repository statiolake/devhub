/**
 * A tooltip that may leave the column it is about.
 *
 * This is the whole point of the layer, so it is the first assertion: the
 * Sidebar's own tooltip was a box in the Sidebar's document, clipped by a view
 * 44px wide on a collapsed rail, and `RowTooltip.tsx` refused to draw one at
 * all rather than draw a ribbon. Here the anchor is a rail glyph and the
 * rectangle runs out over the editor.
 *
 * The rest is the notices' bargain, which this layer keeps for the notices'
 * reason: a `WebContentsView` is a native view and its hit testing is by
 * rectangle, so a layer bigger than what it draws is a hole in the editor and
 * a layer that lingers with nothing to say is a permanent one. Bounds are the
 * reported size; nothing to say means gone.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeWebContents {
	readonly sent: unknown[] = [];
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
		return false;
	}
	focus(): void {
		throw new Error("the tooltip view must never be focused");
	}
	send(_channel: string, payload: unknown): void {
		this.sent.push(payload);
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

const { TooltipView } = await import("./tooltipView.js");
const { windowLayout } = await import("./windowLayout.js");

/** A rail glyph, in the window's coordinates: a 44px column, a row at y 120. */
const RAIL_GLYPH = { x: 14, y: 120, width: 16, height: 24 };

/**
 * Where the layout owner would put this layer, for what it now holds.
 *
 * The same function the window uses, asked with this test's window size, so
 * what is asserted below is the placement DevHub actually makes rather than a
 * second copy of the arithmetic.
 */
function placementFor(
	tooltip: InstanceType<typeof TooltipView>,
): Electron.Rectangle | undefined {
	const children = windowLayout({
		windowSize: { width: 1000, height: 800 },
		state: {
			titleBar: "hidden",
			density: "compact",
			sidebar: { width: 44, collapsed: true },
			surface: { kind: "none" },
			keyboard: "agents",
		},
		editors: [],
		asking: undefined,
		toasts: undefined,
		picker: "none",
		tooltip: tooltip.placement(),
	});
	return children.find((child) => child.identity.kind === "tooltip")?.rect;
}

describe("the tooltip layer", () => {
	let tooltip: InstanceType<typeof TooltipView>;
	let children: string[];

	beforeEach(() => {
		children = [];
		tooltip = new TooltipView("preload.js", "devhub-app://shell/tooltip.html");
		tooltip.adopt({
			tooltipChanged: () => {
				tooltip.place(placementFor(tooltip));
			},
			window: {
				isDestroyed: () => false,
				getContentSize: () => [1000, 800],
				contentView: {
					addChildView: () => children.push("added"),
					removeChildView: () => children.push("removed"),
				},
			} as unknown as Electron.BrowserWindow,
		});
	});

	const view = () => (tooltip as unknown as { view: FakeWebContentsView }).view;
	const show = () => {
		tooltip.show({
			text: "widget workspace",
			anchor: RAIL_GLYPH,
			prefer: "right",
		});
	};

	it("is not in the window at all while no tooltip is up", () => {
		tooltip.place(placementFor(tooltip));
		expect(tooltip.isPresent()).toBe(false);
		expect(children).toEqual([]);
	});

	/**
	 * A request with no size yet is not a tooltip. Between main being asked
	 * and the page reporting its box there is a moment with one and not the
	 * other, and a view placed then is a zero-sized rectangle.
	 */
	it("waits for the page to say how big the box came out", () => {
		show();
		expect(tooltip.isPresent()).toBe(false);
		tooltip.setSize({ width: 220, height: 34 });
		expect(tooltip.isPresent()).toBe(true);
	});

	/**
	 * The assertion the whole layer exists for: anchored to a glyph in a 44px
	 * rail, the box ends well outside that column. In the Sidebar's own
	 * document this was the case that could not be drawn at all.
	 */
	it("runs out over the editor from a rail that could never hold it", () => {
		show();
		tooltip.setSize({ width: 220, height: 34 });
		const bounds = view().bounds;
		expect(bounds).toEqual({ x: 14 + 16 + 6, y: 120, width: 220, height: 34 });
		expect(bounds!.x + bounds!.width).toBeGreaterThan(44);
	});

	it("leaves the window when the tooltip goes down", () => {
		show();
		tooltip.setSize({ width: 220, height: 34 });
		tooltip.hide();
		expect(tooltip.isPresent()).toBe(false);
		expect(children).toEqual(["added", "removed"]);
	});

	/**
	 * Down on the page's side too, and told before this view leaves: a page
	 * that went on drawing would draw into a view nobody can see, and the next
	 * tooltip would flash the previous sentence.
	 */
	it("tells the page to stop drawing when it goes down", () => {
		show();
		tooltip.setSize({ width: 220, height: 34 });
		tooltip.hide();
		expect(view().webContents.sent.at(-1)).toBeUndefined();
	});

	/**
	 * One tooltip for the whole tree, and this class could not hold two if it
	 * tried: one view, one request. Replacing does not clear the size, because
	 * the pointer moving from row to row is the ordinary case and a frame with
	 * no tooltip in it reads as a flicker.
	 */
	it("replaces the tooltip that is up rather than stacking another", () => {
		show();
		tooltip.setSize({ width: 220, height: 34 });
		tooltip.show({
			text: "another row entirely",
			anchor: { x: 14, y: 300, width: 16, height: 24 },
			prefer: "right",
		});
		expect(tooltip.isPresent()).toBe(true);
		expect(view().bounds?.y).toBe(300);
		expect(view().webContents.sent.at(-1)).toEqual({
			text: "another row entirely",
		});
	});

	it("never grows past the window, however long the sentence is", () => {
		show();
		tooltip.setSize({ width: 4000, height: 3000 });
		expect(view().bounds).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
	});

	/**
	 * Re-added on every pass, because re-adding an existing child is what moves
	 * it to the top of the stack — and this layer is last in the owner's list,
	 * so anything that lays the window out again has to leave it on top of
	 * whatever it appeared over.
	 */
	it("raises itself again on every pass, not only on the one it arrived on", () => {
		show();
		tooltip.setSize({ width: 220, height: 34 });
		tooltip.place(placementFor(tooltip));
		tooltip.place(placementFor(tooltip));
		expect(children).toEqual(["added", "added", "added"]);
	});

	/**
	 * It never touches the keyboard in either direction. There is nothing in a
	 * tooltip to type into — the fake throws if anything tries — which is one
	 * step further than the notices, where Escape closes a focused toast and
	 * `ToastsView` has to hand focus back when it leaves holding it.
	 */
	it("never takes the keyboard, and never hands it anywhere", () => {
		show();
		tooltip.setSize({ width: 220, height: 34 });
		tooltip.hide();
		// Reaching here at all is the assertion: `focus()` throws.
		expect(tooltip.isPresent()).toBe(false);
	});

	it("does nothing when told to hide while nothing is up", () => {
		tooltip.hide();
		expect(children).toEqual([]);
		expect(view().webContents.sent).toEqual([]);
	});
});
