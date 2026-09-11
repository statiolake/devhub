import { describe, expect, it } from "vitest";
import { strokeKeys } from "../../model/chordKeys.js";
import type { CommandId } from "../../model/commands.js";
import {
	defaultChordTable,
	matchChord,
	resolveChord,
	type KeyStroke,
} from "./chords.js";
import { AppModel } from "../../model/appModel.js";
import {
	AgentProfile,
	agentId,
	agentProfileId,
	displayPath,
	Workspace,
	workspaceId,
	workspaceRoot,
} from "../../model/domain.js";
import { snapshotWire } from "../../model/wire.js";
import type {
	AgentWire,
	AppSnapshotWire,
	NavigationContext,
	SurfacePresentationWire,
	WorkspaceWire,
} from "../../ipc/appShell.js";

function agent(
	id: string,
	workspaceId: string,
	ordinal: number,
	extra: Partial<AgentWire> = {},
): AgentWire {
	return {
		activity: undefined,
		injection: {
			queued: 0,
			waitingFor: "nothing_queued",
			lastResult: undefined,
		},
		controlState: { kind: "running" },
		displayName: id,
		id,
		ordinal,
		profileId: "profile",
		runtimeHealth: "healthy",
		status: "idle",
		unread: undefined,
		workspaceId,
		...extra,
	};
}

/**
 * `"a1"` for an Agent that has been read, `"a1!"` for one that is unread.
 *
 * The mark is in the name so that a test's expectation reads as the ring it is
 * walking — `["a1!", "b1", "b2!"]` is the whole fixture — rather than as a
 * second list of ids somewhere else that has to be kept in step with it.
 */
function workspace(
	id: string,
	agentIds: readonly string[],
	extra: Partial<WorkspaceWire> = {},
): WorkspaceWire {
	return {
		agents: agentIds.map((written, index) =>
			written.endsWith("!")
				? agent(written.slice(0, -1), id, index, { unread: "idle" })
				: agent(written, id, index),
		),
		canCreateAgent: true,
		id,
		label: id,
		root: `/workspaces/${id}`,
		selectedPath: `/workspaces/${id}`,
		state: { kind: "available" },
		close: { kind: "idle" },
		...extra,
	};
}

function snapshotOf({
	workspaces = [],
	context = { kind: "global" } as NavigationContext,
	presentation = "full" as SurfacePresentationWire,
}: {
	workspaces?: readonly WorkspaceWire[];
	context?: NavigationContext;
	presentation?: SurfacePresentationWire;
} = {}): AppSnapshotWire {
	return {
		editorHost: { status: "ready" },
		layout: { kind: "workbench", editorKey: "global-editor" },
		readiness: "ready",
		revision: 1,
		schemaVersion: 1,
		selection: { context, presentation },
		sidebar: { width: 248 },
		splitRatio: 0.55,
		workspaces,
	};
}

const one = workspace("one", ["a1"]);
const two = workspace("two", ["b1", "b2"]);
const empty = workspace("empty", []);

function run(commandId: CommandId, snapshot: AppSnapshotWire) {
	return resolveChord(commandId, snapshot);
}

function selects(context: NavigationContext) {
	return { kind: "select-context", context };
}

describe("the workspace cycle", () => {
	const snapshot = snapshotOf({ workspaces: [one, two] });

	it("counts Scratch as the first entry", () => {
		expect(run("select_entry_1", snapshot)).toEqual(
			selects({ kind: "global" }),
		);
		expect(run("select_entry_3", snapshot)).toEqual(
			selects({ kind: "workspace", workspaceId: "two" }),
		);
	});

	it("does nothing for a digit past the end of the list", () => {
		expect(run("select_entry_7", snapshot)).toBeUndefined();
	});

	it("steps through Scratch and the workspaces, wrapping at both ends", () => {
		expect(run("next_workspace", snapshot)).toEqual(
			selects({ kind: "workspace", workspaceId: "one" }),
		);
		expect(run("previous_workspace", snapshot)).toEqual(
			selects({ kind: "workspace", workspaceId: "two" }),
		);
		expect(
			run(
				"next_workspace",
				snapshotOf({
					workspaces: [one, two],
					context: { kind: "workspace", workspaceId: "two" },
				}),
			),
		).toEqual(selects({ kind: "global" }));
	});

	it("moves out of an Agent by the workspace that Agent is in", () => {
		expect(
			run(
				"previous_workspace",
				snapshotOf({
					workspaces: [one, two],
					context: { kind: "agent", agentId: "b2" },
				}),
			),
		).toEqual(selects({ kind: "workspace", workspaceId: "one" }));
	});

	it("does nothing when Scratch is the only entry", () => {
		expect(run("next_workspace", snapshotOf())).toBeUndefined();
	});
});

