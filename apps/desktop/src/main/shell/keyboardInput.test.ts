/**
 * The chord layer against the events Electron actually delivers.
 *
 * `keyRouter.test.ts` tests the decision; this tests the whole path from an
 * `Input` object to a command, including the two things only the real event
 * shape can show: that a completed chord is `preventDefault`ed, and that a
 * chord still completes while an input method is composing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../electron.js", () => ({
	electron: {
		app: { on: () => undefined },
		webContents: { getAllWebContents: () => [] },
	},
}));

const { handleInput, resetChordRouterForTests } = await import("./keyboard.js");
const { SHELL_ORIGIN } = await import("./shellPageProtocol.js");

type ChordHost = Parameters<typeof handleInput>[0];

/** One `Input`, with the fields Electron fills in and nothing invented. */
function input(
	code: string,
	key: string,
	overrides: Partial<Electron.Input> = {},
): Electron.Input {
	return {
		type: "keyDown",
		key,
		code,
		isAutoRepeat: false,
		isComposing: false,
		shift: false,
		control: false,
		alt: false,
		meta: false,
		location: 0,
		modifiers: [],
		...overrides,
	} as unknown as Electron.Input;
}

const PREFIX = input("KeyQ", "q", { meta: true });
const WORKBENCH = "vscode-file://vscode-app/out/vs/code/x.html";

const SNAPSHOT = {
	schemaVersion: 1,
	revision: 1,
	readiness: "ready",
	editorHost: { status: "ready" },
	layout: { kind: "workbench", editorKey: "global-editor" },
	selection: { context: { kind: "global" }, presentation: "full" },
	sidebar: { width: 248 },
	splitRatio: 0.55,
	// One workspace with one Agent, so that the cycles have somewhere to go and
	// a chord that was recognised is visibly distinct from one that was not.
	workspaces: [
		{
			id: "w-1",
			label: "widget",
			root: "/workspaces/widget",
			selectedPath: "/workspaces/widget",
			state: "available",
			canCreateAgent: true,
			agents: [
				{
					id: "a-1",
					workspaceId: "w-1",
					displayName: "Claude",
					ordinal: 1,
					profileId: "claude",
					status: "idle",
					runtimeHealth: "healthy",
					controlState: "running",
					unread: false,
					activity: undefined,
					injection: {
						queued: 0,
						waitingFor: "nothing_queued",
						lastResult: undefined,
					},
				},
			],
		},
	],
} as unknown as ReturnType<ChordHost["snapshot"]>;

function host() {
	const calls: string[] = [];
	const record =
		(name: string) =>
		(...args: unknown[]) => {
			calls.push([name, ...args.map(String)].join(" "));
		};
	const chordHost: ChordHost = {
		snapshot: () => SNAPSHOT,
		selectContext: record("selectContext"),
		swapSplitFocus: record("swapSplitFocus"),
		openWorkspacePicker: record("openWorkspacePicker"),
		openTabPicker: record("openTabPicker"),
		openAgentPicker: record("openAgentPicker"),
		openIssuePicker: record("openIssuePicker"),
		openAgentActions: record("openAgentActions"),
		renameAgent: record("renameAgent"),
		closeAgent: record("closeAgent"),
		closeWorkspace: record("closeWorkspace"),
		openWorkspaceExternally: record("openWorkspaceExternally"),
		refreshRepositories: record("refreshRepositories"),
		openChordHelp: record("openChordHelp"),
		openSettings: record("openSettings"),
	};
	return { calls, chordHost };
}

/** Feed a sequence, and report what was taken and what was run. */
function type(
	chordHost: ChordHost,
	events: readonly Electron.Input[],
	url = WORKBENCH,
): readonly boolean[] {
	const taken: boolean[] = [];
	let at = 0;
	for (const event of events) {
		let wasTaken = false;
		handleInput(
			chordHost,
			event,
			url,
			() => {
				wasTaken = true;
			},
			() => undefined,
			(at += 10),
		);
		taken.push(wasTaken);
	}
	return taken;
}

/**
 * What a command id looks like once it has run against this snapshot.
 *
 * The cycles all end in a selection, so they are one string; the pickers name
 * themselves. Written here rather than asserted inline so a layout matrix can
 * say only which *command* each key reached.
 */
function named(commandId: string): string {
	switch (commandId) {
		case "add_workspace":
			return "openWorkspacePicker";
		case "open_settings":
			return "openSettings";
		case "show_chord_help":
			return "openChordHelp";
		default:
			// previous_agent, next_agent, next_workspace: all selections.
			return "selectContext [object Object] undefined";
	}
}

