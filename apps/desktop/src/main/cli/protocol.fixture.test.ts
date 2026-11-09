/**
 * The `devhub` command's requests, as the Go command sends them
 * (`cli/testdata/requests.jsonl`, written and checked by `cli/fixture_test.go`),
 * accepted by the app as they are. One statement of the protocol, read by
 * both suites (`docs/devhub-cli.md`).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseControlRequest } from "./protocol.js";
import { tellFromWords } from "./tell/request.js";

const FIXTURE = fileURLToPath(
	new URL("../../../../../cli/testdata/requests.jsonl", import.meta.url),
);
const lines = readFileSync(FIXTURE, "utf8").split("\n").filter(Boolean);

describe("what the devhub command sends", () => {
	it("has every request kind the command uses", () => {
		const kinds = new Set(
			lines.map((line) => (JSON.parse(line) as { kind: string }).kind),
		);
		expect([...kinds].sort()).toEqual(
			[
				"activate",
				"add-agent",
				"metrics",
				"open",
				"ping",
				"tell",
				"version",
				"wait-ended",
			].sort(),
		);
	});

	for (const line of lines) {
		it(`is accepted as sent: ${line.slice(0, 60)}`, () => {
			// Exactly the object sent: nothing dropped, nothing defaulted.
			expect(parseControlRequest(line)).toEqual(JSON.parse(line));
		});
	}

	it("carries --tell's words to a command the app can run", () => {
		for (const line of lines) {
			const request = parseControlRequest(line);
			if (request.kind !== "tell") continue;
			expect(
				tellFromWords(request.argv, request.cwd, request.home, request.stdin)
					.kind,
			).toBe("tell");
		}
	});
});
