/**
 * Which shell Claude Code gets on a machine: DevHub's own bash, always.
 */

import { describe, expect, it } from "vitest";
import {
	claudeShellEnvironment,
	deliveredClaudeShell,
	noShellRefusal,
} from "./agentShell.js";

const DELIVERED = "/home/me/.devhub-server/bash/5.3.20/bin/bash";

describe("the shell a Claude Agent runs with", () => {
	// The variable Claude Code reads first — for that process only, which is
	// the caller's business.
	it("is DevHub's bash, as CLAUDE_CODE_SHELL", () => {
		expect(claudeShellEnvironment(DELIVERED)).toEqual({
			CLAUDE_CODE_SHELL: DELIVERED,
		});
		expect(
			deliveredClaudeShell("nas", { kind: "installed", path: DELIVERED }),
		).toEqual({ CLAUDE_CODE_SHELL: DELIVERED });
	});

	it("refuses, naming the machine and the reason, when the delivery failed", () => {
		const reason =
			"DevHub could not get the bash 5.3.20 it installs on nas (linux-armv7l): 404";
		expect(() =>
			deliveredClaudeShell("nas", { kind: "failed", reason }),
		).toThrow(noShellRefusal("nas", reason));
		const message = noShellRefusal("nas", reason);
		expect(message).toContain("Claude Code on nas runs in DevHub's own bash");
		expect(message).toContain("linux-armv7l");
		expect(message).toContain("404");
		expect(message).toContain("does not fall back");
	});
});
