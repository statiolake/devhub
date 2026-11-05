import { describe, expect, it } from "vitest";
import type { OrchestratorEvent } from "./events.js";
import {
	GitHubEventSource,
	githubQuery,
	MAX_BACKOFF_MS,
	nextDelay,
	parseReading,
} from "./githubEvents.js";

// --- fixtures: GitHub's answers, as JSON ---------------------------------------

const ME = "me";
const REPO = { nameWithOwner: "acme/app" };

interface IssueCard {
	item: string;
	id: string;
	number: number;
	title?: string;
	status?: string | null;
	assignees?: string[];
	author?: string;
	state?: string;
	linked?: PullRef[];
}

interface PullRef {
	id: string;
	number: number;
	title?: string;
	state?: string;
	isDraft?: boolean;
	author?: string;
}

function url(number: number, kind: "issues" | "pull") {
	return `https://github.com/acme/app/${kind}/${String(number)}`;
}

function issueCard(card: IssueCard) {
	return {
		id: card.item,
		status: card.status === null ? null : { name: card.status ?? "Todo" },
		content: {
			__typename: "Issue",
			id: card.id,
			number: card.number,
			title: card.title ?? `Issue ${String(card.number)}`,
			url: url(card.number, "issues"),
			state: card.state ?? "OPEN",
			repository: REPO,
			author: { login: card.author ?? "lead" },
			assignees: { nodes: (card.assignees ?? []).map((login) => ({ login })) },
			closedByPullRequestsReferences: {
				nodes: (card.linked ?? []).map((pull) => ({
					id: pull.id,
					number: pull.number,
					title: pull.title ?? `PR ${String(pull.number)}`,
					url: url(pull.number, "pull"),
					state: pull.state ?? "OPEN",
					isDraft: pull.isDraft ?? false,
					author: { login: pull.author ?? ME },
					repository: REPO,
				})),
			},
		},
	};
}

interface Review {
	author: string;
	state: string;
	at: string;
}

interface Details {
	id: string;
	number: number;
	state?: string;
	isDraft?: boolean;
	author?: string;
	reviewDecision?: string | null;
	latest?: Review[];
	reviews?: Review[];
	reviewCount?: number;
	threads?: boolean[];
	comments?: { author: string; at: string }[];
	commentCount?: number;
	oid?: string;
	checks?: string | null;
	failing?: number;
	total?: number;
}

function details(pull: Details) {
	const reviews = pull.reviews ?? [];
	const comments = pull.comments ?? [];
	const threads = pull.threads ?? [];
	return {
		id: pull.id,
		number: pull.number,
		title: `PR ${String(pull.number)}`,
		url: url(pull.number, "pull"),
		state: pull.state ?? "OPEN",
		isDraft: pull.isDraft ?? false,
		reviewDecision: pull.reviewDecision ?? null,
		repository: REPO,
		author: { login: pull.author ?? ME },
		latestReviews: {
			nodes: (pull.latest ?? []).map((one) => ({
				author: { login: one.author },
				state: one.state,
				submittedAt: one.at,
			})),
		},
		reviews: {
			totalCount: pull.reviewCount ?? reviews.length,
			nodes: reviews.map((one) => ({
				author: { login: one.author },
				state: one.state,
				submittedAt: one.at,
			})),
		},
		reviewThreads: {
			totalCount: threads.length,
			nodes: threads.map((resolved) => ({ isResolved: resolved })),
		},
		comments: {
			totalCount: pull.commentCount ?? comments.length,
			nodes: comments.map((one) => ({
				author: { login: one.author },
				createdAt: one.at,
			})),
		},
		commits: {
			nodes: [
				{
					commit: {
						oid: pull.oid ?? "c1",
						statusCheckRollup:
							pull.checks === null || pull.checks === undefined
								? null
								: {
										state: pull.checks,
										contexts: {
											totalCount: pull.total ?? 3,
											checkRunCountsByState: [
												{ state: "FAILURE", count: pull.failing ?? 0 },
											],
											statusContextCountsByState: [],
										},
									},
					},
				},
			],
		},
	};
}

