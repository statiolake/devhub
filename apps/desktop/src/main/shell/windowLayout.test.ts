import { describe, expect, it } from "vitest";
import {
	keyboardChild,
	contentRect,
	terminalExtent,
	terminalSeam,
	terminalStacked,
	agentsRect,
	orchestratorBoardWidth,
	chromeVariables,
	sidebarColumnWidth,
	sidebarOverlayHolds,
	sidebarRect,
	sidebarTrailingEdge,
	surfaceRect,
	tooltipRect,
	trafficLightPosition,
	windowLayout,
	workbenchRect,
	movesStalePicture,
	conversationsRect,
	boardTerminalRect,
	ORCHESTRATOR_BOARD_HEADER,
	type LayoutInput,
	type TooltipPlacement,
	type LayoutState,
	onScreenNeovim,
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
		neovims: ["/a", "/b"],
		toasts: undefined,
		picker: false,
		tooltip: undefined,
		...overrides,
	};
}

const kinds = (children: ReturnType<typeof windowLayout>) =>
	children.map((child) => child.identity.kind);

describe("the rectangle the editor is laid into", () => {
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
	it("stacks the page, the editor areas, the notices and the questions", () => {
		const children = windowLayout(
			input({ toasts: { width: 320, height: 90 }, picker: true }),
		);
		expect(kinds(children)).toEqual([
			"shell",
			"sidebar",
			"neovim",
			"neovim",
			"agents",
			"conversations",
			"toasts",
			"picker",
			"tooltip",
		]);
	});

	it("holds exactly one visible editor when a Workspace is selected", () => {
		const children = windowLayout(input());
		const visible = children.filter(
			(child) => child.identity.kind === "neovim" && child.visible,
		);
		expect(visible).toHaveLength(1);
		expect(visible[0]?.identity).toEqual({ kind: "neovim", editorKey: "/a" });
	});

	it("puts the visible editor last among the editor areas", () => {
		const children = windowLayout(
			input({ state: state({ surface: { kind: "editor", editorKey: "/b" } }) }),
		);
		const editors = children.filter(
			(child) => child.identity.kind === "neovim",
		);
		expect(editors.at(-1)?.visible).toBe(true);
		expect(editors.at(-1)?.identity).toEqual({
			kind: "neovim",
			editorKey: "/b",
		});
	});

	it("shows no editor when an Agent fills the area, or nothing can be", () => {
		for (const surface of [
			{ kind: "agent" } as const,
			{ kind: "none" } as const,
		]) {
			const children = windowLayout(input({ state: state({ surface }) }));
			expect(
				children.filter(
					(child) => child.identity.kind === "neovim" && child.visible,
				),
			).toHaveLength(0);
			// The views stay in the list, and stay sized: this is the Agent
			// covering the editor, not the editor going away.
			expect(
				children.filter((child) => child.identity.kind === "neovim"),
			).toHaveLength(2);
		}
	});

	it("sizes every editor, shown or not", () => {
		const children = windowLayout(input());
		const editors = children.filter(
			(child) => child.identity.kind === "neovim",
		);
		expect(
			new Set(editors.map((child) => JSON.stringify(child.rect))).size,
		).toBe(1);
	});

	it("parks every layer in the window's corner while it has nothing to show", () => {
		// In the window's child list, at the window's size and one pixel inside
		// it, so its page is never hidden and never has to lay itself out when
		// it has something to show; the rest outside the window, so it takes
		// no click. The notices, the questions and the tooltip are one rule.
		const parked = {
			rect: { x: WINDOW.width - 1, y: WINDOW.height - 1, ...WINDOW },
			visible: false,
		};
		for (const arrangement of [
			input(),
			input({ toasts: { width: 0, height: 0 } }),
		]) {
			const children = windowLayout(arrangement);
			expect(kinds(children)).toEqual([
				"shell",
				"sidebar",
				"neovim",
				"neovim",
				"agents",
				"conversations",
				"toasts",
				"picker",
				"tooltip",
			]);
			for (const kind of ["toasts", "picker", "tooltip"] as const) {
				expect(children.find((child) => child.identity.kind === kind)).toEqual({
					identity: { kind },
					...parked,
				});
			}
		}
	});

	it("keeps the z-order picker > toasts > editors > shell in every arrangement", () => {
		const arrangements: readonly LayoutInput[] = [
			input(),
			input({ picker: true, toasts: { width: 300, height: 80 } }),
			input({ state: state({ surface: { kind: "agent" } }) }),
			input({ neovims: [] }),
		];
		for (const arrangement of arrangements) {
			const order = kinds(windowLayout(arrangement));
			const rank = {
				shell: 0,
				sidebar: 1,
				neovim: 2,
				agents: 4,
				conversations: 4,
				terminal: 5,
				toasts: 6,
				picker: 7,
				tooltip: 8,
			} as const;
			expect(order[0]).toBe("shell");
			for (let index = 1; index < order.length; index += 1) {
				expect(rank[order[index]!]).toBeGreaterThanOrEqual(
					rank[order[index - 1]!],
				);
			}
		}
	});
});