describe("the Agent cycle", () => {
	const snapshot = snapshotOf({ workspaces: [one, two] });

	it("crosses workspaces, because an Agent is the unit of work", () => {
		// The bug this replaces: `}` stopped dead at a workspace boundary that
		// means nothing to the person pressing it.
		expect(
			run(
				"next_agent",
				snapshotOf({
					workspaces: [one, two],
					context: { kind: "agent", agentId: "a1" },
				}),
			),
		).toEqual(selects({ kind: "agent", agentId: "b1" }));
	});

	it("wraps around the whole list, not around one workspace", () => {
		expect(
			run(
				"next_agent",
				snapshotOf({
					workspaces: [one, two],
					context: { kind: "agent", agentId: "b2" },
				}),
			),
		).toEqual(selects({ kind: "agent", agentId: "a1" }));
		expect(
			run(
				"previous_agent",
				snapshotOf({
					workspaces: [one, two],
					context: { kind: "agent", agentId: "a1" },
				}),
			),
		).toEqual(selects({ kind: "agent", agentId: "b2" }));
	});

	it("starts at the first or the last from a row that is not an Agent", () => {
		expect(run("next_agent", snapshot)).toEqual(
			selects({ kind: "agent", agentId: "a1" }),
		);
		expect(run("previous_agent", snapshot)).toEqual(
			selects({ kind: "agent", agentId: "b2" }),
		);
	});

	it("is a no-op, not an error, with no Agents anywhere", () => {
		expect(
			run("next_agent", snapshotOf({ workspaces: [empty] })),
		).toBeUndefined();
	});
});

/**
 * `}` is `]` with the list narrowed, and that is the whole of it.
 *
 * The same ring in the same order from the same place — so these expectations
 * are written against the ring the all-Agents cycle walks, and only the stops
 * differ.
 */
