/**
 * The GUI Agents' unsent drafts, kept by main across a restart and for as
 * long as their Agent exists.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	makeScratchDir,
	removeScratchDir,
} from "../../../model/testScratch.js";
import { AgentDrafts } from "./drafts.js";

let directory: string;
let path: string;
let agents: Set<string>;

beforeEach(() => {
	directory = makeScratchDir("drafts");
	path = join(directory, "devhub", "drafts.json");
	agents = new Set(["agent-1", "agent-2"]);
});

afterEach(() => {
	removeScratchDir(directory);
});

/** A DevHub starting: the store read back from the file. */
function started(): AgentDrafts {
	const loaded = AgentDrafts.load(path, () => agents);
	expect(loaded.refused).toBeUndefined();
	return loaded.drafts;
}

describe("keeping drafts", () => {
	it("starts with none when there is no file", () => {
		expect(started().get("agent-1")).toBe("");
		expect(existsSync(path)).toBe(false);
	});

	it("gives back after a restart what it was last told, per Agent", () => {
		const drafts = started();
		drafts.set("agent-1", "fix the");
		drafts.set("agent-1", "fix the build");
		drafts.set("agent-2", "look at\n\nthe tests");
		const again = started();
		expect(again.get("agent-1")).toBe("fix the build");
		expect(again.get("agent-2")).toBe("look at\n\nthe tests");
	});

	it("keeps no draft once it is emptied, as when it is sent", () => {
		const drafts = started();
		drafts.set("agent-1", "fix the build");
		drafts.set("agent-1", "");
		expect(started().get("agent-1")).toBe("");
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			version: 1,
			drafts: {},
		});
	});

	it("drops the draft of an Agent that was closed", () => {
		const drafts = started();
		drafts.set("agent-1", "one");
		drafts.set("agent-2", "two");
		agents.delete("agent-1");
		drafts.prune();
		expect(drafts.get("agent-1")).toBe("");
		const again = started();
		expect(again.get("agent-1")).toBe("");
		expect(again.get("agent-2")).toBe("two");
	});

	it("drops, at load, the draft of an Agent that went away while DevHub was not running", () => {
		started().set("agent-1", "one");
		agents.delete("agent-1");
		expect(started().get("agent-1")).toBe("");
		expect(JSON.parse(readFileSync(path, "utf8")).drafts).toEqual({});
	});

	it("does not keep a report that arrives after its Agent went away", () => {
		const drafts = started();
		agents.delete("agent-1");
		drafts.set("agent-1", "too late");
		expect(drafts.get("agent-1")).toBe("");
		expect(existsSync(path)).toBe(false);
	});

	it("moves a file it cannot read aside, starts empty, and says so", () => {
		started().set("agent-1", "one");
		writeFileSync(path, "{ not json");
		const loaded = AgentDrafts.load(path, () => agents);
		expect(loaded.drafts.get("agent-1")).toBe("");
		expect(loaded.refused).toContain(`${path}.corrupt`);
		expect(readFileSync(`${path}.corrupt`, "utf8")).toBe("{ not json");
		expect(existsSync(path)).toBe(false);
	});

	it("refuses a file whose drafts are not text", () => {
		started().set("agent-1", "one");
		writeFileSync(
			path,
			JSON.stringify({ version: 1, drafts: { "agent-1": 3 } }),
		);
		const loaded = AgentDrafts.load(path, () => agents);
		expect(loaded.refused).toContain("the draft of agent-1 is not text");
	});
});
