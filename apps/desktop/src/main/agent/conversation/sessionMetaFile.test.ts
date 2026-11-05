/** `session-meta.json`: written whole, read back at startup, moved aside when it does not read. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	makeScratchDir,
	removeScratchDir,
} from "../../../model/testScratch.js";
import { SessionMetaFile } from "./sessionMetaFile.js";

let directory: string;
let path: string;

beforeEach(() => {
	directory = makeScratchDir("session-meta");
	path = join(directory, "devhub", "session-meta.json");
});

afterEach(() => {
	removeScratchDir(directory);
});

describe("session-meta.json", () => {
	it("round-trips through a restart, and writes only on a change", () => {
		const { index, refused } = SessionMetaFile.load(path, () => 100);
		expect(refused).toBeUndefined();
		expect(index.records).toEqual([]);
		expect(existsSync(path)).toBe(false);
		expect(
			index.remember(
				"claude",
				"c-1",
				{ parent: "orch" },
				{
					name: "Fixer",
					named: true,
				},
			),
		).toBe(true);
		expect(
			index.remember(
				"claude",
				"c-1",
				{ parent: "orch" },
				{
					name: "Fixer",
					named: true,
				},
			),
		).toBe(false);
		expect(existsSync(`${path}.tmp`)).toBe(false);
		const again = SessionMetaFile.load(path, () => 200).index;
		expect(again.of("claude", "c-1")).toEqual({
			kind: "claude",
			session: "c-1",
			meta: { parent: "orch" },
			name: "Fixer",
			named: true,
			at: 100,
		});
		expect(again.of("codex", "c-1")).toBeUndefined();
		again.remember("claude", "c-1", {});
		expect(SessionMetaFile.load(path).index.records).toEqual([]);
	});

	it("moves a file that does not read aside and starts empty", () => {
		SessionMetaFile.load(path).index.remember("claude", "c-1", { k: "v" });
		writeFileSync(path, "{ not json");
		const { index, refused } = SessionMetaFile.load(path);
		expect(index.records).toEqual([]);
		expect(refused).toContain("moved to");
		expect(readFileSync(`${path}.corrupt`, "utf8")).toBe("{ not json");
	});
});
