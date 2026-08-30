import { describe, expect, it } from "vitest";
import { APP_ERROR_SUMMARY } from "./appShell.js";
import {
	TerminalErrorCode,
	agentFailure,
	agentIpcError,
	terminalError,
} from "./agent.js";

describe("how an agent failure is named", () => {
	it("gives each kind of failure its own code and sentence", () => {
		expect(agentFailure(terminalError(TerminalErrorCode.TimedOut))).toEqual({
			code: "agent_attach_timed_out",
			summary: APP_ERROR_SUMMARY.agent_attach_timed_out,
			detail: "The agent runtime did not answer in time.",
		});
		expect(
			agentFailure(terminalError(TerminalErrorCode.RuntimeUnavailable)).code,
		).toBe("agent_runtime_unavailable");
		expect(
			agentFailure(terminalError(TerminalErrorCode.SessionUnavailable)).code,
		).toBe("agent_exited");
		expect(
			agentFailure(terminalError(TerminalErrorCode.ChannelClosed)).code,
		).toBe("agent_not_connected");
	});

	it("recovers the code from an Electron IPC rejection", () => {
		// This is exactly what the page catches: Electron keeps only the message.
		const thrown = new Error(
			`Error invoking remote method 'devhub:agent-attach': ${
				agentIpcError(terminalError(TerminalErrorCode.RuntimeUnavailable))
					.message
			}`,
		);
		expect(agentFailure(thrown).code).toBe("agent_runtime_unavailable");
	});

	it("reads an error frame's body", () => {
		expect(
			agentFailure({
				code: TerminalErrorCode.SessionUnavailable,
				summary: "whatever the sender wrote",
			}).code,
		).toBe("agent_exited");
	});

	it("never lets a stack reach the surface", () => {
		const bug = new Error("something nobody anticipated");
		bug.stack =
			"Error: something nobody anticipated\n    at Timeout.<anonymous>";
		const failure = agentFailure(bug);
		expect(failure.code).toBe("agent_not_connected");
		expect(failure.summary).toBe(APP_ERROR_SUMMARY.agent_not_connected);
		expect(failure.detail).not.toContain("at Timeout");
		expect(failure.detail).not.toContain("something nobody anticipated");
	});

	it("says nothing about the app shell when the agent is what failed", () => {
		for (const code of Object.values(TerminalErrorCode)) {
			const failure = agentFailure(terminalError(code));
			expect(failure.summary).not.toBe(APP_ERROR_SUMMARY.native_unavailable);
			expect(failure.code.startsWith("agent_")).toBe(true);
		}
	});
});
