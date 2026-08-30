/** Ported from the `mod.rs` test module of the Tauri agent adapter. */

import { describe, expect, it } from "vitest";
import {
	HERDR_PROTOCOL_VERSION,
	HERDR_SESSION_NAME,
	HERDR_VERSION,
	expectedProtocol,
	expectedVersion,
	requiredCapabilities,
} from "./contract.js";
import { AgentRuntimeErrorCode, agentError } from "./error.js";

describe("the pinned Herdr contract", () => {
	it("is pinned to one session, version and protocol", () => {
		expect(HERDR_SESSION_NAME).toBe("devhub-session");
		// The Rust adapter pinned 0.8.1; this port targets the 0.8.2 release
		// installed on the build machine. The protocol is unchanged at 20.
		expect(HERDR_VERSION).toBe("0.8.2");
		expect(HERDR_PROTOCOL_VERSION).toBe(20);
		expect(expectedVersion()).toBe("0.8.2");
		expect(expectedProtocol()).toBe(20);
	});

	it("keeps required capabilities stable and content-free", () => {
		const capabilities = requiredCapabilities();
		for (const capability of [
			"session.snapshot",
			"events.subscribe",
			"workspace.create",
			"tab.create",
			"pane.create",
			"pane.close",
			"agent.start:codex",
			"agent.start:claude",
			"terminal.control",
		]) {
			expect(capabilities).toContain(capability);
		}
		expect(capabilities.every((value) => !value.includes("/"))).toBe(true);
	});

	it("never renders provider or user content in an error", () => {
		const error = agentError(AgentRuntimeErrorCode.ProtocolMismatch);
		expect(error.code).toBe(AgentRuntimeErrorCode.ProtocolMismatch);
		expect(`${error.stack}${error.message}`).not.toContain("herdr");
		expect(`${error}`).not.toContain("/Users");
	});
});
