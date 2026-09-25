import { describe, expect, it } from "vitest";
import {
	keyboardChild,
	reconcileEditors,
	agentsRect,
	chromeVariables,
	sidebarColumnWidth,
	sidebarRect,
	surfaceRect,
	tooltipRect,
	trafficLightPosition,
	insideRect,
	windowLayout,
	workbenchRect,
	type AttachedPlacement,
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
		attached: [],
		...overrides,
	};
}

/** A view VS Code attached to `/a`, asking for a box in that workbench. */
function attached(
	overrides: Partial<AttachedPlacement> = {},
): AttachedPlacement {
	return {
		id: 1,
		editorKey: "/a",
		rect: { x: 10, y: 20, width: 300, height: 200 },
		visible: true,
		...overrides,
	};
}

const kinds = (children: ReturnType<typeof windowLayout>) =>
	children.map((child) => child.identity.kind);

describe("the rectangle the workbench is laid into", () => {
	it("is the content area minus the sidebar and the bar", () => {
		expect(workbenchRect(WINDOW, state())).toEqual({
			x: 248,
			y: 33,
			width: 1192,
			height: 867,
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
		// The page's own `--sidebar-rail-collapsed-width`: the density's glyph
		// column with one `--space-3` each side of it. It was 44 and 46 here
		// against the page's 40 and 42, so the rail's marks were centred in a
		// column four pixels narrower than the view they were drawn in.
		expect(
			sidebarColumnWidth(state({ sidebar: { width: 248, collapsed: true } })),
		).toBe(40);
		expect(
			sidebarColumnWidth(
				state({
					sidebar: { width: 248, collapsed: true },
					density: "comfortable",
				}),
			),
		).toBe(42);
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

	it("has the notices in it only when they have content", () => {
		const bare = ["shell", "sidebar", "editor", "editor", "agents", "picker"];
		expect(kinds(windowLayout(input()))).toEqual(bare);
		expect(
			kinds(windowLayout(input({ toasts: { width: 0, height: 0 } }))),
		).toEqual(bare);
	});

	it("parks the questions in the window's corner while nothing is asked", () => {
		// In the window's child list, at the window's size and one pixel inside
		// it, so its page is never hidden and never has to lay itself out when
		// a question comes; the rest outside the window, so it takes no click.
		const picker = windowLayout(input()).find(
			(child) => child.identity.kind === "picker",
		);
		expect(picker).toEqual({
			identity: { kind: "picker" },
			rect: { x: WINDOW.width - 1, y: WINDOW.height - 1, ...WINDOW },
			visible: false,
		});
	});

	it("clips a workbench's question to that workbench", () => {
		const children = windowLayout(input({ picker: "workbench" }));
		expect(children.at(-1)?.rect).toEqual(workbenchRect(WINDOW, state()));
		const whole = windowLayout(input({ picker: "window" }));
		expect(whole.at(-1)?.rect).toEqual({ x: 0, y: 0, ...WINDOW });
	});

	it("keeps the z-order picker > toasts > attached > editors > shell in every arrangement", () => {
		const arrangements: readonly LayoutInput[] = [
			input(),
			input({ attached: [attached()] }),
			input({
				attached: [attached(), attached({ id: 2, editorKey: "/b" })],
				picker: "window",
				toasts: { width: 300, height: 80 },
			}),
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
				attached: 3,
				agents: 4,
				toasts: 5,
				picker: 6,
				tooltip: 7,
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
			y: 33,
			width: 248,
			height: 867,
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
			y: 32,
			width: 248,
			height: 868,
		});
	});

	it("narrows it to the rail rather than taking it out of the window", () => {
		const rail = windowLayout(
			input({ state: state({ sidebar: { width: 248, collapsed: true } }) }),
		).find((child) => child.identity.kind === "sidebar");
		expect(rail?.visible).toBe(true);
		expect(rail?.rect.width).toBe(40);
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
			y: 33,
			width: 1192,
			height: 867,
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
		expect(agents?.rect).toEqual({ x: 248, y: 33, width: 1192, height: 867 });
	});
});

/**
 * A tooltip is placed against the *window*, which is the whole reason it is a
 * child of the window.
 *
 * The Sidebar drew its own until now, against its own box, and the row that
 * most needed one — a glyph on a collapsed rail — was in a box 40 to 76px
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
			size,
			...overrides,
		};
	}

	/**
	 * The rail's case, and the one that could not be drawn before: the anchor
	 * is a glyph in a 40px column and the sentence runs out over the editor.
	 */
	it("puts a rail's tooltip beside the glyph, out over the editor", () => {
		const rect = tooltipRect(WINDOW, placement());
		expect(rect).toEqual({ x: 8 + 36 + 6, y: 100, width: 300, height: 40 });
		// The assertion that matters: it ends outside the column it started in.
		expect(rect.x + rect.width).toBeGreaterThan(76);
	});

	/**
	 * And the expanded column's case is the same case. It used to be under the
	 * row, which in a list of stacked rows is over the *next* row: the answer
	 * to what you just pointed at covering the thing you are pointing at next,
	 * to be dodged before it can be clicked. There is one side now, and it is
	 * the side with a workbench on it.
	 */
	it("puts an expanded row's tooltip beside it too, never under it", () => {
		const anchor = { x: 0, y: 100, width: 248, height: 26 };
		expect(tooltipRect(WINDOW, placement({ anchor }))).toEqual({
			x: 248 + 6,
			y: 100,
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

	/**
	 * The bottom of the column, where a box that hung under the row would have
	 * been off the window. Beside the row there is nothing to flip: the box
	 * starts level with the row's own top and the clamp lifts it until it fits,
	 * which can only ever move it *up*. Nothing is placed below the row it is
	 * about, so nothing lands on the row after it.
	 */
	it("lifts a tooltip at the bottom edge rather than dropping it below", () => {
		const anchor = { x: 8, y: 890, width: 36, height: 24 };
		const rect = tooltipRect(WINDOW, placement({ anchor }));
		expect(rect.y).toBeLessThanOrEqual(890);
		expect(rect.y + rect.height).toBeLessThanOrEqual(WINDOW.height);
		expect(rect.height).toBe(40);
	});

	/**
	 * A sentence too wide for either side of the row. It does not fall back to
	 * hanging under the row — there is no such side any more — it ends against
	 * the window's trailing edge, still level with the row it is about.
	 */
	it("clamps a very wide tooltip to the window, still beside the row", () => {
		const anchor = { x: 0, y: 100, width: 248, height: 26 };
		const rect = tooltipRect(
			WINDOW,
			placement({ anchor, size: { width: WINDOW.width - 20, height: 40 } }),
		);
		expect(rect.y).toBe(100);
		expect(rect.x + rect.width).toBeLessThanOrEqual(WINDOW.width);
		expect(rect.width).toBe(WINDOW.width - 20);
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

/**
 * Where a view a workbench opened inside itself goes.
 *
 * It is a sibling of the workbench, not a child of it — a nested
 * `WebContentsView` is not painted at all on macOS with this Electron — so
 * everything that used to be free from nesting is decided here instead: the
 * rectangle the renderer measured in the workbench's own document, translated
 * and clipped; visibility that follows the workbench and not only VS Code's
 * wish; and a place in the child list above the workbench and below everything
 * the shell draws over it.
 */
describe("a view a workbench attached to itself", () => {
	it("is placed in the window by translating the workbench's origin", () => {
		const child = windowLayout(input({ attached: [attached()] })).find(
			(candidate) => candidate.identity.kind === "attached",
		);
		const workbench = workbenchRect(WINDOW, state());
		expect(child?.rect).toEqual({
			x: workbench.x + 10,
			y: workbench.y + 20,
			width: 300,
			height: 200,
		});
	});

	it("moves with the workbench when the sidebar narrows", () => {
		const collapsed = state({ sidebar: { width: 248, collapsed: true } });
		const child = windowLayout(
			input({ state: collapsed, attached: [attached()] }),
		).find((candidate) => candidate.identity.kind === "attached");
		expect(child?.rect.x).toBe(workbenchRect(WINDOW, collapsed).x + 10);
	});

	it("is clipped to its workbench, never over the sidebar or an agent", () => {
		const workbench = workbenchRect(WINDOW, state());
		// A box that starts before the workbench and runs past its far corner
		// is held to the workbench on all four sides.
		expect(
			insideRect(workbench, {
				x: -50,
				y: -50,
				width: workbench.width + 500,
				height: workbench.height + 500,
			}),
		).toEqual(workbench);
		// And one entirely outside it is empty rather than negative.
		expect(
			insideRect(workbench, {
				x: workbench.width + 10,
				y: 0,
				width: 100,
				height: 100,
			}),
		).toEqual({
			x: workbench.x + workbench.width,
			y: workbench.y,
			width: 0,
			height: 100,
		});
	});

	it("is drawn only when its workbench is the one on screen", () => {
		const drawn = (arrangement: LayoutInput) =>
			windowLayout(arrangement)
				.filter((child) => child.identity.kind === "attached")
				.map((child) => child.visible);
		expect(drawn(input({ attached: [attached()] }))).toEqual([true]);
		// VS Code does not want it drawn.
		expect(drawn(input({ attached: [attached({ visible: false })] }))).toEqual([
			false,
		]);
		// Another Workspace is selected: the wish stands, the answer does not.
		expect(
			drawn(
				input({
					attached: [attached()],
					state: state({ surface: { kind: "editor", editorKey: "/b" } }),
				}),
			),
		).toEqual([false]);
		// An Agent covers the content area, so no workbench is on screen.
		expect(
			drawn(
				input({
					attached: [attached()],
					state: state({ surface: { kind: "agent" } }),
				}),
			),
		).toEqual([false]);
	});

	it("is sized whether or not it is drawn, like the workbenches", () => {
		const hidden = windowLayout(
			input({
				attached: [attached()],
				state: state({ surface: { kind: "editor", editorKey: "/b" } }),
			}),
		).find((child) => child.identity.kind === "attached");
		const shown = windowLayout(input({ attached: [attached()] })).find(
			(child) => child.identity.kind === "attached",
		);
		expect(hidden?.rect).toEqual(shown?.rect);
	});

	it("sits above every workbench and below the notices and the questions", () => {
		const order = kinds(
			windowLayout(
				input({
					attached: [attached()],
					toasts: { width: 300, height: 80 },
					picker: "window",
					tooltip: {
						anchor: { x: 8, y: 100, width: 36, height: 24 },
						size: { width: 300, height: 40 },
					},
				}),
			),
		);
		expect(order).toEqual([
			"shell",
			"sidebar",
			"editor",
			"editor",
			"attached",
			"agents",
			"toasts",
			"picker",
			"tooltip",
		]);
	});

	it("tells its views apart, so the owner can place each one", () => {
		const children = windowLayout(
			input({
				attached: [
					attached(),
					attached({ id: 2, rect: { x: 0, y: 0, width: 10, height: 10 } }),
				],
			}),
		).filter((child) => child.identity.kind === "attached");
		expect(children.map((child) => child.identity)).toEqual([
			{ kind: "attached", editorKey: "/a", id: 1 },
			{ kind: "attached", editorKey: "/a", id: 2 },
		]);
	});
});

/**
 * The bar and the lights in it are one measurement, not two.
 *
 * The bar is a plain macOS title bar's height, and the lights are placed from
 * it rather than tuned beside it — so what is asserted is the relation: their
 * middle is the bar's middle, and they are as far from the leading edge as
 * from the top, which is where a plain titled window keeps them.
 */
describe("the title bar and the traffic lights", () => {
	const variables = new Map(chromeVariables());
	const bar = Number.parseFloat(variables.get("--titlebar-height") ?? "");
	/** A light's frame, as macOS 26 draws it. */
	const light = 14;

	it("is a plain titled window's bar", () => {
		expect(bar).toBe(32);
	});

	it("centres the lights on the bar's middle line", () => {
		const { y } = trafficLightPosition();
		expect(y + light / 2).toBe(bar / 2);
	});

	it("insets the lights as far from the leading edge as from the top", () => {
		expect(trafficLightPosition()).toEqual({ x: 9, y: 9 });
	});

	it("keeps the lights inside the span the page leaves them", () => {
		// Three lights at the system's 23pt pitch, from the derived inset.
		const reach = trafficLightPosition().x + 2 * 23 + light;
		const span = Number.parseFloat(variables.get("--traffic-light-span") ?? "");
		expect(reach).toBeLessThan(span);
	});

	it("starts the content area under the bar and its hairline, and the Sidebar under the bar alone without one", () => {
		expect(surfaceRect(WINDOW, state()).y).toBe(bar + 1);
		expect(sidebarRect(WINDOW, state()).y).toBe(bar + 1);
		expect(sidebarRect(WINDOW, state({ titleBar: "hidden" })).y).toBe(bar);
		expect(surfaceRect(WINDOW, state({ titleBar: "hidden" })).y).toBe(0);
	});
});
