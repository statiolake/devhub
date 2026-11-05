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
	/** The head commit's author's login; absent: not linked to an account. */
	commitAuthor?: string;
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
						author: {
							user:
								pull.commitAuthor === undefined
									? null
									: { login: pull.commitAuthor },
						},
						committer: { user: null },
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

	it("gives the boards' Issues with the pull request that closes each, its review, conversations and checks", async () => {
		const linked = [{ id: "P1", number: 130, isDraft: true }];
		const cards = [issueCard({ ...BASE[0]!, linked }), issueCard(BASE[1]!)];
		const { events, ticks, asked, source } = world([
			{ cards: BASE.map(issueCard) },
			{ cards },
			{
				cards,
				pulls: [
					{
						id: "P1",
						number: 130,
						reviewDecision: "APPROVED",
						threads: [false, true, false],
						checks: "FAILURE",
					},
				],
			},
		]);
		expect(source.issues()).toBeUndefined();
		await ticks(3);
		expect(events).toEqual([]);
		expect(asked[2]?.variables["pulls"]).toEqual(["P1"]);
		expect(source.issues()).toEqual([
			{
				item: {
					repo: "acme/app",
					number: 123,
					title: "API整理",
					url: "https://github.com/acme/app/issues/123",
				},
				open: true,
				assignedToMe: true,
				project: "acme/7",
				lane: "In Progress",
				pull: {
					number: 130,
					url: "https://github.com/acme/app/pull/130",
					state: "open",
					review: "approved",
					unresolved: 2,
					checks: "failing",
				},
			},
			expect.objectContaining({
				item: expect.objectContaining({ number: 200 }) as unknown,
				assignedToMe: false,
			}),
		]);
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

	describe("leaves the viewer's own activity out", () => {
		const at = (minute: number) =>
			`2026-11-05T00:${String(minute).padStart(2, "0")}:00Z`;
		/** My Issue's pull request, written by someone else (dave). */
		async function onDavesPull(...steps: Omit<Details, "id" | "number">[]) {
			const linked = [{ id: "P1", number: 130, author: "dave" }];
			const cards = [issueCard({ ...BASE[0]!, linked }), issueCard(BASE[1]!)];
			const run = world([
				{ cards },
				...steps.map((pull) => ({
					cards,
					pulls: [{ id: "P1", number: 130, author: "dave", ...pull }],
				})),
			]);
			await run.ticks(1 + steps.length);
			return run.events;
		}

		it("says nothing when only my comment is new", async () => {
			// My own pull request: my agent's review comments open threads.
			const events = await onMyPull(
				{ id: "P1", number: 130 },
				{
					id: "P1",
					number: 130,
					reviews: [{ author: ME, state: "COMMENTED", at: at(1) }],
					threads: [false, false],
				},
			);
			expect(events).toEqual([]);
			// Someone else's, linked to my Issue: my review comment.
			expect(
				await onDavesPull(
					{},
					{
						reviews: [{ author: ME, state: "COMMENTED", at: at(1) }],
						threads: [false],
					},
				),
			).toEqual([]);
		});

		it("does not say approved or changes requested for my own review", async () => {
			const events = await onDavesPull(
				{},
				{
					reviews: [{ author: ME, state: "APPROVED", at: at(1) }],
					latest: [{ author: ME, state: "APPROVED", at: at(1) }],
				},
				{
					reviews: [
						{ author: ME, state: "APPROVED", at: at(1) },
						{ author: ME, state: "CHANGES_REQUESTED", at: at(2) },
					],
					latest: [{ author: ME, state: "CHANGES_REQUESTED", at: at(2) }],
				},
			);
			expect(events).toEqual([]);
		});

		it("does not say a reply for commits I pushed to a pull request I reviewed", async () => {
			const mine = { author: ME, state: "COMMENTED", at: at(5) };
			const theirs = { id: "P9", number: 9, author: "carol" };
			const cards = [
				issueCard(BASE[0]!),
				issueCard({ ...BASE[1]!, linked: [theirs] }),
			];
			const pull = { ...theirs, latest: [mine], reviews: [mine] };
			const { events, ticks } = world([
				{ cards },
				{ cards, pulls: [pull] },
				{ cards, pulls: [{ ...pull, oid: "c2", commitAuthor: ME }] },
				{ cards, pulls: [{ ...pull, oid: "c3", commitAuthor: "carol" }] },
			]);
			await ticks(4);
			expect(events).toEqual([
				expect.objectContaining({
					type: "github.reply",
					author: "carol",
					comments: 0,
					commits: true,
				}),
			]);
		});
	});

	it("stops asking about a merged pull request, and says it merged in the Issue's facts", async () => {
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
		expect(merged.events).toEqual([]);
		expect(merged.asked[3]?.variables["pulls"]).toEqual([]);
		expect(merged.source.issues()?.[0]?.pull?.state).toBe("merged");
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

	it("reads a board bigger than a page a page a tick, and gives it whole", async () => {
		const { ticks, asked, source } = world([
			{ cards: [issueCard(BASE[0]!)], next: "c1" },
			{ cards: [issueCard(BASE[1]!)] },
		]);
		await ticks(1);
		expect(source.issues()).toBeUndefined();
		await ticks(1);
		expect(asked.map((one) => one.variables["a0"])).toEqual([null, "c1"]);
		expect(source.issues()?.map((one) => one.item.number)).toEqual([123, 200]);
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
		expect(run.source.issues()).toBeUndefined();
		run.source.follow(true);
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

/** The board with carol's pull request P9 on it (linked to #200). */
const ON_BOARD = [
	issueCard(BASE[0]!),
	issueCard({
		...BASE[1]!,
		linked: [{ id: "P9", number: 9, author: "carol" }],
	}),
];

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

	it("polls once on resume, and what it says goes out in the resume's one message", async () => {
		const run = durable([
			{ cards: ON_BOARD },
			// Meanwhile: carol asked me for a review.
			{
				cards: ON_BOARD,
				requested: [{ id: "P9", number: 9, author: "carol" }],
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
				delivery_interval: "5m",
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
		expect(await dispatcher.resume()).toBe(1);
		expect(run.asked).toHaveLength(2);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatch(/^\[github\.review_requested\] PR #9/u);
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
			{ cards: ON_BOARD },
			{
				cards: ON_BOARD,
				requested: [{ id: "P9", number: 9, author: "carol" }],
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
		cards: ON_BOARD,
		requested: [{ id: "P9", number: 9, author: "carol" }],
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
		const before = durable([{ cards: ON_BOARD }], { store });
		await before.run();
		before.source.stop();
		expect(store.stored?.viewer).toBe(ME);
		const after = durable([changed], { store, now: before.clock.now });
		await after.run();
		expect(after.events.map((event) => event.type)).toEqual([
			"github.review_requested",
		]);
	});

	it("is a baseline when the projects changed", async () => {
		const store = memoryStore();
		const before = durable([{ cards: ON_BOARD }], { store });
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
		const before = durable([{ cards: ON_BOARD }], { store });
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
		const before = durable([{ cards: ON_BOARD }], { store });
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