describe("the unread Agent cycle", () => {
	// The ring, in order: a1, a2 (unread), b1 (unread), b2.
	const mixedOne = workspace("one", ["a1", "a2!"]);
	const mixedTwo = workspace("two", ["b1!", "b2"]);
	const mixed = [mixedOne, mixedTwo];

	function from(agentId: string, commandId: CommandId) {
		return run(
			commandId,
			snapshotOf({ workspaces: mixed, context: { kind: "agent", agentId } }),
		);
	}

	it("skips the Agents that have been read, in sidebar order", () => {
		expect(from("a1", "next_unread_agent")).toEqual(
			selects({ kind: "agent", agentId: "a2" }),
		);
		expect(from("a2", "next_unread_agent")).toEqual(
			selects({ kind: "agent", agentId: "b1" }),
		);
		expect(from("b2", "previous_unread_agent")).toEqual(
			selects({ kind: "agent", agentId: "b1" }),
		);
	});

	it("wraps around the whole ring, crossing workspaces", () => {
		expect(from("b1", "next_unread_agent")).toEqual(
			selects({ kind: "agent", agentId: "a2" }),
		);
		expect(from("a1", "previous_unread_agent")).toEqual(
			selects({ kind: "agent", agentId: "b1" }),
		);
	});

	it("starts at the top from a row that is not an Agent", () => {
		const snapshot = snapshotOf({ workspaces: mixed });
		expect(run("next_unread_agent", snapshot)).toEqual(
			selects({ kind: "agent", agentId: "a2" }),
		);
		expect(run("previous_unread_agent", snapshot)).toEqual(
			selects({ kind: "agent", agentId: "b1" }),
		);
		expect(
			run(
				"next_unread_agent",
				snapshotOf({
					workspaces: mixed,
					context: { kind: "workspace", workspaceId: "two" },
				}),
			),
		).toEqual(selects({ kind: "agent", agentId: "a2" }));
	});

	it("is a no-op with nothing unread, and with no Agents at all", () => {
		const read = snapshotOf({
			workspaces: [one, two],
			context: { kind: "agent", agentId: "a1" },
		});
		expect(run("next_unread_agent", read)).toBeUndefined();
		expect(run("previous_unread_agent", read)).toBeUndefined();
		expect(
			run("next_unread_agent", snapshotOf({ workspaces: [empty] })),
		).toBeUndefined();
	});

	it("leaves the unnarrowed cycle alone", () => {
		expect(from("a1", "next_agent")).toEqual(
			selects({ kind: "agent", agentId: "a2" }),
		);
		expect(from("a2", "next_agent")).toEqual(
			selects({ kind: "agent", agentId: "b1" }),
		);
		expect(from("b1", "previous_agent")).toEqual(
			selects({ kind: "agent", agentId: "a2" }),
		);
	});
});

describe("the tab cycle", () => {
	const snapshot = snapshotOf({ workspaces: [one, two] });

	it("walks every row in order without minding which kind it is", () => {
		// global, one, a1, two, b1, b2.
		expect(run("next_tab", snapshot)).toEqual(
			selects({ kind: "workspace", workspaceId: "one" }),
		);
		expect(
			run(
				"next_tab",
				snapshotOf({
					workspaces: [one, two],
					context: { kind: "workspace", workspaceId: "one" },
				}),
			),
		).toEqual(selects({ kind: "agent", agentId: "a1" }));
		expect(
			run(
				"next_tab",
				snapshotOf({
					workspaces: [one, two],
					context: { kind: "agent", agentId: "a1" },
				}),
			),
		).toEqual(selects({ kind: "workspace", workspaceId: "two" }));
	});

	it("wraps from the last row back to Scratch", () => {
		expect(
			run(
				"next_tab",
				snapshotOf({
					workspaces: [one, two],
					context: { kind: "agent", agentId: "b2" },
				}),
			),
		).toEqual(selects({ kind: "global" }));
		expect(run("previous_tab", snapshot)).toEqual(
			selects({ kind: "agent", agentId: "b2" }),
		);
	});

	it("does nothing when Scratch is the only row", () => {
		expect(run("next_tab", snapshotOf())).toBeUndefined();
	});
});

describe("the two halves of a workspace", () => {
	it("goes from an Agent back to its workspace", () => {
		expect(
			run(
				"toggle_workspace_agent",
				snapshotOf({
					workspaces: [two],
					context: { kind: "agent", agentId: "b2" },
				}),
			),
		).toEqual(selects({ kind: "workspace", workspaceId: "two" }));
	});

	it("goes from the workspace back to the Agent it was last in", () => {
		expect(
			run(
				"toggle_workspace_agent",
				snapshotOf({
					workspaces: [workspace("two", ["b1", "b2"], { lastAgentId: "b2" })],
					context: { kind: "workspace", workspaceId: "two" },
				}),
			),
		).toEqual({
			kind: "select-context",
			context: { kind: "agent", agentId: "b2" },
			presentation: "full",
		});
	});

	it("goes to the first Agent from a workspace that has never had one open", () => {
		expect(
			run(
				"toggle_workspace_agent",
				snapshotOf({
					workspaces: [two],
					context: { kind: "workspace", workspaceId: "two" },
				}),
			),
		).toEqual({
			kind: "select-context",
			context: { kind: "agent", agentId: "b1" },
			presentation: "full",
		});
	});

	it("does nothing from a workspace with no Agents at all", () => {
		expect(
			run(
				"toggle_workspace_agent",
				snapshotOf({
					workspaces: [workspace("empty", [])],
					context: { kind: "workspace", workspaceId: "empty" },
				}),
			),
		).toBeUndefined();
	});

	it("moves the keyboard instead when both halves are already on screen", () => {
		expect(
			run(
				"toggle_workspace_agent",
				snapshotOf({
					workspaces: [two],
					context: { kind: "agent", agentId: "b1" },
					presentation: "beside",
				}),
			),
		).toEqual({ kind: "swap-split-focus" });
	});

	it("does nothing at all on Scratch", () => {
		expect(run("toggle_workspace_agent", snapshotOf())).toBeUndefined();
	});
});

