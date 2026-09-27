/**
 * Who a refusal is about, and what it is called.
 *
 * The rule under test is the owner's: a failure is shown at its subject. So
 * what is pinned here is the subject each raising site names and the code each
 * kind of port refusal gets — the two decisions that used to be one answer for
 * everything, and the two that a renderer must never be left to guess at.
 */

import { describe, expect, it } from "vitest";
import { agentId as parseAgentId } from "../../model/domain.js";
import { portFailure } from "../terminal/ports.js";
import { agentSubject, portRefusal, refusalWire } from "./agentFailure.js";
import { SessionNotResumable } from "../agent/conversation/failures.js";
import { agentRefusal, errorWire, errorWireAt } from "../../model/wire.js";

const AGENT = parseAgentId("550e8400-e29b-41d4-a716-4466554400a0");

describe("what a port refusal is called", () => {
	// Four things to do next, so four codes. Reading them as one is what sent
	// people to look at a tmux that was answering perfectly.
	it.each([
		["unavailable", "agent_runtime_unavailable"],
		["incompatible", "agent_runtime_unavailable"],
		["failed", "tmux_command_failed"],
		["timed_out", "tmux_command_timed_out"],
		["conflict", "tmux_session_conflict"],
		["root_missing", "workspace_unavailable"],
		["root_inaccessible", "workspace_unavailable"],
	] as const)("calls a %s port failure %s", (kind, code) => {
		expect(portRefusal(portFailure(kind)).code).toBe(code);
	});

	it("carries the sentence the port was allowed to carry", () => {
		// `PortFailure.detail` may only hold something DevHub composed about its
		// own configuration — never provider output — so passing it through
		// cannot leak a foreign tmux server's inventory.
		const failure = portFailure("unavailable", {
			detail: "tmux was not found on the configured PATH.",
		});
		expect(portRefusal(failure)).toEqual({
			code: "agent_runtime_unavailable",
			detail: "tmux was not found on the configured PATH.",
		});
	});

	it("says nothing it was not told", () => {
		expect(portRefusal(portFailure("failed")).detail).toBeUndefined();
	});

	it("treats anything that is not a port failure as a refused command", () => {
		expect(portRefusal(new Error("boom"))).toEqual({
			code: "tmux_command_failed",
		});
	});
});

describe("a launch that cannot resume the session it was asked to", () => {
	// Not tmux: the profile cannot start this Agent the way it was asked to.
	it("is the profile's refusal, in the words that say which session and where", () => {
		expect(
			portRefusal(new SessionNotResumable("Claude has no session s1 in /w")),
		).toEqual({
			code: "agent_profile_unavailable",
			detail: "Claude has no session s1 in /w",
		});
	});
});

/**
 * The owner's "Continue in GUI" was refused under "The native app shell is
 * unavailable.": a refusal DevHub words itself went through the one
 * conversion as an unknown failure. It is drawn as itself, wherever it ends.
 */
describe("a session DevHub cannot go on with, on the wire", () => {
	it("is its own code and title, with the reason as the detail, not the app shell's catch-all", () => {
		const wire = errorWire(
			new SessionNotResumable(
				"DevHub cannot tell which Claude session this terminal Agent is in",
			),
		);
		expect(wire.code).toBe("conversation_not_resumable");
		expect(wire.summary).toBe("DevHub cannot go on with this session.");
		expect(wire.summary).not.toBe(errorWireAt("native_unavailable").summary);
		expect(wire.detail).toBe(
			"DevHub cannot tell which Claude session this terminal Agent is in",
		);
		expect(wire.module).toBe("agent");
	});
});

describe("who a refusal is about", () => {
	it("is the Agent, when the raising site named one", () => {
		expect(agentSubject(AGENT, { code: "tmux_session_conflict" })).toEqual({
			subject: "agent",
			id: AGENT,
			code: "tmux_session_conflict",
		});
	});

	it("is the app, when the failure is about every Agent there is", () => {
		// A sweep that could not run is the runtime unreachable for everything,
		// which has no single pane to stand in — the one case that is still an
		// app-wide alert.
		expect(agentSubject(undefined, { code: "tmux_command_failed" })).toEqual({
			subject: "app",
			code: "agent_runtime_unavailable",
		});
	});

	it("keeps the detail whichever surface it goes to", () => {
		const refusal = {
			code: "agent_runtime_unavailable",
			detail: "no socket",
		} as const;
		expect(agentSubject(AGENT, refusal)).toMatchObject({ detail: "no socket" });
		expect(agentSubject(undefined, refusal)).toMatchObject({
			detail: "no socket",
		});
	});
});

/**
 * That the name the port chose is the name the person is shown.
 *
 * Live on a host, a New Agent that hit a session conflict arrived as
 * `{"code":"agent_runtime_unavailable","detail":"terminal runtime conflict"}`:
 * `portRefusal` was never consulted on the launch path, and the wire had
 * nothing to turn "the agent port failed" into but the runtime being
 * unavailable. Two hops, and the code has to survive both.
 */
describe("the code a refused launch reaches the wire with", () => {
	it("is the one the port chose, not the port's own name", () => {
		const refusal = portRefusal(portFailure("conflict"));
		expect(refusal.code).toBe("tmux_session_conflict");

		const wire = agentRefusal(
			refusal.code,
			"the session DevHub needs is not the one that is there",
		).wire;
		expect(wire.code).toBe("tmux_session_conflict");
		expect(wire.detail).toBe(
			"the session DevHub needs is not the one that is there",
		);
	});
});

describe("the words a refused operation is answered in", () => {
	// The same words its subject was drawn with, so the request waiting on it
	// — the page, or `devhub` printing it — never reads another sentence.
	it("are the app notice's own for an app-wide refusal", () => {
		expect(
			refusalWire({
				subject: "app",
				code: "workspace_unavailable",
				detail: "/src/api could not be opened as a workspace: not a directory",
			}),
		).toMatchObject({
			code: "workspace_unavailable",
			summary: errorWireAt("workspace_unavailable").summary,
			detail: "/src/api could not be opened as a workspace: not a directory",
		});
	});

	it("name the Agent port's refusal for an Agent or a machine", () => {
		for (const failure of [
			{
				subject: "agent",
				id: AGENT,
				code: "tmux_command_timed_out",
				detail: "tmux did not answer.",
			},
			{
				subject: "machine",
				id: "ssh:build-box.example.com",
				code: "tmux_command_timed_out",
				detail: "tmux did not answer.",
			},
		] as const) {
			expect(refusalWire(failure)).toMatchObject({
				code: "tmux_command_timed_out",
				detail: "tmux did not answer.",
			});
		}
	});
});