describe("a chord, as Electron delivers it", () => {
	beforeEach(() => {
		resetChordRouterForTests();
	});

	it("swallows the prefix and the second stroke, and runs the command", () => {
		const { calls, chordHost } = host();
		const taken = type(chordHost, [PREFIX, input("KeyF", "f")]);
		expect(taken).toEqual([true, true]);
		expect(calls).toEqual(["openWorkspacePicker"]);
	});

	it("keeps the chord through the Shift that arrives before the key", () => {
		// The sequence the reporter typed. `ShiftLeft` is not taken, because a
		// surface underneath is entitled to know Shift went down; the `P` is.
		const { calls, chordHost } = host();
		const taken = type(chordHost, [
			PREFIX,
			input("ShiftLeft", "Shift", { shift: true }),
			input("KeyP", "P", { shift: true }),
		]);
		expect(taken).toEqual([true, false, true]);
		// `Shift+P` from Scratch steps back to the last workspace.
		expect(calls).toEqual(["selectContext [object Object] undefined"]);
	});

	/**
	 * The same chord on two keyboards, and mid-composition on each.
	 *
	 * A JIS keyboard does not put punctuation where a US one does, and matching
	 * the physical key therefore selected the key one to the left of the one the
	 * person was looking at. The character does not move.
	 *
	 * Composition is where the character is not there to read, and where the
	 * physical key has to be guessed at from two layouts — so the punctuation
	 * rows say which reading wins and the letters, which both layouts agree
	 * about, say that the ordinary case is not a guess at all.
	 */
	describe.each([
		{
			layout: "US",
			rows: [
				{ key: "{", code: "BracketLeft", reaches: "previous_agent" },
				{ key: "}", code: "BracketRight", reaches: "next_agent" },
				{ key: "<", code: "Comma", reaches: "open_settings" },
				{ key: "?", code: "Slash", reaches: "show_chord_help" },
				{ key: "f", code: "KeyF", reaches: "add_workspace" },
			],
			// Composing: no character, so the physical key is read. The US
			// reading is taken first where the two layouts disagree.
			composing: [
				{ code: "BracketLeft", reaches: "previous_agent", shift: true },
				{ code: "BracketRight", reaches: "next_agent", shift: true },
				{ code: "Comma", reaches: "open_settings", shift: true },
				{ code: "Slash", reaches: "show_chord_help", shift: true },
				{ code: "KeyF", reaches: "add_workspace", shift: false },
			],
		},
		{
			layout: "JIS",
			rows: [
				{ key: "{", code: "BracketRight", reaches: "previous_agent" },
				{ key: "}", code: "Backslash", reaches: "next_agent" },
				// The key a US keyboard reads as `{` is `@` here, and `@` is no
				// chord: it cancels rather than firing the wrong command.
				{ key: "@", code: "BracketLeft", reaches: undefined },
				{ key: "<", code: "Comma", reaches: "open_settings" },
				{ key: "?", code: "Slash", reaches: "show_chord_help" },
				{ key: "f", code: "KeyF", reaches: "add_workspace" },
			],
			composing: [
				// The one cell the fallback cannot resolve: shifted BracketRight is
				// `}` on US and `{` on JIS, both are bound, and the US reading
				// wins. Letters and digits are unambiguous, which is why the rest
				// of the chords keep working mid-composition on both keyboards.
				{ code: "BracketRight", reaches: "next_agent", shift: true },
				{ code: "Backslash", reaches: "next_agent", shift: true },
				{ code: "Comma", reaches: "open_settings", shift: true },
				{ code: "Slash", reaches: "show_chord_help", shift: true },
				{ code: "KeyF", reaches: "add_workspace", shift: false },
			],
		},
	])("on a $layout keyboard", ({ rows, composing }) => {
		it.each(rows)("$key ($code) reaches $reaches", ({ key, code, reaches }) => {
			resetChordRouterForTests();
			const { calls, chordHost } = host();
			type(chordHost, [
				PREFIX,
				input("ShiftLeft", "Shift", { shift: true }),
				input(code, key, { shift: key !== "f" }),
			]);
			expect(calls).toEqual(reaches === undefined ? [] : [named(reaches)]);
		});

		it.each(composing)(
			"$code composing reaches $reaches",
			({ code, reaches, shift }) => {
				// Chromium reports `Process` for the key while an input method is
				// composing, and still fills in the code.
				resetChordRouterForTests();
				const { calls, chordHost } = host();
				type(chordHost, [
					PREFIX,
					input(code, "Process", { shift, isComposing: true }),
				]);
				expect(calls).toEqual([named(reaches)]);
			},
		);
	});

	it("swallows a mistyped second stroke rather than letting it through", () => {
		const { calls, chordHost } = host();
		const taken = type(chordHost, [PREFIX, input("KeyY", "y")]);
		expect(taken).toEqual([true, true]);
		expect(calls).toEqual([]);
	});

	it("leaves everything alone when no prefix is armed", () => {
		const { calls, chordHost } = host();
		const taken = type(chordHost, [
			input("KeyF", "f"),
			input("KeyP", "P", { shift: true }),
			input("ShiftLeft", "Shift", { shift: true }),
		]);
		expect(taken).toEqual([false, false, false]);
		expect(calls).toEqual([]);
	});

	it("ignores everything that is not a key going down", () => {
		const { chordHost } = host();
		const taken = type(chordHost, [
			{ ...PREFIX, type: "keyUp" } as Electron.Input,
			{ ...PREFIX, type: "char" } as Electron.Input,
		]);
		expect(taken).toEqual([false, false]);
	});

	it("still answers the Mac's editing keys on DevHub's own chrome", () => {
		// The other half of this module, unchanged: a chord layer that wanted
		// nothing from the key leaves it to `editingCommands`, and only for the
		// surfaces that have no way to answer it themselves.
		const { chordHost } = host();
		const roles: string[] = [];
		handleInput(
			chordHost,
			input("KeyA", "a", { meta: true }),
			`${SHELL_ORIGIN}/index.html?window=settings`,
			() => undefined,
			(role) => roles.push(role),
			10,
		);
		expect(roles).toEqual(["selectAll"]);
		// And not on a workbench, which answers its own.
		roles.length = 0;
		handleInput(
			chordHost,
			input("KeyA", "a", { meta: true }),
			WORKBENCH,
			() => undefined,
			(role) => roles.push(role),
			20,
		);
		expect(roles).toEqual([]);
	});
});
