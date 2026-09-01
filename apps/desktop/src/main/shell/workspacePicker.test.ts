/**
 * What the workspace picker's search says about where a candidate came from.
 *
 * The ordering rule lives across two files — main tags each candidate with its
 * source's rank, the sheet sorts by it — and this is main's half: every
 * candidate says which source named it, sources are ranked by their position in
 * `workspace_sources`, and a path two sources both name is offered by both so
 * the sheet can apply one rule about which it belongs to rather than the answer
 * being decided by which source finished first.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspacePickerEvent } from "../../ipc/contract.js";
import type { Config, WorkspaceSource } from "../../model/config.js";
import { defaultConfig } from "../../model/config.js";
import { makeScratchDir, removeScratchDir } from "../../model/testScratch.js";
import { startWorkspacePicker } from "./workspacePicker.js";

let root: string;

beforeEach(() => {
	root = makeScratchDir("picker");
});

afterEach(() => {
	removeScratchDir(root);
});

function configWith(sources: readonly WorkspaceSource[]): Config {
	return { ...defaultConfig(), workspaceSources: [...sources] };
}

function directorySource(id: string, path: string): WorkspaceSource {
	return {
		type: "filesystem",
		id,
		path,
		min_depth: 1,
		max_depth: 1,
		kinds: ["directory"],
		include_hidden: false,
		exclude_names: [],
	};
}

/** Runs one search to completion and returns everything it emitted. */
function run(config: Config, query: string): Promise<WorkspacePickerEvent[]> {
	return new Promise((resolve) => {
		const events: WorkspacePickerEvent[] = [];
		startWorkspacePicker(config, query, "op-1", (event) => {
			events.push(event);
			if (event.kind === "completed") resolve(events);
		});
	});
}

/** Runs one search with the clock held still, and returns everything it emitted. */
function runAt(config: Config, now: Date): Promise<WorkspacePickerEvent[]> {
	return new Promise((resolve) => {
		const events: WorkspacePickerEvent[] = [];
		startWorkspacePicker(
			config,
			"",
			"op-1",
			(event) => {
				events.push(event);
				if (event.kind === "completed") resolve(events);
			},
			() => now,
		);
	});
}

function candidates(events: readonly WorkspacePickerEvent[]) {
	return events.flatMap((event) =>
		event.kind === "candidate"
			? [
					{
						path: event.path,
						sourceId: event.sourceId,
						sourceRank: event.sourceRank,
						missing: event.missing,
					},
				]
			: [],
	);
}

describe("the workspace picker's search", () => {
	it("tags every candidate with the source that named it and its rank", async () => {
		const alpha = join(root, "alpha");
		const beta = join(root, "beta");
		await mkdir(join(alpha, "one"), { recursive: true });
		await mkdir(join(beta, "two"), { recursive: true });

		const events = await run(
			configWith([
				directorySource("alpha", alpha),
				directorySource("beta", beta),
			]),
			"",
		);

		expect(
			candidates(events).toSorted((a, b) => a.path.localeCompare(b.path)),
		).toEqual([
			{
				path: join(alpha, "one"),
				sourceId: "alpha",
				sourceRank: 0,
				missing: false,
			},
			{
				path: join(beta, "two"),
				sourceId: "beta",
				sourceRank: 1,
				missing: false,
			},
		]);
	});

	it("lets both sources offer a path they both name", async () => {
		// Deliberately the same root twice. Suppressing the second offer would
		// attribute the path to whichever source won a race, and the same search
		// would then order its results differently on different runs.
		await mkdir(join(root, "shared"), { recursive: true });

		const events = await run(
			configWith([
				directorySource("first", root),
				directorySource("second", root),
			]),
			"",
		);

		expect(
			candidates(events)
				.map((entry) => entry.sourceRank)
				.toSorted(),
		).toEqual([0, 1]);
	});

	it("does not offer the same path twice from one source", async () => {
		await mkdir(join(root, "once"), { recursive: true });
		const events = await run(configWith([directorySource("only", root)]), "");
		expect(candidates(events)).toHaveLength(1);
	});
});

describe("a date source", () => {
	const dated = (
		path: string,
		create_if_missing: boolean,
	): WorkspaceSource => ({
		type: "date",
		id: "daily",
		path,
		create_if_missing,
	});
	// A day chosen so the expanded path is unmistakable in a failure message.
	const NOW = new Date(2026, 8, 1);

	it("offers the one folder today's date names", async () => {
		const today = join(root, "2026", "0901");
		await mkdir(today, { recursive: true });

		const events = await runAt(
			configWith([dated(join(root, "YYYY", "MMDD"), false)]),
			NOW,
		);
		expect(candidates(events)).toEqual([
			{ path: today, sourceId: "daily", sourceRank: 0, missing: false },
		]);
	});

	it("offers a folder nothing has made yet, and says it is not there", async () => {
		// The case the source exists for: the moment a person wants today's
		// workspace is the moment before anything has made it.
		const today = join(root, "2026", "0901");
		const events = await runAt(
			configWith([dated(join(root, "YYYY", "MMDD"), true)]),
			NOW,
		);
		expect(candidates(events)).toEqual([
			{ path: today, sourceId: "daily", sourceRank: 0, missing: true },
		]);
	});

	it("says nothing about a missing folder it was told not to offer", async () => {
		const events = await runAt(
			configWith([dated(join(root, "YYYY", "MMDD"), false)]),
			NOW,
		);
		expect(candidates(events)).toEqual([]);
	});

	it("runs no program and reports no failure", async () => {
		// The whole point: a default configuration cannot depend on a command
		// being installed, so a date source has nothing that can be missing.
		const events = await runAt(
			configWith([dated(join(root, "YYYY", "MMDD"), true)]),
			NOW,
		);
		expect(events.some((event) => event.kind === "source-error")).toBe(false);
	});
});

describe("the default configuration's sources", () => {
	it("names nothing that has to already exist on the machine", () => {
		// A default has to mean something on a computer that has only just run
		// DevHub. A command source names a program that may not be installed, and
		// a filesystem source below the home directory names a folder that may not
		// be there — either one turns a new installation's first picker into an
		// error.
		for (const source of defaultConfig().workspaceSources) {
			expect(source.type).not.toBe("command");
			if (source.type === "filesystem") expect(source.path).toBe("~");
		}
	});
});
