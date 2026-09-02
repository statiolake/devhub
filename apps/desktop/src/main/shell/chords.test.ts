import { describe, expect, it } from "vitest";
import {
	DEFAULT_CHORDS,
	matchChord,
	resolveChord,
	type ChordAction,
	type KeyStroke,
} from "./chords.js";
import type {
	AgentWire,
	AppSnapshotWire,
	NavigationContext,
	WorkspaceWire,
} from "../../ipc/appShell.js";

function agent(id: string, workspaceId: string, ordinal: number): AgentWire {
	return {
		activity: undefined,
		injection: {
			queued: 0,
			waitingFor: "nothing_queued",
			lastFailure: undefined,
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
	canCreateAgent = true,
): WorkspaceWire {
	return {
		agents: agentIds.map((agentId, index) => agent(agentId, id, index)),
		canCreateAgent,
		id,
		label: id,
		root: `/tmp/${id}`,
		selectedPath: `/tmp/${id}`,
		state: "available",
	};
}

function snapshotOf({
	workspaces = [],
	context = { kind: "global" } as NavigationContext,
}: {
	workspaces?: readonly WorkspaceWire[];
	context?: NavigationContext;
} = {}): AppSnapshotWire {
	return {
		editorHost: { status: "ready" },
		layout: { kind: "workbench", editorKey: "global-editor" },
		readiness: "ready",
		revision: 1,
		schemaVersion: 1,
		selection: { context, presentation: "full" },
		sidebar: { width: 248 },
		splitRatio: 0.55,
		workspaces,
	};
}

const one = workspace("one", []);
const two = workspace("two", ["a1", "a2"]);

function run(action: ChordAction, snapshot: AppSnapshotWire) {
	return resolveChord(action, snapshot);
}

describe("the sidebar cycle", () => {
	const snapshot = snapshotOf({ workspaces: [one, two] });

	it("counts Scratch as the first entry", () => {
		expect(run({ kind: "select-entry", ordinal: 1 }, snapshot)).toEqual({
			kind: "select-context",
			context: { kind: "global" },
		});
		expect(run({ kind: "select-entry", ordinal: 3 }, snapshot)).toEqual({
			kind: "select-context",
			context: { kind: "workspace", workspaceId: "two" },
		});
	});

	it("does nothing for a digit past the end of the list", () => {
		expect(run({ kind: "select-entry", ordinal: 7 }, snapshot)).toBeUndefined();
	});

	it("steps forward through Scratch and the workspaces, wrapping", () => {
		expect(run({ kind: "cycle-workspace", step: 1 }, snapshot)).toEqual({
			kind: "select-context",
			context: { kind: "workspace", workspaceId: "one" },
		});
		expect(
			run(
				{ kind: "cycle-workspace", step: 1 },
				snapshotOf({
					workspaces: [one, two],
					context: { kind: "workspace", workspaceId: "two" },
				}),
			),
		).toEqual({ kind: "select-context", context: { kind: "global" } });
	});

	it("steps back from Scratch to the last workspace", () => {
		expect(run({ kind: "cycle-workspace", step: -1 }, snapshot)).toEqual({
			kind: "select-context",
			context: { kind: "workspace", workspaceId: "two" },
		});
	});

	it("moves out of an agent by the workspace that agent is in", () => {
		expect(
			run(
				{ kind: "cycle-workspace", step: -1 },
				snapshotOf({
					workspaces: [one, two],
					context: { kind: "agent", agentId: "a2" },
				}),
			),
		).toEqual({
			kind: "select-context",
			context: { kind: "workspace", workspaceId: "one" },
		});
	});

	it("does nothing when Scratch is the only entry", () => {
		expect(
			run({ kind: "cycle-workspace", step: 1 }, snapshotOf()),
		).toBeUndefined();
	});
});

describe("the agent cycle", () => {
	it("starts at the first agent from the workspace row", () => {
		expect(
			run(
				{ kind: "cycle-agent", step: 1 },
				snapshotOf({
					workspaces: [two],
					context: { kind: "workspace", workspaceId: "two" },
				}),
			),
		).toEqual({
			kind: "select-context",
			context: { kind: "agent", agentId: "a1" },
		});
	});

	it("starts at the last agent stepping back from the workspace row", () => {
		expect(
			run(
				{ kind: "cycle-agent", step: -1 },
				snapshotOf({
					workspaces: [two],
					context: { kind: "workspace", workspaceId: "two" },
				}),
			),
		).toEqual({
			kind: "select-context",
			context: { kind: "agent", agentId: "a2" },
		});
	});

	it("wraps within the workspace it is already in", () => {
		expect(
			run(
				{ kind: "cycle-agent", step: 1 },
				snapshotOf({
					workspaces: [one, two],
					context: { kind: "agent", agentId: "a2" },
				}),
			),
		).toEqual({
			kind: "select-context",
			context: { kind: "agent", agentId: "a1" },
		});
	});

	it("is a no-op, not an error, with no agents to move between", () => {
		expect(
			run(
				{ kind: "cycle-agent", step: 1 },
				snapshotOf({
					workspaces: [one],
					context: { kind: "workspace", workspaceId: "one" },
				}),
			),
		).toBeUndefined();
		// And on Scratch, which has no agents at all.
		expect(
			run({ kind: "cycle-agent", step: 1 }, snapshotOf({ workspaces: [two] })),
		).toBeUndefined();
	});
});

describe("the terminal", () => {
	it("asks the workbench on screen to toggle its own terminal", () => {
		// There is nothing to resolve against the model: the terminal belongs to
		// whichever workbench is showing, and which one that is is not this
		// function's question.
		expect(run({ kind: "toggle-terminal" }, snapshotOf())).toEqual({
			kind: "toggle-terminal",
		});
	});
});

describe("the window commands", () => {
	it("opens the picker and the settings window", () => {
		expect(run({ kind: "add-workspace" }, snapshotOf())).toEqual({
			kind: "open-workspace-picker",
		});
		expect(run({ kind: "open-settings" }, snapshotOf())).toEqual({
			kind: "open-settings",
		});
	});

	it("resolves the double prefix to nothing: the router forwards it", () => {
		expect(run({ kind: "forward-prefix" }, snapshotOf())).toBeUndefined();
	});
});

describe("the commands that act on what is selected", () => {
	const inTwo = snapshotOf({
		workspaces: [one, two],
		context: { kind: "workspace", workspaceId: "two" },
	});
	const onAgent = snapshotOf({
		workspaces: [one, two],
		context: { kind: "agent", agentId: "a2" },
	});

	it("adds an agent to the selected workspace, from a row or its agent", () => {
		expect(run({ kind: "add-agent" }, inTwo)).toEqual({
			kind: "open-agent-picker",
			workspaceId: "two",
		});
		expect(run({ kind: "add-agent" }, onAgent)).toEqual({
			kind: "open-agent-picker",
			workspaceId: "two",
		});
	});

	it("does not add an agent on Scratch, or where one cannot start", () => {
		expect(run({ kind: "add-agent" }, snapshotOf())).toBeUndefined();
		expect(
			run(
				{ kind: "add-agent" },
				snapshotOf({
					workspaces: [workspace("shut", [], false)],
					context: { kind: "workspace", workspaceId: "shut" },
				}),
			),
		).toBeUndefined();
	});

	it("renames the selected agent, and nothing on a row", () => {
		expect(run({ kind: "rename-agent" }, onAgent)).toEqual({
			kind: "rename-agent",
			agentId: "a2",
		});
		expect(run({ kind: "rename-agent" }, inTwo)).toBeUndefined();
		expect(run({ kind: "rename-agent" }, snapshotOf())).toBeUndefined();
	});

	it("closes the workspace the selection is in, and nothing on Scratch", () => {
		expect(run({ kind: "close-workspace" }, inTwo)).toEqual({
			kind: "close-workspace",
			workspaceId: "two",
		});
		expect(run({ kind: "close-workspace" }, onAgent)).toEqual({
			kind: "close-workspace",
			workspaceId: "two",
		});
		expect(run({ kind: "close-workspace" }, snapshotOf())).toBeUndefined();
	});
});

describe("the default table", () => {
	function press(
		key: string,
		modifiers: Partial<Omit<KeyStroke, "key" | "isAutoRepeat">> = {},
	) {
		return matchChord(DEFAULT_CHORDS, {
			key,
			command: false,
			shift: false,
			option: false,
			control: false,
			isAutoRepeat: false,
			...modifiers,
		})?.action;
	}

	it("reaches the picker by the finder key and by the new-session key", () => {
		expect(press("f")).toEqual({ kind: "add-workspace" });
		expect(press("C", { shift: true })).toEqual({ kind: "add-workspace" });
	});

	it("keeps the case rule: lower acts inside, upper makes a new one", () => {
		expect(press("c")).toEqual({ kind: "add-agent" });
		expect(press("w", { shift: true })).toEqual({ kind: "close-workspace" });
		// Unshifted `w` is not a row: closing a workspace is not a key you can
		// hit by missing Shift.
		expect(press("w")).toBeUndefined();
	});

	it("separates rename from settings by Shift, as the multiplexer does", () => {
		expect(press(",")).toEqual({ kind: "rename-agent" });
		expect(press(",", { shift: true })).toEqual({ kind: "open-settings" });
	});

	it("toggles the terminal by its own key and by the multiplexer's", () => {
		expect(press("t")).toEqual({ kind: "toggle-terminal" });
		expect(press("j", { control: true })).toEqual({ kind: "toggle-terminal" });
		expect(press("j")).toBeUndefined();
	});
});
