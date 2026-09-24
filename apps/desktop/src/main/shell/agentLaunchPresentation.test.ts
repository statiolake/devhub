/**
 * A GUI Agent, before there is a GUI to start.
 *
 * The conversation host arrives in a later stage. Until it does, a launch that
 * asked for GUI has nothing to start — and the one thing it must not do is
 * start a terminal instead, because the person who asked for the conversation
 * view would be looking at a TUI with no sign that their choice was ignored.
 * So it is refused where it would have started, by name, and tmux is never
 * asked for anything.
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
} from "../../model/domain.js";
import { agents } from "./adapters.js";
import { wireAgents } from "./agentWiring.js";
import type { TmuxTerminalRuntime } from "../terminal/tmux.js";

const WORKSPACE = workspaceId("00000000-0000-4000-8000-0000000000d1");
const AGENT = agentId("550e8400-e29b-41d4-a716-4466554400d0");

function wired() {
	const model = new AppModel(
		new Workspace(
			WORKSPACE,
			workspaceLocation({ kind: "local", path: "/srv/api" }),
			displayPath("/srv/api"),
		),
	);
	const launchAgent = vi.fn(() => Promise.resolve());
	wireAgents({
		runtimeFor: () =>
			Promise.resolve({ launchAgent } as unknown as TmuxTerminalRuntime),
		model: () => model,
		machineOf: () => "local",
	});
	const adapter = agents();
	if (!adapter) throw new Error("the Agent adapter was not registered");
	return { adapter, launchAgent };
}

const claude = AgentProfile.create(
	agentProfileId("claude"),
	"Claude",
	"claude",
	"claude",
	[],
	new Map(),
	"gui",
);

describe("launching a GUI Agent", () => {
	it("is refused by name, and nothing is started in its place", async () => {
		const { adapter, launchAgent } = wired();

		const result = await adapter.launch(
			WORKSPACE,
			AGENT,
			claude,
			"gui",
			"/srv/api",
		);

		expect(result).toEqual({
			kind: "failed",
			code: "agent_profile_unavailable",
			detail:
				"GUI mode is not available yet, so “Claude” was not started. It can open as a terminal instead.",
		});
		expect(launchAgent).not.toHaveBeenCalled();
	});

	it("still starts a terminal from the same profile when that is what was asked", async () => {
		const { adapter, launchAgent } = wired();

		const result = await adapter.launch(
			WORKSPACE,
			AGENT,
			claude,
			"tui",
			"/srv/api",
		);

		expect(result).toEqual({ kind: "started" });
		expect(launchAgent).toHaveBeenCalledTimes(1);
	});
});
