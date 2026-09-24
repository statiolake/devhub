import { describe, expect, it } from "vitest";
import { claudeStructuredCommand } from "./argv.js";

describe("the structured command line", () => {
	const profile = {
		file: "claude",
		args: ["--permission-mode", "acceptEdits"],
		env: { EXAMPLE: "1" },
	};

	it("keeps the profile's command, arguments and environment, and follows them with the stream-json flags", () => {
		expect(claudeStructuredCommand(profile)).toEqual({
			file: "claude",
			args: [
				"--permission-mode",
				"acceptEdits",
				"-p",
				"--input-format",
				"stream-json",
				"--output-format",
				"stream-json",
				"--verbose",
				"--include-partial-messages",
				"--forward-subagent-text",
				"--replay-user-messages",
				"--permission-prompt-tool",
				"stdio",
			],
			env: { EXAMPLE: "1" },
		});
	});

	it("never signs in with an API key alone", () => {
		expect(claudeStructuredCommand(profile).args).not.toContain("--bare");
	});
});
