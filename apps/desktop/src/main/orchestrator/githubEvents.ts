/**
 * The GitHub event source: the team's Projects (v2) boards, read — never
 * written — and diffed into `github.*` events for the orchestrator.
 *
 * **What is watched.** The items on the configured boards
 * (`[orchestrator.github] projects`) that relate to the viewer — assigned to
 * them, authored by them, their review requested — and the pull requests
 * linked to those Issues (GitHub's "closed by" references). An item that
 * related to the viewer stays watched for the session (an Issue the
 * request-review skill unassigned and moved to In Review is still theirs).
 *
 * **One request per tick**, never two in flight, no `gh` subcommands (the
 * token is `gh auth token`'s, read as the Workspace watcher reads it, and the
 * request goes through the same client, `postGraphQl`). Each tick asks for:
 *
 * - `viewer { login }` and `rateLimit { cost remaining limit resetAt }`;
 * - one page (100) of each board's items: type, number, url, title, the
 *   Status field, assignees, author; for an Issue, its linked pull requests.
 *   A board bigger than a page is read a page a tick, and diffed once the
 *   whole of it has been read;
 * - `search(review-requested:@me is:open)`, the pull requests waiting on the
 *   viewer's review;
 * - `nodes(ids:)` for the pull requests being watched: state, draft,
 *   reviewDecision, latest reviews, the last reviews and comments, review
 *   threads (unresolved count), and the head commit's checks rollup.
 *
 * Typically 2–6 points of GitHub's 5,000 an hour.
 *
 * **The interval** starts at `[orchestrator.github] interval` and only ever
 * backs off from it (`nextDelay`): slower as `remaining` falls, paused until
 * `resetAt` when it is low, doubling after a failure.
 *
 * **Events** come of diffing each reading against the last (`diffBoard`,
 * `diffPullRequests`, `diffRequested`). The first reading after a start is the
 * baseline and says nothing — and so is each board's first full pass, and
 * each pull request's first details.
 *
 * Where the Workspace watcher already knows a pull request (the Sidebar's
 * branch → PR), its Workspace and agent go on the event (`ws=`, `agent=`).
 */

import {
	parseInterval,
	parseProjectRef,
} from "../../model/orchestratorSettings.js";
import type { EventAgent, EventItem, OrchestratorEvent } from "./events.js";

// --- the snapshot ----------------------------------------------------------------

export interface LinkedPull {
	readonly id: string;
	readonly item: EventItem;
	readonly state: "OPEN" | "CLOSED" | "MERGED";
	readonly draft: boolean;
	readonly author?: string;
}

/** One card on a board, as one tick reads it. */
export interface BoardEntry {
	/** The card's own id (`ProjectV2Item`). */
	readonly itemId: string;
	readonly kind: "issue" | "pr";
	/** The Issue's or pull request's node id. */
	readonly id: string;
	readonly item: EventItem;
	readonly state: string;
	readonly draft: boolean;
	/** The Status field's option; null when none is set. */
	readonly status: string | null;
	readonly assignees: readonly string[];
	readonly author?: string;
	/** For an Issue: the pull requests that close it. */
	readonly linked: readonly LinkedPull[];
}

export interface PullReview {
	readonly author: string;
	readonly state: string;
	readonly at: string;
}

/** A watched pull request's details. */
export interface PullDetails {
	readonly id: string;
	readonly item: EventItem;
	readonly state: "OPEN" | "CLOSED" | "MERGED";
	readonly draft: boolean;
	readonly author?: string;
	readonly reviewDecision: string | null;
	/** Each reviewer's latest review state. */
	readonly latestReviews: readonly PullReview[];
	/** The last few reviews, oldest first, and how many there are. */
	readonly reviews: readonly PullReview[];
	readonly reviewCount: number;
	readonly threads: number;
	readonly unresolved: number;
	/** The last few conversation comments, oldest first, and how many. */
	readonly comments: readonly {
		readonly author: string;
		readonly at: string;
	}[];
	readonly commentCount: number;
	readonly headOid: string | null;
	/** The head commit's rollup: SUCCESS, FAILURE, ERROR, PENDING, EXPECTED. */
	readonly checks: string | null;
	readonly checksFailing: number;
	readonly checksTotal: number;
}

export interface RequestedPull {
	readonly id: string;
	readonly item: EventItem;
	readonly author?: string;
}

