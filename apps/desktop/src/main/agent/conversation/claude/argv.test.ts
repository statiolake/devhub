import { describe, expect, it } from "vitest";
import { claudeStructuredCommand } from "./argv.js";
import { FILE_LINK_INSTRUCTIONS } from "../linkInstructions.js";

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
				"--append-system-prompt",
				FILE_LINK_INSTRUCTIONS,
			],
			env: { EXAMPLE: "1" },
		});
	});

	it("never signs in with an API key alone", () => {
		expect(claudeStructuredCommand(profile).args).not.toContain("--bare");
	});

	it("tells the Agent how to link files, after what the profile itself appends", () => {
		const appended = (args: readonly string[]) =>
			claudeStructuredCommand({ ...profile, args }).args;
		for (const args of [
			["--append-system-prompt", "Be terse.", "--model", "opus"],
			["--append-system-prompt=Be terse.", "--model", "opus"],
			[
				"--append-system-prompt",
				"Ignored",
				"--append-system-prompt=Be terse.",
				"--model",
				"opus",
			],
		]) {
			const out = appended(args);
			expect(
				out.filter((arg) => arg.startsWith("--append-system-prompt")),
			).toEqual(["--append-system-prompt"]);
			expect(out.slice(0, 2)).toEqual(["--model", "opus"]);
			expect(out.at(-1)).toBe(`Be terse.\n\n${FILE_LINK_INSTRUCTIONS}`);
		}
	});

	it("leaves the profile's --append-system-prompt-file alone: Claude adds it to either", () => {
		const out = claudeStructuredCommand({
			...profile,
			args: ["--append-system-prompt-file", "/notes.md"],
		}).args;
		expect(out.slice(0, 2)).toEqual([
			"--append-system-prompt-file",
			"/notes.md",
		]);
		expect(out.at(-1)).toBe(FILE_LINK_INSTRUCTIONS);
	});
});
