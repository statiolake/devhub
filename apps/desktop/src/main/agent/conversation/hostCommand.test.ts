import { describe, expect, it } from "vitest";
import type { DirEntry, FileKind, Runtime } from "../../runtime/runtime.js";
import { agentHostFiles, agentStateDirectory } from "./hostCommand.js";

const TAG = "0123456789ab";
const AGENT = "550e8400-e29b-41d4-a716-4466554400d0";

/** A machine with a home and one directory listing, and the removals asked of it. */
function machine(entries: readonly DirEntry[] | "absent") {
	const removed: string[] = [];
	const runtime = {
		home: () => Promise.resolve("/home/testuser"),
		stat: (): Promise<FileKind> =>
			Promise.resolve(entries === "absent" ? "absent" : "directory"),
		readdir: () => Promise.resolve(entries === "absent" ? [] : entries),
		removeTree: (path: string) => {
			removed.push(path);
			return Promise.resolve();
		},
	} as unknown as Runtime;
	return { runtime, removed };
}

describe("a GUI Agent's host directory", () => {
	it("is under this profile's own directory, so another profile's sweep never sees it", () => {
		expect(agentStateDirectory("/home/testuser", TAG, AGENT)).toBe(
			`/home/testuser/.devhub/agents-${TAG}/${AGENT}`,
		);
		expect(
			agentStateDirectory("/home/testuser", "fedcba987654", AGENT),
		).not.toBe(agentStateDirectory("/home/testuser", TAG, AGENT));
	});

	it("refuses an id or a tag that could name a path elsewhere", () => {
		expect(() => agentStateDirectory("/home/testuser", TAG, "../x")).toThrow(
			/Agent id/,
		);
		expect(() => agentStateDirectory("/home/testuser", "../x", AGENT)).toThrow(
			/profile tag/,
		);
	});
});

describe("the host directories on a machine", () => {
	it("are the ones named like an Agent DevHub made, and nothing else found there", async () => {
		const { runtime } = machine([
			{ name: AGENT, directory: true },
			{ name: "not-an-agent", directory: true },
			{ name: "550E8400-E29B-41D4-A716-4466554400D1", directory: true },
			{ name: "550e8400-e29b-41d4-a716-4466554400d2", directory: false },
		]);
		expect(await (await agentHostFiles(runtime, TAG)).list()).toEqual([AGENT]);
	});

	it("are none when this profile has never made one there", async () => {
		const { runtime } = machine("absent");
		expect(await (await agentHostFiles(runtime, TAG)).list()).toEqual([]);
	});

	it("are removed one by one, at the path they were made at", async () => {
		const { runtime, removed } = machine([]);
		await (await agentHostFiles(runtime, TAG)).remove(AGENT);
		expect(removed).toEqual([`/home/testuser/.devhub/agents-${TAG}/${AGENT}`]);
	});
});