export interface RateLimit {
	readonly cost: number;
	readonly remaining: number;
	readonly limit: number;
	/** ms since the epoch. */
	readonly resetAt: number;
}

/** One answer, parsed. */
export interface GitHubReading {
	readonly viewer: string;
	readonly rateLimit?: RateLimit;
	/** Per board (`owner/number`): the page read, and where the next starts. */
	readonly pages: ReadonlyMap<
		string,
		{
			readonly title: string;
			readonly entries: readonly BoardEntry[];
			readonly next: string | null;
		}
	>;
	readonly requested: readonly RequestedPull[];
	readonly pulls: ReadonlyMap<string, PullDetails>;
	/** GitHub's complaints that did not stop the answer (a board it cannot read). */
	readonly problems: readonly string[];
}

// --- the query -------------------------------------------------------------------

/** One page of a board. */
export const ITEMS_PER_PAGE = 100;
/** How many linked pull requests of an Issue are read. */
const LINKED_PER_ISSUE = 5;
/** How many pull requests have their details read each tick. */
export const MAX_WATCHED_PULLS = 30;

const PULL_DETAILS = `id number title url state isDraft reviewDecision
  repository{ nameWithOwner } author{ login }
  latestReviews(first:20){ nodes{ author{ login } state submittedAt } }
  reviews(last:10){ totalCount nodes{ author{ login } state submittedAt } }
  reviewThreads(first:100){ totalCount nodes{ isResolved } }
  comments(last:5){ totalCount nodes{ author{ login } createdAt } }
  commits(last:1){ nodes{ commit{ oid statusCheckRollup{ state
    contexts{ totalCount checkRunCountsByState{ state count } statusContextCountsByState{ state count } }
  } } } }`;

const BOARD_ITEM = `id
  status: fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue{ name } }
  content{
    __typename
    ... on Issue{ id number title url state repository{ nameWithOwner } author{ login }
      assignees(first:10){ nodes{ login } }
      closedByPullRequestsReferences(first:${String(LINKED_PER_ISSUE)}, includeClosedPrs:true){
        nodes{ id number title url state isDraft author{ login } repository{ nameWithOwner } } } }
    ... on PullRequest{ id number title url state isDraft repository{ nameWithOwner } author{ login }
      assignees(first:10){ nodes{ login } } }
  }`;

/** The one request of a tick: every board's next page, the review requests, the watched details. */
export function githubQuery(
	boards: readonly {
		readonly owner: string;
		readonly number: number;
		readonly after: string | null;
	}[],
	pulls: readonly string[],
): { readonly query: string; readonly variables: Record<string, unknown> } {
	const declarations: string[] = [];
	const selections: string[] = [];
	const variables: Record<string, unknown> = {};
	for (const [index, board] of boards.entries()) {
		const at = String(index);
		declarations.push(`$o${at}:String!`, `$n${at}:Int!`, `$a${at}:String`);
		variables[`o${at}`] = board.owner;
		variables[`n${at}`] = board.number;
		variables[`a${at}`] = board.after;
		selections.push(
			`p${at}: repositoryOwner(login:$o${at}){ ... on ProjectV2Owner{ projectV2(number:$n${at}){ title
    items(first:${String(ITEMS_PER_PAGE)}, after:$a${at}){ pageInfo{ hasNextPage endCursor } nodes{ ${BOARD_ITEM} } } } } }`,
		);
	}
	declarations.push("$pulls:[ID!]!", "$wantPulls:Boolean!");
	variables["pulls"] = pulls;
	variables["wantPulls"] = pulls.length > 0;
	const query = `query(${declarations.join(",")}){
  viewer{ login }
  rateLimit{ cost remaining limit resetAt }
  ${selections.join("\n  ")}
  requested: search(type:ISSUE, query:"is:pr is:open archived:false review-requested:@me", first:30){
    nodes{ ... on PullRequest{ id number title url author{ login } repository{ nameWithOwner } } } }
  pulls: nodes(ids:$pulls) @include(if:$wantPulls){ ... on PullRequest{ ${PULL_DETAILS} } }
}`;
	return { query, variables };
}

// --- parsing ---------------------------------------------------------------------

type Json = Record<string, unknown>;

function record(value: unknown): Json | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Json)
		: undefined;
}