describe("the layout toggles", () => {
	it("puts the Agent beside the editor, and back to the Agent", () => {
		const alone = snapshotOf({
			workspaces: [two],
			context: { kind: "agent", agentId: "b1" },
		});
		expect(run("toggle_split", alone)).toEqual({
			kind: "select-context",
			context: { kind: "agent", agentId: "b1" },
			presentation: "beside",
		});
		expect(
			run(
				"toggle_split",
				snapshotOf({
					workspaces: [two],
					context: { kind: "agent", agentId: "b1" },
					presentation: "beside",
				}),
			),
		).toEqual({
			kind: "select-context",
			context: { kind: "agent", agentId: "b1" },
			presentation: "full",
		});
	});

	it("splits from the editor to the workspace's last Agent, and back to the editor", () => {
		const onRow = snapshotOf({
			workspaces: [workspace("two", ["b1", "b2"], { lastAgentId: "b2" })],
			context: { kind: "workspace", workspaceId: "two" },
		});
		expect(run("toggle_split", onRow)).toEqual({
			kind: "select-context",
			context: { kind: "workspace", workspaceId: "two" },
			presentation: "beside",
		});
		// The editor is the half in front, so the single view is the editor —
		// the Agent beside it is not what was being worked in.
		expect(
			run(
				"toggle_split",
				snapshotOf({
					workspaces: [workspace("two", ["b1", "b2"], { lastAgentId: "b2" })],
					context: { kind: "workspace", workspaceId: "two" },
					presentation: "beside",
				}),
			),
		).toEqual({
			kind: "select-context",
			context: { kind: "workspace", workspaceId: "two" },
			presentation: "full",
		});
	});

	it("splits from a workspace that has never had an Agent open, to its first", () => {
		// The pair rule, the same one `toggle_workspace_agent` reads: the split
		// is the editor with the first Agent beside it, and the editor is in
		// front because that is where the chord was pressed.
		expect(
			run(
				"toggle_split",
				snapshotOf({
					workspaces: [two],
					context: { kind: "workspace", workspaceId: "two" },
				}),
			),
		).toEqual({
			kind: "select-context",
			context: { kind: "workspace", workspaceId: "two" },
			presentation: "beside",
		});
	});

	it("leaves the split to the half the keyboard was moved to", () => {
		// `Cmd+J` in a split swaps the halves; the selection is the record of
		// which one is in front, so `Shift+J` after it lands on that one.
		expect(
			run(
				"toggle_split",
				snapshotOf({
					workspaces: [two],
					context: { kind: "agent", agentId: "b2" },
					presentation: "beside",
				}),
			),
		).toEqual({
			kind: "select-context",
			context: { kind: "agent", agentId: "b2" },
			presentation: "full",
		});
	});

	it("does nothing on a workspace with no Agents, or on Scratch", () => {
		expect(
			run(
				"toggle_split",
				snapshotOf({
					workspaces: [empty],
					context: { kind: "workspace", workspaceId: "empty" },
				}),
			),
		).toBeUndefined();
		expect(run("toggle_split", snapshotOf())).toBeUndefined();
	});

	it("moves the keyboard to the other pane of a split, and nowhere else", () => {
		expect(
			run(
				"swap_split_focus",
				snapshotOf({
					workspaces: [two],
					context: { kind: "agent", agentId: "b1" },
					presentation: "beside",
				}),
			),
		).toEqual({ kind: "swap-split-focus" });
		expect(
			run(
				"swap_split_focus",
				snapshotOf({
					workspaces: [two],
					context: { kind: "agent", agentId: "b1" },
				}),
			),
		).toBeUndefined();
		expect(run("swap_split_focus", snapshotOf())).toBeUndefined();
	});

	it("shows the editor by selecting it, from an Agent or from Scratch", () => {
		expect(
			run(
				"focus_editor",
				snapshotOf({
					workspaces: [two],
					context: { kind: "agent", agentId: "b1" },
				}),
			),
		).toEqual(selects({ kind: "workspace", workspaceId: "two" }));
		expect(run("focus_editor", snapshotOf())).toEqual(
			selects({ kind: "global" }),
		);
	});
});

