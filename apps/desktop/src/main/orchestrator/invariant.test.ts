import { describe, expect, it } from "vitest";
import { eventLine, type OrchestratorEvent } from "./events.js";
import {
	findItem,
	InvariantWatch,
	itemLinkKey,
	readInvariant,
	type InvariantAgent,
	type InvariantTask,
	type ItemFacts,
} from "./invariant.js";

const URL = "https://github.com/acme/app/issues/123";
const PR = "https://github.com/acme/app/pull/9";
const AGENT = "a1b2c3d4-0000";

function issue(
	overrides: Partial<ItemFacts> & { lane?: string } = {},
): ItemFacts {
	const { lane = "In Progress", ...rest } = overrides;
	return {
		item: { repo: "acme/app", number: 123, title: "API整理", url: URL },
		kind: "issue",
		state: "open",
		assignedToMe: true,
		projects: [{ project: "acme/7", lane }],
		...rest,
	};
}

function agent(overrides: Partial<InvariantAgent> = {}): InvariantAgent {
	return {
		id: AGENT,
		name: "API fix",
		ws: "api",
		workspaceId: "w1",
		managed: true,
		status: "working",
		stopping: false,
		...overrides,
	};
}

function task(overrides: Partial<InvariantTask> = {}): InvariantTask {
	return {
		id: 7,
		title: "API整理",
		status: "in_progress",
		links: [URL],
		agents: [AGENT],
		escalations: [],
		...overrides,
	};
}

const clauses = (reading: ReturnType<typeof readInvariant>) =>
	reading.needsAction.map((one) => [one.key, one.breach.clause]);

describe("the invariant, about tasks", () => {
	it("is held by a 処理中 task one of whose agents works, a 回答待ち one, a 待機 one", () => {
		for (const tasks of [
			[task()],
			[task({ status: "answer", escalations: [3] })],
			[task({ status: "waiting" })],
		])
			expect(
				clauses(
					readInvariant({
						items: [issue()],
						agents: [
							agent({
								status: tasks[0]!.status === "in_progress" ? "working" : "idle",
							}),
						],
						tasks,
					}),
				),
			).toEqual([]);
	});

	it("flags a 処理中 task nobody moves: idle with its agents stopped, no_agent with none open", () => {
		expect(
			clauses(
				readInvariant({
					items: [issue()],
					agents: [agent({ status: "idle" })],
					tasks: [task()],
				}),
			),
		).toEqual([["task 7", "idle"]]);
		expect(
			clauses(readInvariant({ items: [issue()], agents: [], tasks: [task()] })),
		).toEqual([["task 7", "no_agent"]]);
		// A stopping agent is not at work.
		expect(
			clauses(
				readInvariant({
					items: [],
					agents: [agent({ stopping: true })],
					tasks: [task({ links: [] })],
				}),
			),
		).toEqual([["task 7", "idle"]]);
	});

	it("asks for a task for a managed agent on none, whatever it does, and leaves the person's agents alone", () => {
		expect(
			clauses(readInvariant({ items: [], agents: [agent()], tasks: [] })),
		).toEqual([[`agent ${AGENT}`, "no_task"]]);
		expect(
			clauses(
				readInvariant({
					items: [],
					agents: [agent({ managed: false })],
					tasks: [],
				}),
			),
		).toEqual([]);
	});

	it("asks for a task for an item of the population no open task links", () => {
		expect(
			clauses(readInvariant({ items: [issue()], agents: [], tasks: [] })),
		).toEqual([[`item ${URL}`, "no_task"]]);
		// Linked by a task (any link spelling of it): settled as the task is.
		expect(
			clauses(
				readInvariant({
					items: [issue()],
					agents: [agent()],
					tasks: [task({ links: [`${URL}#issuecomment-1`] })],
				}),
			),
		).toEqual([]);
		// Outside the population: closed, not mine, on no Project.
		for (const outside of [
			issue({ state: "closed" }),
			issue({ assignedToMe: false }),
			issue({ projects: [] }),
		])
			expect(
				clauses(readInvariant({ items: [outside], agents: [], tasks: [] })),
			).toEqual([]);
		// The person's own: an unmanaged agent started on it.
		expect(
			clauses(
				readInvariant({
					items: [issue()],
					agents: [agent({ managed: false, issue: URL })],
					tasks: [],
				}),
			),
		).toEqual([]);
	});

	it("says no item while the population is not known, and still holds tasks and agents", () => {
		const reading = readInvariant({
			items: undefined,
			agents: [agent({ status: "idle" })],
			tasks: [task()],
		});
		expect(reading.known).toBe(false);
		expect(clauses(reading)).toEqual([["task 7", "idle"]]);
	});

	it("reads each agent's task and its standing", () => {
		const reading = readInvariant({
			items: [issue()],
			agents: [agent({ status: "idle" }), agent({ id: "zz-9", managed: true })],
			tasks: [task()],
		});
		expect(reading.agents.get(AGENT)).toEqual({
			settled: false,
			task: 7,
			taskBreach: { clause: "idle" },
		});
		expect(reading.agents.get("zz-9")).toEqual({
			settled: false,
			breach: { clause: "no_task" },
		});
		expect(reading.tasks.get(7)).toEqual({ clause: "idle" });
		expect(findItem(reading, "acme/app#123")?.tasks).toEqual([7]);
		expect(findItem(reading, URL)?.inPopulation).toBe(true);
	});

	it("names a task's line by its id and title, never its state", () => {
		const reading = readInvariant({
			items: [issue()],
			agents: [agent({ status: "idle" })],
			tasks: [task()],
		});
		const watch = new InvariantWatch({
			dispatch: () => undefined,
			now: () => 0,
		});
		watch.observe(reading, true);
		expect(watch.due().map((event) => eventLine(event, 0))).toEqual([
			"[needs_action] task=7「API整理」 ws=api — idle",
		]);
	});
});

