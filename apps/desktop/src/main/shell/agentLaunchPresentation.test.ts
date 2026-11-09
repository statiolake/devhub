/**
 * Launching an Agent as a terminal or as a GUI.
 *
 * The two differ at launch in one place: the session command. A GUI Agent's
 * session runs its CLI in structured mode under the host, with the host's
 * files in a directory made for it first; everything else about the session
 * is the terminal's. Only Claude and Codex can be GUI Agents at all; the
 * domain refuses a GUI presentation to any other kind before it gets here.
 */

import { describe, expect, it, vi } from "vitest";
import { AppModel } from "../../model/appModel.js";
import {
	AgentProfile,
	agentId,
	agentProfileId,
	displayPath,
	Workspace,
	workspaceId,
	workspaceLocation,
	type AgentProfileKind,
} from "../../model/domain.js";
import { CLAUDE_STRUCTURED_FLAGS } from "../agent/conversation/claude/argv.js";
import { GUI_AGENT_INSTRUCTIONS } from "../agent/conversation/linkInstructions.js";
import { HOST_NAME, HOST_SCRIPT } from "../agent/conversation/hostScript.js";
import type { Runtime } from "../runtime/runtime.js";
import type { TmuxTerminalRuntime } from "../terminal/tmux.js";
import { agents } from "./adapters.js";
import {
	memoryRecords,
	AGENTS_OFF,
} from "../agent/conversation/limitResumeTestKit.js";
import { wireAgents } from "./agentWiring.js";
import { SessionNotResumable } from "../agent/conversation/failures.js";
import { terminalSession } from "../agent/conversation/resume.js";

// Which session a terminal Agent is in is read from its pane's processes
// (`resume.test.ts` covers that); a restart only asks.
vi.mock(import("../agent/conversation/resume.js"), async (original) => ({
	...(await original()),
	terminalSession: vi.fn(),
}));

const WORKSPACE = workspaceId("00000000-0000-4000-8000-0000000000d1");
const AGENT = agentId("550e8400-e29b-41d4-a716-4466554400d0");
const HOME = "/home/testuser";

/** A host with neither bash nor zsh, given DevHub's bash. */
const DELIVERED_BASH = `${HOME}/.devhub-server/bash/5.3.20/bin/bash`;
const ON_DELIVERED_BASH = {
	CLAUDE_CODE_SHELL: DELIVERED_BASH,
};

function wired(
	claudeShell: () => Promise<Readonly<Record<string, string>>> = () =>
		Promise.resolve({}),
) {
	const model = new AppModel(
		new Workspace(
			WORKSPACE,
			workspaceLocation({ kind: "local", path: "/srv/api" }),
			displayPath("/srv/api"),
		),
	);
	const launchAgent = vi.fn(() => Promise.resolve());
	const respawnAgent = vi.fn(() => Promise.resolve());
	const agentPanePid = vi.fn(() => Promise.resolve(4242));
	const makeDirectory = vi.fn(() => Promise.resolve());
	const askedForShell = vi.fn(claudeShell);
	const wiring = wireAgents({
		runtimeFor: () =>
			Promise.resolve({
				launchAgent,
				respawnAgent,
				agentPanePid,
			} as unknown as TmuxTerminalRuntime),
		model: () => model,
		machineOf: () => "local",
		machineRuntime: () =>
			({
				home: () => Promise.resolve(HOME),
				makeDirectory,
				claudeShell: askedForShell,
				where: "",
			}) as unknown as Runtime,
		report: () => {
			throw new Error("nothing ended in these tests");
		},
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
		model,
		launchAgent,
		respawnAgent,
		makeDirectory,
		askedForShell,
	};
}

function profile(kind: AgentProfileKind): AgentProfile {
	return AgentProfile.create(
		agentProfileId(kind),
		kind === "claude" ? "Claude" : "Codex",
		kind,
		kind,
		["--model", "opus"],
		new Map([["EXAMPLE", "1"]]),
		"gui",
	);
}

describe("launching a GUI Claude Agent", () => {
	it("runs claude in structured mode under the host, in a directory made for it first", async () => {
		const { adapter, launchAgent, makeDirectory } = wired();

		const result = await adapter.launch(
			WORKSPACE,
			AGENT,
			profile("claude"),
			"gui",
			"/srv/api",
		);

		expect(result).toEqual({ kind: "started" });
		const directory = `${HOME}/.devhub/agents-0123456789ab/${AGENT}`;
		expect(makeDirectory).toHaveBeenCalledWith(directory);
		expect(launchAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: AGENT,
				workspaceId: WORKSPACE,
				root: "/srv/api",
			}),
			{
				file: "/bin/sh",
				args: [
					"-c",
					HOST_SCRIPT,
					HOST_NAME,
					directory,
					"claude",
					"--model",
					"opus",
					...CLAUDE_STRUCTURED_FLAGS,
					"--append-system-prompt",
					GUI_AGENT_INSTRUCTIONS,
				],
				env: { EXAMPLE: "1" },
			},
			expect.anything(),
		);
	});
});

