import { describe, expect, it } from "vitest";
import {
	commandName,
	isShellCommand,
	PaneActivityTracker,
	type PaneSample,
} from "./paneActivity.js";
import {
	agentSessionName,
	parsePaneActivity,
	workspaceDigest,
} from "./tmux.js";
import { TerminalPanes } from "../../model/terminalActivity.js";
import { terminalObservations } from "../shell/terminalActivityLoop.js";

const FS = "\u001f";
const RS = "\u001e";
const WS = "550e8400-e29b-41d4-a716-446655440000";
const AGENT = "550e8400-e29b-41d4-a716-4466554400a0";
const ROOT = "/Users/me/projects/widget";

/** One `list-panes` record, in `PANE_ACTIVITY_FIELDS` order. */
function paneRecord(fields: {
	session?: string;
	context?: string;
	workspaceId?: string;
	agentId?: string;
	window?: string;
	pane?: string;
	windowActive?: string;
	attached?: string;
	activity?: string;
	dead?: string;
	screen?: string;
	command?: string;
	root?: string;
}): string {
	return [
		"pane-activity",
		fields.session ?? "widget-0123456789ab",
		fields.context ?? "workspace",
		fields.workspaceId ?? WS,
		fields.agentId ?? "none",
		fields.window ?? "@1",
		fields.pane ?? "%1",
		fields.windowActive ?? "1",
		fields.attached ?? "1",
		fields.activity ?? "1700000000",
		fields.dead ?? "0",
		fields.screen ?? "10:0:5",
		fields.command ?? "zsh",
		fields.root ?? ROOT,
	].join(FS);
}

function output(...records: string[]): Buffer {
	return Buffer.from(records.map((record) => `${record}${RS}\n`).join(""));
}

const MARKER = `marker${FS}1`;

describe("reading tmux's pane listing", () => {
	it("reads every pane of a marked Workspace session, with its signals", () => {
		const { marker, panes } = parsePaneActivity(
			output(
				MARKER,
				paneRecord({ session: sessionFor(ROOT), pane: "%1", command: "-zsh" }),
				paneRecord({
					session: sessionFor(ROOT),
					window: "@2",
					pane: "%2",
					windowActive: "0",
					command: "make",
					screen: "200:3:40",
				}),
			),
			"/Users/me",
		);
		expect(marker).toBe("owned");
		expect(panes).toEqual([
			{
				workspaceId: WS,
				window: "@1",
				pane: "%1",
				inView: true,
				windowActivity: 1700000000,
				dead: false,
				screen: "10:0:5",
				command: "-zsh",
			},
			{
				workspaceId: WS,
				window: "@2",
				pane: "%2",
				inView: false,
				windowActivity: 1700000000,
				dead: false,
				screen: "200:3:40",
				command: "make",
			},
		]);
	});

	it("is not on screen without an attached client", () => {
		const { panes } = parsePaneActivity(
			output(MARKER, paneRecord({ session: sessionFor(ROOT), attached: "0" })),
			"/Users/me",
		);
		expect(panes[0]?.inView).toBe(false);
	});

	it("leaves out Agents, the anchor, and sessions DevHub did not mark", () => {
		const { panes } = parsePaneActivity(
			output(
				MARKER,
				paneRecord({
					session: agentSessionName(AGENT),
					context: "agent",
					agentId: AGENT,
				}),
				paneRecord({
					session: "scratch",
					context: "global",
					workspaceId: "global",
					root: "/Users/me",
				}),
				paneRecord({ session: "mine", context: "", workspaceId: "", root: "" }),
			),
			"/Users/me",
		);
		expect(panes).toEqual([]);
	});

	it("reports a server DevHub does not own as wrong, with no panes", () => {
		expect(
			parsePaneActivity(output(`marker${FS}`, paneRecord({})), "/Users/me"),
		).toEqual({ marker: "wrong", panes: [] });
	});

	it("refuses a record of the wrong width", () => {
		expect(() =>
			parsePaneActivity(output(MARKER, `pane-activity${FS}x`), "/Users/me"),
		).toThrow();
	});
});

describe("which foreground process is a shell", () => {
	it("strips a login shell's dash and a path", () => {
		expect(commandName("-zsh")).toBe("zsh");
		expect(commandName("/bin/bash")).toBe("bash");
	});

	it("knows the configured shell, the common ones, and nothing else", () => {
		expect(isShellCommand("zsh", "zsh")).toBe(true);
		expect(isShellCommand("bash", "zsh")).toBe(true);
		expect(isShellCommand("myshell", "myshell")).toBe(true);
		expect(isShellCommand("", "zsh")).toBe(true);
		expect(isShellCommand("vim", "zsh")).toBe(false);
		expect(isShellCommand("claude", "zsh")).toBe(false);
	});
});

function sample(overrides: Partial<PaneSample> = {}): PaneSample {
	return {
		workspaceId: WS,
		pane: "%1",
		window: "@1",
		inView: false,
		command: "zsh",
		dead: false,
		windowActivity: 1_000,
		screen: "0:0:0",
		...overrides,
	};
}

