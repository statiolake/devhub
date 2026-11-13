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
	STREAM_EXIT,
	WRITE_EXIT,
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

/**
 * Where the host's files are when the wiring starts: there, or gone — removed
 * by a DevHub that quit before its Stop was written down, cleaned off the
 * host, or never at the path this DevHub computes (a profile tag or a home
 * that moved).
 */
interface WiredOptions {
	readonly files?: "there" | "gone";
	/** The journal stream is held open, as a live host's is, until the files go or it is let go of. */
	readonly following?: boolean;
}

function wired(options: WiredOptions = {}) {
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
	let removed = options.files === "gone";
	/** Streams that are following now, ended when the files go. */
	const streams = new Set<(code: number) => void>();
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
				if (removed) {
					return {
						code: WRITE_EXIT.stateMissing,
						signal: null,
						stdout: Buffer.alloc(0),
						stderr: Buffer.from(
							`there is no host state at ${String(request.argv[4])}\n`,
						),
					};
				}
				return answered("");
			}
			// The host files gone are what `ENDING_SCRIPT` says "missing" for;
			// a killed session leaves no `exit`, which it says "vanished" for.
			if (script === ENDING_SCRIPT)
				return answered(removed ? "missing\n" : "vanished\n");
			return answered("");
		},
		spawnStream: (): ByteStream => {
			if (options.following !== true || removed) {
				return {
					stdout: (async function* () {})(),
					ended: Promise.resolve({
						code: removed ? STREAM_EXIT.stateMissing : 0,
						signal: null,
						stderr: Buffer.from(
							removed
								? "devhub-agent-stream: there is no host state at the directory\n"
								: "",
						),
					}),
					kill: () => {},
				};
			}
			let end: (code: number | null) => void = () => {};
			const ended = new Promise<number | null>((done) => (end = done));
			const stop = (code: number) => end(code);
			streams.add(stop);
			return {
				// Open until the stream ends, as a live `tail -f`'s is.
				stdout: (async function* (): AsyncGenerator<Buffer> {
					await ended;
					yield* [];
				})(),
				ended: ended.then((code) => {
					streams.delete(stop);
					return {
						code,
						signal: code === null ? "SIGTERM" : null,
						stderr: Buffer.from(
							code === STREAM_EXIT.stateMissing
								? "devhub-agent-stream: the journal of the directory cannot be read\n"
								: "",
						),
					};
				}),
				kill: () => end(null),
			};
		},
		removeTree: (path: string) => {
			removed = true;
			removals.push(path);
			return Promise.resolve();
		},
	} as unknown as Runtime;

	const wiring = wireAgents({
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
		wiring,
		kill,
		firstRead,
		removals,
		reports,
		vanish: () => {
			alive = false;
		},
		/** Somebody on the host removes the files under the running Agent. */
		clean: () => {
			removed = true;
			for (const stop of [...streams]) stop(STREAM_EXIT.stateMissing);
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

/**
 * An Agent DevHub has ended stays ended: its host files are gone because
 * DevHub removed them, and a round that still finds its row — a Workspace
 * close that has stopped its Agents and is still closing its terminals or
 * removing its worktree, or a close that failed at a later step — is not
 * news. It used to end the Agent a second time, outside the first ending's
 * window, read the ending of the files the first one had removed, and say
 * "there is no host state at …" app-wide.
 */
describe("an Agent DevHub has ended", () => {
	it("says nothing when a round finds the row of an Agent a Workspace close stopped", async () => {
		const { adapter, kill, firstRead, removals, reports } = wired();
		kill.release();
		firstRead.release();
		await adapter.reconcile("local");

		// The close's Agents step: done, and the row is still there until the
		// whole close is.
		await adapter.closeWorkspaceAgents(WORKSPACE);
		expect((await adapter.reconcile("local")).exited).toEqual([AGENT]);

		expect(reports).toEqual([]);
		expect(removals).toHaveLength(1);
	});

	it("says nothing when a round comes between a Stop's return and its row going", async () => {
		const { adapter, kill, firstRead, removals, reports } = wired();
		kill.release();
		firstRead.release();
		await adapter.reconcile("local");

		expect(await adapter.stop(AGENT)).toEqual({ kind: "stopped" });
		await adapter.reconcile("local");
		// And a Stop retried after it is the same ending, not another.
		expect(await adapter.stop(AGENT)).toEqual({ kind: "stopped" });

		expect(reports).toEqual([]);
		expect(removals).toHaveLength(1);
	});

	it("opens no conversation again once it has ended", async () => {
		const { adapter, wiring, kill, firstRead } = wired();
		kill.release();
		firstRead.release();
		await adapter.reconcile("local");
		await adapter.stop(AGENT);

		// A page that attaches while the row is still there is told it ended,
		// rather than given a new conversation on files that are gone.
		await expect(wiring.conversations.of(AGENT)).rejects.toThrow(/ended/u);
		expect(wiring.conversations.registry.get(AGENT)).toBeUndefined();
	});
});

/**
 * Host files that are not there, and DevHub did not just remove: a DevHub that
 * quit between its Stop removing them and the Stop being written down (the row
 * comes back with the next DevHub), a host that cleaned them, or a path that
 * moved under the Agent (a profile tag, or a home, that changed).
 */
describe("an Agent whose host files are gone", () => {
	it("says nothing when it ends after a restart of DevHub", async () => {
		const { adapter, firstRead, removals, reports, vanish } = wired({
			files: "gone",
		});
		firstRead.release();
		vanish();

		expect((await adapter.reconcile("local")).exited).toEqual([AGENT]);

		expect(reports).toEqual([]);
		expect(removals).toHaveLength(1);
	});

	it("says so once, on its own pane, when they are not there to attach to", async () => {
		const { adapter, firstRead, reports, vanish } = wired({
			files: "gone",
		});
		firstRead.release();
		await adapter.reconcile("local");
		await settle();

		// Every round after says the same, rather than trying again and
		// clearing it for a moment each time.
		for (let round = 0; round < 3; round += 1) {
			const [observation] = (await adapter.reconcile("local")).observations;
			expect(observation?.failure?.code).toBe("conversation_host_lost");
			expect(observation?.failure?.detail).toMatch(
				/ホストの状態.*見つかりません/u,
			);
			expect(observation?.failure?.detail).toContain(
				`${HOME}/.devhub/agents-0123456789ab/${AGENT}`,
			);
			await settle();
		}
		expect(reports).toEqual([]);

		// And its ending is not said again, app-wide.
		vanish();
		expect((await adapter.reconcile("local")).exited).toEqual([AGENT]);
		expect(reports).toEqual([]);
	});

	it("says so once, on its own pane, when the host cleans them while it runs", async () => {
		const { adapter, firstRead, reports, vanish, clean } = wired({
			following: true,
		});
		firstRead.release();
		await adapter.reconcile("local");
		await settle();
		expect(
			(await adapter.reconcile("local")).observations[0]?.failure,
		).toBeUndefined();

		clean();
		await settle();
		const [observation] = (await adapter.reconcile("local")).observations;
		expect(observation?.failure?.code).toBe("conversation_host_lost");
		expect(observation?.failure?.detail).toMatch(/見つかりません/u);

		vanish();
		expect((await adapter.reconcile("local")).exited).toEqual([AGENT]);
		expect(reports).toEqual([]);
	});
});
