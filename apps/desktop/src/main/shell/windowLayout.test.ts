import { describe, expect, it } from "vitest";
import {
	keyboardChild,
	reconcileEditors,
	agentsRect,
	sidebarColumnWidth,
	sidebarRect,
	windowLayout,
	workbenchRect,
	type LayoutInput,
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

	it("gives it the whole height when it carries the traffic lights", () => {
		expect(sidebarRect(WINDOW, state({ titleBar: "hidden" }))).toEqual({
			x: 0,
			y: 0,
			width: 248,
			height: 900,
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
