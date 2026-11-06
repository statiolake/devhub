import { describe, expect, it } from "vitest";
import {
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

interface Card {
	kind: "Issue" | "PullRequest" | "DraftIssue";
	id: string;
	number: number;
	state?: string;
	assignees?: string[];
	lane?: string | null;
	linked?: { id: string; number: number; state?: string }[];
}

function card(one: Card) {
	return {
		status: one.lane === null ? null : { name: one.lane ?? "Todo" },
		content:
			one.kind === "DraftIssue"
				? { __typename: "DraftIssue" }
				: {
						__typename: one.kind,
						id: one.id,
						number: one.number,
						title: `#${String(one.number)}`,
						url: url(one.number, one.kind === "Issue" ? "issues" : "pull"),
						state: one.state ?? "OPEN",
						isDraft: false,
						repository: REPO,
						assignees: {
							nodes: (one.assignees ?? [ME]).map((login) => ({ login })),
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
					},
	};
}

interface Page {
	cards: Card[];
	next?: string;
}

interface Answer {
	/** One page per Project, in the order of the settings. */
	boards: Page[];
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
			...Object.fromEntries(
				state.boards.map((page, index) => [
					`p${String(index)}`,
					{
						projectV2: {
							title: `Board ${String(index)}`,
							items: {
								pageInfo: {
									hasNextPage: page.next !== undefined,
									endCursor: page.next ?? null,
								},
								nodes: page.cards.map(card),
							},
						},
					},
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
function world(answers: Answer[], projects = ["acme/7"]) {
	const asked: { query: string; variables: Record<string, unknown> }[] = [];
	const pending: (() => void)[] = [];
	const settings = { projects, interval: "90s" };
	const source = new GitHubItemSource({
		settings: () => settings,
		token: () => Promise.resolve({ token: "t" }),
		post: (body) => {
			asked.push(body as (typeof asked)[number]);
			const next = answers.shift();
			if (next === undefined) throw new Error("no more answers");
			return Promise.resolve(answer(next));
		},
		setTimer: (_ms, run) => {
			pending.push(run);
			return { cancel: () => undefined };
		},
		now: () => Date.parse("2026-11-05T00:00:00Z"),
	});
	source.follow(true);
	return {
		asked,
		source,
		pending,
		settings,
		async ticks(count: number) {
			for (let index = 0; index < count; index += 1) await source.tick();
		},
	};
}

describe("the GitHub items", () => {
	it("asks one request: a page of each registered Project, and the details", () => {
		const { query, variables } = githubQuery(
			[{ owner: "acme", number: 7, after: null }],
			["P9"],
		);
		expect(query).toContain("p0: repositoryOwner(login:$o0)");
		expect(query).toContain("projectV2(number:$n0)");
		expect(query).toContain("rateLimit");
		expect(query).not.toContain("search(");
		expect(variables).toMatchObject({
			o0: "acme",
			n0: 7,
			a0: null,
			pulls: ["P9"],
			wantPulls: true,
		});
	});

	it("gives a Project's Issues and pull requests alike, one item on two Projects with a lane on each", async () => {
		const issue: Card = {
			kind: "Issue",
			id: "I1",
			number: 123,
			lane: "In Review",
			linked: [{ id: "P130", number: 130 }],
		};
		const run = world(
			[
				{
					boards: [
						{
							cards: [
								issue,
								{
									kind: "PullRequest",
									id: "P9",
									number: 9,
									assignees: ["bob"],
								},
								{ kind: "DraftIssue", id: "D1", number: 0 },
							],
						},
						{ cards: [{ ...issue, lane: "Doing" }] },
					],
				},
			],
			["acme/7", "other/3"],
		);
		await run.ticks(1);
		const items = run.source.items()!;
		expect(items.map((one) => [one.kind, one.item.number])).toEqual([
			["issue", 123],
			["pr", 9],
		]);
		expect(items[0]?.projects).toEqual([
			{ project: "acme/7", lane: "In Review" },
			{ project: "other/3", lane: "Doing" },
		]);
		expect(items[1]?.assignedToMe).toBe(false);
		expect(run.source.state()).toMatchObject({
			assigned: 1,
			projects: [
				{ ref: "acme/7", title: "Board 0" },
				{ ref: "other/3", title: "Board 1" },
			],
		});
	});

	it("reads the details of the pull requests the items name", async () => {
		const page: Page = {
			cards: [
				{
					kind: "Issue",
					id: "I1",
					number: 123,
					linked: [{ id: "P130", number: 130 }],
				},
				{ kind: "PullRequest", id: "P9", number: 9 },
			],
		};
		const run = world([
			{ boards: [page] },
			{
				boards: [page],
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

	it("knows the population only once every page of every Project is read", async () => {
		const run = world([
			{
				boards: [
					{ cards: [{ kind: "Issue", id: "I1", number: 1 }], next: "c1" },
				],
			},
			{ boards: [{ cards: [{ kind: "Issue", id: "I2", number: 2 }] }] },
		]);
		await run.ticks(1);
		expect(run.source.items()).toBeUndefined();
		expect(run.asked[0]?.variables["a0"]).toBeNull();
		await run.ticks(1);
		expect(run.asked[1]?.variables["a0"]).toBe("c1");
		expect(run.source.items()?.map((one) => one.item.number)).toEqual([1, 2]);
	});

	it("has an empty population, and asks GitHub nothing, with no Project registered", () => {
		const run = world([], []);
		expect(run.source.items()).toEqual([]);
		expect(run.source.state().mode).toBe("idle");
		expect(run.pending).toHaveLength(0);
	});

	it("keeps going with what GitHub answered beside its complaints", () => {
		const reading = parseReading(
			{
				...answer({
					boards: [{ cards: [{ kind: "Issue", id: "I1", number: 1 }] }],
				}),
				errors: [
					{ message: "Could not resolve to a ProjectV2 with the number 8." },
				],
			},
			["acme/7", "acme/8"],
		);
		expect(reading.problems).toEqual([
			"Could not resolve to a ProjectV2 with the number 8.",
		]);
		expect(reading.pages.get("acme/7")?.cards).toHaveLength(1);
		expect(() =>
			parseReading({ errors: [{ message: "Bad credentials" }] }, []),
		).toThrow(/Bad credentials/u);
	});

	it("runs only while there is an orchestrator, and forgets when it stops", async () => {
		const run = world([
			{ boards: [{ cards: [{ kind: "Issue", id: "I1", number: 1 }] }] },
		]);
		expect(run.pending).toHaveLength(1);
		await run.ticks(1);
		expect(run.source.items()).toHaveLength(1);
		run.source.follow(false);
		expect(run.source.items()).toBeUndefined();
		expect(run.source.state().mode).toBe("idle");
	});

	it("asks nothing while suspended, and polls once on resume", async () => {
		const run = world([
			{ boards: [{ cards: [] }] },
			{ boards: [{ cards: [{ kind: "Issue", id: "I1", number: 1 }] }] },
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
