import { describe, expect, it } from "vitest";
import { parseTellArguments } from "./command.js";
import { usageJson, usageText } from "./usage.js";

/** Local wall-clock times, so the expectations hold in any time zone. */
const at = (day: number, hours: number, minutes = 0) =>
	new Date(2026, 10, day, hours, minutes).getTime();

const now = at(5, 14, 5);

describe("devhub --tell usage", () => {
	it("parses, with --json before or after the verb", () => {
		expect(parseTellArguments(["usage"])).toEqual({
			kind: "tell",
			command: { verb: "usage" },
			json: false,
		});
		expect(parseTellArguments(["usage", "--json"])).toMatchObject({
			command: { verb: "usage" },
			json: true,
		});
		expect(parseTellArguments(["--json", "usage"])).toMatchObject({
			json: true,
		});
		expect(parseTellArguments(["usage", "claude"]).kind).toBe("invalid");
	});

	it("says one line per CLI: windows, resets, when read, and why not since", () => {
		const text = usageText(
			{
				clis: [
					{
						cli: "claude",
						reader: {
							readAt: at(5, 14, 2),
							problem: { at: at(5, 14, 4), text: "429 from the endpoint" },
						},
						windows: [
							{ window: "5-hour", usedPercent: 16.4, resetsAt: at(5, 19, 20) },
							{ window: "7-day", usedPercent: 39, resetsAt: at(8, 10, 0) },
						],
					},
					{
						cli: "codex",
						note: "no_plan_limits",
						reader: { readAt: at(5, 14, 1) },
					},
				],
			},
			now,
		);
		expect(text.split("\n")).toEqual([
			"claude: 5-hour 16% resets 19:20, 7-day 39% resets 11-08 10:00 · read 14:02 (3 min ago) · last attempt: 429 from the endpoint",
			"codex: no plan limits · read 14:01 (4 min ago)",
		]);
	});

	it("says a window that has reset, a command not on this Mac, and nothing read", () => {
		expect(
			usageText(
				{
					clis: [
						{
							cli: "claude",
							reader: { readAt: at(5, 12, 5) },
							windows: [
								{ window: "5-hour", usedPercent: 85, resetsAt: at(5, 14, 0) },
							],
						},
						{ cli: "codex", note: "cli_not_found" },
					],
				},
				now,
			).split("\n"),
		).toEqual([
			"claude: 5-hour reset 14:00 (was 85%) · read 12:05 (2 h ago)",
			"codex: not read: its command is not on this Mac",
		]);
		expect(usageText({ clis: [{ cli: "codex" }] }, now)).toBe(
			"codex: not known yet · never read",
		);
	});

	it("answers a stable JSON schema, with nulls for what is not known", () => {
		const json = usageJson(
			{
				clis: [
					{
						cli: "claude",
						reader: { readAt: now - 120_000 },
						windows: [
							{
								window: "5-hour",
								durationMinutes: 300,
								usedPercent: 82,
								resetsAt: at(5, 19, 20),
								seenAt: now - 30_000,
							},
							{ window: "7-day" },
						],
					},
					{
						cli: "codex",
						reader: { problem: { at: now - 1000, text: "failed" } },
					},
				],
			},
			now,
		);
		expect(json).toEqual({
			schema: 1,
			at: new Date(now).toISOString(),
			clis: [
				{
					cli: "claude",
					plan: "limits",
					windows: [
						{
							window: "5-hour",
							durationMinutes: 300,
							usedPercent: 82,
							resetsAt: new Date(at(5, 19, 20)).toISOString(),
							reset: false,
							seenAt: new Date(now - 30_000).toISOString(),
							ageSeconds: 30,
						},
						{
							window: "7-day",
							durationMinutes: null,
							usedPercent: null,
							resetsAt: null,
							reset: false,
							seenAt: null,
							ageSeconds: null,
						},
					],
					lastReadAt: new Date(now - 120_000).toISOString(),
					ageSeconds: 30,
					problem: null,
					note: null,
				},
				{
					cli: "codex",
					plan: null,
					windows: [],
					lastReadAt: null,
					ageSeconds: null,
					problem: { at: new Date(now - 1000).toISOString(), text: "failed" },
					note: null,
				},
			],
		});
	});
});
