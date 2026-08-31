/** Ported from the `runtime.rs` test module of the Tauri agent adapter. */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	Invalidation,
	SubscriptionHandle,
	type ProviderTransport,
} from "./api.js";
import {
	AgentRuntimeError,
	AgentRuntimeErrorCode,
	ProviderErrorCategory,
	agentError,
} from "./error.js";
import { terminalErrorFromPort } from "./channel.js";
import {
	RuntimeLaunchContext,
	RuntimeErrorCode,
	type RuntimeError,
} from "./launchContext.js";
import {
	AgentRuntimeHealthState,
	EXIT_EVIDENCE_ROUNDS,
	ProviderStatus,
	encodeProviderMapping,
	type ProviderMapping,
	type ProviderProfile,
} from "./model.js";
import {
	AgentLaunchFailureStage,
	HerdrAgentRuntime,
	verifyPing,
} from "./runtime.js";
import {
	AgentProfileKind,
	AgentStatus,
	CancellationToken,
	PortError,
	PortErrorCode,
	RuntimeHealth,
	type AgentProfile,
} from "./ports.js";

const scratchDirs: string[] = [];

function scratchDir(): string {
	// Under the repo, never the OS temp dir.
	const dir = mkdtempSync(join(import.meta.dirname, "agent-runtime-test-"));
	scratchDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (scratchDirs.length > 0) {
		rmSync(scratchDirs.pop()!, { recursive: true, force: true });
	}
});

type Response =
	| readonly [string, unknown]
	| readonly [string, AgentRuntimeError];

class FakeTransport implements ProviderTransport {
	readonly #responses: Response[];
	readonly requests: [string, unknown][] = [];
	subscriptionCount = 0;

	constructor(responses: Response[] = []) {
		this.#responses = [...responses];
	}

	get remaining(): number {
		return this.#responses.length;
	}

	async request(method: string, params: unknown): Promise<unknown> {
		this.requests.push([method, params]);
		const next = this.#responses.shift();
		if (next === undefined) {
			throw agentError(AgentRuntimeErrorCode.ProviderRejected);
		}
		expect(next[0]).toBe(method);
		if (next[1] instanceof AgentRuntimeError) {
			throw next[1];
		}
		return next[1];
	}

	async subscribe(_invalidation: Invalidation): Promise<SubscriptionHandle> {
		this.subscriptionCount += 1;
		const handle = new SubscriptionHandle(Promise.resolve());
		handle.markReady(true);
		return handle;
	}
}

const PONG = {
	type: "pong",
	version: "0.8.2",
	protocol: 20,
	capabilities: { live_handoff: true },
};

function context(): RuntimeLaunchContext {
	return RuntimeLaunchContext.create(scratchDir(), process.env);
}

function runtimeWith(transport: ProviderTransport): HerdrAgentRuntime {
	return HerdrAgentRuntime.withTransport(
		context(),
		transport,
		join(scratchDir(), "journal.json"),
	);
}

function token(seed: string): CancellationToken {
	return new CancellationToken(
		`cccccccc-cccc-4ccc-8ccc-${seed.padStart(12, "0")}`,
	);
}

function profile(args: string[] = ["--deterministic"]): AgentProfile {
	return {
		id: "codex",
		displayName: "Codex",
		kind: AgentProfileKind.Codex,
		args,
		env: {},
	};
}

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function createdWorkspace(index = ""): unknown {
	return {
		workspace: { workspace_id: `provider-workspace${index}` },
		tab: { tab_id: `provider-tab${index}` },
		root_pane: {
			pane_id: `provider-pane${index}`,
			terminal_id: `provider-terminal${index}`,
		},
	};
}

function mapping(overrides: Partial<ProviderMapping> = {}): ProviderMapping {
	return {
		workspaceId: "provider-workspace",
		tabId: "provider-tab",
		paneId: "provider-pane",
		terminalId: "provider-terminal",
		workspaceRoot: "/devhub-agent",
		workspaceDomainId: undefined,
		generation: 1,
		...overrides,
	};
}

