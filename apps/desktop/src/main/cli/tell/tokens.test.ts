import { describe, expect, it } from "vitest";
import { parseTellArguments } from "./command.js";
import { fixtureReport } from "./tokensTestKit.js";
import { parseSince, tokensJson, tokensText } from "./tokens.js";

const NOW = Date.parse("2026-11-13T10:00:00.000Z");

describe("devhub --tell usage --by", () => {
	it("parses: any token flag asks for tokens, usage alone is still the limits", () => {
		expect(parseTellArguments(["usage"])).toMatchObject({
			command: { verb: "usage" },
		});
		expect(parseTellArguments(["usage", "--by", "task"])).toMatchObject({
			command: {
				verb: "usage-tokens",
				by: "task",
				since: { range: "window5h" },
				cache: "raw",
			},
			json: false,
		});
		expect(
			parseTellArguments([
				"usage",
				"--since",
				"12h",
				"--cache=weighted",
				"--json",
			]),
		).toMatchObject({
			command: {
				verb: "usage-tokens",
				by: "agent",
				since: { agoMs: 12 * 3_600_000 },
				cache: "weighted",
			},
			json: true,
		});
		expect(parseTellArguments(["usage", "--tokens"])).toMatchObject({
			command: { verb: "usage-tokens" },
		});
		for (const bad of [
			["usage", "--by", "person"],
			["usage", "--cache", "half"],
			["usage", "--since", "yesterday"],
			["usage", "--since", "today", "--until", "2026-11-13"],
		])
			expect(parseTellArguments(bad).kind).toBe("invalid");
	});

	it("reads --since", () => {
		expect(parseSince("window")).toEqual({ range: "window5h" });
		expect(parseSince("week")).toEqual({ range: "week" });
		expect(parseSince("7d")).toEqual({ range: "days7" });
		expect(parseSince("3d")).toEqual({ agoMs: 3 * 86_400_000 });
		expect(parseSince("90m")).toEqual({ agoMs: 90 * 60_000 });
		expect(parseSince("2026-11-12")).toEqual({
			at: new Date(2026, 10, 12).getTime(),
		});
		expect(parseSince("soon")).toBe(undefined);
	});

	it("says a table, subagents under their agent, the total last", () => {
		const lines = tokensText(fixtureReport(), "raw", NOW).split("\n");
		expect(lines[0]).toMatch(
			/^Tokens · Last 7 days .* · by agent · without cache weighting$/u,
		);
		expect(lines[1]).toMatch(/input +cache read +cache write +output +total$/u);
		expect(lines[2]).toMatch(
			/^Builder \(Claude · app\) \[Sonnet 5\.5, Opus 5\.5, Haiku 4\.5\]/u,
		);
		expect(lines[3]).toMatch(/^ {2}Survey the parser \(subagent\)/u);
		const total = lines.find((line) => line.startsWith("Total"))!;
		// Every request once: 10K input, 16K read, 11.6K written, 2K output.
		expect(total).toMatch(/39\.6K$/u);
	});

	it("says the weighted view with its cost, and that it is an estimate", () => {
		const text = tokensText(fixtureReport(), "weighted", NOW);
		expect(text).toMatch(/weighted in +output +hit rate +est\. cost/u);
		expect(text).toMatch(/^Total .* \$0\.07$/mu);
		expect(text).toMatch(/a Claude plan is not billed this/u);
		expect(text).toMatch(/12\.5K tokens on models with no pinned price/u);
	});

	it("answers the whole report as JSON", () => {
		const json = tokensJson(fixtureReport("model"), "weighted");
		expect(json).toMatchObject({
			schema: 1,
			cache: "weighted",
			by: "model",
			totals: { requests: 8 },
			prices: { asOf: "2026-11-13" },
		});
		expect(json.rows.map((row) => row.id)).toContain("model:claude-opus-5-5");
	});
});
