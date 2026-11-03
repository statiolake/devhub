/**
 * Closing a GUI Agent ends it once, and says nothing about it.
 *
 * Two parts of DevHub end a GUI Agent: its Stop, and the reconcile round that
 * finds its session gone. Closing one is both at once — the Stop kills the
 * session, and the next round sees it missing while the Stop is still on its
 * way out. The two used to end it independently, and when the round took the
 * conversation first it was still waiting for it to stop following when the
 * Stop, with nothing left to stop, removed the host files and stopped counting
 * the Agent as stopping. The round then read the ending of files that were
 * gone, and the person who had just closed the Agent got the toast "DevHub
 * could not read how “Codex” ended: there is no host state at …".
 *
 * The fakes hold each step where the race needs it: the session's kill, and
 * the conversation's first read of its host (which keeps its stop waiting,
 * as live a conversation still busy with its host does).
 */

import { describe, expect, it } from "vitest";
import { AppModel } from "../../model/appModel.js";
import {
	AgentProfile,
	agentId,
	agentProfileId,
	displayPath,
	Workspace,
	workspaceId,
	workspaceLocation,
} from "../../model/domain.js";
import {
	ENDING_SCRIPT,
	SENT_LOG_SCRIPT,
} from "../agent/conversation/hostScript.js";
import {
	memoryRecords,
	AGENTS_OFF,
} from "../agent/conversation/limitResumeTestKit.js";
import type {
	ByteStream,
	ExecRequest,
	ExecResult,
	Runtime,
} from "../runtime/runtime.js";
import type { TmuxTerminalRuntime } from "../terminal/tmux.js";
import { agents } from "./adapters.js";
import { wireAgents } from "./agentWiring.js";

const WORKSPACE = workspaceId("00000000-0000-4000-8000-0000000000e1");
const AGENT = agentId("00000000-0000-4000-8000-0000000000e2");
const HOME = "/home/testuser";

function held(): {
	readonly promise: Promise<void>;
	readonly release: () => void;
} {
	let release = () => {};
	const promise = new Promise<void>((done) => (release = done));
	return { promise, release };
}

function answered(stdout: string): ExecResult {
	return {
		code: 0,
		signal: null,
		stdout: Buffer.from(stdout, "utf8"),
		stderr: Buffer.alloc(0),
	};
}

function wired() {
	const model = new AppModel(
		new Workspace(
			WORKSPACE,
			workspaceLocation({ kind: "local", path: "/srv/api" }),
			displayPath("/srv/api"),
		),
	);
	const profile = AgentProfile.create(
		agentProfileId("codex"),
		"Codex",
		"codex",
		"codex",
		[],
		new Map(),
		"gui",
	);
	model.addAgent(WORKSPACE, AGENT, profile, "gui");

	let alive = true;
	/** Each kill of the session returns once this is released. */
	const kill = held();
	/** The conversation's first read of its host answers once this is released. */
	const firstRead = held();
	let removed = false;
	const removals: string[] = [];
	const reports: string[] = [];

	const listed = () =>
		alive
			? [
					{
						record: {
							kind: "agent",
							agentId: AGENT,
							workspaceId: WORKSPACE,
							sessionName: "agent",
						},
						activity: "1",
					},
				]
			: [];
	const tmux = {
		adapterAvailable: true,
		agentRound: () =>
			Promise.resolve({
				marker: "owned",
				agents: listed(),
				screens: new Map(),
			}),
		listAgents: () => Promise.resolve(listed()),
		closeAgent: async () => {
			alive = false;
			await kill.promise;
		},
	} as unknown as TmuxTerminalRuntime;

	const machine = {
		where: "",
		home: () => Promise.resolve(HOME),
		exec: async (request: ExecRequest): Promise<ExecResult> => {
			const script = request.argv[2];
			if (script === SENT_LOG_SCRIPT) {
				await firstRead.promise;
				return answered("");
			}
			// The host files gone are what `ENDING_SCRIPT` says "missing" for;
			// a killed session leaves no `exit`, which it says "vanished" for.
			if (script === ENDING_SCRIPT)
				return answered(removed ? "missing\n" : "vanished\n");
			return answered("");
		},
		spawnStream: (): ByteStream => ({
			stdout: (async function* () {})(),
			ended: Promise.resolve({
				code: 0,
				signal: null,
				stderr: Buffer.alloc(0),
			}),
			kill: () => {},
		}),
		removeTree: (path: string) => {
			removed = true;
			removals.push(path);
			return Promise.resolve();
		},
	} as unknown as Runtime;

	wireAgents({
		runtimeFor: () => Promise.resolve(tmux),
		model: () => model,
		machineOf: () => "local",
		machineRuntime: () => machine,
		report: (message) => reports.push(message),
		clientVersion: "0.0.0-test",
		profileTag: "0123456789ab",
		settings: AGENTS_OFF,
		limitResumes: memoryRecords(),
	});
	const adapter = agents();
	if (!adapter) throw new Error("the Agent adapter was not registered");
	return {
		adapter,
		kill,
		firstRead,
		removals,
		reports,
		vanish: () => {
			alive = false;
		},
	};
}

/** Lets every step that can run, run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("closing a GUI Agent", () => {
	it("says nothing when a round finds its session gone while the Stop is under way", async () => {
		const { adapter, kill, firstRead, removals, reports } = wired();
		// The round that opens the conversation, which starts following.
		await adapter.reconcile("local");

		// The person closes it: the Stop kills the session…
		const stopped = adapter.stop(AGENT);
		await settle();
		// …and a round sees it gone, and takes the conversation to end it,
		// before the Stop has come back from the kill.
		const round = adapter.reconcile("local");
		await settle();
		kill.release();
		await settle();
		firstRead.release();

		expect(await stopped).toEqual({ kind: "stopped" });
		expect((await round).exited).toEqual([AGENT]);
		expect(reports).toEqual([]);
		expect(removals).toHaveLength(1);
	});

	it("says nothing when it is stopped twice at once", async () => {
		const { adapter, kill, firstRead, removals, reports } = wired();
		await adapter.reconcile("local");

		// Stop pressed again before the first one came back: the second finds
		// no session, and takes the conversation to end it.
		const first = adapter.stop(AGENT);
		await settle();
		const second = adapter.stop(AGENT);
		await settle();
		kill.release();
		await settle();
		firstRead.release();

		expect(await first).toEqual({ kind: "stopped" });
		expect(await second).toEqual({ kind: "stopped" });
		expect(reports).toEqual([]);
		expect(removals).toHaveLength(1);
	});

	it("still says how it ended when nobody in DevHub stopped it", async () => {
		const { adapter, firstRead, removals, reports, vanish } = wired();
		firstRead.release();
		await adapter.reconcile("local");

		vanish();
		expect((await adapter.reconcile("local")).exited).toEqual([AGENT]);

		expect(reports).toEqual([
			"The session of “Codex 1” was ended outside DevHub",
		]);
		expect(removals).toHaveLength(1);
	});
});
