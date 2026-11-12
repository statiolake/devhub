import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TASKS_FILE, TaskStore } from "./taskStore.js";

function folder(files: Record<string, unknown> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "tasks-"));
	for (const [name, value] of Object.entries(files))
		writeFileSync(
			join(dir, name),
			typeof value === "string" ? value : JSON.stringify(value),
		);
	return dir;
}

describe("the task store on disk", () => {
	it("starts empty with nothing there, and keeps every change", () => {
		const dir = folder();
		const { store, refused, migrated } = TaskStore.load(dir);
		expect([refused, migrated]).toEqual([undefined, undefined]);
		const task = store.createTask({ title: "A" }, 1);
		store.raise({ taskId: task.id, title: "q", markdown: "b" }, 2);
		const again = TaskStore.load(dir).store;
		expect(again.tasks().map((one) => one.title)).toEqual(["A"]);
		expect(again.escalations()).toHaveLength(1);
		expect(again.nextEscalationId).toBe(2);
	});

	it("converts the files from before tasks once, and moves them aside", () => {
		const dir = folder({
			"escalations.json": {
				version: 1,
				next: 2,
				escalations: [
					{
						id: 1,
						title: "移行",
						entries: [{ role: "orchestrator", markdown: "?", at: 1 }],
						agents: [],
						links: [],
						createdAt: 1,
						updatedAt: 1,
					},
				],
			},
			"orchestrator-memos.json": {
				version: 2,
				memos: [{ subject: "esc 1", text: "次", at: 2 }],
			},
			"orchestrator-kept.json": { version: 1, kept: {} },
		});
		const { store, migrated } = TaskStore.load(dir, undefined, 5);
		expect(migrated).toMatch(
			/converted to 1 tasks \(1 open\) and 1 escalations/u,
		);
		expect(store.task(1)).toMatchObject({
			title: "移行",
			memo: { text: "次" },
		});
		expect(readdirSync(dir).toSorted()).toEqual([
			"escalations.json.migrated",
			"orchestrator-kept.json.migrated",
			"orchestrator-memos.json.migrated",
			TASKS_FILE,
		]);
		// Once: loaded again, it is the tasks file.
		expect(TaskStore.load(dir).migrated).toBeUndefined();
	});

	it("moves a file that does not read aside, and says so", () => {
		const dir = folder({ [TASKS_FILE]: "{ not json" });
		const { store, refused } = TaskStore.load(dir);
		expect(refused).toMatch(/could not be read/u);
		expect(store.tasks()).toEqual([]);
		expect(readFileSync(join(dir, `${TASKS_FILE}.corrupt`), "utf8")).toBe(
			"{ not json",
		);
	});

	it("tells its listeners after each change", () => {
		const store = TaskStore.inMemory();
		let told = 0;
		store.onChange(() => (told += 1));
		const task = store.createTask({ title: "A" }, 1);
		store.setStatus(task.id, "in_progress", {}, 2);
		store.complete(task.id, undefined, 3);
		expect(told).toBe(3);
	});
});
