/**
 * The quoting contract, written down before anything depends on it.
 *
 * Nothing in DevHub composes a remote command line yet, so none of these cases
 * can fail today — which is exactly why they are worth writing now. The rule
 * they pin down is the one that a remote runtime will be built on, and every
 * one of them is a case somebody has shipped a bug for: a branch named
 * `fix/it's-broken`, a path under `~/My Documents`, a commit message with a
 * `$USER` in it that a shell was delighted to expand.
 */

import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";
import { shellQuote, shellQuoteArgv } from "./quote.js";

/** What `/bin/sh` actually makes of a quoted argv. The only real assertion. */
function shellArgv(line: string): Promise<string[]> {
	return new Promise((resolve, reject) => {
		execFile(
			"/bin/sh",
			["-c", `for word in ${line}; do printf '%s\\0' "$word"; done`],
			(error, stdout) => {
				if (error) {
					reject(error);
					return;
				}
				const parts = stdout.split("\0");
				parts.pop();
				resolve(parts);
			},
		);
	});
}

describe("shellQuote", () => {
	const nasty = [
		["a space", "one two"],
		["a single quote", "it's"],
		["only single quotes", "'''"],
		["a double quote", 'say "hi"'],
		["a dollar", "$HOME and ${PATH}"],
		["a backtick", "`whoami`"],
		["a backslash", "back\\slash"],
		["a newline", "first\nsecond"],
		["a semicolon and an ampersand", "a; rm -rf /& b"],
		["a glob", "*.ts"],
		["a tilde", "~/notes"],
		["a bang", "history!"],
		["the empty string", ""],
		["a non-ASCII byte", "日本語 — ok"],
	] as const;

	for (const [what, value] of nasty) {
		it(`survives ${what}`, async () => {
			expect(await shellArgv(shellQuote(value))).toEqual([value]);
		});
	}

	it("makes the empty string a word rather than nothing", () => {
		// The case a "quote it if it looks dangerous" rule always gets wrong:
		// unquoted, an empty argument disappears from the command line, and
		// `-m ''` becomes `-m` with the next word as the message.
		expect(shellQuote("")).toBe("''");
	});
});

describe("shellQuoteArgv", () => {
	it("keeps every word a word, whatever is in it", async () => {
		const argv = ["git", "commit", "-m", "it's a $test\nand a 'quote'", ""];
		expect(await shellArgv(shellQuoteArgv(argv))).toEqual(argv);
	});

	it("is empty for an empty argv", () => {
		expect(shellQuoteArgv([])).toBe("");
	});
});