describe("launching a GUI Codex Agent", () => {
	it("runs codex's app-server under the host, after the profile's own arguments", async () => {
		const { adapter, launchAgent, makeDirectory } = wired();

		const result = await adapter.launch(
			WORKSPACE,
			AGENT,
			profile("codex"),
			"gui",
			"/srv/api",
		);

		expect(result).toEqual({ kind: "started" });
		const directory = `${HOME}/.devhub/agents-0123456789ab/${AGENT}`;
		expect(makeDirectory).toHaveBeenCalledWith(directory);
		expect(launchAgent).toHaveBeenCalledWith(
			expect.anything(),
			{
				file: "/bin/sh",
				args: [
					"-c",
					HOST_SCRIPT,
					HOST_NAME,
					directory,
					"codex",
					"--model",
					"opus",
					"app-server",
				],
				env: { EXAMPLE: "1" },
			},
			expect.anything(),
		);
	});
});

describe("launching a terminal Agent", () => {
	// A terminal Agent is its CLI as the profile says, nothing added: DevHub
	// gives the person's Claude no hook, settings or directory of its own (the
	// session it is in is Claude's own record, `terminalSession`).
	it.each(["claude", "codex"] as const)(
		"runs a terminal %s's own command as it is, with no directory",
		async (kind) => {
			const { adapter, launchAgent, makeDirectory } = wired();

			const result = await adapter.launch(
				WORKSPACE,
				AGENT,
				profile(kind),
				"tui",
				"/srv/api",
			);

			expect(result).toEqual({ kind: "started" });
			expect(launchAgent).toHaveBeenCalledWith(
				expect.anything(),
				{ file: kind, args: ["--model", "opus"], env: { EXAMPLE: "1" } },
				expect.anything(),
			);
			expect(makeDirectory).not.toHaveBeenCalled();
		},
	);
});

describe("restarting a terminal Agent", () => {
	function terminalAgent(kind: "claude" | "codex", args: readonly string[]) {
		const setup = wired();
		setup.model.addAgent(
			WORKSPACE,
			AGENT,
			AgentProfile.create(
				agentProfileId(kind),
				kind === "claude" ? "Claude" : "Codex",
				kind,
				`/opt/bin/${kind}`,
				args,
				new Map([["EXAMPLE", "1"]]),
			),
			"tui",
		);
		return setup;
	}

	// The pane is respawned with what a launch of the profile runs, on the
	// session the CLI is in now — whichever session it was launched on, or
	// a profile's own `--continue`, gives way to it.
	it.each([
		[
			"claude",
			["--model", "opus", "--resume", "first"],
			"S-now",
			["--model", "opus", "--resume", "S-now"],
		],
		[
			"codex",
			["--model", "o3", "resume", "first"],
			"T-now",
			["--model", "o3", "resume", "T-now"],
		],
		["claude", ["--continue"], "S-now", ["--resume", "S-now"]],
	] as const)(
		"starts a terminal %s again in its own pane, resuming its session",
		async (kind, args, session, expected) => {
			vi.mocked(terminalSession).mockResolvedValueOnce(session);
			const { wiring, respawnAgent, launchAgent } = terminalAgent(kind, args);

			await wiring.restartTerminal(AGENT);

			expect(vi.mocked(terminalSession)).toHaveBeenLastCalledWith(
				expect.anything(),
				expect.objectContaining({ kind }),
				4242,
			);
			expect(respawnAgent).toHaveBeenCalledWith(
				{
					machine: "local",
					agentId: AGENT,
					workspaceId: WORKSPACE,
					root: "/srv/api",
				},
				{ file: `/opt/bin/${kind}`, args: expected, env: { EXAMPLE: "1" } },
				expect.anything(),
			);
			expect(launchAgent).not.toHaveBeenCalled();
		},
	);

	it("is refused, and nothing is killed, when the session cannot be told", async () => {
		vi.mocked(terminalSession).mockRejectedValueOnce(
			new SessionNotResumable("no record of it"),
		);
		const { wiring, respawnAgent } = terminalAgent("codex", []);

		await expect(wiring.restartTerminal(AGENT)).rejects.toBeInstanceOf(
			SessionNotResumable,
		);
		expect(respawnAgent).not.toHaveBeenCalled();
	});
});