interface Answer {
	cards: ReturnType<typeof issueCard>[];
	next?: string;
	requested?: { id: string; number: number; author: string }[];
	pulls?: Details[];
	remaining?: number;
	resetAt?: string;
}

function answer(state: Answer) {
	return {
		data: {
			viewer: { login: ME },
			rateLimit: {
				cost: 3,
				remaining: state.remaining ?? 4900,
				limit: 5000,
				resetAt: state.resetAt ?? "2026-11-05T01:00:00Z",
			},
			p0: {
				projectV2: {
					title: "Team",
					items: {
						pageInfo: {
							hasNextPage: state.next !== undefined,
							endCursor: state.next ?? null,
						},
						nodes: state.cards,
					},
				},
			},
			requested: {
				nodes: (state.requested ?? []).map((one) => ({
					id: one.id,
					number: one.number,
					title: `PR ${String(one.number)}`,
					url: url(one.number, "pull"),
					author: { login: one.author },
					repository: REPO,
				})),
			},
			pulls: (state.pulls ?? []).map(details),
		},
	};
}

/** A source answering from `answers`, one per tick, and what it asked. */
function world(answers: Answer[], where = new Map<string, string>()) {
	const events: OrchestratorEvent[] = [];
	const asked: { query: string; variables: Record<string, unknown> }[] = [];
	let now = Date.parse("2026-11-05T00:00:00Z");
	const pending: (() => void)[] = [];
	const source = new GitHubEventSource({
		settings: () => ({ projects: ["acme/7"], interval: "90s" }),
		token: () => Promise.resolve({ token: "t" }),
		post: (body) => {
			asked.push(body as (typeof asked)[number]);
			const next = answers.shift();
			if (next === undefined) throw new Error("no more answers");
			return Promise.resolve(answer(next));
		},
		dispatch: (event) => events.push(event),
		where: (link) =>
			link !== undefined && where.has(link)
				? { ws: where.get(link)!, agent: { id: "a1", name: "Claude" } }
				: undefined,
		setTimer: (_ms, run) => {
			pending.push(run);
			return { cancel: () => undefined };
		},
		now: () => now,
	});
	source.follow(true);
	return {
		events,
		asked,
		source,
		async ticks(count: number) {
			for (let index = 0; index < count; index += 1) {
				now += 90_000;
				await source.tick();
			}
		},
		pending,
	};
}

/** The board as the first tick sees it: my Issue in progress, someone else's. */
const BASE: IssueCard[] = [
	{
		item: "i1",
		id: "I1",
		number: 123,
		title: "API整理",
		status: "In Progress",
		assignees: [ME],
	},
	{ item: "i2", id: "I2", number: 200, status: "Todo", assignees: ["bob"] },
];