describe("the commands that act on what is selected", () => {
	const inTwo = snapshotOf({
		workspaces: [one, two],
		context: { kind: "workspace", workspaceId: "two" },
	});
	const onAgent = snapshotOf({
		workspaces: [one, two],
		context: { kind: "agent", agentId: "b2" },
	});

	it("adds an Agent to the selected workspace, from a row or its Agent", () => {
		expect(run("add_agent", inTwo)).toEqual({
			kind: "open-agent-picker",
			workspaceId: "two",
		});
		expect(run("add_agent", onAgent)).toEqual({
			kind: "open-agent-picker",
			workspaceId: "two",
		});
	});

	it("does not add an Agent on Scratch, or where one cannot start", () => {
		expect(run("add_agent", snapshotOf())).toBeUndefined();
		expect(
			run(
				"add_agent",
				snapshotOf({
					workspaces: [workspace("shut", [], { canCreateAgent: false })],
					context: { kind: "workspace", workspaceId: "shut" },
				}),
			),
		).toBeUndefined();
	});

	it("renames the selected Agent, and nothing on a row", () => {
		expect(run("rename_agent", onAgent)).toEqual({
			kind: "rename-agent",
			agentId: "b2",
		});
		expect(run("rename_agent", inTwo)).toBeUndefined();
	});

	it("sends an action to the selected Agent, and nothing on a row", () => {
		expect(run("send_agent_action", onAgent)).toEqual({
			kind: "open-agent-actions",
			agentId: "b2",
		});
		expect(run("send_agent_action", inTwo)).toBeUndefined();
	});

	it("closes the small thing when standing on one, the big thing when not", () => {
		expect(run("close_selection", onAgent)).toEqual({
			kind: "close-agent",
			agentId: "b2",
		});
		expect(run("close_selection", inTwo)).toEqual({
			kind: "close-workspace",
			workspaceId: "two",
		});
		// Scratch is neither, so there is nothing to close.
		expect(run("close_selection", snapshotOf())).toBeUndefined();
	});

	it("closes the workspace from either row, and nothing on Scratch", () => {
		expect(run("close_workspace", inTwo)).toEqual({
			kind: "close-workspace",
			workspaceId: "two",
		});
		expect(run("close_workspace", onAgent)).toEqual({
			kind: "close-workspace",
			workspaceId: "two",
		});
		expect(run("close_workspace", snapshotOf())).toBeUndefined();
	});
});

describe("the commands that need nothing at all", () => {
	it("opens the pickers, the settings and the help", () => {
		const nothing = snapshotOf();
		expect(run("add_workspace", nothing)).toEqual({
			kind: "open-workspace-picker",
		});
		expect(run("open_tab_picker", nothing)).toEqual({
			kind: "open-tab-picker",
		});
		expect(run("open_issue_picker", nothing)).toEqual({
			kind: "open-issue-picker",
		});
		expect(run("refresh_repositories", nothing)).toEqual({
			kind: "refresh-repositories",
		});
		expect(run("open_settings", nothing)).toEqual({ kind: "open-settings" });
		expect(run("show_chord_help", nothing)).toEqual({
			kind: "open-chord-help",
		});
	});

	it("resolves the double prefix to nothing: the router forwards it", () => {
		expect(run("forward_prefix", snapshotOf())).toBeUndefined();
	});
});

