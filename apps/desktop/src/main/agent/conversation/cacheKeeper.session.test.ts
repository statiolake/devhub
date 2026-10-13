/**
 * Auto-compact on a real session: the scrubbed capture played through the
 * Claude adapter, each transcript handed to a `CacheKeeper` as the
 * conversation does, on fake timers set to the capture's own clock.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Transcript } from "../../../model/conversation.js";
import {
	CACHE_KEEP_OFF,
	CacheKeeper,
	type CacheKeepSettings,
} from "./cacheKeeper.js";
import { ClaudeAdapter } from "./claude/adapter.js";
import { REAL_CLOCK } from "./limitResume.js";

const CAPTURE = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"claude-session.capture.ndjson",
);

const ON: CacheKeepSettings = {
	enabled: true,
	leadSeconds: 60,
	minTokens: 20_000,
};

const lines = readFileSync(CAPTURE, "utf8")
	.split("\n")
	.filter((text) => text !== "" && !text.startsWith("#"));

/** The time the CLI stamped on the line, if it stamped one. */
function stamp(line: string): number | undefined {
	const match = /"timestamp":"([^"]+)"/.exec(line);
	return match === null ? undefined : Date.parse(match[1]!);
}

/** The capture played, the clock following its stamps; every transcript observed. */
function play(keeper: CacheKeeper): Transcript {
	const adapter = new ClaudeAdapter("replay");
	for (const text of lines) {
		const line = text.slice(2);
		const at = stamp(line);
		if (at !== undefined && at > Date.now()) vi.setSystemTime(at);
		if (text.startsWith("> ")) adapter.sent(line);
		else adapter.received(line);
		keeper.observe(adapter.transcript);
	}
	return adapter.transcript;
}

describe("auto-compact on the captured session", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	function start(settings: () => CacheKeepSettings) {
		vi.useFakeTimers();
		vi.setSystemTime(stamp(lines.find((l) => stamp(l) !== undefined)!)!);
		const due = vi.fn();
		const keeper = new CacheKeeper(settings, REAL_CLOCK, due);
		return { keeper, due };
	}

	it("reads the 1h TTL off the stream and a context above the minimum", () => {
		const { keeper } = start(() => ON);
		const transcript = play(keeper);
		const cache = transcript.usage?.promptCache;
		expect(cache?.ttlSeconds).toBe(3600);
		expect(cache?.ttlKnown).toBe(true);
		expect(cache?.expiresAt).toBeGreaterThan(Date.now());
		expect(transcript.usage?.contextTokens).toBeGreaterThanOrEqual(20_000);
		expect(transcript.state).toEqual({ phase: "ready", turn: "none" });
	});

	it("fires a minute before the hour runs out, once, and takes it", () => {
		const { keeper, due } = start(() => ON);
		const transcript = play(keeper);
		const expiresAt = transcript.usage!.promptCache!.expiresAt!;
		expect(keeper.dueAt()).toBe(expiresAt - 60_000);
		vi.advanceTimersByTime(expiresAt - 60_001 - Date.now());
		expect(due).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(due).toHaveBeenCalledOnce();
		expect(keeper.take(transcript)).toBe(true);
		vi.advanceTimersByTime(3_600_000);
		expect(due).toHaveBeenCalledOnce();
	});

	it("arms when the setting is turned on while the conversation sits idle", () => {
		let settings = CACHE_KEEP_OFF;
		const { keeper, due } = start(() => settings);
		const transcript = play(keeper);
		expect(keeper.dueAt()).toBeUndefined();
		settings = ON;
		keeper.reconsider();
		const expiresAt = transcript.usage!.promptCache!.expiresAt!;
		expect(keeper.dueAt()).toBe(expiresAt - 60_000);
		vi.advanceTimersByTime(expiresAt - 60_000 - Date.now());
		expect(due).toHaveBeenCalledOnce();
		expect(keeper.take(transcript)).toBe(true);
	});

	it("disarms when the setting is turned off again", () => {
		let settings = ON;
		const { keeper, due } = start(() => settings);
		play(keeper);
		settings = CACHE_KEEP_OFF;
		keeper.reconsider();
		expect(keeper.dueAt()).toBeUndefined();
		vi.advanceTimersByTime(7_200_000);
		expect(due).not.toHaveBeenCalled();
	});
});
