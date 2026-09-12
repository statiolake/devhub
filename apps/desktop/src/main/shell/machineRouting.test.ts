/**
 * That an Agent, a terminal and a window all reach the Workspace's machine.
 *
 * The negative assertion is everywhere else: every existing suite still passes,
 * because nothing about a Workspace on this Mac changed. What those cannot show
 * is the thing this step was for — that a Workspace on a host gets *that host's*
 * tmux server, *that host's* PTY and *that host's* `devhub-terminal`, and that
 * a round about one machine says nothing about the other. A site that kept one
 * adapter for everything would pass every local suite and be exactly the bug
 * the per-machine registry exists to make impossible.
 *
 * Two machines throughout, both fakes, neither of them this one.
 */

import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { AgentSessions } from "../agent/sessions.js";
import { AppModel } from "../../model/appModel.js";
import {
	AgentProfile,
	agentId,
	agentProfileId,
	displayPath,
	Workspace,
	workspaceId,
	workspaceLocation,
	type WorkspaceId,
} from "../../model/domain.js";
import { agents } from "./adapters.js";
import { wireAgents } from "./agentWiring.js";
import { LOCAL_CADENCE } from "../runtime/local.js";
import { TerminalRuntimes } from "./terminalRuntimes.js";
import { windowTerminalEnvironment } from "./loginEnvironment.js";
import { TerminalSurfaces } from "../terminal/surfaces.js";
import { workspaceTarget } from "../terminal/ports.js";
import type { AttachmentManager } from "../terminal/attachments.js";
import type { TmuxTerminalRuntime } from "../terminal/tmux.js";
import type { Pty, PtyLaunch } from "../terminal/pty.js";
import type { SettingsResolvedRuntimeWire } from "../../ipc/settings.js";
import type {
	ExecRequest,
	ExecResult,
	FileKind,
	Runtime,
	RuntimeId,
	TerminalLauncher,
	TerminalLauncherSpec,
	Watcher,
} from "../runtime/runtime.js";

/** A machine that runs nothing and remembers everything it was asked. */
class FakeMachine implements Runtime {
	readonly execs: ExecRequest[] = [];
	readonly ptys: PtyLaunch[] = [];

	constructor(
		readonly id: RuntimeId,
		readonly where: string,
		private readonly homeDirectory: string,
	) {}

	readonly cadence = LOCAL_CADENCE;

	home(): Promise<string> {
		return Promise.resolve(this.homeDirectory);
	}
	scratchDirectory(): Promise<string> {
		return Promise.resolve(`${this.homeDirectory}/.devhub/tmp`);
	}
	terminalLauncher(_spec: TerminalLauncherSpec): Promise<TerminalLauncher> {
		return Promise.resolve({
			path: `${this.homeDirectory}/.devhub/devhub-terminal`,
			unreachable: undefined,
		});
	}
	resolveProgram(configured: string): Promise<SettingsResolvedRuntimeWire> {
		return Promise.resolve({ kind: "command_name", value: configured });
	}
	exec(request: ExecRequest): Promise<ExecResult> {
		this.execs.push(request);
		// Every tmux command this suite provokes is answered the same way: a
		// refusal with nothing on stderr. What is asserted is *which machine was
		// asked*, and a fake that answered the protocol would be a second tmux
		// to keep true.
		return Promise.resolve({
			code: 1,
			signal: null,
			stdout: Buffer.from(""),
			stderr: Buffer.from(""),
		});
	}
	spawnPty(request: PtyLaunch): Pty {
		this.ptys.push(request);
		return {
			pid: 1,
			onData: () => {},
			onExit: () => {},
			write: () => {},
			resize: () => {},
			kill: () => {},
			pause: () => {},
			resume: () => {},
		};
	}
	stat(): Promise<FileKind> {
		return Promise.resolve("directory");
	}
	readTextFile(): Promise<string> {
		return Promise.resolve("");
	}
	writeTextFile(): Promise<void> {
		return Promise.resolve();
	}
	writeNewTextFile(): Promise<boolean> {
		return Promise.resolve(true);
	}
	readdir(): Promise<readonly never[]> {
		return Promise.resolve([]);
	}
	removeTree(): Promise<void> {
		return Promise.resolve();
	}
	makeDirectory(): Promise<void> {
		return Promise.resolve();
	}
	realpath(path: string): Promise<string> {
		return Promise.resolve(path);
	}
	watchGitDirectory(): Promise<Watcher> {
		return Promise.resolve({ close: () => {} });
	}
	reading() {
		return {
			id: this.id,
			connected: true,
			masterPid: undefined,
			medianRoundTripMs: 0,
			reconcileIntervalMs: this.cadence.reconcileIntervalMs,
			execsLastMinute: this.execs.length,
			loginEnvironmentNames: [],
			lastFailure: undefined,
		};
	}
}

