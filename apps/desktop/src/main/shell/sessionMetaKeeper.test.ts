/**
 * An Agent's metadata outlives it under its CLI session: written down as it
 * changes and when it is closed, listed with the session, given back to the
 * Agent that goes on with it, and editable once no Agent runs it.
 */

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeScratchDir, removeScratchDir } from "../../model/testScratch.js";
import type { AgentMeta } from "../../model/agentMeta.js";
import { SessionMetaFile } from "../agent/conversation/sessionMetaFile.js";
import { SessionMetaKeeper, type KeptAgent } from "./sessionMetaKeeper.js";

let directory: string;
let path: string;

beforeEach(() => {
	directory = makeScratchDir("session-meta-keeper");
	path = join(directory, "session-meta.json");
});

afterEach(() => {
	removeScratchDir(directory);
});

function agent(
	id: string,
	meta: AgentMeta = {},
	overrides: Partial<KeptAgent> = {},
): KeptAgent {
	return {
		id,
		profile: { kind: "claude", args: [] },
		presentation: "gui",
		meta,
		displayName: `Claude ${id}`,
		named: false,
		managed: false,
		...overrides,
	};
}

function keeper(sessions: Record<string, string> = {}) {
	let agents: KeptAgent[] = [];
	const restored: [string, AgentMeta][] = [];
	const managed: string[] = [];
	const made = new SessionMetaKeeper(SessionMetaFile.load(path).index, {
		agents: () => agents,
		sessionOf: (agentId) => Promise.resolve(sessions[agentId]),
		restore: (agentId, meta, isManaged) => {
			restored.push([agentId, meta]);
			if (isManaged) managed.push(agentId);
			agents = agents.map((one) =>
				one.id === agentId ? { ...one, meta, managed: isManaged } : one,
			);
		},
	});
	return {
		keeper: made,
		restored,
		managed,
		set: (next: KeptAgent[]) => {
			agents = next;
		},
	};
}

describe("SessionMetaKeeper", () => {
	it("keeps a stopped and then closed agent's metadata with its session", async () => {
		const { keeper: kept, set } = keeper({ a1: "c-1" });
		set([
			agent("a1", { parent: "orch" }, { named: true, displayName: "Fixer" }),
		]);
		kept.sweep();
		await kept.settled();
		expect(kept.known("claude").get("c-1")).toEqual({
			meta: { parent: "orch" },
			liveAgentId: "a1",
		});
		// Stopped: still an Agent, still written down; closed: still there.
		const stopped = agent(
			"a1",
			{ parent: "orch", state: "done" },
			{
				named: true,
				displayName: "Fixer",
			},
		);
		set([stopped]);
		kept.sweep();
		kept.closed(stopped, "c-1");
		set([]);
		kept.sweep();
		expect(kept.known("claude").get("c-1")).toEqual({
			meta: { parent: "orch", state: "done" },
		});
		// And after a restart of DevHub.
		expect(SessionMetaFile.load(path).index.of("claude", "c-1")).toMatchObject({
			meta: { parent: "orch", state: "done" },
			name: "Fixer",
			named: true,
		});
	});

	it("keeps the managed flag with the session, pairs or none, and gives it back", async () => {
		const { keeper: kept, set, managed } = keeper({ a1: "c-1" });
		set([agent("a1", {}, { managed: true })]);
		kept.sweep();
		await kept.settled();
		expect(kept.index.of("claude", "c-1")?.managed).toBe(true);
		expect(kept.known("claude").get("c-1")?.managed).toBe(true);
		set([
			agent(
				"a2",
				{},
				{ profile: { kind: "claude", args: ["--resume", "c-1"] } },
			),
		]);
		kept.sweep();
		expect(managed).toEqual(["a2"]);
		expect(kept.resumedIn(agent("a3"), "c-1")).toEqual({
			meta: {},
			managed: true,
		});
	});

	it("gives the pairs back to an agent started on the session, not to one already there", async () => {
		const { keeper: kept, set, restored } = keeper({ a1: "c-1" });
		set([agent("a1", { parent: "orch" })]);
		kept.sweep();
		await kept.settled();
		kept.closed(agent("a1", { parent: "orch" }), "c-1");
		const resumed = agent(
			"a2",
			{},
			{
				profile: { kind: "claude", args: ["--resume", "c-1"] },
			},
		);
		set([resumed]);
		kept.sweep();
		expect(restored).toEqual([["a2", { parent: "orch" }]]);
		// The restored pairs are what it has now: nothing new is written.
		kept.sweep();
		expect(restored).toHaveLength(1);
		// One the state file had at startup is not given anything.
		const other = keeper();
		other.keeper.seed(["a3"]);
		other.set([
			agent(
				"a3",
				{},
				{ profile: { kind: "claude", args: ["--resume", "c-1"] } },
			),
		]);
		other.keeper.sweep();
		expect(other.restored).toEqual([]);
		// `/resume` inside a GUI agent with no pairs of its own.
		expect(kept.resumedIn(agent("a4"), "c-1")).toEqual({
			meta: { parent: "orch" },
			managed: false,
		});
		expect(kept.resumedIn(agent("a5", { k: "v" }), "c-1")).toBeUndefined();
	});

	it("edits a stopped session's pairs, and refuses one an agent runs", async () => {
		const { keeper: kept, set } = keeper({ live: "c-live" });
		set([agent("live")]);
		await expect(
			kept.set("claude", "c-old", "role", "reviewer", "Old"),
		).resolves.toEqual({
			role: "reviewer",
		});
		expect(kept.index.of("claude", "c-old")).toMatchObject({
			name: "Old",
			named: true,
		});
		await expect(
			kept.set("claude", "c-old", "role", undefined),
		).resolves.toEqual({});
		expect(kept.index.of("claude", "c-old")).toBeUndefined();
		await expect(kept.set("claude", "c-old", "1bad", "x")).rejects.toThrow(
			/not a metadata key/,
		);
		await expect(kept.set("claude", "c-live", "k", "v")).rejects.toThrow(
			/agent live's, running now: use 'agent meta live'/,
		);
		await expect(kept.set("shell", "s", "k", "v")).rejects.toThrow(
			/no metadata/,
		);
	});
});
