import { describe, expect, it } from "vitest";
import { keyNameForCode } from "../../model/chordKeys.js";
import type { CommandId } from "../../model/commands.js";
import {
	defaultChordTable,
	matchChord,
	resolveChord,
	type KeyStroke,
} from "./chords.js";
import type {
	AgentWire,
	AppSnapshotWire,
	NavigationContext,
	SurfacePresentationWire,
	WorkspaceWire,
} from "../../ipc/appShell.js";

function agent(id: string, workspaceId: string, ordinal: number): AgentWire {
	return {
		activity: undefined,
		injection: {
			queued: 0,
			waitingFor: "nothing_queued",
			lastResult: undefined,
		},
		controlState: "running",
		displayName: id,
		id,
		ordinal,
		profileId: "profile",
		runtimeHealth: "healthy",
		status: "idle",
		unread: false,
		workspaceId,
	};
}

function workspace(
	id: string,
	agentIds: readonly string[],
	extra: Partial<WorkspaceWire> = {},
): WorkspaceWire {
	return {
		agents: agentIds.map((agentId, index) => agent(agentId, id, index)),
		canCreateAgent: true,
		id,
		label: id,
		root: `/workspaces/${id}`,
		selectedPath: `/workspaces/${id}`,
		state: "available",
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

	it("does nothing from a workspace that has never had one open", () => {
		// Falling back to the first Agent would make one chord mean two things.
		expect(
			run(
				"toggle_workspace_agent",
				snapshotOf({
					workspaces: [two],
					context: { kind: "workspace", workspaceId: "two" },
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
	it("puts the Agent beside the editor, and back again", () => {
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

	it("does nothing with no Agent selected: there is no pane to move", () => {
		expect(
			run(
				"toggle_split",
				snapshotOf({
					workspaces: [two],
					context: { kind: "workspace", workspaceId: "two" },
				}),
			),
		).toBeUndefined();
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

	it("opens the selected workspace outside DevHub, never Scratch", () => {
		expect(run("open_workspace_externally", inTwo)).toEqual({
			kind: "open-workspace-externally",
			workspaceId: "two",
		});
		expect(run("open_workspace_externally", snapshotOf())).toBeUndefined();
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
	function press(code: string, modifiers: Partial<KeyStroke> = {}) {
		return matchChord(defaultChordTable(), {
			key: keyNameForCode(code),
			code,
			command: false,
			shift: false,
			option: false,
			control: false,
			isAutoRepeat: false,
			...modifiers,
		})?.commandId;
	}

	it("reaches the picker by the finder key", () => {
		expect(press("KeyF")).toBe("add_workspace");
	});

	it("keeps the case rule: lower acts inside, upper reaches further", () => {
		expect(press("KeyC")).toBe("add_agent");
		expect(press("KeyW", { shift: true })).toBe("close_workspace");
		// Unshifted `w` is not a row: closing a workspace is not a key you can
		// hit by missing Shift.
		expect(press("KeyW")).toBeUndefined();
	});

	it("separates rename from settings by Shift, as the multiplexer does", () => {
		expect(press("Comma")).toBe("rename_agent");
		expect(press("Comma", { shift: true })).toBe("open_settings");
	});

	it("no longer claims the workbench's terminal key", () => {
		expect(press("KeyT")).toBeUndefined();
		expect(press("KeyJ", { control: true })).toBeUndefined();
	});

	it("gives the three cycles three different keys", () => {
		expect(press("KeyN", { shift: true })).toBe("next_workspace");
		expect(press("BracketRight", { shift: true })).toBe("next_agent");
		expect(press("KeyN", { command: true })).toBe("next_tab");
	});
});