describe("the output clock", () => {
	const IDLE = 5;
	const at = (seconds: number) => seconds * 1000;

	it("is working while a command prints, quiet after N seconds, working again on output", () => {
		const tracker = new PaneActivityTracker();
		expect(
			tracker.observe([sample()], at(1_000), IDLE, "zsh")[0]?.running,
		).toBe(false);
		// A command starts: the foreground process changed, which is output.
		const run = (seconds: number, screen: string, activity = seconds) =>
			tracker.observe(
				[sample({ command: "make", screen, windowActivity: activity })],
				at(seconds),
				IDLE,
				"zsh",
			)[0]?.running;
		expect(run(1_001, "0:0:0")).toBe(true);
		expect(run(1_002, "1:0:1")).toBe(true);
		// Nothing for four seconds: still working.
		expect(run(1_006, "1:0:1", 1_002)).toBe(true);
		// Five: quiet, which is finished.
		expect(run(1_007, "1:0:1", 1_002)).toBe(false);
		// It prints again.
		expect(run(1_008, "2:0:1")).toBe(true);
		// It exits: the shell is back.
		expect(
			tracker.observe([sample({ screen: "3:0:2" })], at(1_009), IDLE, "zsh")[0]
				?.running,
		).toBe(false);
	});

	it("counts a redraw that leaves the cursor where it was, by the window's activity", () => {
		const tracker = new PaneActivityTracker();
		const htop = (seconds: number) =>
			tracker.observe(
				[sample({ command: "htop", screen: "0:0:0", windowActivity: seconds })],
				at(seconds),
				IDLE,
				"zsh",
			)[0]?.running;
		htop(1_000);
		for (let second = 1_001; second < 1_020; second += 1) {
			expect(htop(second)).toBe(true);
		}
	});

	it("dates a pane it has never seen by its window, not by now", () => {
		// A `less` open since long before DevHub started is quiet at once, so
		// it never goes working → quiet and raises an unread nobody earned.
		const tracker = new PaneActivityTracker();
		expect(
			tracker.observe(
				[sample({ command: "less", windowActivity: 100 })],
				at(1_000),
				IDLE,
				"zsh",
			)[0]?.running,
		).toBe(false);
	});

	it("credits a window's output to the pane whose screen moved", () => {
		const tracker = new PaneActivityTracker();
		const round = (seconds: number, aScreen: string, bScreen: string) =>
			tracker.observe(
				[
					sample({
						pane: "%1",
						command: "make",
						screen: aScreen,
						windowActivity: seconds,
					}),
					sample({
						pane: "%2",
						command: "tail",
						screen: bScreen,
						windowActivity: seconds,
					}),
				],
				at(seconds),
				IDLE,
				"zsh",
			);
		round(1_000, "a0", "b0");
		for (let second = 1_001; second <= 1_010; second += 1) {
			round(second, `a${String(second)}`, "b0");
		}
		const verdict = round(1_011, "a-last", "b0");
		expect(verdict.map((one) => one.running)).toEqual([true, false]);
	});

	it("never goes quiet with N = 0", () => {
		const tracker = new PaneActivityTracker();
		tracker.observe([sample({ command: "sleep" })], at(1_000), 0, "zsh");
		expect(
			tracker.observe([sample({ command: "sleep" })], at(9_000), 0, "zsh")[0]
				?.running,
		).toBe(true);
	});

	it("is not working in a dead pane", () => {
		const tracker = new PaneActivityTracker();
		expect(
			tracker.observe(
				[sample({ command: "make", dead: true, windowActivity: 1_000 })],
				at(1_000),
				IDLE,
				"zsh",
			)[0]?.running,
		).toBe(false);
	});
});

describe("from tmux to the row", () => {
	it("goes running → quiet → unread → output → running, and is read when viewed", () => {
		const tracker = new PaneActivityTracker();
		const panes = new TerminalPanes();
		const round = (
			seconds: number,
			overrides: Partial<PaneSample>,
			visible = false,
		) => {
			const verdicts = tracker.observe(
				[sample(overrides)],
				seconds * 1000,
				5,
				"zsh",
			);
			const [observation] = terminalObservations(verdicts, [WS]);
			panes.observe(observation?.panes ?? [], visible);
			return panes.activity;
		};
		round(1_000, {});
		expect(
			round(1_001, { command: "npm", screen: "1", windowActivity: 1_001 }),
		).toEqual({ status: "working", unread: undefined });
		// Quiet for five seconds while nobody looks: finished, unread.
		expect(
			round(1_006, { command: "npm", screen: "1", windowActivity: 1_001 }),
		).toEqual({ status: "idle", unread: "idle" });
		// Output again: working (unread still owed).
		expect(
			round(1_007, { command: "npm", screen: "2", windowActivity: 1_007 }),
		).toEqual({ status: "working", unread: "idle" });
		// Quiet again, and this time the person is looking at it: read.
		expect(
			round(
				1_012,
				{ command: "npm", screen: "2", windowActivity: 1_007, inView: true },
				true,
			),
		).toEqual({ status: "idle", unread: undefined });
	});

	it("leaves an empty reading for a Workspace with no session, and drops strangers", () => {
		expect(
			terminalObservations(
				[{ workspaceId: "other", pane: "%9", running: true, inView: false }],
				[WS],
			),
		).toEqual([{ workspaceId: WS, panes: [] }]);
	});
});

/** The session name DevHub gives a root (`isWorkspaceSessionName`). */
function sessionFor(root: string): string {
	return `ws-${workspaceDigest(root).slice(0, 20)}`;
}