function machines(): {
	a: FakeMachine;
	b: FakeMachine;
	runtimes: TerminalRuntimes;
} {
	const a = new FakeMachine("local", "", "/home/here");
	const b = new FakeMachine(
		"ssh:build.example.com",
		" on build.example.com",
		"/home/there",
	);
	return {
		a,
		b,
		runtimes: new TerminalRuntimes({
			config: undefined,
			environment: { PATH: "/usr/bin:/bin" },
			effectiveSocketName: "devhub",
		}),
	};
}

describe("one tmux adapter per machine", () => {
	it("builds one for each, on that machine's own home", async () => {
		const { a, b, runtimes } = machines();
		const here = await runtimes.for(a);
		const there = await runtimes.for(b);
		expect(here.machine).toBe("local");
		expect(there.machine).toBe("ssh:build.example.com");
		expect(here.contextHome).toBe("/home/here");
		// Not this Mac's `$HOME`: the tmux over there starts its sessions in a
		// directory that only exists over there.
		expect(there.contextHome).toBe("/home/there");
	});

	it("hands the same machine the same adapter, and never two", async () => {
		const { b, runtimes } = machines();
		const [first, second] = await Promise.all([
			runtimes.for(b),
			runtimes.for(b),
		]);
		// Two adapters for one machine would be two operation gates, so a socket
		// transition held through one would not exclude an attach through the
		// other.
		expect(first).toBe(second);
		expect(await runtimes.live()).toEqual([first]);
	});

	it("forgets a machine no Workspace is on any more", async () => {
		const { b, runtimes } = machines();
		const before = await runtimes.for(b);
		runtimes.forget(b.id);
		expect(await runtimes.for(b)).not.toBe(before);
	});
});

describe("a round about one machine", () => {
	it("asks that machine, and never the other", async () => {
		const { a, b, runtimes } = machines();
		const sessions = new AgentSessions((machine) =>
			runtimes.for(machine === a.id ? a : b),
		);
		// The answer is a refusal — this fake speaks no tmux — and that is not
		// what is being asserted. Which machine was asked is.
		await expect(sessions.list(b.id)).rejects.toThrow();
		expect(b.execs.length).toBeGreaterThan(0);
		expect(a.execs).toHaveLength(0);
		for (const request of b.execs) expect(request.argv[0]).toBe("tmux");
	});

	it("launches an Agent on the machine its Workspace is on", async () => {
		const { a, b, runtimes } = machines();
		const sessions = new AgentSessions((machine) =>
			runtimes.for(machine === a.id ? a : b),
		);
		await expect(
			sessions.launch({
				machine: b.id,
				agentId: "00000000-0000-4000-8000-0000000000a1",
				workspaceId: "00000000-0000-4000-8000-0000000000w1",
				root: "/srv/api",
				command: { file: "claude", args: [], env: {} },
			}),
		).rejects.toThrow();
		expect(b.execs.length).toBeGreaterThan(0);
		expect(a.execs).toHaveLength(0);
	});

	it("sends an Agent's text to the machine that Agent is on", async () => {
		const { a, b, runtimes } = machines();
		const sessions = new AgentSessions((machine) =>
			runtimes.for(machine === a.id ? a : b),
		);
		await expect(
			sessions.inject(
				b.id,
				"00000000-0000-4000-8000-0000000000a1",
				"00000000-0000-4000-8000-0000000000w1",
				"hello",
			),
		).rejects.toThrow();
		expect(b.execs.length).toBeGreaterThan(0);
		// An injection that reached the wrong machine would be typed into
		// whatever pane happened to carry that Agent's name over here.
		expect(a.execs).toHaveLength(0);
	});
});