describe("the GitHub source", () => {
	it("asks one request per tick, with the rate limit, the boards, the requests and the details", () => {
		const { query, variables } = githubQuery(
			[{ owner: "acme", number: 7, after: null }],
			["P1"],
		);
		expect(query).toContain("rateLimit{ cost remaining limit resetAt }");
		expect(query).toContain("viewer{ login }");
		expect(query).toContain('fieldValueByName(name:"Status")');
		expect(query).toContain("review-requested:@me");
		expect(query).toContain("nodes(ids:$pulls) @include(if:$wantPulls)");
		expect(query).toContain("statusCheckRollup");
		expect(variables).toMatchObject({
			o0: "acme",
			n0: 7,
			a0: null,
			pulls: ["P1"],
			wantPulls: true,
		});
		expect(githubQuery([], []).variables).toMatchObject({ wantPulls: false });
	});

	it("says nothing about its baseline", async () => {
		const { events, ticks, asked } = world([
			{
				cards: BASE.map(issueCard),
				requested: [{ id: "R1", number: 9, author: "carol" }],
			},
		]);
		await ticks(1);
		expect(asked).toHaveLength(1);
		expect(events).toEqual([]);
	});

	it("says assigned, unassigned and a lane change of my Issue", async () => {
		const { events, ticks } = world(
			[
				{ cards: BASE.map(issueCard) },
				{
					cards: [
						// request-review: In Review, and the assignee removed.
						issueCard({ ...BASE[0]!, status: "In Review", assignees: [] }),
						issueCard({ ...BASE[1]!, assignees: ["bob", ME] }),
					],
				},
			],
			new Map([[url(123, "issues"), "api-refactor"]]),
		);
		await ticks(2);
		expect(events).toEqual([
			{
				type: "github.unassigned",
				item: {
					repo: "acme/app",
					number: 123,
					title: "API整理",
					url: url(123, "issues"),
				},
				kind: "issue",
				login: ME,
				ws: "api-refactor",
				agent: { id: "a1", name: "Claude" },
			},
			{
				type: "github.lane_changed",
				item: {
					repo: "acme/app",
					number: 123,
					title: "API整理",
					url: url(123, "issues"),
				},
				kind: "issue",
				project: "acme/7",
				from: "In Progress",
				to: "In Review",
				ws: "api-refactor",
				agent: { id: "a1", name: "Claude" },
			},
			{
				type: "github.assigned",
				item: {
					repo: "acme/app",
					number: 200,
					title: "Issue 200",
					url: url(200, "issues"),
				},
				kind: "issue",
				login: ME,
			},
		]);
	});

	it("leaves other people's cards alone", async () => {
		const { events, ticks } = world([
			{ cards: BASE.map(issueCard) },
			{
				cards: [
					issueCard(BASE[0]!),
					issueCard({ ...BASE[1]!, status: "Done" }),
				],
			},
		]);
		await ticks(2);
		expect(events).toEqual([]);
	});

	it("says a pull request opened for my Issue, and reads its details from then on", async () => {
		const linked = [{ id: "P1", number: 130, isDraft: true }];
		const { events, ticks, asked } = world([
			{ cards: BASE.map(issueCard) },
			{ cards: [issueCard({ ...BASE[0]!, linked }), issueCard(BASE[1]!)] },
			{
				cards: [issueCard({ ...BASE[0]!, linked }), issueCard(BASE[1]!)],
				pulls: [{ id: "P1", number: 130, isDraft: true }],
			},
			{
				cards: [issueCard({ ...BASE[0]!, linked }), issueCard(BASE[1]!)],
				pulls: [{ id: "P1", number: 130, isDraft: false }],
			},
		]);
		await ticks(4);
		expect(events.map((event) => event.type)).toEqual([
			"github.pr_opened",
			"github.pr_ready",
		]);
		expect(events[0]).toMatchObject({ draft: true, issue: 123 });
		expect(asked[1]?.variables["pulls"]).toEqual([]);
		expect(asked[2]?.variables["pulls"]).toEqual(["P1"]);
	});

	/** Ticks: the board with my PR P1 linked, then each details answer in turn. */
	async function onMyPull(...steps: Details[]) {
		const linked = [{ id: "P1", number: 130 }];
		const cards = [issueCard({ ...BASE[0]!, linked }), issueCard(BASE[1]!)];
		const run = world([
			{ cards },
			...steps.map((pull) => ({ cards, pulls: [pull] })),
		]);
		await run.ticks(1 + steps.length);
		return run.events;
	}

	it("says approvals, changes requested and review comments on my pull request, one line per kind", async () => {
		const events = await onMyPull(
			{ id: "P1", number: 130 },
			{
				id: "P1",
				number: 130,
				reviews: [
					{ author: "alice", state: "COMMENTED", at: "2026-11-05T00:01:00Z" },
					{ author: "alice", state: "COMMENTED", at: "2026-11-05T00:02:00Z" },
					{
						author: "bob",
						state: "CHANGES_REQUESTED",
						at: "2026-11-05T00:03:00Z",
					},
				],
				threads: [false, false, true],
			},
			{
				id: "P1",
				number: 130,
				reviews: [
					{ author: "alice", state: "COMMENTED", at: "2026-11-05T00:01:00Z" },
					{ author: "alice", state: "COMMENTED", at: "2026-11-05T00:02:00Z" },
					{
						author: "bob",
						state: "CHANGES_REQUESTED",
						at: "2026-11-05T00:03:00Z",
					},
					{ author: "bob", state: "APPROVED", at: "2026-11-05T00:09:00Z" },
				],
				threads: [false, false, true],
			},
		);
		expect(events).toEqual([
			expect.objectContaining({
				type: "github.changes_requested",
				by: ["bob"],
			}),
			expect.objectContaining({
				type: "github.review_comment",
				count: 3,
				authors: ["alice"],
				unresolved: 2,
			}),
			expect.objectContaining({ type: "github.pr_approved", by: ["bob"] }),
		]);
	});

	it("says CI passed or failed once per head commit", async () => {
		const events = await onMyPull(
			{ id: "P1", number: 130, checks: "PENDING" },
			{ id: "P1", number: 130, checks: "FAILURE", failing: 2, total: 5 },
			{ id: "P1", number: 130, checks: "FAILURE", failing: 2, total: 5 },
			{ id: "P1", number: 130, oid: "c2", checks: "PENDING" },
			{ id: "P1", number: 130, oid: "c2", checks: "SUCCESS" },
		);
		expect(events).toEqual([
			expect.objectContaining({
				type: "github.checks",
				result: "failed",
				failing: 2,
				total: 5,
			}),
			expect.objectContaining({ type: "github.checks", result: "passed" }),
		]);
	});

	it("says merged and closed, and stops asking", async () => {
		const merged = world([
			{
				cards: [
					issueCard({ ...BASE[0]!, linked: [{ id: "P1", number: 130 }] }),
				],
			},
			{
				cards: [
					issueCard({ ...BASE[0]!, linked: [{ id: "P1", number: 130 }] }),
				],
				pulls: [{ id: "P1", number: 130 }],
			},
			{
				cards: [
					issueCard({
						...BASE[0]!,
						linked: [{ id: "P1", number: 130, state: "MERGED" }],
					}),
				],
				pulls: [{ id: "P1", number: 130, state: "MERGED" }],
			},
			{
				cards: [
					issueCard({
						...BASE[0]!,
						linked: [{ id: "P1", number: 130, state: "MERGED" }],
					}),
				],
			},
		]);
		await merged.ticks(4);
		expect(merged.events.map((event) => event.type)).toEqual([
			"github.pr_merged",
		]);
		expect(merged.asked[3]?.variables["pulls"]).toEqual([]);
		const closed = await onMyPull(
			{ id: "P1", number: 130 },
			{ id: "P1", number: 130, state: "CLOSED" },
		);
		expect(closed.map((event) => event.type)).toEqual(["github.pr_closed"]);
	});

	it("says my review requested on a pull request on the board, and the author's reply after my review", async () => {
		const theirs = { id: "P9", number: 9, author: "carol" };
		const cards = [
			issueCard(BASE[0]!),
			issueCard({ ...BASE[1]!, linked: [theirs] }),
		];
		const requested = [{ id: "P9", number: 9, author: "carol" }];
		const mine = { author: ME, state: "COMMENTED", at: "2026-11-05T00:05:00Z" };
		const { events, ticks } = world([
			{ cards },
			{ cards, requested },
			{
				cards,
				requested,
				pulls: [{ id: "P9", number: 9, author: "carol" }],
			},
			{
				cards,
				pulls: [
					{
						id: "P9",
						number: 9,
						author: "carol",
						latest: [mine],
						reviews: [mine],
					},
				],
			},
			{
				cards,
				pulls: [
					{
						id: "P9",
						number: 9,
						author: "carol",
						latest: [mine],
						reviews: [
							mine,
							{
								author: "carol",
								state: "COMMENTED",
								at: "2026-11-05T00:07:00Z",
							},
						],
						comments: [{ author: "carol", at: "2026-11-05T00:08:00Z" }],
						oid: "c2",
					},
				],
			},
		]);
		await ticks(5);
		expect(events).toEqual([
			expect.objectContaining({
				type: "github.review_requested",
				author: "carol",
			}),
			expect.objectContaining({
				type: "github.reply",
				author: "carol",
				comments: 2,
				commits: true,
			}),
		]);
	});

	it("reads a board bigger than a page a page a tick, and diffs it whole", async () => {
		const { events, ticks, asked } = world([
			{ cards: [issueCard(BASE[0]!)], next: "c1" },
			{ cards: [issueCard(BASE[1]!)] },
			{ cards: [issueCard(BASE[0]!)], next: "c1" },
			{ cards: [issueCard({ ...BASE[1]!, assignees: [ME] })] },
		]);
		await ticks(4);
		expect(asked.map((one) => one.variables["a0"])).toEqual([
			null,
			"c1",
			null,
			"c1",
		]);
		expect(events.map((event) => event.type)).toEqual(["github.assigned"]);
	});

	it("keeps going with what GitHub answered beside its complaints", () => {
		const reading = parseReading(
			{
				...answer({ cards: [issueCard(BASE[0]!)] }),
				errors: [
					{ message: "Could not resolve to a ProjectV2 with the number 8." },
				],
			},
			["acme/7"],
		);
		expect(reading.problems).toEqual([
			"Could not resolve to a ProjectV2 with the number 8.",
		]);
		expect(reading.pages.get("acme/7")?.entries).toHaveLength(1);
		expect(() =>
			parseReading({ errors: [{ message: "Bad credentials" }] }, []),
		).toThrow(/Bad credentials/u);
	});

	it("runs only while there is an orchestrator, and forgets when it stops", async () => {
		const run = world([
			{ cards: BASE.map(issueCard) },
			{ cards: [issueCard({ ...BASE[1]!, assignees: [ME] })] },
		]);
		expect(run.pending).toHaveLength(1);
		await run.ticks(1);
		run.source.follow(false);
		run.source.follow(true);
		// After a restart the next reading is a baseline again.
		await run.ticks(1);
		expect(run.events).toEqual([]);
	});
});