describe("where the keyboard goes", () => {
	it("goes to the editor on screen", () => {
		expect(keyboardChild(input())).toEqual({ kind: "neovim", editorKey: "/a" });
	});

	it("goes to the Agent beside an editor, not to the editor", () => {
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
		expect(keyboardChild(input({ picker: true }))).toEqual({
			kind: "picker",
		});
	});
});

describe("a GUI Agent's conversation, in a view of its own", () => {
	const child = (
		children: ReturnType<typeof windowLayout>,
		kind: "agents" | "conversations" | "toasts" | "picker" | "tooltip",
	) => children.find((one) => one.identity.kind === kind)!;

	it("is drawn over the Agents' rectangle in place of the Agents view, and has the keys", () => {
		for (const surface of [
			{ kind: "agent" } as const,
			{ kind: "split", editorKey: "/a", ratio: 0.5 } as const,
		]) {
			const gui = input({
				state: state({ surface, keyboard: "agents", conversation: "whole" }),
			});
			const children = windowLayout(gui);
			expect(child(children, "conversations")).toEqual({
				identity: { kind: "conversations" },
				rect: agentsRect(WINDOW, gui.state),
				visible: true,
			});
			// Sized all the same, so a terminal Agent shown next is not a reflow.
			expect(child(children, "agents")).toEqual({
				identity: { kind: "agents" },
				rect: agentsRect(WINDOW, gui.state),
				visible: false,
			});
			expect(keyboardChild(gui)).toEqual({ kind: "conversations" });
		}
	});

	it("is not drawn for a terminal Agent, nor with no Agent on screen", () => {
		const terminal = input({
			state: state({ surface: { kind: "agent" }, keyboard: "agents" }),
		});
		expect(child(windowLayout(terminal), "conversations").visible).toBe(false);
		expect(child(windowLayout(terminal), "agents").visible).toBe(true);
		expect(keyboardChild(terminal)).toEqual({ kind: "agents" });
		const editor = input({ state: state({ conversation: "whole" }) });
		expect(child(windowLayout(editor), "conversations").visible).toBe(false);
		expect(keyboardChild(editor)).toEqual({ kind: "neovim", editorKey: "/a" });
	});

	it("stands right of the Orchestrator's board, which the Agents view still draws", () => {
		const board = input({
			state: state({
				surface: { kind: "agent" },
				keyboard: "agents",
				conversation: "beside-board",
			}),
		});
		const children = windowLayout(board);
		const agents = child(children, "agents");
		const conversations = child(children, "conversations");
		expect(agents.visible).toBe(true);
		expect(conversations.visible).toBe(true);
		const width = orchestratorBoardWidth(agents.rect.width);
		expect(conversations.rect).toEqual({
			...agents.rect,
			x: agents.rect.x + width,
			width: agents.rect.width - width,
		});
		// Above the Agents view, which it covers the right of.
		expect(children.indexOf(conversations)).toBeGreaterThan(
			children.indexOf(agents),
		);
		expect(keyboardChild(board)).toEqual({ kind: "conversations" });
	});

	it("goes under the board's view while a picture is open large over it, and only then", () => {
		const open = windowLayout(
			input({
				state: state({
					surface: { kind: "agent" },
					keyboard: "agents",
					conversation: "beside-board",
					agentsOverlay: true,
				}),
			}),
		);
		const agents = child(open, "agents");
		const conversations = child(open, "conversations");
		// The board's page, whole, over the conversation it is beside, and
		// still under every layer.
		expect(agents.visible).toBe(true);
		expect(conversations.visible).toBe(true);
		expect(open.indexOf(agents)).toBeGreaterThan(open.indexOf(conversations));
		for (const layer of ["toasts", "picker", "tooltip"] as const) {
			expect(open.indexOf(child(open, layer))).toBeGreaterThan(
				open.indexOf(agents),
			);
		}
		expect(agents.rect.x).toBeLessThan(conversations.rect.x);
		expect(agents.rect.x + agents.rect.width).toBe(
			conversations.rect.x + conversations.rect.width,
		);
		// A conversation over the whole area hides the Agents view, and a
		// picture said to be open on a page not drawn lifts nothing.
		const whole = windowLayout(
			input({
				state: state({
					surface: { kind: "agent" },
					conversation: "whole",
					agentsOverlay: true,
				}),
			}),
		);
		expect(child(whole, "agents").visible).toBe(false);
		expect(whole.indexOf(child(whole, "conversations"))).toBeGreaterThan(
			whole.indexOf(child(whole, "agents")),
		);
	});

	it("says the board's width as its stylesheet does: 46%, never under 380 or over 720", () => {
		expect(orchestratorBoardWidth(1000)).toBe(460);
		expect(orchestratorBoardWidth(600)).toBe(380);
		expect(orchestratorBoardWidth(2000)).toBe(720);
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
			input({ neovims: [] }),
			input({ state: state({ surface: { kind: "none" } }) }),
			input({ picker: true, toasts: { width: 10, height: 10 } }),
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

	it("draws exactly one of the Agents and an editor for a selection", () => {
		const onScreen = (arrangement: LayoutInput) =>
			windowLayout(arrangement)
				.filter((child) => child.visible)
				.map((child) => child.identity.kind)
				.filter((kind) => kind === "neovim" || kind === "agents");

		expect(onScreen(input())).toEqual(["neovim"]);
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
		).toEqual(["neovim", "agents"]);
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
	 * the side with an editor on it.
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
	 * Over the window exactly when there is a tooltip up — the rule of every
	 * layer: a native view takes every click inside its bounds, so a layer
	 * over the window with nothing to say is a permanent hole in the editor.
	 * With nothing to say it is parked (see "parks every layer").
	 */
	it("is over the window exactly when a tooltip is up", () => {
		const tooltip = (arrangement: LayoutInput) =>
			windowLayout(arrangement).find(
				(child) => child.identity.kind === "tooltip",
			);
		expect(tooltip(input())?.visible).toBe(false);
		expect(tooltip(input({ tooltip: placement() }))).toEqual({
			identity: { kind: "tooltip" },
			rect: tooltipRect(WINDOW, placement(), 248),
			visible: true,
		});
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
				picker: true,
				toasts: { width: 320, height: 90 },
			}),
		);
		expect(kinds(children)).toEqual([
			"shell",
			"sidebar",
			"neovim",
			"neovim",
			"agents",
			"conversations",
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

describe("the Agent's terminal, with its Agent", () => {
	const T1 = "11111111-1111-4111-8111-111111111111";
	const T2 = "22222222-2222-4222-8222-222222222222";
	const right = { terminalId: T1, share: 0.4 } as const;
	const split = state({
		surface: { kind: "split", editorKey: "/a", ratio: 0.5 },
		terminal: right,
	});
	const terminalChild = (layoutState: LayoutState, id = T1) =>
		windowLayout(input({ state: layoutState, terminals: [T1, T2] })).find(
			(child) =>
				child.identity.kind === "terminal" && child.identity.terminalId === id,
		);

	it("lays a full Agent inside the content, and the terminal right of it", () => {
		const full = state({ surface: { kind: "agent" }, terminal: right });
		const area = surfaceRect(WINDOW, full);
		// Less one seam, the terminal taking 40% of what is left.
		const terminalWidth = Math.round((area.width - 6) * 0.4);
		const contentWidth = area.width - 6 - terminalWidth;
		expect(agentsRect(WINDOW, full)).toEqual({ ...area, width: contentWidth });
		expect(terminalStacked(full)).toBe(false);
		expect(terminalExtent(WINDOW, full)).toEqual(area);
		expect(terminalSeam(WINDOW, full)).toEqual({
			...area,
			x: area.x + contentWidth,
			width: 6,
		});
		expect(terminalChild(full)).toMatchObject({
			visible: true,
			rect: {
				x: area.x + contentWidth + 6,
				y: area.y,
				width: terminalWidth,
				height: area.height,
			},
		});
		// Another Agent's terminal is sized and hidden, its session running.
		expect(terminalChild(full, T2)?.visible).toBe(false);
	});

	it("in a split, keeps the editor the whole left half and puts the terminal under the Agent", () => {
		const area = surfaceRect(WINDOW, split);
		const editor = workbenchRect(WINDOW, split);
		const agents = agentsRect(WINDOW, split);
		// The editor half is what it is without a terminal: full height, the
		// split's own share of the whole width.
		expect(editor).toEqual(
			workbenchRect(WINDOW, { ...split, terminal: undefined }),
		);
		expect(editor.height).toBe(area.height);
		const half = {
			...area,
			x: editor.x + editor.width + 6,
			width: area.x + area.width - (editor.x + editor.width + 6),
		};
		expect(terminalStacked(split)).toBe(true);
		expect(terminalExtent(WINDOW, split)).toEqual(half);
		// Less one level seam, the terminal taking 40% of the half's height.
		const terminalHeight = Math.round((area.height - 6) * 0.4);
		const agentHeight = area.height - 6 - terminalHeight;
		expect(agents).toEqual({ ...half, height: agentHeight });
		expect(terminalSeam(WINDOW, split)).toEqual({
			...half,
			y: area.y + agentHeight,
			height: 6,
		});
		expect(terminalChild(split)).toMatchObject({
			visible: true,
			rect: { ...half, y: area.y + agentHeight + 6, height: terminalHeight },
		});
	});

	it("is never drawn with the editor alone", () => {
		const editorOnly = state({ terminal: right });
		expect(terminalSeam(WINDOW, editorOnly)).toBeUndefined();
		expect(terminalExtent(WINDOW, editorOnly)).toBeUndefined();
		expect(workbenchRect(WINDOW, editorOnly)).toEqual(
			surfaceRect(WINDOW, editorOnly),
		);
		expect(terminalChild(editorOnly)?.visible).toBe(false);
	});

	it("is the whole area for the content when no terminal is shown", () => {
		expect(terminalSeam(WINDOW, state())).toBeUndefined();
		expect(contentRect(WINDOW, state())).toEqual(surfaceRect(WINDOW, state()));
	});

	it("gives the keyboard to the terminal on screen, and to the content otherwise", () => {
		const withTerminal = { ...split, keyboard: { terminal: T1 } } as const;
		expect(
			keyboardChild(input({ state: withTerminal, terminals: [T1] })),
		).toEqual({ kind: "terminal", terminalId: T1 });
		// Not drawn — its view does not exist yet — so the editor keeps it.
		expect(keyboardChild(input({ state: withTerminal }))).toEqual({
			kind: "neovim",
			editorKey: "/a",
		});
		// Nothing in the content area at all: the terminal is not drawn.
		expect(
			keyboardChild(
				input({
					state: { ...withTerminal, surface: { kind: "none" } },
					terminals: [T1],
				}),
			),
		).toEqual({ kind: "shell" });
	});

	it("stacks the terminal over the content's views and under every layer", () => {
		const order = kinds(windowLayout(input({ state: split, terminals: [T1] })));
		expect(order.indexOf("terminal")).toBeGreaterThan(order.indexOf("agents"));
		expect(order.indexOf("terminal")).toBeLessThan(order.indexOf("toasts"));
	});
});

describe("the editor area's Neovim page", () => {
	// A Neovim page per Workspace whose Neovim was shown, in the editor's
	// rectangle (`docs/neovim-editor.md`).
	const showing = (overrides: Partial<LayoutState> = {}) =>
		input({ state: state(overrides) });
	const splitTerminal = {
		kind: "split" as const,
		editorKey: "/a",
		ratio: 0.5,
	};

	it("lays the selected Workspace's terminal in the editor's rectangle", () => {
		const children = windowLayout(showing());
		const terminals = children.filter(
			(child) => child.identity.kind === "neovim",
		);
		expect(terminals.map((child) => [child.identity, child.visible])).toEqual([
			[{ kind: "neovim", editorKey: "/b" }, false],
			[{ kind: "neovim", editorKey: "/a" }, true],
		]);
		// Hidden ones are sized too, so coming back is a move, not a reflow.
		for (const child of terminals) {
			expect(child.rect).toEqual(workbenchRect(WINDOW, state()));
		}
		expect(keyboardChild(showing())).toEqual({
			kind: "neovim",
			editorKey: "/a",
		});
	});

	it("is the left half of a split, with the Agent beside it", () => {
		const children = windowLayout(
			showing({ surface: splitTerminal, keyboard: "agents" }),
		);
		const shown = children.find(
			(child) => child.identity.kind === "neovim" && child.visible,
		);
		expect(shown?.rect).toEqual(
			workbenchRect(WINDOW, state({ surface: splitTerminal })),
		);
		const agents = children.find((child) => child.identity.kind === "agents");
		expect(agents?.visible).toBe(true);
		expect(agents?.rect.x).toBeGreaterThan(
			(shown?.rect.x ?? 0) + (shown?.rect.width ?? 0),
		);
	});

	it("is not drawn under a full Agent, but stays sized", () => {
		const children = windowLayout(showing({ surface: { kind: "agent" } }));
		expect(
			children.filter(
				(child) => child.identity.kind === "neovim" && child.visible,
			),
		).toEqual([]);
		expect(onScreenNeovim(showing())).toBe("/a");
	});

	it("draws nothing for a Workspace whose terminal has no view yet", () => {
		const children = windowLayout(
			showing({
				surface: { kind: "editor", editorKey: "/c" },
			}),
		);
		expect(
			children.some(
				(child) => child.identity.kind === "neovim" && child.visible,
			),
		).toBe(false);
	});

	it("takes the keyboard as the editor half, in the split and alone", () => {
		expect(keyboardChild(showing({ surface: splitTerminal }))).toEqual({
			kind: "neovim",
			editorKey: "/a",
		});
		expect(
			keyboardChild(showing({ surface: splitTerminal, keyboard: "agents" })),
		).toEqual({ kind: "agents" });
	});

	it("falls back to the editor area from an Agent terminal that is not on screen", () => {
		expect(
			keyboardChild(
				showing({ surface: splitTerminal, keyboard: { terminal: "t1" } }),
			),
		).toEqual({
			kind: "neovim",
			editorKey: "/a",
		});
	});
});

/**
 * Compact mode's floating Sidebar (`useSidebarOverlay.ts`): the expanded
 * Sidebar on a card over the content, like a browser's vertical tab bar.
 * Only the Sidebar's own view moves for it, and it moves *up the stack*.
 */
describe("the floating Sidebar", () => {
	const floating = (overrides: Partial<LayoutState> = {}) =>
		state({
			sidebar: { width: 248, collapsed: true, overlay: true },
			...overrides,
		});
	const variables = new Map(chromeVariables());
	const shadow = Number.parseFloat(
		variables.get("--sidebar-overlay-shadow") ?? "",
	);

	it("tells every page the room its shadow is drawn in", () => {
		expect(shadow).toBeGreaterThan(0);
	});

	/**
	 * The rail growing: the same left edge and top as the rail, so nothing in
	 * it moves but its trailing edge.
	 */
	it("widens the Sidebar's view from the rail's own edge: expanded width, shadow", () => {
		expect(sidebarRect(WINDOW, floating())).toEqual({
			x: 0,
			y: 33,
			width: 248 + shadow,
			height: 867,
		});
	});

	it("moves nothing in the content area: it is laid out from the rail", () => {
		const rail = state({ sidebar: { width: 248, collapsed: true } });
		expect(surfaceRect(WINDOW, floating())).toEqual(surfaceRect(WINDOW, rail));
		expect(workbenchRect(WINDOW, floating())).toEqual(
			workbenchRect(WINDOW, rail),
		);
		const split = { kind: "split", editorKey: "/a", ratio: 0.5 } as const;
		expect(agentsRect(WINDOW, floating({ surface: split }))).toEqual(
			agentsRect(
				WINDOW,
				state({ sidebar: { width: 248, collapsed: true }, surface: split }),
			),
		);
	});

	it("is stacked over the content and under every layer", () => {
		const children = windowLayout(
			input({
				state: floating({
					surface: { kind: "split", editorKey: "/a", ratio: 0.5 },
					terminal: { terminalId: "t", share: 0.3 },
				}),
				terminals: ["t"],
			}),
		);
		const order = kinds(children);
		const sidebar = order.indexOf("sidebar");
		for (const content of ["neovim", "agents", "conversations", "terminal"]) {
			expect(order.lastIndexOf(content as never)).toBeLessThan(sidebar);
		}
		for (const layer of ["toasts", "picker", "tooltip"]) {
			expect(order.indexOf(layer as never)).toBeGreaterThan(sidebar);
		}
		expect(order.filter((kind) => kind === "sidebar")).toHaveLength(1);
	});

	it("stays under the content when it is docked or a rail", () => {
		for (const collapsed of [false, true]) {
			const order = kinds(
				windowLayout(
					input({ state: state({ sidebar: { width: 248, collapsed } }) }),
				),
			);
			expect(order.indexOf("sidebar")).toBe(1);
		}
	});

	/**
	 * Compact mode turned off under the card: the column is docked at once —
	 * the content moves over, once — while the view stays as wide as the card
	 * and over the content until the page says it has landed.
	 */
	it("lands: docked content, the card's view, until the page lets go", () => {
		const landing = state({
			sidebar: { width: 248, collapsed: false, overlay: true },
		});
		const docked = state({ sidebar: { width: 248, collapsed: false } });
		expect(surfaceRect(WINDOW, landing)).toEqual(surfaceRect(WINDOW, docked));
		expect(surfaceRect(WINDOW, landing).x).toBe(248);
		expect(sidebarRect(WINDOW, landing).width).toBe(248 + shadow);
		expect(sidebarRect(WINDOW, docked).width).toBe(248);
	});

	it("is the rail's own rectangle, grown", () => {
		const rail = sidebarRect(
			WINDOW,
			state({ sidebar: { width: 248, collapsed: true } }),
		);
		const card = sidebarRect(WINDOW, floating());
		expect({ x: card.x, y: card.y, height: card.height }).toEqual({
			x: rail.x,
			y: rail.y,
			height: rail.height,
		});
	});

	/**
	 * The page asks this once the pointer has left its document: the card,
	 * the rail included, and the tooltip a row raised hold it; the room the
	 * shadow is drawn in and the rest of the window do not.
	 */
	it("is held by a cursor on the card or on its tooltip, and nowhere else", () => {
		const tooltip: TooltipPlacement = {
			anchor: { x: 8, y: 100, width: 232, height: 26 },
			size: { width: 200, height: 60 },
		};
		const holds = (x: number, y: number, raised = tooltip) =>
			sidebarOverlayHolds({ x, y }, WINDOW, floating(), raised);
		expect(holds(10, 300)).toBe(true);
		expect(holds(247, 300)).toBe(true);
		// The shadow's room is not the card.
		expect(holds(248 + shadow / 2, 300)).toBe(false);
		// The tooltip, beside the row, is.
		const box = tooltipRect(WINDOW, tooltip, 248);
		expect(box.x).toBeGreaterThan(248);
		expect(holds(box.x + 5, box.y + 5)).toBe(true);
		expect(
			sidebarOverlayHolds(
				{ x: box.x + 5, y: box.y + 5 },
				WINDOW,
				floating(),
				undefined,
			),
		).toBe(false);
		expect(holds(800, 300)).toBe(false);
		// Above the card is the window's band, not the card.
		expect(holds(10, 10)).toBe(false);
	});

	it("is never wider than the window", () => {
		const narrow = { width: 200, height: 600 };
		expect(sidebarRect(narrow, floating()).width).toBe(200);
	});
});

/**
 * A tooltip is about a row in the Sidebar, and it never stands over the
 * Sidebar's rows: it starts past the column's visible trailing edge — the
 * docked column's, the rail's, or the floating card's — level with the row,
 * and only the window's edge can bring it back.
 */
describe("a tooltip beside the Sidebar, never over its rows", () => {
	/** An Issue mark half way along a row: 20 wide at x 150, the row at y 140. */
	const mark: TooltipPlacement = {
		anchor: { x: 150, y: 140, width: 20, height: 26 },
		size: { width: 240, height: 64 },
	};
	const placed = (sidebar: LayoutState["sidebar"], size = WINDOW) => {
		const at = state({ sidebar });
		const child = windowLayout(
			input({ windowSize: size, state: at, tooltip: mark }),
		).find((each) => each.identity.kind === "tooltip");
		if (!child?.visible) throw new Error("no tooltip");
		return { rect: child.rect, edge: sidebarTrailingEdge(size, at) };
	};

	it("starts past the docked column, level with the row", () => {
		const { rect, edge } = placed({ width: 248, collapsed: false });
		expect(edge).toBe(248);
		expect(rect.x).toBe(248 + 6);
		expect(rect.y).toBe(140);
	});

	it("starts past the floating card, at the card's full width", () => {
		const { rect, edge } = placed({
			width: 300,
			collapsed: true,
			overlay: true,
		});
		expect(edge).toBe(300);
		expect(rect.x).toBe(306);
		expect(rect.y).toBe(140);
	});

	it("starts past the rail, and past its own mark", () => {
		const rail = placed({ width: 248, collapsed: true });
		expect(rail.edge).toBe(40);
		// The anchor is further right than the rail here; the box is past
		// whichever is further, so it never covers what it is about.
		expect(rail.rect.x).toBe(150 + 20 + 6);
		const glyph = windowLayout(
			input({
				state: state({ sidebar: { width: 248, collapsed: true } }),
				tooltip: {
					anchor: { x: 12, y: 100, width: 16, height: 26 },
					size: { width: 240, height: 64 },
				},
			}),
		).find((each) => each.identity.kind === "tooltip");
		expect(glyph?.rect.x).toBe(40 + 6);
	});

	it("never flips back over the rows; only the window's edge clamps it", () => {
		const narrow = { width: 420, height: 600 };
		const { rect } = placed({ width: 248, collapsed: false }, narrow);
		// No room past the column: against the window's edge, not mirrored to
		// the leading side of the mark.
		expect(rect.x).toBe(420 - 240 - 4);
		expect(rect.x).toBeGreaterThan(150 - 240);
	});

	it("moves up, and only up, at the foot of the window", () => {
		const low: TooltipPlacement = {
			...mark,
			anchor: { ...mark.anchor, y: 880 },
		};
		const child = windowLayout(input({ tooltip: low })).find(
			(each) => each.identity.kind === "tooltip",
		);
		expect(child?.rect.y).toBe(900 - 64 - 4);
	});
});

describe("which moves would show a stale picture", () => {
	it("is a view moved and resized at once, and only that", () => {
		const at = { x: 248, y: 33, width: 1192, height: 867 };
		expect(movesStalePicture(at, { ...at, x: 40, width: 1400 })).toBe(true);
		// Moved at its size: the same frame, drawn elsewhere in the same frame.
		expect(movesStalePicture(at, { ...at, x: 40 })).toBe(false);
		// Resized where it stands: its old frame, where it was.
		expect(movesStalePicture(at, { ...at, width: 1400 })).toBe(false);
	});

	/**
	 * Every content view the Sidebar's toggle moves, in every arrangement it
	 * can be in, the editor area included: each of them is one the window
	 * holds back (`ShellWindow`).
	 */
	it("is what the Sidebar's toggle does to every view right of it", () => {
		const open = { width: 248, collapsed: false };
		const shut = { width: 248, collapsed: true };
		const arrangements: Partial<LayoutState>[] = [
			{ surface: { kind: "agent" } },
			{ surface: { kind: "agent" }, conversation: "whole" },
			{ surface: { kind: "agent" }, conversation: "beside-board" },
			{ surface: { kind: "split", editorKey: "/a", ratio: 0.5 } },
			{
				surface: { kind: "agent" },
				terminal: { terminalId: "t", share: 0.4 },
			},
		];
		for (const arrangement of arrangements) {
			const before = state({ ...arrangement, sidebar: open });
			const after = state({ ...arrangement, sidebar: shut });
			const label = JSON.stringify(arrangement);
			expect(
				movesStalePicture(
					agentsRect(WINDOW, before),
					agentsRect(WINDOW, after),
				),
				label,
			).toBe(true);
			if (arrangement.conversation !== undefined) {
				expect(
					movesStalePicture(
						conversationsRect(WINDOW, before),
						conversationsRect(WINDOW, after),
					),
					label,
				).toBe(true);
			}
			expect(
				movesStalePicture(
					workbenchRect(WINDOW, before),
					workbenchRect(WINDOW, after),
				),
				label,
			).toBe(true);
		}
	});

	/**
	 * A window resized from its edge moves no view that fills the content
	 * area: each keeps its origin and is resized where it stands. A split's
	 * Agent half does move, by its share of the change, which a live resize
	 * follows frame by frame rather than holding back.
	 */
	it("is not what a window resize does to a view filling the content area", () => {
		const wider = { width: 1600, height: 900 };
		for (const surface of [
			{ kind: "agent" } as const,
			{ kind: "editor", editorKey: "/a" } as const,
		]) {
			const now = state({ surface });
			expect(
				movesStalePicture(agentsRect(WINDOW, now), agentsRect(wider, now)),
			).toBe(false);
			expect(
				movesStalePicture(
					workbenchRect(WINDOW, now),
					workbenchRect(wider, now),
				),
			).toBe(false);
		}
		const split = state({
			surface: { kind: "split", editorKey: "/a", ratio: 0.5 },
		});
		expect(
			movesStalePicture(agentsRect(WINDOW, split), agentsRect(wider, split)),
		).toBe(true);
	});
});

describe("the Orchestrator's Terminal tab", () => {
	const neovim = (children: ReturnType<typeof windowLayout>, key: string) =>
		children.find(
			(one) => one.identity.kind === "neovim" && one.identity.editorKey === key,
		)!;
	const agentsOf = (children: ReturnType<typeof windowLayout>) =>
		children.find((one) => one.identity.kind === "agents")!;

	it("lays the row's Workspace's terminal page over the board's body, under its tabs and inside its hairline", () => {
		const tab = input({
			state: state({
				surface: { kind: "agent" },
				keyboard: "agents",
				boardTerminal: "/b",
			}),
		});
		const children = windowLayout(tab);
		const agents = agentsOf(children);
		const terminal = neovim(children, "/b");
		const board = orchestratorBoardWidth(agents.rect.width);
		expect(terminal).toEqual({
			identity: { kind: "neovim", editorKey: "/b" },
			rect: {
				x: agents.rect.x,
				y: agents.rect.y + ORCHESTRATOR_BOARD_HEADER,
				width: board - 1,
				height: agents.rect.height - ORCHESTRATOR_BOARD_HEADER,
			},
			visible: true,
		});
		expect(boardTerminalRect(WINDOW, tab.state)).toEqual(terminal.rect);
		// Over the Agents view, which goes on drawing the tabs and the
		// orchestrator's pane; the other Workspace's stays hidden.
		expect(agents.visible).toBe(true);
		expect(children.indexOf(terminal)).toBeGreaterThan(
			children.indexOf(agents),
		);
		expect(neovim(children, "/a").visible).toBe(false);
		expect(onScreenNeovim(tab)).toBe("/b");
	});

	it("stays beside a GUI orchestrator's conversation, never under it", () => {
		const tab = input({
			state: state({
				surface: { kind: "agent" },
				keyboard: "agents",
				conversation: "beside-board",
				boardTerminal: "/b",
			}),
		});
		const children = windowLayout(tab);
		const terminal = neovim(children, "/b").rect;
		const conversation = children.find(
			(one) => one.identity.kind === "conversations",
		)!.rect;
		expect(terminal.x + terminal.width).toBeLessThanOrEqual(conversation.x);
	});

	it("takes the keys when the editor half has them, and gives them back to the board", () => {
		const editor = input({
			state: state({
				surface: { kind: "agent" },
				keyboard: "editor",
				boardTerminal: "/b",
			}),
		});
		expect(keyboardChild(editor)).toEqual({ kind: "neovim", editorKey: "/b" });
		expect(
			keyboardChild({
				...editor,
				state: { ...editor.state, keyboard: "agents" },
			}),
		).toEqual({ kind: "agents" });
	});

	it("is not drawn before its page exists, nor with anything but the row's Agent surface", () => {
		const unmade = input({
			neovims: ["/a"],
			state: state({
				surface: { kind: "agent" },
				keyboard: "editor",
				boardTerminal: "/b",
			}),
		});
		expect(onScreenNeovim(unmade)).toBeUndefined();
		expect(keyboardChild(unmade)).toEqual({ kind: "shell" });
		const editor = input({ state: state({ boardTerminal: "/b" }) });
		expect(onScreenNeovim(editor)).toBe("/a");
		expect(neovim(windowLayout(editor), "/b").visible).toBe(false);
	});
});