async function portCodeOf(run: () => Promise<unknown>): Promise<PortErrorCode> {
	try {
		await run();
	} catch (error) {
		expect(error).toBeInstanceOf(PortError);
		return (error as PortError).code;
	}
	throw new Error("expected a failure");
}

describe("the Herdr ping handshake", () => {
	it("requires an exact version, protocol and capability object", () => {
		expect(() => verifyPing(PONG)).not.toThrow();
		expect(() => verifyPing({ ...PONG, version: "0.8.1" })).toThrow(
			/protocol mismatch/,
		);
		expect(() =>
			verifyPing({ type: "pong", version: "0.8.2", protocol: 20 }),
		).toThrow(/capability mismatch/);
	});
});

describe("the Herdr agent runtime", () => {
	it("refuses to be created on a config home that cannot hold its socket", () => {
		const longConfigHome = `/${"config-home".repeat(12)}`;
		let thrown: AgentRuntimeError | undefined;
		try {
			HerdrAgentRuntime.create(
				RuntimeLaunchContext.create(scratchDir(), {
					...process.env,
					XDG_CONFIG_HOME: longConfigHome,
				}),
				"herdr",
				join(scratchDir(), "journal.json"),
			);
		} catch (error) {
			thrown = error as AgentRuntimeError;
		}
		expect(thrown?.code).toBe(AgentRuntimeErrorCode.SocketPathTooLong);
		expect(thrown?.message).toContain(longConfigHome);
	});

	it("tells every agent it launches that the surface renders true colour", async () => {
		// An Agent's output is drawn by xterm.js, which renders 24-bit colour.
		// A terminal is told so through tmux; Herdr does not use tmux, so an
		// Agent was told only when `COLORTERM` happened to survive the login
		// environment import — true of a shell-launched DevHub, not necessarily
		// of one launched from Finder. The capability is a fact about the
		// surface, so it is asserted rather than inherited.
		const read = async (
			environment: Record<string, string>,
		): Promise<{ colorterm: string; term: string }> => {
			const launch = RuntimeLaunchContext.create(scratchDir(), environment);
			const child = launch.spawn(launch.resolve("/bin/sh"), [
				"-c",
				'printf "%s\\n%s" "$COLORTERM" "$TERM"',
			]);
			const chunks: Buffer[] = [];
			child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
			await new Promise((resolve) => child.on("close", resolve));
			const [colorterm = "", term = ""] = Buffer.concat(chunks)
				.toString("utf8")
				.split("\n");
			return { colorterm, term };
		};

		// Nothing in the login environment said so — a Finder launch.
		expect((await read({ PATH: "/usr/bin:/bin" })).colorterm).toBe("truecolor");
		// Something said something else. The surface's capability is not the
		// launching terminal's, so it is not negotiated with it.
		expect(
			await read({ PATH: "/usr/bin:/bin", COLORTERM: "16", TERM: "vt100" }),
		).toEqual({
			colorterm: "truecolor",
			// `TERM` is the user's own and is passed through: Herdr's control
			// stream is not a terminfo consumer, so overriding it would take
			// something away and give nothing.
			term: "vt100",
		});
	});

	it("names the Herdr it could not find, and where it looked", () => {
		// The reason is composed where the search happens and reported at the
		// first attach, far from it. "Agent runtime unavailable" was all that
		// reached the surface before: it named neither the program nor the
		// directories, on a machine whose PATH was simply launchd's.
		const launch = RuntimeLaunchContext.create(scratchDir(), {
			PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
		});
		let thrown: RuntimeError | undefined;
		try {
			launch.resolve("devhub-herdr-that-is-not-installed");
		} catch (error) {
			thrown = error as RuntimeError;
		}
		const named =
			"DevHub could not find 'devhub-herdr-that-is-not-installed' on PATH " +
			"(looked in: /usr/bin, /bin, /usr/sbin, /sbin).";
		expect(thrown?.code).toBe(RuntimeErrorCode.MissingExecutable);
		expect(thrown?.detail).toBe(named);

		// And the surface renders exactly that, rather than the code's stock
		// words: the runtime carries the reason from construction to the first
		// bootstrap, which raises `unavailablePort(reason)`.
		expect(
			terminalErrorFromPort(new PortError(PortErrorCode.Unavailable, named))
				.summary,
		).toBe(named);
	});

	it("names the path a configured Herdr path pointed at", () => {
		const launch = RuntimeLaunchContext.create(scratchDir(), {
			PATH: "/usr/bin:/bin",
		});
		let thrown: RuntimeError | undefined;
		try {
			launch.resolve("/opt/nothing/bin/herdr");
		} catch (error) {
			thrown = error as RuntimeError;
		}
		expect(thrown?.detail).toBe(
			"DevHub could not find '/opt/nothing/bin/herdr' at /opt/nothing/bin/herdr.",
		);
	});

	it("bootstraps without mutating anything and installs one subscription", async () => {
		const transport = new FakeTransport([["ping", PONG]]);
		const runtime = runtimeWith(transport);
		const health = await runtime.bootstrap(token("1"));
		expect(health.state).toBe(AgentRuntimeHealthState.Healthy);
		expect(transport.subscriptionCount).toBe(1);
		expect(transport.requests.map(([method]) => method)).toEqual(["ping"]);
	});

	it("keeps one long-lived subscription across sixteen agent launches", async () => {
		const responses: Response[] = [["ping", PONG]];
		for (let index = 0; index < 16; index += 1) {
			responses.push(["workspace.create", createdWorkspace(`-${index}`)]);
			responses.push([
				"agent.start",
				{ agent: { terminal_id: `provider-terminal-${index}` } },
			]);
		}
		const transport = new FakeTransport(responses);
		const runtime = runtimeWith(transport);
		for (let index = 0; index < 16; index += 1) {
			await runtime.launchForWorkspace(
				`bbbbbbbb-bbbb-4bbb-8bbb-${index.toString(16).padStart(12, "0")}`,
				`/devhub-scale-${index}`,
				`aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, "0")}`,
				profile(),
				token(index.toString(16)),
			);
		}
		expect(transport.subscriptionCount).toBe(1);
		expect(transport.remaining).toBe(0);
	});

	it("preserves the first failed launch stage and its codes", async () => {
		const transport = new FakeTransport([
			["ping", PONG],
			[
				"workspace.create",
				agentError(
					AgentRuntimeErrorCode.ProviderRejected,
					ProviderErrorCategory.AgentPaneBusy,
				),
			],
			["pane.close", agentError(AgentRuntimeErrorCode.ProviderNotFound)],
			["workspace.close", agentError(AgentRuntimeErrorCode.ProviderNotFound)],
		]);
		const runtime = runtimeWith(transport);
		runtime.registerAgentWorkspace(AGENT_ID, WORKSPACE_ID, "/devhub-launch");
		expect(
			await portCodeOf(() =>
				runtime.launchForWorkspace(
					WORKSPACE_ID,
					"/devhub-launch",
					AGENT_ID,
					profile(),
					token("2"),
				),
			),
		).toBe(PortErrorCode.Failed);
		expect(runtime.takeLastLaunchFailure()).toEqual({
			stage: AgentLaunchFailureStage.WorkspaceCreate,
			agentRuntimeErrorCode: AgentRuntimeErrorCode.ProviderRejected,
			portErrorCode: PortErrorCode.Failed,
			providerErrorCategory: ProviderErrorCategory.AgentPaneBusy,
		});
		expect(runtime.takeLastLaunchFailure()).toBeUndefined();
	});

	it("rejects an oversized profile before any provider request", async () => {
		const transport = new FakeTransport([["sentinel", {}]]);
		const runtime = runtimeWith(transport);
		runtime.registerAgentWorkspace(AGENT_ID, WORKSPACE_ID, "/devhub-budget");
		expect(
			await portCodeOf(() =>
				runtime.launchForWorkspace(
					WORKSPACE_ID,
					"/devhub-budget",
					AGENT_ID,
					profile(Array(64).fill("x".repeat(14_500))),
					token("3"),
				),
			),
		).toBe(PortErrorCode.Failed);
		expect(transport.remaining).toBe(1);
		expect(runtime.takeLastLaunchFailure()?.stage).toBe(
			AgentLaunchFailureStage.ValidateProfile,
		);
	});

	it("sends agent.start with an explicit interactive timeout", async () => {
		const transport = new FakeTransport([
			["ping", PONG],
			["workspace.create", createdWorkspace()],
			["agent.start", { agent: { terminal_id: "provider-terminal" } }],
		]);
		const runtime = runtimeWith(transport);
		await runtime.launchForWorkspace(
			WORKSPACE_ID,
			"/devhub-agent-start-timeout",
			AGENT_ID,
			profile(),
			token("4"),
		);
		const request = transport.requests.find(
			([method]) => method === "agent.start",
		)?.[1] as Record<string, unknown>;
		expect(request.timeout_ms).toBe(30_000);
		expect(request.kind).toBe("codex");
		expect(request.args).toEqual(["--deterministic"]);
	});

	it("waits for the owned workspace shell before one agent.start retry", async () => {
		const busy = agentError(
			AgentRuntimeErrorCode.ProviderRejected,
			ProviderErrorCategory.AgentPaneBusy,
		);
		const transport = new FakeTransport([
			["agent.start", busy],
			["pane.get", { pane: { terminal_id: "provider-terminal" } }],
			[
				"pane.process_info",
				{
					process_info: {
						shell_pid: 10,
						foreground_process_group_id: 10,
						foreground_processes: [
							{ pid: 10, name: "zsh" },
							{ pid: 11, name: "workspace-init" },
						],
					},
				},
			],
			["pane.get", { pane: { terminal_id: "provider-terminal" } }],
			[
				"pane.process_info",
				{
					process_info: {
						shell_pid: 10,
						foreground_process_group_id: 10,
						foreground_processes: [{ pid: 10, name: "zsh" }],
					},
				},
			],
			["agent.start", { agent: { terminal_id: "provider-terminal" } }],
		]);
		const runtime = runtimeWith(transport);
		const providerProfile: ProviderProfile = {
			kind: "codex",
			args: ["--deterministic"],
			env: {},
		};
		const started = (await runtime.startAgent(
			AGENT_ID,
			mapping(),
			providerProfile,
			token("5"),
		)) as { agent: { terminal_id: string } };
		expect(started.agent.terminal_id).toBe("provider-terminal");
		expect(transport.remaining).toBe(0);
		expect(transport.requests.map(([method]) => method)).toEqual([
			"agent.start",
			"pane.get",
			"pane.process_info",
			"pane.get",
			"pane.process_info",
			"agent.start",
		]);
	});

	it("never retries agent.start once the target terminal changed", async () => {
		const busy = agentError(
			AgentRuntimeErrorCode.ProviderRejected,
			ProviderErrorCategory.AgentPaneBusy,
		);
		const transport = new FakeTransport([
			["agent.start", busy],
			["pane.get", { pane: { terminal_id: "replacement-terminal" } }],
		]);
		const runtime = runtimeWith(transport);
		await expect(
			runtime.startAgent(
				AGENT_ID,
				mapping(),
				{ kind: "codex", args: [], env: {} },
				token("6"),
			),
		).rejects.toBe(busy);
		expect(transport.remaining).toBe(0);
		expect(transport.requests.map(([method]) => method)).toEqual([
			"agent.start",
			"pane.get",
		]);
	});

	it("keeps a missing persisted pane owned until reconcile can emit its exit", async () => {
		const transport = new FakeTransport([
			["ping", PONG],
			["session.snapshot", { snapshot: { workspaces: [], panes: [] } }],
		]);
		const runtime = runtimeWith(transport);
		runtime.registerAgentWorkspace(AGENT_ID, WORKSPACE_ID, "/devhub-restored");
		const opaque = encodeProviderMapping(
			mapping({
				workspaceRoot: "/devhub-restored",
				workspaceDomainId: WORKSPACE_ID,
			}),
		);
		expect(
			await portCodeOf(() => runtime.attach(AGENT_ID, opaque, token("7"))),
		).toBe(PortErrorCode.Unavailable);
		expect(runtime.stateForTests.mappings.has(AGENT_ID)).toBe(true);
	});

	it("projects an unmounted agent's natural exit from reconciliation", () => {
		const runtime = runtimeWith(new FakeTransport());
		runtime.stateForTests.mappings.set(
			AGENT_ID,
			mapping({ workspaceDomainId: WORKSPACE_ID }),
		);
		const empty = { workspaces: [], panes: [] };
		for (let round = 1; round < EXIT_EVIDENCE_ROUNDS; round += 1) {
			const pending = runtime.projectSnapshot(empty);
			expect(pending.observations).toEqual([]);
			expect(pending.exited).toEqual([]);
			expect(runtime.stateForTests.tombstones.has(AGENT_ID)).toBe(false);
		}
		const { observations, exited } = runtime.projectSnapshot(empty);
		expect(observations).toEqual([]);
		expect(exited).toEqual([AGENT_ID]);
		expect(runtime.stateForTests.tombstones.has(AGENT_ID)).toBe(true);
	});

	it("says nothing about an agent Herdr cannot classify", () => {
		const runtime = runtimeWith(new FakeTransport());
		const owned = mapping({ workspaceDomainId: WORKSPACE_ID });
		runtime.stateForTests.mappings.set(AGENT_ID, owned);
		const pane = (status: ProviderStatus) => ({
			workspaces: [],
			panes: [
				{
					id: owned.paneId,
					terminalId: owned.terminalId,
					workspaceId: owned.workspaceId,
					tabId: owned.tabId,
					agent: "codex",
					status,
				},
			],
		});
		expect(
			runtime.projectSnapshot(pane(ProviderStatus.Working)).observations,
		).toEqual([
			{
				agentId: AGENT_ID,
				status: AgentStatus.Working,
				runtimeHealth: RuntimeHealth.Healthy,
			},
		]);
		// `unknown` is not a failure to report: the row keeps the status it
		// has rather than flashing Error while Herdr catches up.
		const unclassified = runtime.projectSnapshot(pane(ProviderStatus.Unknown));
		expect(unclassified.observations).toEqual([]);
		expect(unclassified.exited).toEqual([]);
		expect(runtime.stateForTests.tombstones.has(AGENT_ID)).toBe(false);
	});

	it("forgets the evidence as soon as the pane comes back", () => {
		const runtime = runtimeWith(new FakeTransport());
		const owned = mapping({ workspaceDomainId: WORKSPACE_ID });
		runtime.stateForTests.mappings.set(AGENT_ID, owned);
		const live = {
			workspaces: [],
			panes: [
				{
					id: owned.paneId,
					terminalId: owned.terminalId,
					workspaceId: owned.workspaceId,
					tabId: owned.tabId,
					agent: "codex",
					status: ProviderStatus.Working,
				},
			],
		};
		const empty = { workspaces: [], panes: [] };
		for (let round = 0; round < EXIT_EVIDENCE_ROUNDS * 3; round += 1) {
			// Two rounds of absence, then one that finds it again: the streak
			// never completes, so the Agent stays for as long as this goes on.
			expect(runtime.projectSnapshot(empty).exited).toEqual([]);
			expect(runtime.projectSnapshot(empty).exited).toEqual([]);
			expect(runtime.projectSnapshot(live).exited).toEqual([]);
		}
		expect(runtime.stateForTests.tombstones.has(AGENT_ID)).toBe(false);
		expect(runtime.stateForTests.mappings.has(AGENT_ID)).toBe(true);
	});
});
