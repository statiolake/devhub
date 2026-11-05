import { describe, expect, it } from "vitest";
import {
	ASSIGNED_QUERY,
	GitHubItemSource,
	githubQuery,
	MAX_BACKOFF_MS,
	nextDelay,
	parseReading,
} from "./githubItems.js";

// --- fixtures: GitHub's answers, as JSON ---------------------------------------

const ME = "me";
const REPO = { nameWithOwner: "acme/app" };

function url(number: number, kind: "issues" | "pull") {
	return `https://github.com/acme/app/${kind}/${String(number)}`;
}

interface Node {
	kind: "Issue" | "PullRequest";
	id: string;
	number: number;
	state?: string;
	assignees?: string[];
	lanes?: [string, number, string | null][];
	linked?: { id: string; number: number; state?: string }[];
}

function node(one: Node) {
	return {
		__typename: one.kind,
		id: one.id,
		number: one.number,
		title: `#${String(one.number)}`,
		url: url(one.number, one.kind === "Issue" ? "issues" : "pull"),
		state: one.state ?? "OPEN",
		isDraft: false,
		repository: REPO,
		assignees: { nodes: (one.assignees ?? [ME]).map((login) => ({ login })) },
		projectItems: {
			nodes: (one.lanes ?? []).map(([owner, number, lane]) => ({
				project: { number, title: `Board ${owner}`, owner: { login: owner } },
				status: lane === null ? null : { name: lane },
			})),
		},
		...(one.kind === "Issue"
			? {
					closedByPullRequestsReferences: {
						nodes: (one.linked ?? []).map((pull) => ({
							id: pull.id,
							number: pull.number,
							title: `PR ${String(pull.number)}`,
							url: url(pull.number, "pull"),
							state: pull.state ?? "OPEN",
							isDraft: false,
							repository: REPO,
						})),
					},
				}
			: {}),
	};
}

interface Answer {
	assigned: Node[];
	next?: string;
	looked?: (Node | null)[];
	pulls?: {
		id: string;
		decision?: string;
		unresolved?: number;
		checks?: string;
	}[];
	remaining?: number;
}

function answer(state: Answer) {
	return {
		data: {
			viewer: { login: ME },
			rateLimit: {
				cost: 2,
				remaining: state.remaining ?? 4900,
				limit: 5000,
				resetAt: "2026-11-05T01:00:00Z",
			},
			assigned: {
				pageInfo: {
					hasNextPage: state.next !== undefined,
					endCursor: state.next ?? null,
				},
				nodes: state.assigned.map(node),
			},
			...Object.fromEntries(
				(state.looked ?? []).map((one, index) => [
					`l${String(index)}`,
					one === null ? null : node(one),
				]),
			),
			pulls: (state.pulls ?? []).map((one) => ({
				id: one.id,
				state: "OPEN",
				isDraft: false,
				reviewDecision: one.decision ?? null,
				reviewThreads: {
					nodes: [
						...Array.from({ length: one.unresolved ?? 0 }, () => ({
							isResolved: false,
						})),
						{ isResolved: true },
					],
				},
				commits: {
					nodes: [
						{
							commit: {
								statusCheckRollup:
									one.checks === undefined ? null : { state: one.checks },
							},
						},
					],
				},
			})),
		},
	};
}

/** A source answering from `answers`, one per tick, and what it asked. */
function world(answers: Answer[], linked: string[] = []) {
	const asked: { query: string; variables: Record<string, unknown> }[] = [];
	const pending: (() => void)[] = [];
	let polled = 0;
	const source = new GitHubItemSource({
		settings: () => ({ projects: ["acme/7"], interval: "90s" }),
		token: () => Promise.resolve({ token: "t" }),
		post: (body) => {
			asked.push(body as (typeof asked)[number]);
			const next = answers.shift();
			if (next === undefined) throw new Error("no more answers");
			return Promise.resolve(answer(next));
		},
		linked: () => linked,
		setTimer: (_ms, run) => {
			pending.push(run);
			return { cancel: () => undefined };
		},
		polled: () => {
			polled += 1;
		},
		now: () => Date.parse("2026-11-05T00:00:00Z"),
	});
	source.follow(true);
	return {
		asked,
		source,
		pending,
		polled: () => polled,
		async ticks(count: number) {
			for (let index = 0; index < count; index += 1) await source.tick();
		},
	};
}