describe("the Agent pane's PTY", () => {
	it("is opened on the machine the session is on", async () => {
		const { b, runtimes } = machines();
		const there = await runtimes.for(b);
		there.spawnPty({
			file: "/usr/bin/tmux",
			args: ["-L", "devhub", "attach-session", "-t", "agent"],
			cwd: "/home/there",
			cols: 80,
			rows: 24,
			pixelWidth: 0,
			pixelHeight: 0,
			env: {},
		});
		expect(b.ptys).toHaveLength(1);
		expect(b.ptys[0]?.args).toContain("attach-session");
	});

	it("is asked for from the adapter the target names", async () => {
		const { a, b, runtimes } = machines();
		const asked: RuntimeId[] = [];
		const surfaces = new TerminalSurfaces({
			runtimeFor: async (machine) => {
				asked.push(machine);
				return runtimes.for(machine === a.id ? a : b);
			},
			attachments: {
				detachTarget: vi.fn(),
			} as unknown as AttachmentManager,
		});
		await expect(
			surfaces.closeWorkspace({
				machine: b.id,
				workspaceId: "00000000-0000-4000-8000-0000000000w1",
				root: "/srv/api",
			}),
		).rejects.toThrow();
		expect(asked).toEqual([b.id]);
	});
});

describe("what a window is told its terminal is", () => {
	it("names the launcher of the machine that window is on", async () => {
		const { a, b } = machines();
		const spec: TerminalLauncherSpec = {
			localLauncherPath: "/here/devhub-terminal",
			controlSocketPath: "/here/control.sock",
			entryFiles: new Map(),
			entryName: "terminal/devhubTerminal.js",
			serverDataFolderName: ".devhub-server",
			serverCommit: "abc123",
		};
		expect(windowTerminalEnvironment(await a.terminalLauncher(spec))).toEqual({
			DEVHUB_TERMINAL: "/home/here/.devhub/devhub-terminal",
		});
		// A window on a host names a path on that host. This Mac's launcher is
		// a file that machine has never heard of, and naming it would give the
		// workbench there a terminal profile that cannot start.
		expect(windowTerminalEnvironment(await b.terminalLauncher(spec))).toEqual({
			DEVHUB_TERMINAL: "/home/there/.devhub/devhub-terminal",
		});
	});

	it("says nothing at all when the launcher cannot reach DevHub", () => {
		// Absent rather than wrong: the patched workbench refuses to invent a
		// launcher, so the terminal tab over there says why, which is the same
		// sentence in the place the person is looking.
		expect(
			windowTerminalEnvironment({
				path: "/home/there/.devhub/devhub-terminal",
				unreachable: "the control socket could not be forwarded",
			}),
		).toEqual({});
	});
});

describe("targets carry their machine", () => {
	it("keeps two hosts' identical paths apart", () => {
		const here = workspaceTarget(
			"local",
			"00000000-0000-4000-8000-0000000000w1",
			"/srv/api",
		);
		const there = workspaceTarget(
			"ssh:build.example.com",
			"00000000-0000-4000-8000-0000000000w1",
			"/srv/api",
		);
		expect(here).not.toEqual(there);
	});
});