function nodes(value: unknown): Json[] {
	const list = record(value)?.["nodes"];
	return Array.isArray(list)
		? list.flatMap((one) => {
				const node = record(one);
				return node === undefined ? [] : [node];
			})
		: [];
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number {
	return typeof value === "number" ? value : 0;
}

function login(value: unknown): string | undefined {
	return str(record(value)?.["login"]);
}

function itemOf(node: Json): EventItem {
	return {
		repo: str(record(node["repository"])?.["nameWithOwner"]) ?? "",
		number: num(node["number"]),
		...(str(node["title"]) === undefined ? {} : { title: str(node["title"])! }),
		...(str(node["url"]) === undefined ? {} : { url: str(node["url"])! }),
	};
}

function pullState(value: unknown): "OPEN" | "CLOSED" | "MERGED" {
	const state = str(value)?.toUpperCase();
	return state === "MERGED" ? "MERGED" : state === "CLOSED" ? "CLOSED" : "OPEN";
}

function reviewsOf(value: unknown): PullReview[] {
	return nodes(value).map((node) => ({
		author: login(node["author"]) ?? "",
		state: str(node["state"])?.toUpperCase() ?? "",
		at: str(node["submittedAt"]) ?? "",
	}));
}

const FAILING = new Set([
	"FAILURE",
	"ERROR",
	"CANCELLED",
	"TIMED_OUT",
	"STARTUP_FAILURE",
	"ACTION_REQUIRED",
]);

export function parseDetails(node: Json): PullDetails | undefined {
	const id = str(node["id"]);
	if (id === undefined || node["number"] === undefined) return undefined;
	const threads = record(node["reviewThreads"]);
	const reviews = record(node["reviews"]);
	const comments = record(node["comments"]);
	const commit = record(nodes(node["commits"])[0]?.["commit"]);
	const rollup = record(commit?.["statusCheckRollup"]);
	const contexts = record(rollup?.["contexts"]);
	const counts = [
		...((contexts?.["checkRunCountsByState"] as unknown[] | null) ?? []),
		...((contexts?.["statusContextCountsByState"] as unknown[] | null) ?? []),
	].flatMap((one) => {
		const count = record(one);
		return count === undefined ? [] : [count];
	});
	const author = login(node["author"]);
	return {
		id,
		item: itemOf(node),
		state: pullState(node["state"]),
		draft: node["isDraft"] === true,
		...(author === undefined ? {} : { author }),
		reviewDecision: str(node["reviewDecision"]) ?? null,
		latestReviews: reviewsOf(node["latestReviews"]),
		reviews: reviewsOf(reviews),
		reviewCount: num(reviews?.["totalCount"]),
		threads: num(threads?.["totalCount"]),
		unresolved: nodes(threads).filter((one) => one["isResolved"] === false)
			.length,
		comments: nodes(comments).map((one) => ({
			author: login(one["author"]) ?? "",
			at: str(one["createdAt"]) ?? "",
		})),
		commentCount: num(comments?.["totalCount"]),
		headOid: str(commit?.["oid"]) ?? null,
		checks: str(rollup?.["state"])?.toUpperCase() ?? null,
		checksFailing: counts
			.filter((count) => FAILING.has(str(count["state"])?.toUpperCase() ?? ""))
			.reduce((sum, count) => sum + num(count["count"]), 0),
		checksTotal: num(contexts?.["totalCount"]),
	};
}

function entryOf(node: Json): BoardEntry | undefined {
	const itemId = str(node["id"]);
	const content = record(node["content"]);
	const type = str(content?.["__typename"]);
	if (
		itemId === undefined ||
		content === undefined ||
		(type !== "Issue" && type !== "PullRequest")
	)
		return undefined;
	const id = str(content["id"]);
	if (id === undefined) return undefined;
	const author = login(content["author"]);
	return {
		itemId,
		kind: type === "Issue" ? "issue" : "pr",
		id,
		item: itemOf(content),
		state: str(content["state"])?.toUpperCase() ?? "OPEN",
		draft: content["isDraft"] === true,
		status: str(record(node["status"])?.["name"]) ?? null,
		assignees: nodes(content["assignees"]).flatMap((one) => {
			const name = str(one["login"]);
			return name === undefined ? [] : [name];
		}),
		...(author === undefined ? {} : { author }),
		linked: nodes(content["closedByPullRequestsReferences"]).flatMap(
			(pull): LinkedPull[] => {
				const pullId = str(pull["id"]);
				if (pullId === undefined) return [];
				const by = login(pull["author"]);
				return [
					{
						id: pullId,
						item: itemOf(pull),
						state: pullState(pull["state"]),
						draft: pull["isDraft"] === true,
						...(by === undefined ? {} : { author: by }),
					},
				];
			},
		),
	};
}

/** An answer, as the source reads it. Throws only when it has no data at all. */
export function parseReading(
	answer: {
		readonly data?: unknown;
		readonly errors?:
			| readonly { readonly message?: string; readonly type?: string }[]
			| null;
	},
	boards: readonly string[],
): GitHubReading {
	const data = record(answer.data);
	const problems = (answer.errors ?? []).flatMap((one) =>
		one.message === undefined ? [] : [one.message],
	);
	const viewer = login(data?.["viewer"]);
	if (data === undefined || viewer === undefined)
		throw new Error(problems[0] ?? "GitHub answered without data.");
	const rate = record(data["rateLimit"]);
	const pages = new Map<
		string,
		{ title: string; entries: BoardEntry[]; next: string | null }
	>();
	for (const [index, board] of boards.entries()) {
		const project = record(record(data[`p${String(index)}`])?.["projectV2"]);
		if (project === undefined) continue;
		const items = record(project["items"]);
		const pageInfo = record(items?.["pageInfo"]);
		pages.set(board, {
			title: str(project["title"]) ?? board,
			entries: nodes(items).flatMap((node) => {
				const entry = entryOf(node);
				return entry === undefined ? [] : [entry];
			}),
			next:
				pageInfo?.["hasNextPage"] === true
					? (str(pageInfo["endCursor"]) ?? null)
					: null,
		});
	}
	const pulls = new Map<string, PullDetails>();
	for (const one of Array.isArray(data["pulls"]) ? data["pulls"] : []) {
		const node = record(one);
		const details = node === undefined ? undefined : parseDetails(node);
		if (details !== undefined) pulls.set(details.id, details);
	}
	return {
		viewer,
		...(rate === undefined
			? {}
			: {
					rateLimit: {
						cost: num(rate["cost"]),
						remaining: num(rate["remaining"]),
						limit: num(rate["limit"]) || 5000,
						resetAt: Date.parse(str(rate["resetAt"]) ?? "") || 0,
					},
				}),
		pages,
		requested: nodes(data["requested"]).flatMap((node): RequestedPull[] => {
			const id = str(node["id"]);
			if (id === undefined) return [];
			const author = login(node["author"]);
			return [
				{ id, item: itemOf(node), ...(author === undefined ? {} : { author }) },
			];
		}),
		pulls,
		problems,
	};
}

// --- the diff ----------------------------------------------------------------------

/** Where an Issue's or pull request's work is open in DevHub. */
export type WhereLookup = (
	url: string | undefined,
) => { readonly ws?: string; readonly agent?: EventAgent } | undefined;

function placed(
	where: WhereLookup,
	url: string | undefined,
): { ws?: string; agent?: EventAgent } {
	const found = where(url);
	return {
		...(found?.ws === undefined ? {} : { ws: found.ws }),
		...(found?.agent === undefined ? {} : { agent: found.agent }),
	};
}

function same(a: string | undefined, b: string): boolean {
	return a !== undefined && a.toLowerCase() === b.toLowerCase();
}

/** Whether a card is the viewer's: assigned to them, or theirs. */
export function relates(entry: BoardEntry, viewer: string): boolean {
	return (
		entry.assignees.some((one) => same(one, viewer)) ||
		same(entry.author, viewer)
	);
}

/**
 * A board's full pass against its last one. `watched` is every card id that
 * has related to the viewer this session (and is added to here).
 */
export function diffBoard(
	project: string,
	before: readonly BoardEntry[],
	after: readonly BoardEntry[],
	context: {
		readonly viewer: string;
		readonly watched: Set<string>;
		readonly where: WhereLookup;
	},
): OrchestratorEvent[] {
	const { viewer, watched, where } = context;
	const events: OrchestratorEvent[] = [];
	const earlier = new Map(before.map((entry) => [entry.itemId, entry]));
	for (const entry of after) {
		const was = earlier.get(entry.itemId);
		const related = relates(entry, viewer) || watched.has(entry.id);
		if (relates(entry, viewer)) watched.add(entry.id);
		if (!related) continue;
		const at = placed(where, entry.item.url);
		const mineNow = entry.assignees.some((one) => same(one, viewer));
		const mineBefore = was?.assignees.some((one) => same(one, viewer)) ?? false;
		if (mineNow !== mineBefore)
			events.push({
				type: mineNow ? "github.assigned" : "github.unassigned",
				item: entry.item,
				kind: entry.kind,
				login: viewer,
				...at,
			});
		if (was !== undefined && was.status !== entry.status)
			events.push({
				type: "github.lane_changed",
				item: entry.item,
				kind: entry.kind,
				project,
				from: was.status,
				to: entry.status,
				...at,
			});
		// A pull request that is the viewer's, new on the board.
		if (
			was === undefined &&
			entry.kind === "pr" &&
			entry.state === "OPEN" &&
			same(entry.author, viewer)
		)
			events.push({
				type: "github.pr_opened",
				pr: entry.item,
				...(entry.author === undefined ? {} : { author: entry.author }),
				draft: entry.draft,
				...at,
			});
		// Pull requests newly linked to the viewer's Issue.
		if (entry.kind === "issue") {
			const known = new Set(was?.linked.map((pull) => pull.id) ?? []);
			for (const pull of entry.linked) {
				watched.add(pull.id);
				if (was === undefined || known.has(pull.id) || pull.state !== "OPEN")
					continue;
				events.push({
					type: "github.pr_opened",
					pr: pull.item,
					...(pull.author === undefined ? {} : { author: pull.author }),
					draft: pull.draft,
					issue: entry.item.number,
					...placed(where, pull.item.url),
				});
			}
		}
	}
	return events;
}

/** The review requests against the last ones: new ones on watched boards. */
export function diffRequested(
	before: readonly RequestedPull[],
	after: readonly RequestedPull[],
	onBoards: ReadonlySet<string>,
	where: WhereLookup,
): OrchestratorEvent[] {
	const known = new Set(before.map((one) => one.id));
	return after
		.filter((one) => !known.has(one.id) && onBoards.has(one.id))
		.map((one) => ({
			type: "github.review_requested" as const,
			pr: one.item,
			...(one.author === undefined ? {} : { author: one.author }),
			...placed(where, one.item.url),
		}));
}

function newer<T extends { readonly at: string }>(
	list: readonly T[],
	since: readonly T[],
	countBefore: number,
	countAfter: number,
): T[] {
	const last = since.reduce((max, one) => (one.at > max ? one.at : max), "");
	const byTime = list.filter((one) => one.at > last);
	// The page is the last few; the count says how many are new at most.
	const fresh = Math.max(0, countAfter - countBefore);
	return byTime.slice(Math.max(0, byTime.length - fresh));
}

/** A watched pull request's details against its last ones. */
export function diffPullRequest(
	before: PullDetails,
	after: PullDetails,
	context: {
		readonly viewer: string;
		/** It is the viewer's: theirs, or linked to their Issue. */
		readonly mine: boolean;
		readonly where: WhereLookup;
	},
): OrchestratorEvent[] {
	const { viewer, mine, where } = context;
	const events: OrchestratorEvent[] = [];
	const pr = after.item;
	const at = placed(where, pr.url);
	const author = after.author;
	const reviewedByMe =
		!same(author, viewer) &&
		after.latestReviews.some((review) => same(review.author, viewer));
	if (before.state === "OPEN" && after.state === "MERGED") {
		events.push({ type: "github.pr_merged", pr, ...at });
		return events;
	}
	if (before.state === "OPEN" && after.state === "CLOSED") {
		events.push({ type: "github.pr_closed", pr, ...at });
		return events;
	}
	if (after.state !== "OPEN") return events;
	if (before.draft && !after.draft)
		events.push({
			type: "github.pr_ready",
			pr,
			...(author === undefined ? {} : { author }),
			...at,
		});
	const reviews = newer(
		after.reviews,
		before.reviews,
		before.reviewCount,
		after.reviewCount,
	);
	if (mine) {
		const others = reviews.filter(
			(review) => !same(review.author, author ?? ""),
		);
		const by = (state: string) => [
			...new Set(
				others
					.filter((review) => review.state === state)
					.map((review) => review.author),
			),
		];
		const approved = by("APPROVED");
		if (approved.length > 0)
			events.push({ type: "github.pr_approved", pr, by: approved, ...at });
		const changes = by("CHANGES_REQUESTED");
		if (changes.length > 0)
			events.push({
				type: "github.changes_requested",
				pr,
				by: changes,
				...at,
			});
		const commented = others.filter((review) => review.state === "COMMENTED");
		const count = Math.max(
			commented.length,
			Math.max(0, after.threads - before.threads),
		);
		if (count > 0)
			events.push({
				type: "github.review_comment",
				pr,
				count,
				authors: [...new Set(commented.map((review) => review.author))],
				unresolved: after.unresolved,
				...at,
			});
		const finished = (state: string | null) =>
			state === "SUCCESS" || state === "FAILURE" || state === "ERROR";
		if (
			finished(after.checks) &&
			(after.checks !== before.checks || after.headOid !== before.headOid)
		)
			events.push({
				type: "github.checks",
				pr,
				result: after.checks === "SUCCESS" ? "passed" : "failed",
				...(after.checks === "SUCCESS"
					? {}
					: { failing: after.checksFailing, total: after.checksTotal }),
				...at,
			});
	}
	if (reviewedByMe && author !== undefined) {
		const replies =
			reviews.filter((review) => same(review.author, author)).length +
			newer(
				after.comments,
				before.comments,
				before.commentCount,
				after.commentCount,
			).filter((comment) => same(comment.author, author)).length;
		const commits =
			after.headOid !== null &&
			before.headOid !== null &&
			after.headOid !== before.headOid;
		if (replies > 0 || commits)
			events.push({
				type: "github.reply",
				pr,
				author,
				comments: replies,
				commits,
				...at,
			});
	}
	return events;
}

// --- the interval ----------------------------------------------------------------

/** The most a failure backs off to. */
export const MAX_BACKOFF_MS = 15 * 60_000;

/**
 * How long until the next tick: the base, slower as the rate limit runs
 * down, paused until it resets when it is low; never faster than the base.
 */
export function nextDelay(
	baseMs: number,
	rate: RateLimit | undefined,
	now: number,
	failures = 0,
): { readonly ms: number; readonly why: string } {
	if (failures > 0)
		return {
			ms: Math.min(MAX_BACKOFF_MS, baseMs * 2 ** Math.min(failures, 10)),
			why: `backing off after ${String(failures)} failure(s)`,
		};
	if (rate === undefined) return { ms: baseMs, why: "base interval" };
	const floor = Math.max(100, rate.cost * 20);
	if (rate.remaining <= floor && rate.resetAt > now)
		return {
			ms: Math.max(baseMs, rate.resetAt - now + 5_000),
			why: `rate limit low (${String(rate.remaining)} left): paused until it resets`,
		};
	const share = rate.limit > 0 ? rate.remaining / rate.limit : 1;
	const factor = share < 0.1 ? 4 : share < 0.25 ? 2 : share < 0.5 ? 1.5 : 1;
	return {
		ms: Math.round(baseMs * factor),
		why:
			factor === 1
				? "base interval"
				: `rate limit at ${String(Math.round(share * 100))}%: ${String(factor)}× slower`,
	};
}

// --- the poller ------------------------------------------------------------------

export interface GitHubSourcePorts {
	/** `[orchestrator.github]` now. */
	readonly settings: () => {
		readonly projects: readonly string[];
		readonly interval: string;
	};
	/** The token, or why there is none (said once). */
	readonly token: () => Promise<
		{ readonly token: string } | { readonly problem: string }
	>;
	readonly post: (
		body: { readonly query: string; readonly variables: unknown },
		token: string,
	) => Promise<{
		readonly data?: unknown;
		readonly errors?:
			| readonly { readonly message?: string; readonly type?: string }[]
			| null;
	}>;
	readonly dispatch: (event: OrchestratorEvent) => void;
	readonly where: WhereLookup;
	readonly setTimer: (ms: number, run: () => void) => { cancel(): void };
	readonly now?: () => number;
	readonly log?: (line: string) => void;
}

interface BoardState {
	/** The last full pass; undefined until the first (the baseline). */
	complete: readonly BoardEntry[] | undefined;
	/** The pass being read, page by page. */
	partial: BoardEntry[];
	after: string | null;
}

export class GitHubEventSource {
	#running = false;
	#inFlight = false;
	#timer: { cancel(): void } | undefined;
	#failures = 0;
	#rate: RateLimit | undefined;
	#viewer: string | undefined;
	#boards = new Map<string, BoardState>();
	/** Cards (Issues, pull requests) that related to the viewer this session. */
	#watched = new Set<string>();
	#pulls = new Map<string, PullDetails>();
	#requested: RequestedPull[] | undefined;
	#problem: string | undefined;
	#lastAt: number | undefined;
	#nextAt: number | undefined;

	constructor(private readonly ports: GitHubSourcePorts) {}

	#now(): number {
		return (this.ports.now ?? Date.now)();
	}

	/** Run while there is an orchestrator and a board to watch; else stop and forget. */
	follow(active: boolean): void {
		const wanted = active && this.#boardRefs().length > 0;
		if (wanted === this.#running) return;
		if (wanted) {
			this.#running = true;
			this.#schedule(0);
		} else this.stop();
	}

	stop(): void {
		this.#running = false;
		this.#timer?.cancel();
		this.#timer = undefined;
		this.#failures = 0;
		this.#viewer = undefined;
		this.#boards = new Map();
		this.#watched = new Set();
		this.#pulls = new Map();
		this.#requested = undefined;
		this.#nextAt = undefined;
	}

	/** For `orchestrator status`: how the source stands. */
	state(): {
		readonly running: boolean;
		readonly lastAt?: number;
		readonly nextAt?: number;
		readonly rateLimit?: RateLimit;
		readonly problem?: string;
		readonly watched: number;
	} {
		return {
			running: this.#running,
			...(this.#lastAt === undefined ? {} : { lastAt: this.#lastAt }),
			...(this.#nextAt === undefined ? {} : { nextAt: this.#nextAt }),
			...(this.#rate === undefined ? {} : { rateLimit: this.#rate }),
			...(this.#problem === undefined ? {} : { problem: this.#problem }),
			watched: this.#pulls.size,
		};
	}

	#boardRefs(): string[] {
		return this.ports
			.settings()
			.projects.filter((ref) => parseProjectRef(ref) !== undefined);
	}

	#schedule(ms: number): void {
		this.#timer?.cancel();
		this.#nextAt = this.#now() + ms;
		this.#timer = this.ports.setTimer(ms, () => {
			this.#timer = undefined;
			void this.tick();
		});
	}

	#say(problem: string | undefined): void {
		if (problem !== undefined && problem !== this.#problem)
			this.ports.log?.(`[devhub] orchestrator GitHub events: ${problem}`);
		this.#problem = problem;
	}

	/** One request, and its events. Never two at once. */
	async tick(): Promise<void> {
		if (!this.#running || this.#inFlight) return;
		this.#inFlight = true;
		const base = parseInterval(this.ports.settings().interval) ?? 90_000;
		try {
			await this.#read();
			this.#failures = 0;
		} catch (error) {
			this.#failures += 1;
			this.#say(error instanceof Error ? error.message : String(error));
		} finally {
			this.#inFlight = false;
			this.#lastAt = this.#now();
		}
		if (!this.#running) return;
		const delay = nextDelay(base, this.#rate, this.#now(), this.#failures);
		this.#schedule(delay.ms);
	}

	async #read(): Promise<void> {
		const refs = this.#boardRefs();
		for (const ref of [...this.#boards.keys()])
			if (!refs.includes(ref)) this.#boards.delete(ref);
		const credentials = await this.ports.token();
		if ("problem" in credentials) throw new Error(credentials.problem);
		const boards = refs.map((ref) => {
			const state =
				this.#boards.get(ref) ??
				({ complete: undefined, partial: [], after: null } as BoardState);
			this.#boards.set(ref, state);
			const parsed = parseProjectRef(ref)!;
			return {
				ref,
				owner: parsed.owner,
				number: parsed.number,
				after: state.after,
			};
		});
		const pulls = [...this.#watchedPulls()];
		const request = githubQuery(boards, pulls);
		const answer = await this.ports.post(request, credentials.token);
		const reading = parseReading(answer, refs);
		this.#say(reading.problems[0]);
		this.#rate = reading.rateLimit ?? this.#rate;
		this.#apply(reading, refs);
	}

	/** The pull requests whose details are read: the viewer's, linked, requested, reviewed. */
	#watchedPulls(): Set<string> {
		// The ones already watched first, so the cap never drops one mid-way:
		// a merge or a close is read off their details.
		const ids = new Set<string>(
			[...this.#pulls]
				.filter(([, details]) => details.state === "OPEN")
				.map(([id]) => id),
		);
		const viewer = this.#viewer;
		if (viewer === undefined) return ids;
		for (const state of this.#boards.values())
			for (const entry of state.complete ?? []) {
				const related = relates(entry, viewer) || this.#watched.has(entry.id);
				if (entry.kind === "pr" && related && entry.state === "OPEN")
					ids.add(entry.id);
				if (entry.kind === "issue" && related)
					for (const pull of entry.linked)
						if (pull.state === "OPEN") ids.add(pull.id);
			}
		for (const one of this.#requested ?? [])
			if (this.#onBoards().has(one.id)) ids.add(one.id);
		return new Set([...ids].slice(0, MAX_WATCHED_PULLS));
	}

	/** Every pull request on a board, or linked to an Issue on one. */
	#onBoards(): Set<string> {
		const ids = new Set<string>();
		for (const state of this.#boards.values())
			for (const entry of state.complete ?? []) {
				if (entry.kind === "pr") ids.add(entry.id);
				for (const pull of entry.linked) ids.add(pull.id);
			}
		return ids;
	}

	/** The viewer's pull requests: theirs, or linked to their Issue. */
	#mine(id: string, details: PullDetails, viewer: string): boolean {
		if (same(details.author, viewer)) return true;
		for (const state of this.#boards.values())
			for (const entry of state.complete ?? [])
				if (
					entry.kind === "issue" &&
					(relates(entry, viewer) || this.#watched.has(entry.id)) &&
					entry.linked.some((pull) => pull.id === id)
				)
					return true;
		return false;
	}

	#apply(reading: GitHubReading, refs: readonly string[]): void {
		const viewer = reading.viewer;
		this.#viewer = viewer;
		const where = this.ports.where;
		const events: OrchestratorEvent[] = [];
		for (const ref of refs) {
			const page = reading.pages.get(ref);
			const state = this.#boards.get(ref);
			if (page === undefined || state === undefined) continue;
			state.partial.push(...page.entries);
			if (page.next !== null) {
				state.after = page.next;
				continue;
			}
			const pass = state.partial;
			state.partial = [];
			state.after = null;
			if (state.complete === undefined) {
				// The baseline: what relates to the viewer now is watched from here.
				for (const entry of pass)
					if (relates(entry, viewer)) {
						this.#watched.add(entry.id);
						for (const pull of entry.linked) this.#watched.add(pull.id);
					}
			} else
				events.push(
					...diffBoard(ref, state.complete, pass, {
						viewer,
						watched: this.#watched,
						where,
					}),
				);
			state.complete = pass;
		}
		if (this.#requested !== undefined)
			events.push(
				...diffRequested(
					this.#requested,
					reading.requested,
					this.#onBoards(),
					where,
				),
			);
		this.#requested = [...reading.requested];
		for (const one of reading.requested)
			if (this.#onBoards().has(one.id)) this.#watched.add(one.id);
		for (const [id, details] of reading.pulls) {
			const before = this.#pulls.get(id);
			if (
				!same(details.author, viewer) &&
				details.latestReviews.some((review) => same(review.author, viewer))
			)
				this.#watched.add(id);
			if (before !== undefined)
				events.push(
					...diffPullRequest(before, details, {
						viewer,
						mine: this.#mine(id, details, viewer),
						where,
					}),
				);
			this.#pulls.set(id, details);
		}
		// Finished ones are no longer asked about.
		for (const [id, details] of [...this.#pulls])
			if (details.state !== "OPEN") {
				this.#pulls.delete(id);
				this.#watched.delete(id);
			}
		// A pull request on the board and linked to an Issue is opened once.
		const opened = new Set<string>();
		for (const event of events) {
			if (event.type === "github.pr_opened") {
				const key = `${event.pr.repo}#${String(event.pr.number)}`;
				if (opened.has(key)) continue;
				opened.add(key);
			}
			this.ports.dispatch(event);
		}
	}
}