describe("a 待機 task's subjects", () => {
	it("are said as task.changed when they move, not at the first look", () => {
		const said: OrchestratorEvent[] = [];
		const watch = new InvariantWatch({
			dispatch: (event) => said.push(event),
			now: () => 0,
		});
		const waiting = task({ status: "waiting", links: [PR] });
		const pr = (state: "open" | "merged"): ItemFacts => ({
			...issue(),
			kind: "pr",
			state,
			item: { repo: "acme/app", number: 9, url: PR },
		});
		const read = (state: "open" | "merged", status = "idle") =>
			readInvariant({
				items: [pr(state)],
				agents: [agent({ status })],
				tasks: [waiting],
			});
		watch.observe(read("open"), true);
		watch.observe(read("open"), true);
		expect(said).toEqual([]);
		watch.observe(read("merged"), true);
		expect(said).toEqual([
			{ type: "task.changed", taskId: 7, reasons: ["subjects_changed"] },
		]);
		// Its agent going to work moves it too.
		watch.observe(read("merged", "working"), true);
		expect(said).toHaveLength(2);
		// Nothing is said with no orchestrator.
		watch.observe(read("open"), false);
		expect(said).toHaveLength(2);
	});
});

describe("the watch's state print", () => {
	it("changes when the subject's facts move, so saving can tell new from said again", () => {
		const watch = new InvariantWatch({
			dispatch: () => undefined,
			now: () => 5,
		});
		const read = (status: string, checks: "passing" | "failing") =>
			readInvariant({
				items: [
					issue({
						pull: {
							number: 9,
							state: "open",
							review: "none",
							unresolved: 0,
							checks,
						},
					}),
				],
				agents: [agent({ status })],
				tasks: [task()],
			});
		watch.observe(read("idle", "passing"), true);
		const line = watch.due()[0]!;
		const first = watch.print(line);
		watch.observe(read("idle", "passing"), true);
		expect(watch.print(line)).toBe(first);
		watch.observe(read("idle", "failing"), true);
		expect(watch.print(line)).not.toBe(first);
		watch.observe(read("working", "failing"), true);
		expect(watch.print(line)).toBeUndefined();
	});
});

describe("an item link's key", () => {
	it("is the item's URL without what follows its number; other links have none", () => {
		expect(itemLinkKey(`${PR}/files#diff`)).toBe(PR);
		expect(itemLinkKey("https://notion.so/page")).toBeUndefined();
		expect(itemLinkKey("devhub:agent/abcd")).toBeUndefined();
	});
});