describe("the GitHub interval", () => {
	const now = Date.parse("2026-11-05T00:00:00Z");
	const rate = (remaining: number) => ({
		cost: 3,
		remaining,
		limit: 5000,
		resetAt: now + 30 * 60_000,
	});

	it("starts from the base and only backs off", () => {
		expect(nextDelay(90_000, undefined, now).ms).toBe(90_000);
		expect(nextDelay(90_000, rate(4900), now).ms).toBe(90_000);
		expect(nextDelay(90_000, rate(2000), now).ms).toBe(135_000);
		expect(nextDelay(90_000, rate(1000), now).ms).toBe(180_000);
		expect(nextDelay(90_000, rate(400), now).ms).toBe(360_000);
	});

	it("pauses until the reset when little is left", () => {
		const paused = nextDelay(90_000, rate(50), now);
		expect(paused.ms).toBe(30 * 60_000 + 5_000);
		expect(paused.why).toMatch(/paused until it resets/u);
	});

	it("doubles after each failure, up to a ceiling", () => {
		expect(nextDelay(90_000, rate(4900), now, 1).ms).toBe(180_000);
		expect(nextDelay(90_000, rate(4900), now, 2).ms).toBe(360_000);
		expect(nextDelay(90_000, rate(4900), now, 9).ms).toBe(MAX_BACKOFF_MS);
	});

	it("waits as the rate limit says between ticks, one request at a time", async () => {
		const run = world([{ cards: [], remaining: 50 }]);
		const first = run.source.tick();
		// A second tick while the first is out asks nothing.
		await run.source.tick();
		await first;
		expect(run.asked).toHaveLength(1);
		const state = run.source.state();
		expect(state.rateLimit?.remaining).toBe(50);
		expect((state.nextAt ?? 0) - (state.lastAt ?? 0)).toBeGreaterThan(
			30 * 60_000,
		);
	});
});
