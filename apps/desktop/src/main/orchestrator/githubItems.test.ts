import { OFF_LINKED_INTERVAL_MS } from "./mode.js";
import { describe, expect, it } from "vitest";
import {
	GitHubItemSource,
	githubQuery,
	ITEMS_PER_PAGE,
	MAX_BACKOFF_MS,
	MAX_LINKED_ITEMS,
	nextDelay,
	parseReading,
	PROJECT_SCOPE_HINT,
	SEARCH_QUERY,
} from "./githubItems.js";
import { readInvariant, type InvariantAgent } from "./invariant.js";

// --- fixtures: a GitHub that answers what is asked -----------------------------

const ME = "me";
const REPO = { nameWithOwner: "acme/app" };
const START = Date.parse("2026-11-05T00:00:00Z");

function url(number: number, kind: "issues" | "pull") {
	return `https://github.com/acme/app/${kind}/${String(number)}`;
}

interface Node {
	kind: "Issue" | "PullRequest";
	id: string;
	number: number;
	state?: string;
	assignees?: string[];
	/** The Projects it is on (`owner/number`), each with its lane. */
	boards?: { ref: string; lane?: string | null }[];
	linked?: { id: string; number: number; state?: string }[];
}

function node(one: Node) {
	const boards = {
		nodes: (one.boards ?? [{ ref: "acme/7" }]).map((board) => {
			const [owner, number] = board.ref.split("/");
			return {
				status: board.lane === null ? null : { name: board.lane ?? "Todo" },
				project: {
					number: Number(number),
					title: `Board ${board.ref}`,
					owner: { login: owner },
				},
			};
		}),
	};
	return {
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
		projectItems: boards,
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

interface Details {
	decision?: string;
	unresolved?: number;
	checks?: string;
}

/** What GitHub holds; the fake answers each request from it. */
interface GitHub {
	/** The search's result, in order: paged by `ITEMS_PER_PAGE`, or by `pageSize`. */
	assigned: Node[];
	pageSize?: number;
	/** Items read by URL. */
	byUrl?: Record<string, Node>;
	details?: Record<string, Details>;
	/** Projects GitHub has; any other is answered as nothing. */
	projects?: string[];
	remaining?: number;
	resetAt?: number;
	/** Throw instead of answering. */
	failing?: boolean;
}

function answerFrom(
	github: GitHub,
	body: { query: string; variables: Record<string, unknown> },
) {
	const v = body.variables;
	const data: Record<string, unknown> = {
		viewer: { login: ME },
		rateLimit: {
			cost: 1,
			remaining: github.remaining ?? 4900,
			limit: 5000,
			resetAt: new Date(github.resetAt ?? START + 3_600_000).toISOString(),
		},
	};
	if ("q" in v) {
		const size = github.pageSize ?? ITEMS_PER_PAGE;
		const from = v["after"] === null ? 0 : Number(v["after"]);
		const page = github.assigned.slice(from, from + size);
		const more = from + size < github.assigned.length;
		data["search"] = {
			pageInfo: {
				hasNextPage: more,
				endCursor: more ? String(from + size) : null,
			},
			nodes: page.map(node),
		};
	}
	for (let index = 0; `o${String(index)}` in v; index += 1) {
		const ref = `${String(v[`o${String(index)}`])}/${String(v[`n${String(index)}`])}`;
		data[`p${String(index)}`] = (
			github.projects ?? ["acme/7", "corp/2"]
		).includes(ref)
			? { projectV2: { title: `Board ${ref}` } }
			: null;
	}
	for (let index = 0; `u${String(index)}` in v; index += 1) {
		const one = github.byUrl?.[String(v[`u${String(index)}`])];
		data[`l${String(index)}`] = one === undefined ? null : node(one);
	}
	if (Array.isArray(v["pulls"]))
		data["pulls"] = (v["pulls"] as string[]).map((id) => {
			const one = github.details?.[id] ?? {};
			return {
				id,
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
			};
		});
	return { data };
}

/** A source over `github`, with a clock and timers the test runs. */
function world(
	github: GitHub,
	options: { projects?: string[]; linked?: string[] } = {},
) {
	const asked: { query: string; variables: Record<string, unknown> }[] = [];
	const clock = { now: START };
	let pending: { ms: number; run: () => void } | undefined;
	const delays: number[] = [];
	const settings = {
		projects: options.projects ?? ["acme/7"],
		interval: "90s",
	};
	const linked = { urls: options.linked ?? [] };
	const source = new GitHubItemSource({
		settings: () => settings,
		linked: () => linked.urls,
		token: () => Promise.resolve({ token: "t" }),
		post: (body) => {
			const one = body as (typeof asked)[number];
			asked.push(one);
			if (github.failing === true)
				return Promise.reject(new Error("GitHub answered 502."));
			return Promise.resolve(answerFrom(github, one));
		},
		setTimer: (ms, run) => {
			delays.push(ms);
			const timer = { ms, run };
			pending = timer;
			return {
				cancel: () => {
					if (pending === timer) pending = undefined;
				},
			};
		},
		now: () => clock.now,
	});
	source.follow(true);
	return {
		asked,
		source,
		delays,
		settings,
		linked,
		clock,
		/** Wait out the pending timer and poll, as the app would. */
		async next() {
			const timer = pending;
			if (timer === undefined) throw new Error("nothing scheduled");
			clock.now += timer.ms;
			pending = undefined;
			await source.tick();
		},
		get pending() {
			return pending;
		},
	};
}

const searches = (asked: { variables: Record<string, unknown> }[]) =>
	asked.filter((one) => "q" in one.variables);

// --- tests ---------------------------------------------------------------------

describe("the GitHub items", () => {
	it("asks GitHub for the population: one search, never a whole Project", () => {
		const { query, variables } = githubQuery({
			search: { after: null },
			boards: [{ owner: "acme", number: 7 }],
			linked: [url(5, "issues")],
			pulls: ["P9"],
		});
		expect(query).toContain(
			`search(type:ISSUE, query:$q, first:${String(ITEMS_PER_PAGE)}, after:$after)`,
		);
		expect(query).toContain("projectItems(first:20");
		expect(query).toContain('fieldValueByName(name:"Status")');
		expect(query).toContain("p0: repositoryOwner(login:$o0)");
		expect(query).toContain("projectV2(number:$n0){ title }");
		expect(query).not.toMatch(/projectV2\(number:\$n0\)\{ title\s+items/u);
		expect(query).toContain("l0: resource(url:$u0)");
		expect(query).toContain("pulls: nodes(ids:$pulls)");
		expect(query).toContain("rateLimit");
		expect(variables).toMatchObject({
			q: SEARCH_QUERY,
			after: null,
			o0: "acme",
			n0: 7,
			u0: url(5, "issues"),
			pulls: ["P9"],
		});
		expect(SEARCH_QUERY).toBe("is:open assignee:@me archived:false");
		// A page alone carries nothing else.
		const page = githubQuery({ search: { after: "c1" } });
		expect(page.query).not.toContain("repositoryOwner");
		expect(page.query).not.toContain("nodes(ids:");
		expect(page.query).not.toContain("resource(");
	});

	it("gives the items on the registered Projects, one on two with a lane on each, and leaves out one on another Project only", async () => {
		const run = world(
			{
				assigned: [
					{
						kind: "Issue",
						id: "I1",
						number: 1,
						boards: [
							{ ref: "acme/7", lane: "In Progress" },
							{ ref: "corp/2", lane: null },
						],
					},
					{ kind: "Issue", id: "I2", number: 2, boards: [{ ref: "corp/2" }] },
					{ kind: "Issue", id: "I3", number: 3, boards: [{ ref: "else/1" }] },
					{ kind: "Issue", id: "I4", number: 4, boards: [] },
				],
			},
			{ projects: ["acme/7", "CORP/2"] },
		);
		await run.next();
		const items = run.source.items()!;
		expect(items.map((one) => one.item.number)).toEqual([1, 2]);
		expect(items[0]).toMatchObject({
			kind: "issue",
			state: "open",
			assignedToMe: true,
			projects: [
				{ project: "acme/7", lane: "In Progress" },
				{ project: "CORP/2", lane: null },
			],
		});
		expect(run.source.state()).toMatchObject({
			assigned: 2,
			projects: [{ ref: "acme/7", title: "Board acme/7" }, { ref: "CORP/2" }],
		});
	});

	it("gives a pull request as an item, with its details read once a pass", async () => {
		const run = world({
			assigned: [{ kind: "PullRequest", id: "P9", number: 9 }],
			details: {
				P9: { decision: "CHANGES_REQUESTED", unresolved: 2, checks: "FAILURE" },
			},
		});
		await run.next();
		// Known now, its details not yet: the extras alone follow at once.
		expect(run.source.items()?.[0]).toMatchObject({
			kind: "pr",
			pull: { number: 9, state: "open", review: "none" },
		});
		expect(run.delays.at(-1)).toBe(0);
		await run.next();
		expect(run.asked[1]?.variables).toMatchObject({ pulls: ["P9"] });
		expect(run.asked[1]?.variables).not.toHaveProperty("q");
		expect(run.source.items()?.[0]?.pull).toEqual({
			number: 9,
			url: url(9, "pull"),
			state: "open",
			review: "changes_requested",
			unresolved: 2,
			checks: "failing",
		});
		// From then on, one request a pass: the search, carrying the details.
		expect(run.delays.at(-1)).toBe(90_000);
		await run.next();
		expect(run.asked).toHaveLength(3);
		expect(run.asked[2]?.variables).toMatchObject({
			q: SEARCH_QUERY,
			pulls: ["P9"],
		});
		expect(run.delays.at(-1)).toBe(90_000);
	});

	it("gives an Issue the pull request that closes it", async () => {
		const run = world({
			assigned: [
				{
					kind: "Issue",
					id: "I1",
					number: 1,
					linked: [
						{ id: "P1", number: 10, state: "CLOSED" },
						{ id: "P2", number: 11 },
					],
				},
			],
			details: { P2: { decision: "APPROVED", checks: "SUCCESS" } },
		});
		await run.next();
		await run.next();
		expect(run.asked[1]?.variables).toMatchObject({ pulls: ["P2"] });
		expect(run.source.items()?.[0]?.pull).toMatchObject({
			number: 11,
			review: "approved",
			checks: "passing",
		});
	});

	it("reads a linked item the search did not give by URL: a closed one is closed, an unassigned one unassigned", async () => {
		const closed = url(5, "issues");
		const theirs = url(6, "issues");
		const run = world(
			{
				assigned: [],
				byUrl: {
					[closed]: { kind: "Issue", id: "I5", number: 5, state: "CLOSED" },
					[theirs]: {
						kind: "Issue",
						id: "I6",
						number: 6,
						assignees: ["someone"],
						boards: [{ ref: "else/1" }],
					},
				},
			},
			{ linked: [closed, theirs] },
		);
		await run.next();
		expect(run.asked[0]?.variables).toMatchObject({ u0: closed, u1: theirs });
		const items = run.source.items()!;
		expect(
			items.map((one) => [one.item.number, one.state, one.assignedToMe]),
		).toEqual([
			[5, "closed", true],
			[6, "open", false],
		]);
		expect(run.source.state().assigned).toBe(0);
		const agent = (issue: string): InvariantAgent => ({
			id: `a-${issue}`,
			name: "x",
			ws: "w",
			workspaceId: "w",
			managed: true,
			status: "working",
			stopping: false,
			issue,
		});
		const reading = readInvariant({
			items,
			agents: [agent(closed), agent(theirs)],
			tasks: [],
		});
		// Read, and outside the population: no task is asked for them.
		expect([...reading.items.values()].map((one) => one.inPopulation)).toEqual([
			false,
			false,
		]);
		expect(reading.needsAction.filter((one) => one.kind !== "agent")).toEqual(
			[],
		);
	});

	it("says a linked item on no registered Project is not in a Project, and reads no item the search gave by URL", async () => {
		const elsewhere = url(3, "issues");
		const mine = url(1, "issues");
		const run = world(
			{
				assigned: [
					{ kind: "Issue", id: "I1", number: 1 },
					{ kind: "Issue", id: "I3", number: 3, boards: [{ ref: "else/1" }] },
				],
				byUrl: {},
			},
			{ linked: [elsewhere, mine] },
		);
		await run.next();
		// No search was read yet: both asked by URL once; neither is asked again.
		await run.next();
		expect(run.asked.slice(1).every((one) => !("u0" in one.variables))).toBe(
			true,
		);
		const items = run.source.items()!;
		expect(items.map((one) => [one.item.number, one.projects.length])).toEqual([
			[1, 1],
			[3, 0],
		]);
		const reading = readInvariant({
			items,
			agents: [
				{
					id: "a1",
					name: "x",
					ws: "w",
					workspaceId: "w",
					managed: true,
					status: "working",
					stopping: false,
					issue: elsewhere,
				},
			],
			tasks: [],
		});
		// On no registered Project: read, and not in the population.
		expect(
			[...reading.items.values()].map((one) => [
				one.facts.item.number,
				one.inPopulation,
			]),
		).toEqual([
			[1, true],
			[3, false],
		]);
	});

	it(`reads at most ${String(MAX_LINKED_ITEMS)} linked items a request`, async () => {
		const many = Array.from({ length: 30 }, (_, index) =>
			url(100 + index, "issues"),
		);
		const run = world({ assigned: [] }, { linked: many });
		await run.next();
		const variables = run.asked[0]!.variables;
		expect(
			Object.keys(variables).filter((key) => /^u\d+$/u.test(key)),
		).toHaveLength(MAX_LINKED_ITEMS);
	});

	it("reads the search's further pages one after another, and knows the population only after the last", async () => {
		const assigned = Array.from(
			{ length: 5 },
			(_, index): Node => ({
				kind: "Issue",
				id: `I${String(index)}`,
				number: index + 1,
			}),
		);
		const run = world({ assigned, pageSize: 2 });
		expect(run.source.state().reading).toBe(
			"searching the open items assigned to me, page 1",
		);
		await run.next();
		expect(run.source.items()).toBeUndefined();
		expect(run.source.state().reading).toBe(
			"searching the open items assigned to me, page 2",
		);
		expect(run.delays.at(-1)).toBe(0);
		await run.next();
		await run.next();
		expect(run.source.items()).toHaveLength(5);
		expect(run.source.state().reading).toBeUndefined();
		expect(run.delays.at(-1)).toBe(90_000);
		expect(searches(run.asked).map((one) => one.variables["after"])).toEqual([
			null,
			"2",
			"4",
		]);
		// The further pages carry nothing else.
		expect(run.asked[1]?.query).not.toContain("repositoryOwner");
		// The next pass starts over, after the interval.
		await run.next();
		expect(run.asked[3]?.variables["after"]).toBeNull();
		expect(run.source.items()).toHaveLength(5);
	});

	it("has an empty population, and asks GitHub nothing, with no Project registered", () => {
		const run = world({ assigned: [] }, { projects: [] });
		expect(run.source.items()).toEqual([]);
		expect(run.source.state().mode).toBe("idle");
		expect(run.pending).toBeUndefined();
	});

	it("runs only while there is an orchestrator, and forgets when it stops", async () => {
		const run = world({ assigned: [{ kind: "Issue", id: "I1", number: 1 }] });
		await run.next();
		expect(run.source.items()).toHaveLength(1);
		run.source.follow(false);
		expect(run.source.items()).toBeUndefined();
		expect(run.source.state().mode).toBe("idle");
	});

	it("asks nothing while suspended, and polls once on resume", async () => {
		const github: GitHub = { assigned: [] };
		const run = world(github);
		await run.next();
		run.source.follow(true, true);
		await run.source.tick();
		expect(run.asked).toHaveLength(1);
		github.assigned = [{ kind: "Issue", id: "I1", number: 1 }];
		run.source.follow(true, false);
		await run.source.caughtUp();
		expect(run.asked).toHaveLength(2);
		expect(run.source.items()).toHaveLength(1);
	});
});

describe("while off (suspended)", () => {
	it("reads only the items the open tasks link, every 20 minutes, and a closing one is seen", async () => {
		const issue = url(1, "issues");
		const github: GitHub = {
			assigned: [{ kind: "Issue", id: "I1", number: 1 }],
			byUrl: { [issue]: { kind: "Issue", id: "I1", number: 1 } },
		};
		const run = world(github, { linked: [issue] });
		await run.next();
		expect(run.source.items()?.map((one) => one.state)).toEqual(["open"]);
		const before = run.asked.length;
		run.source.follow(true, true);
		expect(run.pending?.ms).toBe(OFF_LINKED_INTERVAL_MS);
		// Nothing is asked before its time; then one request, by URL only.
		await run.source.tick();
		expect(run.asked).toHaveLength(before);
		github.byUrl = {
			[issue]: { kind: "Issue", id: "I1", number: 1, state: "CLOSED" },
		};
		run.clock.now += OFF_LINKED_INTERVAL_MS;
		await run.source.tickOff();
		expect(run.asked).toHaveLength(before + 1);
		const asked = run.asked.at(-1)!;
		expect(asked.variables).toEqual({ u0: issue });
		expect(asked.query).not.toContain("search(");
		expect(asked.query).not.toContain("pulls:");
		expect(run.source.items()?.map((one) => one.state)).toEqual(["closed"]);
		expect(run.pending?.ms).toBe(OFF_LINKED_INTERVAL_MS);
		expect(run.source.state().mode).toBe("suspended");
	});

	it("asks nothing while off when no open task links an item", async () => {
		const run = world({ assigned: [] });
		await run.next();
		const before = run.asked.length;
		run.source.follow(true, true);
		await run.source.tickOff();
		expect(run.asked).toHaveLength(before);
		expect(run.pending?.ms).toBe(OFF_LINKED_INTERVAL_MS);
	});
});

describe("the GitHub cost", () => {
	it("is one request a pass, whatever the Projects hold", async () => {
		const run = world(
			{ assigned: [{ kind: "Issue", id: "I1", number: 1 }] },
			{ projects: ["acme/7", "corp/2"] },
		);
		// An hour.
		while (run.clock.now < START + 3_600_000) await run.next();
		expect(run.asked.length).toBeLessThanOrEqual(3_600_000 / 90_000 + 1);
	});

	it("does not hammer GitHub after a rate-limit reset: a long run stays at the interval's pace", async () => {
		const github: GitHub = {
			assigned: [
				{ kind: "PullRequest", id: "P9", number: 9 },
				{
					kind: "Issue",
					id: "I1",
					number: 1,
					linked: [{ id: "P2", number: 2 }],
				},
			],
			pageSize: 1,
			remaining: 20,
			resetAt: START + 600_000,
		};
		const run = world(github, { linked: [url(50, "issues")] });
		await run.next();
		// Low: paused until the reset.
		expect(run.delays.at(-1)).toBeGreaterThanOrEqual(600_000);
		expect(run.source.state().nextAt).toBeGreaterThanOrEqual(START + 600_000);
		// After it, plenty left: six hours of polling.
		github.remaining = 5000;
		github.resetAt = START + 7 * 3_600_000;
		const before = run.asked.length;
		while (run.clock.now < START + 6 * 3_600_000) {
			await run.next();
			// Never a next poll before the last one sent.
			const state = run.source.state();
			expect(state.nextAt!).toBeGreaterThanOrEqual(state.lastAt!);
			expect(state.lastOutcome).toBe("ok");
		}
		const passes = (6 * 3_600_000 - 600_000) / 90_000;
		// Two pages a pass (two items a page of one), plus a request of extras now and then.
		expect(run.asked.length - before).toBeLessThanOrEqual(passes * 2 + 4);
		expect(run.delays.filter((ms) => ms === 0).length).toBeLessThanOrEqual(
			passes + 4,
		);
	});

	it("backs off after a failure, doubling, and reads on after it", async () => {
		const github: GitHub = { assigned: [], failing: true };
		const run = world(github);
		await run.next();
		expect(run.source.state()).toMatchObject({
			problem: "GitHub answered 502.",
			lastOutcome: "failed",
		});
		expect(run.delays.at(-1)).toBe(180_000);
		await run.next();
		expect(run.delays.at(-1)).toBe(360_000);
		github.failing = false;
		await run.next();
		expect(run.source.state().problem).toBeUndefined();
		expect(run.source.items()).toEqual([]);
		expect(run.delays.at(-1)).toBe(90_000);
	});

	it("says the last poll as sent, in flight while it is out, and the next only after it", async () => {
		let release: (() => void) | undefined;
		const asked: unknown[] = [];
		const clock = { now: START };
		const source = new GitHubItemSource({
			settings: () => ({ projects: ["acme/7"], interval: "90s" }),
			token: () => Promise.resolve({ token: "t" }),
			post: (body) => {
				asked.push(body);
				return new Promise((resolve) => {
					release = () =>
						resolve(
							answerFrom(
								{ assigned: [] },
								body as Parameters<typeof answerFrom>[1],
							),
						);
				});
			},
			setTimer: () => ({ cancel: () => undefined }),
			now: () => clock.now,
		});
		source.follow(true);
		const tick = source.tick();
		await Promise.resolve();
		await Promise.resolve();
		expect(source.state()).toMatchObject({
			lastAt: START,
			lastOutcome: "in_flight",
		});
		expect(source.state().nextAt).toBeUndefined();
		clock.now += 5_000;
		release?.();
		await tick;
		expect(source.state()).toMatchObject({
			lastAt: START,
			lastOutcome: "ok",
			nextAt: START + 5_000 + 90_000,
		});
	});
});

/** A source whose GitHub answers each request with `respond`'s value. */
function raw(
	respond: (body: {
		query: string;
		variables: Record<string, unknown>;
	}) => unknown,
	projects = ["acme/7"],
) {
	const source = new GitHubItemSource({
		settings: () => ({ projects, interval: "90s" }),
		token: () => Promise.resolve({ token: "t" }),
		post: (body) =>
			Promise.resolve(
				respond(
					body as { query: string; variables: Record<string, unknown> },
				) as never,
			),
		setTimer: () => ({ cancel: () => undefined }),
		now: () => START,
	});
	source.follow(true);
	return { source };
}

describe("the GitHub items, never silently unread", () => {
	const scopes = {
		type: "INSUFFICIENT_SCOPES",
		message:
			"Your token has not been granted the required scopes to execute this query. The 'projectItems' field requires one of the following scopes: ['read:project'], but your token has only been granted the: ['gist', 'read:org', 'repo'] scopes.",
	};

	it("names a Project GitHub answers as nothing, though GitHub says nothing of it", async () => {
		const run = raw((body) => answerFrom({ assigned: [], projects: [] }, body));
		await run.source.tick();
		expect(run.source.state().problem).toBe(
			'Project acme/7: GitHub answered no such Project (no owner "acme", or no Project 7 this token can read)',
		);
		expect(run.source.state().problemAt).toBe(START);
	});

	it("says a missing read:project scope while searching, and how to add it", async () => {
		const run = raw((body) => ({
			...answerFrom({ assigned: [] }, body),
			errors: [{ ...scopes, path: ["search", "nodes", 0, "projectItems"] }],
		}));
		await run.source.tick();
		expect(run.source.state().problem).toBe(
			`searching: ${scopes.message} — ${PROJECT_SCOPE_HINT}`,
		);
	});

	it("says the scope's fix when GitHub refuses the whole request for it", async () => {
		const run = raw(() => ({ errors: [scopes] }));
		await run.source.tick();
		expect(run.source.state().problem).toBe(
			`GitHub: ${scopes.message} — ${PROJECT_SCOPE_HINT}`,
		);
		expect(run.source.items()).toBeUndefined();
	});

	it("names each Project, linked item and the details its complaints are about", () => {
		const reading = parseReading(
			{
				data: {
					viewer: { login: ME },
					p0: { projectV2: { title: "A" } },
					p1: null,
					l0: null,
				},
				errors: [
					{
						type: "FORBIDDEN",
						message: "Resource protected by organization SAML enforcement.",
						path: ["p1", "projectV2"],
					},
					{
						type: "NOT_FOUND",
						message: "Could not resolve to a resource with the URL",
						path: ["l0"],
					},
					{
						type: "NOT_FOUND",
						message: "Could not resolve to a node with the global id of 'P1'",
						path: ["pulls", 0],
					},
				],
			},
			{
				search: false,
				boards: ["acme/7", "corp/2"],
				linked: [url(5, "issues")],
			},
		);
		expect(reading.problems).toEqual([
			"Project corp/2: Resource protected by organization SAML enforcement.",
			`linked item ${url(5, "issues")}: Could not resolve to a resource with the URL`,
			"pull request details: Could not resolve to a node with the global id of 'P1'",
		]);
		expect(reading.titles.get("acme/7")).toBe("A");
	});

	it("says nothing is being read while suspended", () => {
		const run = world({ assigned: [] });
		run.source.follow(true, true);
		expect(run.source.state()).toMatchObject({ mode: "suspended" });
		expect(run.source.state().reading).toBeUndefined();
	});
});

describe("the GitHub interval", () => {
	const now = START;
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

	it("asks the rest of a pass at once, unless the rate limit says to slow down", () => {
		expect(nextDelay(90_000, undefined, now, 0, true).ms).toBe(0);
		expect(nextDelay(90_000, rate(4900), now, 0, true).ms).toBe(0);
		expect(nextDelay(90_000, rate(1000), now, 0, true).ms).toBe(180_000);
		expect(nextDelay(90_000, rate(50), now, 0, true).ms).toBe(605_000);
		expect(nextDelay(90_000, undefined, now, 1, true).ms).toBe(180_000);
	});

	it("doubles after each failure, up to a ceiling", () => {
		expect(nextDelay(90_000, undefined, now, 1).ms).toBe(180_000);
		expect(nextDelay(90_000, undefined, now, 9).ms).toBe(MAX_BACKOFF_MS);
	});
});
