import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventDispatcher, type OrchestratorEvent } from "./events.js";
import {
	GitHubSnapshotFile,
	STALE_SNAPSHOT_MS,
	type GitHubSnapshot,
	type SnapshotStore,
} from "./githubSnapshot.js";
import {
	GitHubEventSource,
	githubQuery,
	MAX_BACKOFF_MS,
	nextDelay,
	parseReading,
} from "./githubEvents.js";
import { linkedAgent, type LinkWorkspace } from "./unattended.js";

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
function world(
	answers: Answer[],
	where = new Map<string, string>(),
	links?: () => readonly LinkWorkspace[],
) {
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
		...(links === undefined ? {} : { links }),
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

	it("says assigned and a lane change of my Issue, nothing for an unassignment", async () => {
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

/** A store in memory: what the file would hold. */
function memoryStore(): SnapshotStore & { stored: GitHubSnapshot | undefined } {
	const store = {
		stored: undefined as GitHubSnapshot | undefined,
		pending: undefined as GitHubSnapshot | undefined,
		load: () =>
			store.stored === undefined
				? undefined
				: (JSON.parse(JSON.stringify(store.stored)) as unknown),
		save: (snapshot: GitHubSnapshot) => {
			store.pending = snapshot;
		},
		flush: () => {
			if (store.pending !== undefined) store.stored = store.pending;
			store.pending = undefined;
		},
	};
	return store;
}

/** A source with a store, a clock, and settings that can move. */
function durable(
	answers: Answer[],
	options: {
		store?: SnapshotStore;
		projects?: string[];
		now?: number;
		paused?: boolean;
	} = {},
) {
	const events: OrchestratorEvent[] = [];
	const asked: unknown[] = [];
	const clock = { now: options.now ?? Date.parse("2026-11-05T00:00:00Z") };
	const timers: (() => void)[] = [];
	const settings = {
		projects: options.projects ?? ["acme/7"],
		interval: "90s",
	};
	const source = new GitHubEventSource({
		settings: () => settings,
		token: () => Promise.resolve({ token: "t" }),
		post: (body) => {
			asked.push(body);
			const next = answers.shift();
			if (next === undefined) throw new Error("no more answers");
			return Promise.resolve(answer(next));
		},
		dispatch: (event) => {
			dispatch(event);
		},
		where: () => undefined,
		setTimer: (_ms, run) => {
			timers.push(run);
			return { cancel: () => undefined };
		},
		...(options.store === undefined ? {} : { snapshots: options.store }),
		now: () => clock.now,
	});
	let dispatch = (event: OrchestratorEvent) => {
		events.push(event);
	};
	source.follow(true, options.paused ?? false);
	return {
		events,
		asked,
		source,
		clock,
		settings,
		/** Route the source's events elsewhere (a dispatcher). */
		into(to: (event: OrchestratorEvent) => void) {
			dispatch = to;
		},
		/** Run the timers due, as many rounds as asked. */
		async run(rounds = 1) {
			for (let index = 0; index < rounds; index += 1) {
				clock.now += 90_000;
				const due = timers.splice(0);
				for (const one of due) one();
				await new Promise((done) => setTimeout(done, 0));
			}
		},
	};
}

describe("GitHub polling and the pause", () => {
	it("asks nothing while suspended, and keeps what it read", async () => {
		const run = durable([{ cards: BASE.map(issueCard) }]);
		await run.run();
		expect(run.asked).toHaveLength(1);
		run.source.follow(true, true);
		expect(run.source.state().mode).toBe("suspended");
		await run.run(5);
		await run.source.tick();
		expect(run.asked).toHaveLength(1);
		expect(run.source.state().watched).toBe(0);
	});

	it("polls once on resume, and the net change goes out in the resume's one message", async () => {
		const run = durable([
			{ cards: BASE.map(issueCard) },
			// Meanwhile: I was put on #200, and #123 went to review and on to done.
			{
				cards: [
					issueCard({ ...BASE[0]!, status: "Done" }),
					issueCard({ ...BASE[1]!, assignees: [ME] }),
				],
			},
		]);
		await run.run();
		const sent: string[] = [];
		const dispatcher = new EventDispatcher({
			orchestrator: () => "orch",
			settings: () => ({
				event_prompt: "{EVENT}",
				init_prompt: undefined,
				events: ["*"],
			}),
			deliver: (_agent, text) => sent.push(text),
			paused: (paused) => {
				run.source.follow(true, paused);
				return paused ? undefined : run.source.caughtUp();
			},
		});
		run.into((event) => dispatcher.dispatch(event));
		dispatcher.pause();
		await run.run(3);
		expect(run.asked).toHaveLength(1);
		expect(await dispatcher.resume()).toBe(2);
		expect(run.asked).toHaveLength(2);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.split("\n")).toEqual([
			expect.stringMatching(
				/^\[github\.lane_changed\] #123.*In Progress → Done/u,
			),
			expect.stringMatching(/^\[github\.assigned\] #200/u),
		]);
		expect(run.source.state().mode).toBe("active");
	});

	it("waits for the rate limit's reset on resume rather than polling", async () => {
		const run = durable([
			{
				cards: BASE.map(issueCard),
				remaining: 50,
				resetAt: "2026-11-05T01:00:00Z",
			},
		]);
		await run.run();
		run.source.follow(true, true);
		run.source.follow(true, false);
		await run.source.caughtUp();
		expect(run.asked).toHaveLength(1);
		expect(run.source.state().nextAt).toBeGreaterThan(
			Date.parse("2026-11-05T01:00:00Z"),
		);
	});

	it("is a baseline again after a pause longer than the staleness limit", async () => {
		const run = durable([
			{ cards: BASE.map(issueCard) },
			{
				cards: [
					issueCard(BASE[0]!),
					issueCard({ ...BASE[1]!, assignees: [ME] }),
				],
			},
		]);
		await run.run();
		run.source.follow(true, true);
		run.clock.now += STALE_SNAPSHOT_MS + 60_000;
		run.source.follow(true, false);
		await run.source.caughtUp();
		expect(run.asked).toHaveLength(2);
		expect(run.events).toEqual([]);
	});
});

describe("the stored snapshot", () => {
	const changed: Answer = {
		cards: [issueCard(BASE[0]!), issueCard({ ...BASE[1]!, assignees: [ME] })],
	};

	it("round-trips through the file, debounced and atomically", () => {
		const folder = mkdtempSync(join(tmpdir(), "devhub-gh-"));
		try {
			const path = join(folder, "devhub", "orchestrator-github.json");
			const timers: (() => void)[] = [];
			const file = new GitHubSnapshotFile(path, {
				setTimer: (_ms, run) => {
					timers.push(run);
					return { cancel: () => undefined };
				},
			});
			expect(file.load()).toBeUndefined();
			const snapshot: GitHubSnapshot = {
				version: 1,
				savedAt: 1,
				viewer: ME,
				projects: ["acme/7"],
				boards: { "acme/7": [] },
				watched: ["I1"],
				pulls: [],
				requested: null,
			};
			file.save({ ...snapshot, savedAt: 0 });
			file.save(snapshot);
			// One write for both, when the debounce is up.
			expect(timers).toHaveLength(1);
			timers[0]!();
			expect(file.load()).toEqual(snapshot);
			expect(readdirSync(join(folder, "devhub"))).toEqual([
				"orchestrator-github.json",
			]);
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	it("diffs the first poll after a restart against it", async () => {
		const store = memoryStore();
		const before = durable([{ cards: BASE.map(issueCard) }], { store });
		await before.run();
		before.source.stop();
		expect(store.stored?.viewer).toBe(ME);
		const after = durable([changed], { store, now: before.clock.now });
		await after.run();
		expect(after.events.map((event) => event.type)).toEqual([
			"github.assigned",
		]);
	});

	it("is a baseline when the projects changed", async () => {
		const store = memoryStore();
		const before = durable([{ cards: BASE.map(issueCard) }], { store });
		await before.run();
		before.source.stop();
		const after = durable([changed], {
			store,
			projects: ["acme/8"],
			now: before.clock.now,
		});
		await after.run();
		expect(after.events).toEqual([]);
	});

	it("is a baseline when it is stale", async () => {
		const store = memoryStore();
		const before = durable([{ cards: BASE.map(issueCard) }], { store });
		await before.run();
		before.source.stop();
		const after = durable([changed], {
			store,
			now: before.clock.now + STALE_SNAPSHOT_MS + 60_000,
		});
		await after.run();
		expect(after.events).toEqual([]);
	});

	it("is a baseline when the viewer is someone else", async () => {
		const store = memoryStore();
		const before = durable([{ cards: BASE.map(issueCard) }], { store });
		await before.run();
		before.source.stop();
		store.stored = { ...store.stored!, viewer: "someone-else" };
		const after = durable([changed], { store, now: before.clock.now });
		await after.run();
		expect(after.events).toEqual([]);
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

// --- github.unattended -----------------------------------------------------------

/** A Workspace on `branch`'s Issue, with an agent (live unless said). */
function space(
	number: number | undefined,
	agent: { live?: boolean; meta?: Record<string, string> } | null = {},
): LinkWorkspace {
	return {
		ws: `ws${String(number ?? 0)}`,
		issueUrls: number === undefined ? [] : [url(number, "issues")],
		repo: "acme/app",
		agents:
			agent === null
				? []
				: [
						{
							id: `agent-${String(number ?? 0)}`,
							name: "Claude",
							live: agent.live ?? true,
							meta: agent.meta ?? {},
						},
					],
	};
}

function unattended(events: readonly OrchestratorEvent[]): number[] {
	return events.flatMap((event) =>
		event.type === "github.unattended" ? [event.item.number] : [],
	);
}

describe("github.unattended", () => {
	const MINE: IssueCard[] = [
		{
			item: "i1",
			id: "I1",
			number: 123,
			status: "In Progress",
			assignees: [ME],
		},
		{
			item: "i3",
			id: "I3",
			number: 200,
			title: "検索の改善",
			status: "Todo",
			assignees: [ME],
		},
		{ item: "i2", id: "I2", number: 300, status: "Todo", assignees: ["bob"] },
	];

	it("says an unattended Issue of mine on the baseline poll, not one with an agent", async () => {
		const run = world([{ cards: MINE.map(issueCard) }], new Map(), () => [
			space(123),
		]);
		await run.ticks(1);
		expect(run.events).toEqual([
			{
				type: "github.unattended",
				item: {
					repo: "acme/app",
					number: 200,
					title: "検索の改善",
					url: url(200, "issues"),
				},
				project: "acme/7",
				lane: "Todo",
			},
		]);
		const state = run.source.state();
		expect(state.boards).toEqual([
			{
				ref: "acme/7",
				title: "Team",
				read: true,
				items: 3,
				assigned: 2,
				unattended: 1,
			},
		]);
		expect(state.unattended.map((one) => one.item.number)).toEqual([200]);
		expect(state.notes.join("\n")).toMatch(
			/acme\/7: first full pass, a baseline/u,
		);
		expect(state.notes.join("\n")).toMatch(
			/#123 .*linked to agent=agent-12 in ws=ws123/u,
		);
	});

	it("does not wait for a Workspace that is not a repository, nor one whose branch is unread", async () => {
		// Scratch (a plain folder) with a live agent, and a Workspace no round
		// has read yet: neither links #200, and neither holds it back.
		const run = world([{ cards: MINE.map(issueCard) }], new Map(), () => [
			space(123),
			{ ws: "scratch", issueUrls: [], agents: space(undefined).agents },
			{ ...space(undefined), ws: "fresh" },
		]);
		await run.ticks(1);
		expect(unattended(run.events)).toEqual([200]);
	});

	it("says an Issue assigned to me after the baseline", async () => {
		const later: IssueCard[] = [
			MINE[0]!,
			MINE[1]!,
			{ ...MINE[2]!, assignees: ["bob", ME] },
		];
		const run = world(
			[{ cards: MINE.map(issueCard) }, { cards: later.map(issueCard) }],
			new Map(),
			() => [space(123)],
		);
		await run.ticks(2);
		expect(unattended(run.events)).toEqual([200, 300]);
		expect(run.events.map((event) => event.type)).toContain("github.assigned");
	});

	it("says an Issue of mine added to the board after the baseline", async () => {
		const added: IssueCard = {
			item: "i9",
			id: "I9",
			number: 900,
			status: "Todo",
			assignees: [ME],
		};
		const run = world(
			[
				{ cards: MINE.map(issueCard) },
				{ cards: [...MINE, added].map(issueCard) },
			],
			new Map(),
			() => [space(123)],
		);
		await run.ticks(2);
		expect(unattended(run.events)).toEqual([200, 900]);
	});

	it("is not said again while nothing changed", async () => {
		const run = world(
			[{ cards: MINE.map(issueCard) }, { cards: MINE.map(issueCard) }],
			new Map(),
			() => [space(123)],
		);
		await run.ticks(2);
		run.source.reconsider();
		expect(unattended(run.events)).toEqual([200]);
		expect(run.source.state().notes.join("\n")).toMatch(
			/#200 .*said already for this stretch/u,
		);
	});

	it("re-arms once an agent is linked, and says it again when it is gone", async () => {
		let spaces = [space(123)];
		const run = world(
			[{ cards: MINE.map(issueCard) }],
			new Map(),
			() => spaces,
		);
		await run.ticks(1);
		expect(unattended(run.events)).toEqual([200]);
		// An agent on its branch: attended.
		spaces = [space(123), space(200)];
		run.source.reconsider();
		expect(run.source.state().unattended).toEqual([]);
		// Still attended: nothing.
		run.source.reconsider();
		expect(unattended(run.events)).toEqual([200]);
		// The agent stopping: unattended again, said again.
		spaces = [space(123), space(200, { live: false })];
		run.source.reconsider();
		expect(unattended(run.events)).toEqual([200, 200]);
	});

	it("does not say a closed Issue, whatever its lane; the lane is information", async () => {
		const run = world(
			[
				{
					cards: [
						issueCard({
							item: "i4",
							id: "I4",
							number: 400,
							status: "Todo",
							assignees: [ME],
							state: "CLOSED",
						}),
						issueCard({
							item: "i5",
							id: "I5",
							number: 500,
							status: "Done",
							assignees: [ME],
						}),
						issueCard({
							item: "i6",
							id: "I6",
							number: 600,
							status: null,
							assignees: [ME],
						}),
					],
				},
			],
			new Map(),
			() => [],
		);
		await run.ticks(1);
		// Open in Done is still open: said, with its lane; closed is not.
		expect(
			run.events.map(
				(event) =>
					event.type === "github.unattended" && [event.item.number, event.lane],
			),
		).toEqual([
			[500, "Done"],
			[600, null],
		]);
		expect(run.source.state().notes.join("\n")).toMatch(/#400 .*closed/u);
	});

	it("is not said without a link check (no Workspaces port)", async () => {
		const run = world([{ cards: MINE.map(issueCard) }]);
		await run.ticks(1);
		expect(run.events).toEqual([]);
	});

	it("is dropped as stale when, by delivery, an agent got linked or it was closed", async () => {
		let spaces: LinkWorkspace[] = [];
		const run = world(
			[
				{ cards: MINE.map(issueCard) },
				{
					cards: MINE.map((card) =>
						issueCard(
							card.number === 123 ? { ...card, state: "CLOSED" } : card,
						),
					),
				},
			],
			new Map(),
			() => spaces,
		);
		const delivered: string[] = [];
		const dispatcher = new EventDispatcher({
			orchestrator: () => "orch",
			settings: () => ({
				event_prompt: "{EVENT}",
				init_prompt: undefined,
				events: ["github.*"],
			}),
			deliver: (_agent, text) => delivered.push(text),
			relevant: (event) =>
				event.type !== "github.unattended" ||
				run.source.stillUnattended(event.item),
		});
		dispatcher.pause();
		await run.ticks(1);
		for (const event of run.events) dispatcher.dispatch(event);
		expect(dispatcher.held()).toHaveLength(2);
		// #200 gets an agent; #123 is closed on the next poll.
		spaces = [space(200)];
		await run.ticks(1);
		void dispatcher.resume();
		expect(delivered).toEqual([]);
		expect(dispatcher.recent(10).map((entry) => entry.fate)).toEqual([
			"dropped-stale",
			"dropped-stale",
		]);
	});

	it("is delivered again after a re-arm, not taken for a repeat", async () => {
		let spaces: LinkWorkspace[] = [space(123)];
		const run = world(
			[{ cards: MINE.map(issueCard) }],
			new Map(),
			() => spaces,
		);
		const delivered: string[] = [];
		const dispatcher = new EventDispatcher({
			orchestrator: () => "orch",
			settings: () => ({
				event_prompt: "{EVENT}",
				init_prompt: undefined,
				events: ["github.*"],
			}),
			deliver: (_agent, text) => delivered.push(text),
		});
		await run.ticks(1);
		spaces = [space(123), space(200)];
		run.source.reconsider();
		spaces = [space(123)];
		run.source.reconsider();
		for (const event of run.events) dispatcher.dispatch(event);
		expect(delivered).toEqual([
			`[github.unattended] #200「検索の改善」 lane=Todo — 自分にアサインされているがエージェントがいない ${url(200, "issues")}`,
			`[github.unattended] #200「検索の改善」 lane=Todo — 自分にアサインされているがエージェントがいない ${url(200, "issues")}`,
		]);
	});
});

describe("linkedAgent", () => {
	const issue = { repo: "acme/app", number: 200, url: url(200, "issues") };

	it("links a Workspace on the Issue's branch with a live agent", () => {
		expect(linkedAgent(issue, [space(200)])).toEqual({
			ws: "ws200",
			agent: { id: "agent-200", name: "Claude" },
		});
		expect(linkedAgent(issue, [space(200, { live: false })])).toBeUndefined();
		expect(linkedAgent(issue, [space(200, null)])).toBeUndefined();
		expect(linkedAgent(issue, [space(201)])).toBeUndefined();
		// Case, a trailing slash: the same Issue.
		expect(
			linkedAgent(issue, [
				{
					...space(undefined),
					issueUrls: ["https://github.com/ACME/app/issues/200/"],
				},
			]),
		).toBeDefined();
	});

	it("links an agent whose meta issue= names it, by URL or by number in its repository", () => {
		const meta = (value: string, repo?: string): LinkWorkspace => ({
			...space(undefined, { meta: { issue: value } }),
			...(repo === undefined ? {} : { repo }),
		});
		expect(linkedAgent(issue, [meta("200")])).toBeDefined();
		expect(linkedAgent(issue, [meta("#200")])).toBeDefined();
		expect(linkedAgent(issue, [meta(url(200, "issues"))])).toBeDefined();
		expect(linkedAgent(issue, [meta("201")])).toBeUndefined();
		expect(linkedAgent(issue, [meta("200", "other/repo")])).toBeUndefined();
		expect(
			linkedAgent(issue, [
				{
					...meta("200"),
					agents: [{ id: "x", live: false, meta: { issue: "200" } }],
				},
			]),
		).toBeUndefined();
	});
});