describe("the GitHub items", () => {
	it("asks one request: the items assigned to me, the linked lookups, the details", () => {
		const { query, variables } = githubQuery(null, [url(5, "issues")], ["P9"]);
		expect(query).toContain(JSON.stringify(ASSIGNED_QUERY));
		expect(query).toContain("l0: resource(url:$u0)");
		expect(query).toContain("rateLimit");
		expect(variables).toMatchObject({
			u0: url(5, "issues"),
			pulls: ["P9"],
			wantPulls: true,
		});
	});

	it("gives Issues and pull requests alike, lanes from the watched Projects only", async () => {
		const run = world([
			{
				assigned: [
					{
						kind: "Issue",
						id: "I1",
						number: 123,
						lanes: [
							["acme", 7, "In Review"],
							["other", 3, "Doing"],
						],
						linked: [{ id: "P130", number: 130 }],
					},
					{ kind: "PullRequest", id: "P9", number: 9 },
				],
			},
		]);
		await run.ticks(1);
		expect(
			run.source.items()?.map((one) => [one.kind, one.item.number]),
		).toEqual([
			["issue", 123],
			["pr", 9],
		]);
		expect(run.source.items()?.[0]?.projects).toEqual([
			{ project: "acme/7", lane: "In Review" },
		]);
	});

	it("reads the details of the pull requests the items name", async () => {
		const assigned: Node[] = [
			{
				kind: "Issue",
				id: "I1",
				number: 123,
				linked: [{ id: "P130", number: 130 }],
			},
			{ kind: "PullRequest", id: "P9", number: 9 },
		];
		const run = world([
			{ assigned },
			{
				assigned,
				pulls: [
					{ id: "P130", decision: "CHANGES_REQUESTED", unresolved: 2 },
					{ id: "P9", decision: "APPROVED", checks: "SUCCESS" },
				],
			},
		]);
		await run.ticks(2);
		// The second tick reads the details the first named.
		expect(run.asked[1]?.variables["pulls"]).toEqual(["P130", "P9"]);
		const items = run.source.items()!;
		expect(items[0]?.pull).toMatchObject({
			number: 130,
			review: "changes_requested",
			unresolved: 2,
			checks: "none",
		});
		expect(items[1]?.pull).toMatchObject({
			number: 9,
			review: "approved",
			checks: "passing",
		});
	});

	it("knows the population only once every page is read", async () => {
		const run = world([
			{ assigned: [{ kind: "Issue", id: "I1", number: 1 }], next: "c1" },
			{ assigned: [{ kind: "Issue", id: "I2", number: 2 }] },
		]);
		await run.ticks(1);
		expect(run.source.items()).toBeUndefined();
		expect(run.asked[0]?.variables["after"]).toBeNull();
		await run.ticks(1);
		expect(run.asked[1]?.variables["after"]).toBe("c1");
		expect(run.source.items()?.map((one) => one.item.number)).toEqual([1, 2]);
		expect(run.source.state().assigned).toBe(2);
	});

	it("looks up a linked item outside the population, and says which have none", async () => {
		const closed = url(5, "issues");
		const gone = url(6, "issues");
		const run = world(
			[
				{ assigned: [] },
				{
					assigned: [],
					looked: [
						{
							kind: "Issue",
							id: "I5",
							number: 5,
							state: "CLOSED",
							assignees: ["bob"],
						},
						null,
					],
				},
			],
			[closed, gone],
		);
		await run.ticks(2);
		expect(run.asked[1]?.variables).toMatchObject({ u0: closed, u1: gone });
		expect(run.source.items()).toEqual([
			expect.objectContaining({ state: "closed", assignedToMe: false }),
		]);
		expect(run.source.missing(gone)).toBe(true);
		expect(run.source.missing(closed)).toBe(false);
		expect(run.polled()).toBe(2);
	});

	it("keeps going with what GitHub answered beside its complaints", () => {
		const reading = parseReading(
			{
				...answer({ assigned: [{ kind: "Issue", id: "I1", number: 1 }] }),
				errors: [{ message: "Could not resolve to a node" }],
			},
			[],
		);
		expect(reading.problems).toEqual(["Could not resolve to a node"]);
		expect(reading.assigned).toHaveLength(1);
		expect(() =>
			parseReading({ errors: [{ message: "Bad credentials" }] }, []),
		).toThrow(/Bad credentials/u);
	});

	it("runs only while there is an orchestrator, and forgets when it stops", async () => {
		const run = world([{ assigned: [{ kind: "Issue", id: "I1", number: 1 }] }]);
		expect(run.pending).toHaveLength(1);
		await run.ticks(1);
		expect(run.source.items()).toHaveLength(1);
		run.source.follow(false);
		expect(run.source.items()).toBeUndefined();
		expect(run.source.state().mode).toBe("idle");
	});

	it("asks nothing while suspended, and polls once on resume", async () => {
		const run = world([
			{ assigned: [] },
			{ assigned: [{ kind: "Issue", id: "I1", number: 1 }] },
		]);
		await run.ticks(1);
		run.source.follow(true, true);
		await run.ticks(1);
		expect(run.asked).toHaveLength(1);
		expect(run.source.items()).toEqual([]);
		run.source.follow(true, false);
		await run.source.caughtUp();
		expect(run.asked).toHaveLength(2);
		expect(run.source.items()).toHaveLength(1);
	});
});

describe("the GitHub interval", () => {
	const now = Date.parse("2026-11-05T00:00:00Z");
	const rate = (remaining: number) => ({
		cost: 2,
		remaining,
		limit: 5000,
		resetAt: now + 600_000,
	});

	it("starts from the base and only backs off", () => {
		expect(nextDelay(90_000, undefined, now).ms).toBe(90_000);
		expect(nextDelay(90_000, rate(4900), now).ms).toBe(90_000);
		expect(nextDelay(90_000, rate(1000), now).ms).toBe(180_000);
	});

	it("pauses until the reset when little is left", () => {
		expect(nextDelay(90_000, rate(50), now).ms).toBe(605_000);
	});

	it("doubles after each failure, up to a ceiling", () => {
		expect(nextDelay(90_000, undefined, now, 1).ms).toBe(180_000);
		expect(nextDelay(90_000, undefined, now, 9).ms).toBe(MAX_BACKOFF_MS);
	});
});