/**
 * The shell Claude Code runs in (`runtime/agentShell.ts`): DevHub's bash,
 * asked of the Agent's machine, and what it answers goes into that Agent's
 * environment and nobody else's.
 */
describe("a Claude Agent runs on DevHub's bash", () => {
	it("runs a terminal claude on DevHub's bash, for its own process", async () => {
		const { adapter, launchAgent } = wired(() =>
			Promise.resolve(ON_DELIVERED_BASH),
		);

		const result = await adapter.launch(
			WORKSPACE,
			AGENT,
			profile("claude"),
			"tui",
			"/srv/api",
		);

		expect(result).toEqual({ kind: "started" });
		expect(launchAgent).toHaveBeenCalledWith(
			expect.anything(),
			{
				file: "claude",
				args: ["--model", "opus"],
				env: { ...ON_DELIVERED_BASH, EXAMPLE: "1" },
			},
			expect.anything(),
		);
	});

	// The host's environment is the session's, and survives the CLI being
	// started again (`RESTART_SCRIPT`), so this is the one place it is set.
	it("runs a GUI claude's host on DevHub's bash", async () => {
		const { adapter, launchAgent } = wired(() =>
			Promise.resolve(ON_DELIVERED_BASH),
		);

		await adapter.launch(
			WORKSPACE,
			AGENT,
			profile("claude"),
			"gui",
			"/srv/api",
		);

		expect(launchAgent).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				file: "/bin/sh",
				env: { ...ON_DELIVERED_BASH, EXAMPLE: "1" },
			}),
			expect.anything(),
		);
	});

	// A profile that names its own shell has said which it wants.
	it("leaves a shell the profile states itself alone", async () => {
		const { adapter, launchAgent } = wired(() =>
			Promise.resolve(ON_DELIVERED_BASH),
		);
		const own = AgentProfile.create(
			agentProfileId("claude"),
			"Claude",
			"claude",
			"claude",
			[],
			new Map([["CLAUDE_CODE_SHELL", "/opt/bin/bash"]]),
			"tui",
		);

		await adapter.launch(WORKSPACE, AGENT, own, "tui", "/srv/api");

		expect(launchAgent).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				env: { CLAUDE_CODE_SHELL: "/opt/bin/bash" },
			}),
			expect.anything(),
		);
	});

	// DevHub's sentence, not Claude Code's "No suitable shell found" from
	// inside a session that then ends: nothing is launched at all.
	it("does not start, and says why in DevHub's words, when there is no shell to be had", async () => {
		const refusal =
			"Claude Code needs bash or zsh on nas, and nas has neither (busybox sh is not enough).";
		const { adapter, launchAgent } = wired(() =>
			Promise.reject(new Error(refusal)),
		);

		const result = await adapter.launch(
			WORKSPACE,
			AGENT,
			profile("claude"),
			"tui",
			"/srv/api",
		);

		expect(result).toMatchObject({ kind: "failed" });
		expect(result.kind === "failed" ? result.detail : "").toContain(refusal);
		expect(launchAgent).not.toHaveBeenCalled();
	});

	// Only Claude Code asks for a particular shell.
	it("does not ask about a shell for a Codex Agent", async () => {
		const { adapter, askedForShell } = wired(() =>
			Promise.reject(new Error("not asked")),
		);

		const result = await adapter.launch(
			WORKSPACE,
			AGENT,
			profile("codex"),
			"tui",
			"/srv/api",
		);

		expect(result).toEqual({ kind: "started" });
		expect(askedForShell).not.toHaveBeenCalled();
	});

	it("restarts a terminal claude on DevHub's bash too", async () => {
		vi.mocked(terminalSession).mockResolvedValueOnce("S-now");
		const setup = wired(() => Promise.resolve(ON_DELIVERED_BASH));
		setup.model.addAgent(
			WORKSPACE,
			AGENT,
			AgentProfile.create(
				agentProfileId("claude"),
				"Claude",
				"claude",
				"claude",
				[],
				new Map(),
			),
			"tui",
		);

		await setup.wiring.restartTerminal(AGENT);

		expect(setup.respawnAgent).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ env: ON_DELIVERED_BASH }),
			expect.anything(),
		);
	});
});