describe("an adapter for a machine with no tmux", () => {
	it("is unavailable, and its reason names the machine", async () => {
		const b = new FakeMachine(
			"ssh:build.example.com",
			" on build.example.com",
			"/home/there",
		);
		const missing = vi.spyOn(b, "resolveProgram").mockResolvedValue({
			kind: "unavailable",
			configured: "tmux",
			lookup: { kind: "path", directories: ["/usr/bin"] },
		});
		const runtimes = new TerminalRuntimes({
			config: undefined,
			environment: { PATH: "/usr/bin" },
			effectiveSocketName: "devhub",
		});
		const adapter = await runtimes.for(b);
		// Not a new predicate: the sentence `RuntimeExecutable.unavailable`
		// already carried, with the host in it. Only terminals and Agents
		// refuse — git and worktrees on that host are unaffected.
		expect(adapter.adapterAvailable).toBe(false);
		missing.mockRestore();
	});
});

/** Two Workspaces, one on each machine, one Agent in each. */
function twoMachineModel(
	here: string,
	there: string,
): { model: AppModel; machineOf: (id: WorkspaceId) => RuntimeId } {
	const model = new AppModel();
	const localWorkspace = workspaceId("00000000-0000-4000-8000-0000000000c1");
	const remoteWorkspace = workspaceId("00000000-0000-4000-8000-0000000000c2");
	model.addWorkspace(
		new Workspace(
			localWorkspace,
			workspaceLocation({ kind: "local", path: "/projects/widget" }),
			displayPath("/projects/widget"),
		),
	);
	model.addWorkspace(
		new Workspace(
			remoteWorkspace,
			workspaceLocation({
				kind: "ssh",
				host: "build.example.com",
				path: "/srv/api",
			}),
			displayPath("/srv/api"),
		),
	);
	const profile = AgentProfile.create(
		agentProfileId("codex"),
		"Codex",
		"codex",
		"codex",
	);
	model.addAgent(localWorkspace, agentId(here), profile);
	model.addAgent(remoteWorkspace, agentId(there), profile);
	return {
		model,
		machineOf: (id) =>
			id === remoteWorkspace ? "ssh:build.example.com" : "local",
	};
}

describe("a reconcile round is about one machine's Agents", () => {
	/**
	 * A tmux adapter that lists whatever this machine was told to have.
	 *
	 * Only the three methods a round reaches, because the round is what is
	 * under test: an adapter that also answered the protocol would be a second
	 * tmux to keep true, and the assertion here is about which Agents a round
	 * *judges*, not about what tmux says.
	 */
	function adapterListing(agentIds: readonly string[]): TmuxTerminalRuntime {
		return {
			adapterAvailable: true,
			agentRound: () =>
				Promise.resolve({
					marker: "owned",
					agents: agentIds.map((agentId) => ({
						record: { kind: "agent", agentId, workspaceId: "w" },
						activity: "1",
					})),
					screens: new Map(),
				}),
		} as unknown as TmuxTerminalRuntime;
	}

	it("leaves the other machine's Agents exactly where they were", async () => {
		const HERE = "00000000-0000-4000-8000-00000000000a";
		const THERE = "00000000-0000-4000-8000-00000000000b";
		const model = twoMachineModel(HERE, THERE);
		wireAgents({
			runtimeFor: (machine) =>
				Promise.resolve(adapterListing(machine === "local" ? [HERE] : [THERE])),
			model: () => model.model,
			machineOf: (workspaceId) => model.machineOf(workspaceId),
		});
		const adapter = agents();
		if (!adapter) throw new Error("the Agent adapter was not registered");

		const here = await adapter.reconcile("local");
		// The Agent over there is not in this round at all — neither observed
		// nor exited. A round that judged it against this machine's session
		// list would have reported a running Agent as ended.
		expect(here.observations.map((one) => one.agentId)).toEqual([HERE]);
		expect(here.exited).toEqual([]);

		const there = await adapter.reconcile("ssh:build.example.com");
		expect(there.observations.map((one) => one.agentId)).toEqual([THERE]);
		expect(there.exited).toEqual([]);
	});
});
