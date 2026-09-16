import { describe, expect, it } from "vitest";
import {
	keyboardChild,
	reconcileEditors,
	agentsRect,
	sidebarColumnWidth,
	sidebarRect,
	tooltipRect,
	windowLayout,
	workbenchRect,
	type LayoutInput,
	type TooltipPlacement,
	type LayoutState,
} from "./windowLayout.js";

const WINDOW = { width: 1440, height: 900 };

function state(overrides: Partial<LayoutState> = {}): LayoutState {
	return {
		titleBar: "shown",
		density: "compact",
		sidebar: { width: 248, collapsed: false },
		surface: { kind: "editor", editorKey: "/a" },
		keyboard: "editor",
		...overrides,
	};
}

function input(overrides: Partial<LayoutInput> = {}): LayoutInput {
	return {
		windowSize: WINDOW,
		state: state(),
		editors: ["/a", "/b"],
		asking: undefined,
		toasts: undefined,
		picker: "none",
		tooltip: undefined,
		...overrides,
	};
}

const kinds = (children: ReturnType<typeof windowLayout>) =>
	children.map((child) => child.identity.kind);

describe("the rectangle the workbench is laid into", () => {
	it("is the content area minus the sidebar and the bar", () => {
		expect(workbenchRect(WINDOW, state())).toEqual({
			x: 248,
			y: 39,
			width: 1192,
			height: 861,
		});
	});

	it("gives the whole height back when there is no bar of DevHub's own", () => {
		const rect = workbenchRect(WINDOW, state({ titleBar: "hidden" }));
		expect(rect.y).toBe(0);
		expect(rect.height).toBe(900);
	});

	it("follows the sidebar's width without anything measuring it", () => {
		const wide = workbenchRect(WINDOW, state());
		const wider = workbenchRect(
			WINDOW,
			state({ sidebar: { width: 400, collapsed: false } }),
		);
		expect(wide.x).toBe(248);
		expect(wider.x).toBe(400);
		expect(wide.width - wider.width).toBe(152);
	});

	it("is a rail's width when the sidebar is collapsed, per chrome", () => {
		expect(
			sidebarColumnWidth(state({ sidebar: { width: 248, collapsed: true } })),
		).toBe(44);
		expect(
			sidebarColumnWidth(
				state({
					sidebar: { width: 248, collapsed: true },
					density: "comfortable",
				}),
			),
		).toBe(46);
		// With no bar above it the Sidebar carries the traffic lights, and the
		// rail may not be narrower than their span.
		expect(
			sidebarColumnWidth(
				state({ sidebar: { width: 248, collapsed: true }, titleBar: "hidden" }),
			),
		).toBe(76);
	});

	it("is the leading share of the area in a split, minus the seam", () => {
		const rect = workbenchRect(
			WINDOW,
			state({ surface: { kind: "split", editorKey: "/a", ratio: 0.5 } }),
		);
		expect(rect.x).toBe(248);
		expect(rect.width).toBe(593);
	});
});

