/**
 * The usage-limits readout, fed by the adapters themselves: real captured
 * lines go through the Claude and Codex adapters, and the events they emit go
 * through the listener main registers on the conversation registry.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../agent/conversation/claude/adapter.js";
import { CodexAdapter } from "../agent/conversation/codex/adapter.js";
import type { ProtocolAdapter } from "../agent/conversation/protocolAdapter.js";
import type { UsageLimitsWire } from "../../ipc/contract.js";
import type { ConversationEvent } from "../../model/conversation.js";
import type { AgentId, AgentProfileKind } from "../../model/domain.js";
import { UsageLimits, usageLimitsListener } from "./usageLimits.js";

/** The events an adapter emits for a capture, in order. */
function eventsOf(
	adapter: ProtocolAdapter,
	capture: URL,
): readonly ConversationEvent[] {
	const events: ConversationEvent[] = [];
	for (const text of readFileSync(capture, "utf8").split("\n")) {
		if (text.startsWith("> "))
			events.push(...adapter.sent(text.slice(2)).events);
		else if (text.startsWith("< "))
			events.push(...adapter.received(text.slice(2)).events);
	}
	return events;
}

const CLAUDE_CAPTURE = new URL(
	"../agent/conversation/fixtures/claude-session.capture.ndjson",
	import.meta.url,
);
const CODEX_CAPTURE = new URL(
	"../agent/conversation/codex/fixtures/codex-greeting.capture.ndjson",
	import.meta.url,
);

function readout(kinds: Record<string, AgentProfileKind>) {
	const limits = new UsageLimits();
	const published: UsageLimitsWire[] = [];
	const listen = usageLimitsListener(
		limits,
		(agentId) => kinds[agentId],
		(wire) => published.push(wire),
	);
	const feed = (agentId: string, events: readonly ConversationEvent[]) => {
		for (const event of events) listen(agentId as AgentId, 1, event);
	};
	return { limits, published, feed };
}

describe("the usage-limits readout", () => {
	it("says nothing is known for a CLI no Agent has reported for", () => {
		expect(new UsageLimits().wire()).toEqual({
			clis: [{ cli: "claude" }, { cli: "codex" }],
		});
	});

	it("takes each CLI's limit from what its GUI Agents report", () => {
		const { limits, published, feed } = readout({
			a: "claude",
			b: "codex",
		});
		feed("a", eventsOf(new ClaudeAdapter("replay"), CLAUDE_CAPTURE));
		feed(
			"b",
			eventsOf(
				new CodexAdapter({
					clientVersion: "0.1.0",
					cwd: "/home/testuser/project",
					resumeThreadId: undefined,
				}),
				CODEX_CAPTURE,
			),
		);
		const wire = limits.wire();
		const claude = wire.clis.find((one) => one.cli === "claude");
		const codex = wire.clis.find((one) => one.cli === "codex");
		// The capture's last `rate_limit_event`: 98% of the five-hour window
		// and 80% of the seven-day one, resets in epoch seconds on the wire.
		expect(claude?.windows).toEqual([
			{ window: "5-hour", usedPercent: 98, resetsAt: 1_790_280_600_000 },
			{ window: "7-day", usedPercent: 80, resetsAt: 1_790_517_600_000 },
		]);
		expect(codex?.windows).toEqual([
			{ window: "5-hour", usedPercent: 0, resetsAt: 1_790_313_079_000 },
			{ window: "7-day", usedPercent: 17, resetsAt: 1_790_593_906_000 },
		]);
		// Published when it changed, and only then.
		expect(published.at(-1)).toEqual(wire);
	});

	it("keeps the newer reading whichever Agent's arrives last", () => {
		// Journals replay at startup in no particular order across Agents, so
		// a later window, or more used of the same one, is what makes a
		// reading newer.
		const limits = new UsageLimits();
		const w = (usedPercent: number, resetsAt: number) => ({
			window: "5-hour",
			usedPercent,
			resetsAt,
		});
		expect(limits.observe("claude", w(40, 2_000))).toBe(true);
		expect(limits.observe("claude", w(90, 1_000))).toBe(false);
		expect(limits.observe("claude", w(30, 2_000))).toBe(false);
		expect(limits.observe("claude", w(55, 2_000))).toBe(true);
		expect(limits.observe("claude", w(5, 3_000))).toBe(true);
		// Another window is its own reading, and does not displace this one.
		expect(
			limits.observe("claude", {
				window: "7-day",
				usedPercent: 1,
				resetsAt: 1,
			}),
		).toBe(true);
		expect(limits.wire().clis[0]).toEqual({
			cli: "claude",
			windows: [
				{ window: "5-hour", usedPercent: 5, resetsAt: 3_000 },
				{ window: "7-day", usedPercent: 1, resetsAt: 1 },
			],
		});
	});

	it("refuses a rate limit from an Agent that cannot have a GUI", () => {
		const { feed } = readout({ c: "cursor" });
		expect(() =>
			feed("c", [
				{
					type: "usage",
					usage: {
						inputTokens: undefined,
						outputTokens: undefined,
						cachedInputTokens: undefined,
						contextTokens: undefined,
						contextWindow: undefined,
						costUsd: undefined,
						rateLimits: [{ window: "5-hour", usedPercent: 1, resetsAt: 1 }],
					},
				},
			]),
		).toThrow(/only Claude and Codex have a GUI/u);
	});
});
