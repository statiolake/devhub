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
import { HOST_NAME, HOST_SCRIPT } from "../agent/conversation/hostScript.js";
import type { Runtime } from "../runtime/runtime.js";
import type { TmuxTerminalRuntime } from "../terminal/tmux.js";
import { agents } from "./adapters.js";
import { wireAgents } from "./agentWiring.js";

const WORKSPACE = workspaceId("00000000-0000-4000-8000-0000000000d1");
const AGENT = agentId("550e8400-e29b-41d4-a716-4466554400d0");
const HOME = "/home/testuser";

function wired() {
	const model = new AppModel(
		new Workspace(
			WORKSPACE,
			workspaceLocation({ kind: "local", path: "/srv/api" }),
			displayPath("/srv/api"),
		),
	);
	const launchAgent = vi.fn(() => Promise.resolve());
	const makeDirectory = vi.fn(() => Promise.resolve());
	wireAgents({
		runtimeFor: () =>
			Promise.resolve({ launchAgent } as unknown as TmuxTerminalRuntime),
		model: () => model,
		machineOf: () => "local",
		machineRuntime: () =>
			({
				home: () => Promise.resolve(HOME),
				makeDirectory,
				where: "",
			}) as unknown as Runtime,
		report: () => {
			throw new Error("nothing ended in these tests");
		},
		clientVersion: "0.0.0-test",
		profileTag: "0123456789ab",
	});
	const adapter = agents();
	if (!adapter) throw new Error("the Agent adapter was not registered");
	return { adapter, launchAgent, makeDirectory };
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
	it("runs the profile's own command, with no host and no directory", async () => {
		const { adapter, launchAgent, makeDirectory } = wired();

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
			{ file: "claude", args: ["--model", "opus"], env: { EXAMPLE: "1" } },
			expect.anything(),
		);
		expect(makeDirectory).not.toHaveBeenCalled();
	});
});