describe("the child list", () => {
	it("stacks the page, the workbenches, the notices and the questions", () => {
		const children = windowLayout(
			input({ toasts: { width: 320, height: 90 }, picker: "window" }),
		);
		expect(kinds(children)).toEqual([
			"shell",
			"sidebar",
			"editor",
			"editor",
			"agents",
			"toasts",
			"picker",
		]);
	});

	it("holds exactly one visible workbench when a Workspace is selected", () => {
		const children = windowLayout(input());
		const visible = children.filter(
			(child) => child.identity.kind === "editor" && child.visible,
		);
		expect(visible).toHaveLength(1);
		expect(visible[0]?.identity).toEqual({ kind: "editor", editorKey: "/a" });
	});

	it("puts the visible workbench last among the workbenches", () => {
		const children = windowLayout(
			input({ state: state({ surface: { kind: "editor", editorKey: "/b" } }) }),
		);
		const editors = children.filter(
			(child) => child.identity.kind === "editor",
		);
		expect(editors.at(-1)?.visible).toBe(true);
		expect(editors.at(-1)?.identity).toEqual({
			kind: "editor",
			editorKey: "/b",
		});
	});

	it("shows no workbench when an Agent fills the area, or nothing can be", () => {
		for (const surface of [
			{ kind: "agent" } as const,
			{ kind: "none" } as const,
		]) {
			const children = windowLayout(input({ state: state({ surface }) }));
			expect(
				children.filter(
					(child) => child.identity.kind === "editor" && child.visible,
				),
			).toHaveLength(0);
			// The views stay in the list, and stay sized: this is the Agent
			// covering the workbench, not the workbench going away.
			expect(
				children.filter((child) => child.identity.kind === "editor"),
			).toHaveLength(2);
		}
	});

	it("sizes every workbench, shown or not", () => {
		const children = windowLayout(input());
		const editors = children.filter(
			(child) => child.identity.kind === "editor",
		);
		expect(
			new Set(editors.map((child) => JSON.stringify(child.rect))).size,
		).toBe(1);
	});

	it("has the notices and the questions in it only when they have content", () => {
		const bare = ["shell", "sidebar", "editor", "editor", "agents"];
		expect(kinds(windowLayout(input()))).toEqual(bare);
		expect(
			kinds(windowLayout(input({ toasts: { width: 0, height: 0 } }))),
		).toEqual(bare);
	});

	it("clips a workbench's question to that workbench", () => {
		const children = windowLayout(input({ picker: "workbench" }));
		expect(children.at(-1)?.rect).toEqual(workbenchRect(WINDOW, state()));
		const whole = windowLayout(input({ picker: "window" }));
		expect(whole.at(-1)?.rect).toEqual({ x: 0, y: 0, ...WINDOW });
	});

	it("keeps the z-order picker > toasts > editors > shell in every arrangement", () => {
		const arrangements: readonly LayoutInput[] = [
			input(),
			input({ picker: "window", toasts: { width: 300, height: 80 } }),
			input({ asking: "/b", picker: "workbench" }),
			input({ state: state({ surface: { kind: "agent" } }) }),
			input({ editors: [] }),
		];
		for (const arrangement of arrangements) {
			const order = kinds(windowLayout(arrangement));
			const rank = {
				shell: 0,
				sidebar: 1,
				editor: 2,
				agents: 3,
				toasts: 4,
				picker: 5,
				tooltip: 6,
			} as const;
			expect(order[0]).toBe("shell");
			for (let index = 1; index < order.length; index += 1) {
				expect(rank[order[index]!]).toBeGreaterThanOrEqual(
					rank[order[index - 1]!],
				);
			}
		}
	});

	it("shows the workbench that is asking, whatever the selection says", () => {
		const children = windowLayout(
			input({ asking: "/b", state: state({ surface: { kind: "agent" } }) }),
		);
		const visible = children.filter(
			(child) => child.identity.kind === "editor" && child.visible,
		);
		expect(visible[0]?.identity).toEqual({ kind: "editor", editorKey: "/b" });
	});
});

describe("where the keyboard goes", () => {
	it("goes to the workbench on screen", () => {
		expect(keyboardChild(input())).toEqual({ kind: "editor", editorKey: "/a" });
	});

	it("goes to the Agent beside a workbench, not to the workbench", () => {
		expect(
			keyboardChild(
				input({
					state: state({
						surface: { kind: "split", editorKey: "/a", ratio: 0.5 },
						keyboard: "agents",
					}),
				}),
			),
		).toEqual({ kind: "agents" });
	});

	it("goes to the Sidebar when the Sidebar is what was asked for", () => {
		expect(
			keyboardChild(input({ state: state({ keyboard: "sidebar" }) })),
		).toEqual({ kind: "sidebar" });
	});

	it("refuses to put the keys in an Agents view that is not drawn", () => {
		// The invisible-focus bug, stated as a property: `agents` is only ever
		// the answer where there is an Agent on screen to type into.
		expect(
			keyboardChild(
				input({
					state: state({
						surface: { kind: "editor", editorKey: "/a" },
						keyboard: "agents",
					}),
				}),
			),
		).toEqual({ kind: "shell" });
	});

	it("goes to a standing question before anything else", () => {
		expect(keyboardChild(input({ picker: "window" }))).toEqual({
			kind: "picker",
		});
	});

	it("goes to a workbench that is asking, even over an Agent", () => {
		expect(
			keyboardChild(
				input({ asking: "/b", state: state({ surface: { kind: "agent" } }) }),
			),
		).toEqual({ kind: "editor", editorKey: "/b" });
	});
});

describe("reconciling the workbenches against the projection", () => {
	const base = {
		wanted: ["/scratch", "/a"],
		existing: ["/scratch", "/a"],
		selected: "/a",
		gaveUp: [],
		parked: [],
		waiting: [],
	} as const;

	it("opens a workbench for a Workspace that appeared, selected one first", () => {
		const plan = reconcileEditors({
			...base,
			wanted: ["/scratch", "/a", "/b"],
			selected: "/b",
		});
		expect(plan.create).toEqual(["/b", "/scratch", "/a"]);
		expect(plan.dispose).toEqual([]);
	});

	it("destroys the workbench of a Workspace that left", () => {
		const plan = reconcileEditors({ ...base, wanted: ["/scratch"] });
		expect(plan.dispose).toEqual(["/a"]);
	});

	it("leaves an exhausted folder without a view, and parks its verdict", () => {
		// The supervisor gave up, which made the Workspace unavailable, which
		// takes it out of `wanted`: the folder is a child the page draws, not a
		// view.
		const plan = reconcileEditors({
			...base,
			wanted: ["/scratch"],
			gaveUp: ["/a"],
			selected: undefined,
		});
		expect(plan.create).toEqual(["/scratch"]);
		expect(plan.dispose).toEqual(["/a"]);
		expect(plan.park).toEqual(["/a"]);
	});

	it("forgets a parked verdict when a person brings the folder back", () => {
		const plan = reconcileEditors({
			...base,
			existing: ["/scratch"],
			gaveUp: ["/a"],
			parked: ["/a"],
		});
		expect(plan.forget).toEqual(["/a"]);
		expect(plan.create).toContain("/a");
	});

	it("asks again for nothing the supervisor has already answered", () => {
		const plan = reconcileEditors({
			...base,
			wanted: ["/scratch", "/a", "/b"],
			gaveUp: ["/a"],
			waiting: ["/b"],
			selected: undefined,
		});
		expect(plan.create).toEqual(["/scratch"]);
	});
});

