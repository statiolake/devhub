import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { escalationState } from "../../model/escalations.js";
import { EscalationStore } from "./escalationStore.js";

const directory = () => mkdtempSync(join(tmpdir(), "devhub-escalations-"));

describe("EscalationStore", () => {
	it("keeps the thread and the orchestrator across a restart", () => {
		const path = join(directory(), "escalations.json");
		const { store } = EscalationStore.load(path);
		const made = store.create(
			{ title: "決めてほしい", markdown: "A or B?", agents: ["a1"] },
			1,
		);
		store.answer(made.id, "A", 2);
		store.setOrchestrator("orch");
		const again = EscalationStore.load(path).store;
		expect(again.orchestratorAgentId).toBe("orch");
		const kept = again.require(made.id);
		expect(escalationState(kept)).toBe("in_progress");
		expect(kept.entries.map((one) => one.markdown)).toEqual(["A or B?", "A"]);
		// Numbers go on from where they were.
		expect(again.create({ title: "次", markdown: "x" }, 3).id).toBe(
			made.id + 1,
		);
	});

	it("tells its listeners once a change is on disk", () => {
		const path = join(directory(), "escalations.json");
		const { store } = EscalationStore.load(path);
		let told = 0;
		store.onChange(() => {
			told += 1;
			expect(existsSync(path)).toBe(true);
		});
		store.create({ title: "t", markdown: "x" }, 1);
		expect(told).toBe(1);
	});

	it("moves a file it cannot read aside, and starts empty", () => {
		const path = join(directory(), "escalations.json");
		writeFileSync(path, "{ not json");
		const { store, refused } = EscalationStore.load(path);
		expect(store.all()).toEqual([]);
		expect(refused).toMatch(/corrupt/u);
		expect(readFileSync(`${path}.corrupt`, "utf8")).toBe("{ not json");
	});
});
