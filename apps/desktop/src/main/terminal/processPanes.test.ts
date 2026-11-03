/**
 * Who runs what on DevHub's tmux server, as the Task Manager reads it: every
 * marked pane's pid with its owner, every client's pid with its session, and
 * the server's own pid — in one client's answer.
 */

import { describe, expect, it } from "vitest";
import {
	agentSessionName,
	parseProcessPanes,
	terminalSessionName,
	workspaceDigest,
} from "./tmux.js";

const FS = "\u001f";
const RS = "\u001e";
const WS = "550e8400-e29b-41d4-a716-446655440000";
const AGENT = "550e8400-e29b-41d4-a716-4466554400a0";
const TERMINAL = "11111111-1111-4111-8111-111111111111";
const ROOT = "/Users/me/projects/widget";
const WS_SESSION = `ws-${workspaceDigest(ROOT).slice(0, 20)}`;

function output(...records: string[]): Buffer {
	return Buffer.from(records.map((record) => `${record}${RS}\n`).join(""));
}
const pane = (fields: readonly string[]) =>
	["process-pane", ...fields].join(FS);
const client = (pid: string, session: string) =>
	["process-client", pid, session].join(FS);

describe("reading the processes on DevHub's tmux server", () => {
	it("names each marked pane's owner, and every client's session", () => {
		const read = parseProcessPanes(
			output(
				`marker${FS}1`,
				pane([WS_SESSION, "workspace", WS, "none", "%1", "201", "200", ROOT]),
				pane([
					agentSessionName(AGENT),
					"agent",
					WS,
					AGENT,
					"%2",
					"210",
					"200",
					ROOT,
				]),
				pane([
					terminalSessionName(TERMINAL),
					"terminal",
					WS,
					"none",
					"%3",
					"220",
					"200",
					ROOT,
				]),
				// A session DevHub did not mark is not DevHub's to name.
				pane(["mine", "", "", "", "%4", "240", "200", ""]),
				client("131", WS_SESSION),
			),
			"/Users/me",
		);
		expect(read).toEqual({
			marker: "owned",
			serverPid: 200,
			panes: [
				{
					context: "workspace",
					workspaceId: WS,
					agentId: undefined,
					sessionName: WS_SESSION,
					paneId: "%1",
					pid: 201,
				},
				{
					context: "agent",
					workspaceId: WS,
					agentId: AGENT,
					sessionName: agentSessionName(AGENT),
					paneId: "%2",
					pid: 210,
				},
				{
					context: "terminal",
					workspaceId: WS,
					agentId: undefined,
					sessionName: terminalSessionName(TERMINAL),
					paneId: "%3",
					pid: 220,
				},
			],
			clients: [{ pid: 131, session: WS_SESSION }],
		});
	});

	it("reads nothing from a server DevHub does not own", () => {
		expect(parseProcessPanes(output(`marker${FS}`), "/Users/me")).toEqual({
			marker: "wrong",
			serverPid: undefined,
			panes: [],
			clients: [],
		});
	});

	it("refuses an answer that is not the shape it asked for", () => {
		expect(() =>
			parseProcessPanes(output(`marker${FS}1`, "pane-activity"), "/Users/me"),
		).toThrow();
	});
});