describe("the Sidebar and the Agents as children of their own", () => {
	it("gives the Sidebar the leading column under the bar", () => {
		expect(sidebarRect(WINDOW, state())).toEqual({
			x: 0,
			y: 39,
			width: 248,
			height: 861,
		});
	});

	/**
	 * With no bar there is still a band, and it is still the window's.
	 *
	 * The traffic lights are drawn over this column in that chrome, and what
	 * the window is dragged by has to be a rectangle the *window's own page*
	 * declares — a drag region is handed to macOS by the window's contents, and
	 * whether one declared inside a child view composes into the same handle is
	 * not a thing this codebase can check. So the band is left out of the
	 * Sidebar's rectangle and the Sidebar starts under it.
	 */
	it("leaves the traffic lights' band to the window's own page", () => {
		expect(sidebarRect(WINDOW, state({ titleBar: "hidden" }))).toEqual({
			x: 0,
			y: 38,
			width: 248,
			height: 862,
		});
	});

	it("narrows it to the rail rather than taking it out of the window", () => {
		const rail = windowLayout(
			input({ state: state({ sidebar: { width: 248, collapsed: true } }) }),
		).find((child) => child.identity.kind === "sidebar");
		expect(rail?.visible).toBe(true);
		expect(rail?.rect.width).toBe(44);
	});

	it("is always in the window, in every arrangement", () => {
		for (const arrangement of [
			input(),
			input({ editors: [] }),
			input({ state: state({ surface: { kind: "none" } }) }),
			input({ picker: "window", toasts: { width: 10, height: 10 } }),
		]) {
			expect(kinds(windowLayout(arrangement))).toContain("sidebar");
		}
	});

	it("gives the Agents the whole content area when one covers it", () => {
		expect(agentsRect(WINDOW, state({ surface: { kind: "agent" } }))).toEqual({
			x: 248,
			y: 39,
			width: 1192,
			height: 861,
		});
	});

	it("gives the Agents the trailing share of a split, past the seam", () => {
		const split = state({
			surface: { kind: "split", editorKey: "/a", ratio: 0.5 },
		});
		const workbench = workbenchRect(WINDOW, split);
		const agents = agentsRect(WINDOW, split);
		// The seam belongs to neither: it is drawn on the window's own page,
		// in the one strip of the content area no child view covers, which is
		// what makes it draggable at all.
		expect(agents.x - (workbench.x + workbench.width)).toBe(6);
		expect(workbench.width + 6 + agents.width).toBe(1192);
	});

	it("draws exactly one of the Agents and a workbench for a selection", () => {
		const onScreen = (arrangement: LayoutInput) =>
			windowLayout(arrangement)
				.filter((child) => child.visible)
				.map((child) => child.identity.kind)
				.filter((kind) => kind === "editor" || kind === "agents");

		expect(onScreen(input())).toEqual(["editor"]);
		expect(
			onScreen(input({ state: state({ surface: { kind: "agent" } }) })),
		).toEqual(["agents"]);
		// A split is the one arrangement with two, and that is what a split is.
		expect(
			onScreen(
				input({
					state: state({
						surface: { kind: "split", editorKey: "/a", ratio: 0.5 },
					}),
				}),
			),
		).toEqual(["editor", "agents"]);
		expect(
			onScreen(input({ state: state({ surface: { kind: "none" } }) })),
		).toEqual([]);
	});

	it("sizes the Agents' view even while it is not drawn", () => {
		const agents = windowLayout(input()).find(
			(child) => child.identity.kind === "agents",
		);
		expect(agents?.visible).toBe(false);
		// The whole content area — the size it will be shown at, so that being
		// shown is not also a resize.
		expect(agents?.rect).toEqual({ x: 248, y: 39, width: 1192, height: 861 });
	});
});