describe("the default table", () => {
	function press(
		key: string,
		code: string,
		modifiers: Partial<Omit<KeyStroke, "keys" | "code">> = {},
	) {
		const flags = {
			command: false,
			shift: false,
			option: false,
			control: false,
			isAutoRepeat: false,
			...modifiers,
		};
		return matchChord(defaultChordTable(), {
			keys: strokeKeys(key, code, flags.shift),
			code,
			...flags,
		})?.commandId;
	}

	it("reaches the picker by the finder key", () => {
		expect(press("f", "KeyF")).toBe("add_workspace");
	});

	it("keeps the case rule: lower acts inside, upper reaches further", () => {
		expect(press("c", "KeyC")).toBe("add_agent");
		expect(press("W", "KeyW", { shift: true })).toBe("close_workspace");
		// Unshifted `w` is not a row: closing a workspace is not a key you can
		// hit by missing Shift.
		expect(press("w", "KeyW")).toBeUndefined();
	});

	it("separates rename from settings by Shift, as the multiplexer does", () => {
		expect(press(",", "Comma")).toBe("rename_agent");
		expect(press("<", "Comma", { shift: true })).toBe("open_settings");
	});

	it("no longer claims the workbench's terminal key", () => {
		expect(press("t", "KeyT")).toBeUndefined();
		expect(press("j", "KeyJ", { control: true })).toBeUndefined();
	});

	it("gives the three cycles three different keys", () => {
		expect(press("N", "KeyN", { shift: true })).toBe("next_workspace");
		expect(press("]", "BracketRight")).toBe("next_agent");
		expect(press("n", "KeyN", { command: true })).toBe("next_tab");
	});

	it("puts the unread narrowing on Shift, over the same brackets", () => {
		expect(press("}", "BracketRight", { shift: true })).toBe(
			"next_unread_agent",
		);
		expect(press("{", "BracketLeft", { shift: true })).toBe(
			"previous_unread_agent",
		);
	});

	it("reaches the Agent cycle with Command held as well", () => {
		// A second key onto one command, not a second command: `Cmd+]` is its own
		// stroke, and the bare `]` still means the same thing.
		expect(press("]", "BracketRight", { command: true })).toBe("next_agent");
		expect(press("[", "BracketLeft", { command: true })).toBe("previous_agent");
		expect(press("[", "BracketLeft")).toBe("previous_agent");
	});

	it("matches the character, so a JIS keyboard reaches the same commands", () => {
		// The same two characters, from the keys a JIS keyboard makes them with.
		expect(press("{", "BracketRight", { shift: true })).toBe(
			"previous_unread_agent",
		);
		expect(press("}", "Backslash", { shift: true })).toBe("next_unread_agent");
		expect(press("[", "BracketRight")).toBe("previous_agent");
		expect(press("]", "Backslash")).toBe("next_agent");
		// And the key a US keyboard would have read as `{` is `@` there, which
		// is no chord at all rather than the wrong one.
		expect(press("@", "BracketLeft", { shift: true })).toBeUndefined();
	});
});

/**
 * The list on screen and the list the chords walk are the same list.
 *
 * The bug this covers: the sidebar grouped worktrees under their repository
 * and sorted the groups by name, while every cycle walked the order folders
 * happened to be opened in. Three presses of `Cmd+Q Cmd+N` landed nowhere near
 * the third row. The order lives in the projection now, so this builds a real
 * model, projects it the way main does, and checks that stepping the ring
 * visits exactly the rows the sidebar draws, in that order.
 */
