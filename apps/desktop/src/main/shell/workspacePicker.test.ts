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

function candidates(events: readonly WorkspacePickerEvent[]) {
	return events.flatMap((event) =>
		event.kind === "candidate"
			? [
					{
						path: event.path,
						sourceId: event.sourceId,
						sourceRank: event.sourceRank,
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
			{ path: join(alpha, "one"), sourceId: "alpha", sourceRank: 0 },
			{ path: join(beta, "two"), sourceId: "beta", sourceRank: 1 },
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