/**
 * A tooltip is placed against the *window*, which is the whole reason it is a
 * child of the window.
 *
 * The Sidebar drew its own until now, against its own box, and the row that
 * most needed one — a glyph on a collapsed rail — was in a box 44 to 76px
 * wide. There was no arithmetic that made a sentence readable in that, so the
 * page refused to draw one at all. These are the assertions that say the
 * refusal is gone: the rectangle may start inside the Sidebar's column and
 * end well outside it, and the only thing it may not leave is the window.
 */
describe("where a tooltip goes", () => {
	const size = { width: 300, height: 40 };
	function placement(
		overrides: Partial<TooltipPlacement> = {},
	): TooltipPlacement {
		return {
			anchor: { x: 8, y: 100, width: 36, height: 24 },
			prefer: "right",
			size,
			...overrides,
		};
	}

	/**
	 * The rail's case, and the one that could not be drawn before: the anchor
	 * is a glyph in a 44px column and the sentence runs out over the editor.
	 */
	it("puts a rail's tooltip beside the glyph, out over the editor", () => {
		const rect = tooltipRect(WINDOW, placement());
		expect(rect).toEqual({ x: 8 + 36 + 6, y: 100, width: 300, height: 40 });
		// The assertion that matters: it ends outside the column it started in.
		expect(rect.x + rect.width).toBeGreaterThan(76);
	});

	it("hangs a row's tooltip under the row when that is the side asked for", () => {
		expect(tooltipRect(WINDOW, placement({ prefer: "below" }))).toEqual({
			x: 8,
			y: 100 + 24 + 6,
			width: 300,
			height: 40,
		});
	});

	/**
	 * Flipped to the other side of the anchor rather than squeezed into what
	 * is left. A tooltip is one rectangle with one width; narrowing it to fit
	 * is how a sentence becomes a ribbon, which is the failure this whole view
	 * exists to end.
	 */
	it("flips to the other side of the anchor at the trailing edge", () => {
		const anchor = { x: 1300, y: 100, width: 36, height: 24 };
		const rect = tooltipRect(WINDOW, placement({ anchor }));
		expect(rect.x).toBe(1300 - 6 - 300);
		expect(rect.width).toBe(300);
	});

	it("flips above the row at the bottom edge", () => {
		const anchor = { x: 8, y: 870, width: 36, height: 24 };
		const rect = tooltipRect(WINDOW, placement({ anchor, prefer: "below" }));
		expect(rect.y).toBe(870 - 6 - 40);
		expect(rect.height).toBe(40);
	});

	/**
	 * A flip can still land out of bounds when the anchor is itself in the
	 * corner, so the clamp is the last word. Off-window is the one result that
	 * is never readable.
	 */
	it("is clamped to the window when even the flip does not fit", () => {
		const rect = tooltipRect(
			WINDOW,
			placement({ anchor: { x: 2, y: 890, width: 36, height: 24 } }),
		);
		expect(rect.x).toBeGreaterThanOrEqual(4);
		expect(rect.y).toBeGreaterThanOrEqual(4);
		expect(rect.x + rect.width).toBeLessThanOrEqual(WINDOW.width);
		expect(rect.y + rect.height).toBeLessThanOrEqual(WINDOW.height);
	});

	it("never grows past the window, however long the sentence is", () => {
		const rect = tooltipRect(
			WINDOW,
			placement({ size: { width: 4000, height: 3000 } }),
		);
		expect(rect.width).toBe(WINDOW.width);
		expect(rect.height).toBe(WINDOW.height);
	});

	/**
	 * Present exactly when there is a tooltip up — the `toasts` rule, and for
	 * the same reason: a native view takes every click inside its bounds, so a
	 * layer that stays in the window with nothing to say is a permanent hole
	 * in the editor.
	 */
	it("is not in the child list at all while no tooltip is up", () => {
		expect(kinds(windowLayout(input()))).not.toContain("tooltip");
	});

	it("is in the child list exactly when one is", () => {
		expect(kinds(windowLayout(input({ tooltip: placement() })))).toContain(
			"tooltip",
		);
	});

	/**
	 * Above every other child, the questions included. Not because a tooltip
	 * may stand over a modal — the pointer leaves the row before a sheet is
	 * drawn — but because it is the one child that takes no click and hides
	 * nothing, so there is nothing it could be underneath *for*.
	 */
	it("is the topmost child of all, above the questions", () => {
		const children = windowLayout(
			input({
				tooltip: placement(),
				picker: "window",
				toasts: { width: 320, height: 90 },
			}),
		);
		expect(kinds(children)).toEqual([
			"shell",
			"sidebar",
			"editor",
			"editor",
			"agents",
			"toasts",
			"picker",
			"tooltip",
		]);
	});

	/** It is never what the keys go to: there is nothing in it to type into. */
	it("never takes the keyboard", () => {
		expect(keyboardChild(input({ tooltip: placement() }))).not.toEqual({
			kind: "tooltip",
		});
	});
});