describe("the order every cycle walks", () => {
	const codex = AgentProfile.create(
		agentProfileId("codex"),
		"Codex",
		"codex",
		"codex",
	);
	const id = (last: string) =>
		workspaceId(`550e8400-e29b-41d4-a716-446655${last}`);
	const agentOf = (last: string) =>
		agentId(`550e8400-e29b-41d4-a716-446655${last}`);

	// Opened in an order nobody would choose to read them in: a worktree before
	// its repository, an unrelated repository in between, and a workspace with
	// no Agents in it at all.
	const ZEBRA_WT = id("4000a1");
	const ALPHA = id("4000a2");
	const ZEBRA = id("4000a3");
	const MIDDLE = id("4000a4");

	function projected() {
		const model = new AppModel();
		for (const [workspace, path] of [
			[ZEBRA_WT, "/src/zebra_topic"],
			[ALPHA, "/src/alpha"],
			[ZEBRA, "/src/zebra"],
			[MIDDLE, "/src/middle"],
		] as const) {
			model.addWorkspace(
				new Workspace(workspace, workspaceRoot(path), displayPath(path)),
			);
		}
		model.addAgent(ZEBRA, agentOf("4000b1"), codex);
		model.addAgent(ZEBRA_WT, agentOf("4000b2"), codex);
		model.addAgent(ALPHA, agentOf("4000b3"), codex);
		// MIDDLE deliberately has none: a workspace with no Agents is still a row.
		const repositories = new Map<string, string>([
			[ZEBRA, "/src/zebra"],
			[ZEBRA_WT, "/src/zebra"],
			[ALPHA, "/src/alpha"],
		]);
		return snapshotWire(model.snapshot(), "ready", (workspace) =>
			repositories.get(workspaceId(workspace)),
		);
	}

	/** The rows the sidebar draws, top to bottom: it renders this array. */
	function sidebarRows(
		snapshot: AppSnapshotWire,
	): readonly NavigationContext[] {
		return [
			{ kind: "global" },
			...snapshot.workspaces.flatMap((workspace): NavigationContext[] => [
				{ kind: "workspace", workspaceId: workspace.id },
				...workspace.agents.map(
					(one): NavigationContext => ({ kind: "agent", agentId: one.id }),
				),
			]),
		];
	}

	it("groups worktrees under their repository, by name", () => {
		expect(projected().workspaces.map((workspace) => workspace.label)).toEqual([
			"alpha",
			"middle",
			"zebra",
			"zebra_topic",
		]);
	});

	it("steps `next_tab` through the rows the sidebar draws", () => {
		const snapshot = projected();
		const rows = sidebarRows(snapshot);
		const visited: NavigationContext[] = [];
		let context: NavigationContext = { kind: "global" };
		for (let step = 0; step < rows.length; step += 1) {
			const effect = run("next_tab", {
				...snapshot,
				selection: { context, presentation: "full" },
			});
			expect(effect?.kind).toBe("select-context");
			context =
				effect?.kind === "select-context" ? effect.context : { kind: "global" };
			visited.push(context);
		}
		// Round the ring once, ending back where it started.
		expect(visited).toEqual([...rows.slice(1), rows[0]]);
	});

	it("steps `next_agent` through the Agents in the same order", () => {
		const snapshot = projected();
		const agents = sidebarRows(snapshot).filter((row) => row.kind === "agent");
		const visited: NavigationContext[] = [];
		let context: NavigationContext = { kind: "global" };
		for (let step = 0; step < agents.length; step += 1) {
			const effect = run("next_agent", {
				...snapshot,
				selection: { context, presentation: "full" },
			});
			context =
				effect?.kind === "select-context" ? effect.context : { kind: "global" };
			visited.push(context);
		}
		expect(visited).toEqual(agents);
	});

	it("names the rows a digit selects in the same order", () => {
		const snapshot = projected();
		expect(run("select_entry_2", snapshot)).toEqual(
			selects({ kind: "workspace", workspaceId: ALPHA }),
		);
		// The workspace with no Agents is still an entry, and still visited.
		expect(run("select_entry_3", snapshot)).toEqual(
			selects({ kind: "workspace", workspaceId: MIDDLE }),
		);
	});
});
