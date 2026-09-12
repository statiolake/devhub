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
import { agentSubject, portRefusal } from "./agentFailure.js";
import { AppError, AppErrorCode } from "../../model/intents.js";
import { errorWire } from "../../model/wire.js";

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

		const error = new AppError(AppErrorCode.PortUnavailable)
			.withPort("agent")
			.withAgentFailure(refusal.code)
			.withDetail("the session DevHub needs is not the one that is there");

		const wire = errorWire(error);
		expect(wire.code).toBe("tmux_session_conflict");
		expect(wire.detail).toBe(
			"the session DevHub needs is not the one that is there",
		);
	});

	// A port failure that never went through `portRefusal` still has to say
	// something, and "the runtime" is the honest answer for one.
	it("falls back to the runtime only when nothing chose a code", () => {
		expect(
			errorWire(new AppError(AppErrorCode.PortUnavailable).withPort("agent"))
				.code,
		).toBe("agent_runtime_unavailable");
	});
});
