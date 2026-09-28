/**
 * Going on after a usage limit, decided from the conversation alone: which
 * stop stands, what is shown, and what is kept for the next DevHub. The
 * conversation's own tests drive it through a CLI's lines
 * (`conversation.test.ts`).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	EMPTY_TRANSCRIPT,
	applyEvents,
	entryId,
	type ConversationEvent,
	type LimitResume,
	type Transcript,
} from "../../../model/conversation.js";
import {
	makeScratchDir,
	removeScratchDir,
} from "../../../model/testScratch.js";
import { AgentRecords } from "./agentRecords.js";
import {
	LIMIT_RESUME_RECORDS,
	LimitResumer,
	RESET_MARGIN_MS,
	type LimitResumeSettings,
} from "./limitResume.js";
import { HandClock, memoryRecords, RESUME_ON } from "./limitResumeTestKit.js";

const NOW = 1_800_000_000_000;

const ready = (turn: "none" | "running"): ConversationEvent => ({
	type: "state",
	state: { phase: "ready", turn },
});

function turnEnd(id: string, resetsAt: number | undefined): ConversationEvent {
	return {
		type: "entry",
		entry: {
			kind: "turn-end",
			id: entryId(id),
			outcome: "failed",
			detail: undefined,
			usage: undefined,
			durationMs: undefined,
			limit: { resetsAt },
		},
	};
}

function limitedTurn(
	id: string,
	resetsAt: number | undefined,
): ConversationEvent[] {
	return [ready("running"), turnEnd(id, resetsAt), ready("none")];
}

/** A resumer watching a conversation that is folded as the test goes. */
function watching(settings: LimitResumeSettings = RESUME_ON) {
	const clock = new HandClock(NOW);
	const records = memoryRecords();
	const shown: (LimitResume | undefined)[] = [];
	let due = 0;
	const resumer = new LimitResumer(
		{
			settings: () => settings,
			record: {
				get: () => records.get("agent"),
				set: (record) => records.set("agent", record),
			},
			clock,
		},
		(resume) => shown.push(resume),
		() => {
			due += 1;
		},
	);
	let transcript: Transcript = EMPTY_TRANSCRIPT;
	let offset = 0;
	const see = (...events: ConversationEvent[]) => {
		transcript = applyEvents(transcript, events);
		offset += 100;
		resumer.observe(transcript, offset);
	};
	return {
		clock,
		records,
		resumer,
		see,
		shown: () => shown.at(-1),
		due: () => due,
	};
}

describe("a stop at a usage limit", () => {
	it("is resumed after its reset, with the margin", () => {
		const { see, shown, records, clock, due, resumer } = watching();
		see(...limitedTurn("t1", NOW + 3_600_000));
		const at = NOW + 3_600_000 + RESET_MARGIN_MS;
		expect(shown()).toEqual({ kind: "scheduled", at });
		expect(records.get("agent")).toEqual({ entry: "t1", since: 100, at });
		clock.advance(at - NOW);
		expect(due()).toBe(1);
		expect(resumer.take()).toBe("続けて");
		expect(shown()).toBeUndefined();
		expect(records.get("agent")?.at).toBeUndefined();
	});

	it("is not resumed when its reset has already passed as it is seen", () => {
		const { see, shown, clock } = watching();
		see(...limitedTurn("t1", NOW - 1));
		expect(shown()).toEqual({
			kind: "unscheduled",
			reason: "the limit had already reset when DevHub read it",
		});
		expect(clock.pending).toBe(0);
	});

	it("learns its reset after it first stood, and is resumed then", () => {
		const { see, shown } = watching();
		see(...limitedTurn("t1", undefined));
		expect(shown()).toMatchObject({ kind: "unscheduled" });
		see(turnEnd("t1", NOW + 60_000));
		expect(shown()).toEqual({
			kind: "scheduled",
			at: NOW + 60_000 + RESET_MARGIN_MS,
		});
	});

	it("is over once the CLI is started again on its session", () => {
		const { see, shown, clock, records } = watching();
		see(...limitedTurn("t1", NOW + 60_000));
		see(
			{ type: "restarted" },
			{
				type: "entry",
				entry: {
					kind: "notice",
					id: entryId("restarted:1"),
					parent: null,
					level: "info",
					text: "Session restarted",
					raw: undefined,
				},
			},
		);
		expect(shown()).toBeUndefined();
		expect(clock.pending).toBe(0);
		expect(records.get("agent")).toMatchObject({ entry: "t1", at: undefined });
	});

	it("is never written when Settings turned it off before it was due", () => {
		let settings: LimitResumeSettings = RESUME_ON;
		const clock = new HandClock(NOW);
		const records = memoryRecords();
		const resumer = new LimitResumer(
			{
				settings: () => settings,
				record: {
					get: () => records.get("agent"),
					set: (record) => records.set("agent", record),
				},
				clock,
			},
			() => undefined,
			() => undefined,
		);
		resumer.observe(
			applyEvents(EMPTY_TRANSCRIPT, limitedTurn("t1", NOW + 60_000)),
			100,
		);
		settings = { ...RESUME_ON, enabled: false };
		clock.advance(60_000 + RESET_MARGIN_MS);
		expect(resumer.take()).toBeUndefined();
		expect(records.get("agent")?.at).toBeUndefined();
	});
});

describe("what DevHub keeps of it", () => {
	let directory: string;
	beforeEach(() => {
		directory = makeScratchDir("limit-resumes");
	});
	afterEach(() => {
		removeScratchDir(directory);
	});

	it("is read back as written, and a record that is not one is refused", () => {
		const path = join(directory, "limit-resumes.json");
		const agents = new Set(["agent-1"]);
		const first = AgentRecords.load(path, LIMIT_RESUME_RECORDS, () => agents);
		first.records.set("agent-1", { entry: "turn:1", since: 42, at: 7 });
		const again = AgentRecords.load(path, LIMIT_RESUME_RECORDS, () => agents);
		expect(again.records.get("agent-1")).toEqual({
			entry: "turn:1",
			since: 42,
			at: 7,
		});

		writeFileSync(
			path,
			JSON.stringify({ version: 1, resumes: { "agent-1": { at: "soon" } } }),
		);
		const refused = AgentRecords.load(path, LIMIT_RESUME_RECORDS, () => agents);
		expect(refused.refused).toContain(
			"the resume of agent-1 is not an entry, an offset and a time",
		);
		expect(refused.records.get("agent-1")).toBeUndefined();
	});
});
