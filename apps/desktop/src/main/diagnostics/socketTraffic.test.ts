/**
 * Whether a workbench's sockets are talking, from macOS's nettop and Linux's
 * ss, on fixtures.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseNettop, parseSsTraffic, trafficSince } from "./socketTraffic.js";

const fixture = (name: string) =>
	readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("macOS: nettop", () => {
	it("reads bytes in and out per pid, a name with spaces and dots kept whole", () => {
		const totals = parseNettop(fixture("nettop-darwin.txt"));
		expect(totals.get(121)).toBe(182233 + 90211);
		expect(totals.get(120)).toBe(3072);
		expect(totals.get(122)).toBe(0);
		expect(totals.get(1)).toBe(0);
	});

	it("is traffic only where a total moved between two readings", () => {
		const before = parseNettop(fixture("nettop-darwin.txt"));
		const after = new Map(before);
		after.set(121, (before.get(121) ?? 0) + 10);
		after.set(999, 5);
		expect([...trafficSince(before, after)]).toEqual([121]);
		expect(trafficSince(before, before)).toEqual(new Set());
	});

	it("reads nothing without its header", () => {
		expect(parseNettop("launchd.1,0,0,\n")).toEqual(new Map());
	});
});

describe("Linux: ss -tinp", () => {
	it("reads how long ago each pid's established sockets last talked", () => {
		const quiet = parseSsTraffic(fixture("ss-tinp-linux.txt"));
		expect(quiet.get(1234)).toBe(840);
		expect(quiet.get(1240)).toBe(62000);
		expect(quiet.get(777)).toBe(29999);
		expect(quiet.size).toBe(3);
	});
});
