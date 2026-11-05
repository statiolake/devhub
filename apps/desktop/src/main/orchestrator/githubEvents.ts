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
 * **What it gives.** The boards' Issues as last read (`issues`), with the
 * pull request that closes each and its review decision, unresolved
 * conversations and checks: what the invariant (`invariant.ts`) reads its
 * population and its facts off. And two events no state shows: someone
 * asks the viewer for a review on a watched board (`github.review_requested`,
 * `diffRequested`), and the author of a pull request the viewer reviewed
 * answers or pushes (`github.reply`, `diffPullRequest`). Each board's first
 * full pass and each pull request's first details are a baseline and say
 * nothing.
 *
 * **The viewer's own activity is never an event.** Their agents post with the
 * same GitHub identity: a push counts as the viewer's when its head commit's
 * author (or committer) is.
 *
 * **Pause, restart.** While the orchestrator's events are paused the source
 * is `suspended`: it does not poll at all, and keeps what it last read. A
 * resume polls at once (the rate limit permitting) and diffs against that, so
 * what changed during the pause is said — the net change, not each flip — in
 * the one message the resume sends. The last reading is also kept on disk
 * (`githubSnapshot.ts`): a start (DevHub restarted, or a new orchestrator in
 * the same profile) diffs its first poll against it, unless the boards or the
 * viewer changed, or it is older than `STALE_SNAPSHOT_MS` — then, as with no
 * snapshot, the first reading is the baseline. Stopping forgets the memory
 * and keeps the file.
 *
 * Where the Workspace watcher already knows a pull request (the Sidebar's
 * branch → PR), its Workspace and agent go on the event (`ws=`, `agent=`).
 */

import {
	parseInterval,
	parseProjectRef,
} from "../../model/orchestratorSettings.js";
import type { EventAgent, EventItem, OrchestratorEvent } from "./events.js";
import {
	SNAPSHOT_VERSION,
	STALE_SNAPSHOT_MS,
	usableSnapshot,
	type SnapshotStore,
} from "./githubSnapshot.js";
import type { IssueFacts, PullFacts } from "./invariant.js";

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
	/**
	 * Who wrote the head commit (its author's, else its committer's, GitHub
	 * login), when GitHub links the commit to an account. The pusher is not
	 * in the API; a push whose last commit is the viewer's counts as theirs.
	 */
	readonly headAuthor?: string;
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
  commits(last:1){ nodes{ commit{ oid author{ user{ login } } committer{ user{ login } }
    statusCheckRollup{ state
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
	const headAuthor =
		login(record(commit?.["author"])?.["user"]) ??
		login(record(commit?.["committer"])?.["user"]);
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
		...(headAuthor === undefined ? {} : { headAuthor }),
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
 * A board's full pass: what relates to the viewer is watched from here
 * (`watched`, every card id that has related to the viewer this session),
 * and the pull requests linked to their Issues.
 */
export function watchBoard(
	after: readonly BoardEntry[],
	viewer: string,
	watched: Set<string>,
): void {
	for (const entry of after) {
		if (relates(entry, viewer)) watched.add(entry.id);
		if (
			entry.kind === "issue" &&
			(relates(entry, viewer) || watched.has(entry.id))
		)
			for (const pull of entry.linked) watched.add(pull.id);
	}
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

/**
 * What on the page is new since the last look: everyone's, the viewer's too —
 * the caller leaves the viewer's out afterwards, so their own comment neither
 * counts nor hides someone else's that came in the same tick, and the next
 * look's cursor is past it all the same (it is in `since` from then on).
 */
function newer<T extends { readonly at: string }>(
	list: readonly T[],
	since: readonly T[],
	countBefore: number,
	countAfter: number,
): T[] {
	const last = since.reduce((max, one) => (one.at > max ? one.at : max), "");
	// Not yet submitted (a pending review): nothing to say until it is.
	const byTime = list.filter((one) => one.at !== "" && one.at > last);
	if (last !== "") return byTime;
	// Nothing to go by but the count: the page is the last few, and the count
	// says how many are new at most — those not yet submitted last time
	// (pending, timeless) are new once they are.
	const unsaid = since.filter((one) => one.at === "").length;
	const fresh = Math.max(0, countAfter - countBefore + unsaid);
	return byTime.slice(Math.max(0, byTime.length - fresh));
}

/**
 * A watched pull request's details against its last ones: new activity by
 * its author on one the viewer reviewed (`github.reply`), the viewer's own
 * left out.
 */
export function diffPullRequest(
	before: PullDetails,
	after: PullDetails,
	context: {
		readonly viewer: string;
		readonly where: WhereLookup;
	},
): OrchestratorEvent[] {
	const { viewer, where } = context;
	const author = after.author;
	if (after.state !== "OPEN" || before.state !== "OPEN") return [];
	const reviewedByMe =
		!same(author, viewer) &&
		after.latestReviews.some((review) => same(review.author, viewer));
	if (!reviewedByMe || author === undefined) return [];
	const reviews = newer(
		after.reviews,
		before.reviews,
		before.reviewCount,
		after.reviewCount,
	);
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
		after.headOid !== before.headOid &&
		!same(after.headAuthor, viewer);
	if (replies === 0 && !commits) return [];
	return [
		{
			type: "github.reply",
			pr: after.item,
			author,
			comments: replies,
			commits,
			...placed(where, after.item.url),
		},
	];
}

/** A pull request's review decision, as a line says it. */
export function reviewWord(decision: string | null): PullFacts["review"] {
	switch (decision) {
		case "APPROVED":
			return "approved";
		case "CHANGES_REQUESTED":
			return "changes_requested";
		case "REVIEW_REQUIRED":
			return "review_required";
		default:
			return "none";
	}
}

/** A checks rollup, as a line says it. */
function checksWord(rollup: string | null): PullFacts["checks"] {
	if (rollup === null) return "none";
	if (rollup === "SUCCESS") return "passing";
	if (FAILING.has(rollup)) return "failing";
	return "pending";
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
	/** Where the last reading is kept across restarts; absent: nowhere. */
	readonly snapshots?: SnapshotStore;
	/** A poll has been read: what `issues` gives may have moved. */
	readonly polled?: () => void;
	/** How it stands (`state()`) moved. */
	readonly changed?: () => void;
	readonly now?: () => number;
	readonly log?: (line: string) => void;
}

interface BoardState {
	/** The board's title, as GitHub last gave it. */
	title?: string;
	/** The last full pass; undefined until the first (the baseline). */
	complete: readonly BoardEntry[] | undefined;
	/** The pass being read, page by page. */
	partial: BoardEntry[];
	after: string | null;
}

/**
 * How the source stands: `active` polls; `suspended` (events paused) sends
 * nothing and keeps what it last read, to diff the next reading against;
 * `idle` (no orchestrator, or no board configured) has forgotten it.
 */
export type GitHubPolling = "active" | "suspended" | "idle";

/** A board's last full pass, counted, for `orchestrator status`. */
export interface BoardCounts {
	readonly ref: string;
	readonly title?: string;
	/** Read in full at least once. */
	readonly read: boolean;
	readonly items: number;
	/** Issues and pull requests assigned to the viewer. */
	readonly assigned: number;
}

/** Whether the rate limit is low enough that polling waits for its reset. */
function rateLimited(rate: RateLimit | undefined, now: number): boolean {
	return (
		rate !== undefined &&
		rate.remaining <= Math.max(100, rate.cost * 20) &&
		rate.resetAt > now
	);
}

export class GitHubEventSource {
	#mode: GitHubPolling = "idle";
	#inFlight: Promise<void> | undefined;
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
	/** When what is remembered was read: the last successful poll. */
	#readAt: number | undefined;
	#nextAt: number | undefined;
	/** The poll a resume asked for, until it is done. */
	#catchUp: Promise<void> | undefined;

	constructor(private readonly ports: GitHubSourcePorts) {}

	#now(): number {
		return (this.ports.now ?? Date.now)();
	}

	/**
	 * Poll while there is an orchestrator and a board to watch, suspended
	 * while its events are paused; else stop and forget.
	 *
	 * Starting (from idle) restores the stored snapshot, if it may be used,
	 * so the first poll is diffed against it. Resuming polls at once (unless
	 * the rate limit says to wait), and `caughtUp()` settles when that poll
	 * has said what it found.
	 */
	follow(active: boolean, paused = false): void {
		const mode: GitHubPolling =
			!active || this.#boardRefs().length === 0
				? "idle"
				: paused
					? "suspended"
					: "active";
		if (mode === this.#mode) return;
		if (mode === "idle") {
			this.stop();
			return;
		}
		const from = this.#mode;
		this.#mode = mode;
		if (from === "idle") this.#restore();
		if (mode === "suspended") {
			this.#timer?.cancel();
			this.#timer = undefined;
			this.#nextAt = undefined;
		} else if (from === "idle") this.#schedule(0);
		else this.#resume();
		this.ports.changed?.();
	}

	/** The poll a resume started, done (its events dispatched). */
	caughtUp(): Promise<void> {
		return this.#catchUp ?? Promise.resolve();
	}

	/** Stop and forget. The stored snapshot stays, for the next start. */
	stop(): void {
		const was = this.#mode;
		this.#mode = "idle";
		this.#timer?.cancel();
		this.#timer = undefined;
		this.ports.snapshots?.flush();
		this.#forget();
		this.#failures = 0;
		this.#nextAt = undefined;
		this.#catchUp = undefined;
		if (was !== "idle") this.ports.changed?.();
	}

	#forget(): void {
		this.#viewer = undefined;
		this.#boards = new Map();
		this.#watched = new Set();
		this.#pulls = new Map();
		this.#requested = undefined;
		this.#readAt = undefined;
	}

	/** The stored snapshot, as the memory the first poll is diffed against. */
	#restore(): void {
		const raw = this.ports.snapshots?.load();
		if (raw === undefined) return;
		const usable = usableSnapshot(raw, this.#boardRefs(), this.#now());
		if ("refused" in usable) {
			this.ports.log?.(
				`[devhub] orchestrator GitHub events: ${usable.refused}; the first poll is a baseline`,
			);
			return;
		}
		const { snapshot } = usable;
		this.#viewer = snapshot.viewer;
		this.#readAt = snapshot.savedAt;
		this.#boards = new Map(
			Object.entries(snapshot.boards).map(([ref, entries]) => [
				ref,
				{ complete: entries, partial: [], after: null },
			]),
		);
		this.#watched = new Set(snapshot.watched);
		this.#pulls = new Map(snapshot.pulls.map((one) => [one.id, one]));
		this.#requested =
			snapshot.requested === null ? undefined : [...snapshot.requested];
	}

	/** Back from a pause: poll now, and diff against what was kept. */
	#resume(): void {
		const now = this.#now();
		if (this.#readAt !== undefined && now - this.#readAt > STALE_SNAPSHOT_MS) {
			this.ports.log?.(
				"[devhub] orchestrator GitHub events: paused for too long; the next poll is a baseline",
			);
			this.#forget();
		}
		if (rateLimited(this.#rate, now)) {
			const base = parseInterval(this.ports.settings().interval) ?? 90_000;
			this.#schedule(nextDelay(base, this.#rate, now).ms);
			this.#catchUp = undefined;
			return;
		}
		this.#timer?.cancel();
		this.#timer = undefined;
		this.#nextAt = now;
		const running = this.#inFlight ?? Promise.resolve();
		const catchUp = running.then(() => this.tick());
		this.#catchUp = catchUp;
		void catchUp.finally(() => {
			if (this.#catchUp === catchUp) this.#catchUp = undefined;
		});
	}

	/** For `orchestrator status` and the board: how the source stands. */
	state(): {
		readonly mode: GitHubPolling;
		readonly running: boolean;
		readonly lastAt?: number;
		readonly nextAt?: number;
		readonly rateLimit?: RateLimit;
		readonly problem?: string;
		readonly watched: number;
		readonly boards: readonly BoardCounts[];
	} {
		return {
			mode: this.#mode,
			running: this.#mode === "active",
			...(this.#lastAt === undefined ? {} : { lastAt: this.#lastAt }),
			...(this.#nextAt === undefined ? {} : { nextAt: this.#nextAt }),
			...(this.#rate === undefined ? {} : { rateLimit: this.#rate }),
			...(this.#problem === undefined ? {} : { problem: this.#problem }),
			watched: this.#pulls.size,
			boards: this.#counts(),
		};
	}

	#counts(): BoardCounts[] {
		const viewer = this.#viewer;
		return this.#boardRefs().map((ref) => {
			const state = this.#boards.get(ref);
			const entries = state?.complete ?? [];
			return {
				ref,
				...(state?.title === undefined ? {} : { title: state.title }),
				read: state?.complete !== undefined,
				items: entries.length,
				assigned:
					viewer === undefined
						? 0
						: entries.filter((entry) =>
								entry.assignees.some((one) => same(one, viewer)),
							).length,
			};
		});
	}

	/**
	 * Every Issue on the watched boards as last read, with the pull request
	 * that closes it; undefined until every board has been read in full (the
	 * population is not known before).
	 */
	issues(): readonly IssueFacts[] | undefined {
		const viewer = this.#viewer;
		if (viewer === undefined || this.#mode === "idle") return undefined;
		const refs = this.#boardRefs();
		if (refs.length === 0) return undefined;
		const out: IssueFacts[] = [];
		const seen = new Set<string>();
		for (const ref of refs) {
			const entries = this.#boards.get(ref)?.complete;
			if (entries === undefined) return undefined;
			for (const entry of entries) {
				if (entry.kind !== "issue" || seen.has(entry.id)) continue;
				seen.add(entry.id);
				const pull =
					entry.linked.find((one) => one.state === "OPEN") ??
					entry.linked.at(-1);
				out.push({
					item: entry.item,
					open: entry.state === "OPEN",
					assignedToMe: entry.assignees.some((one) => same(one, viewer)),
					project: ref,
					lane: entry.status,
					...(pull === undefined ? {} : { pull: this.#pullFacts(pull) }),
				});
			}
		}
		return out;
	}

	#pullFacts(pull: LinkedPull): PullFacts {
		const details = this.#pulls.get(pull.id);
		const state =
			pull.state === "MERGED"
				? "merged"
				: pull.state === "CLOSED"
					? "closed"
					: (details?.draft ?? pull.draft)
						? "draft"
						: "open";
		return {
			number: pull.item.number,
			...(pull.item.url === undefined ? {} : { url: pull.item.url }),
			state,
			review: reviewWord(details?.reviewDecision ?? null),
			unresolved: details?.unresolved ?? 0,
			checks: checksWord(details?.checks ?? null),
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

	/** One request, and its events. Never two at once; none unless active. */
	async tick(): Promise<void> {
		if (this.#mode !== "active" || this.#inFlight !== undefined) return;
		const base = parseInterval(this.ports.settings().interval) ?? 90_000;
		const reading = this.#read();
		this.#inFlight = reading;
		try {
			await reading;
			this.#failures = 0;
		} catch (error) {
			this.#failures += 1;
			this.#say(error instanceof Error ? error.message : String(error));
		} finally {
			this.#inFlight = undefined;
			this.#lastAt = this.#now();
		}
		this.ports.changed?.();
		// Suspended or stopped meanwhile: no next tick until it is resumed.
		if (this.#mode !== "active") return;
		const delay = nextDelay(base, this.#rate, this.#now(), this.#failures);
		this.#schedule(delay.ms);
	}

	async #read(): Promise<void> {
		// A promise from the first line on: `tick` holds it as the one in flight.
		await Promise.resolve();
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
		// Stopped while it was asked: what it says is nobody's.
		if (this.#mode === "idle") return;
		const reading = parseReading(answer, refs);
		this.#say(reading.problems[0]);
		this.#rate = reading.rateLimit ?? this.#rate;
		this.#apply(reading, refs);
		this.#readAt = this.#now();
		this.#store(refs);
	}

	/** What is remembered, for the next DevHub to diff against. */
	#store(refs: readonly string[]): void {
		const viewer = this.#viewer;
		if (this.ports.snapshots === undefined || viewer === undefined) return;
		const boards: Record<string, readonly BoardEntry[]> = {};
		for (const [ref, state] of this.#boards)
			if (state.complete !== undefined) boards[ref] = state.complete;
		this.ports.snapshots.save({
			version: SNAPSHOT_VERSION,
			savedAt: this.#readAt ?? this.#now(),
			viewer,
			projects: [...refs].sort(),
			boards,
			watched: [...this.#watched],
			pulls: [...this.#pulls.values()],
			requested: this.#requested ?? null,
		});
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

	#apply(reading: GitHubReading, refs: readonly string[]): void {
		const viewer = reading.viewer;
		// Another login than the one remembered: its boards are a baseline.
		if (this.#viewer !== undefined && !same(this.#viewer, viewer)) {
			this.ports.log?.(
				`[devhub] orchestrator GitHub events: the viewer is ${viewer} now, not ${this.#viewer}; this poll is a baseline`,
			);
			this.#forget();
			for (const ref of refs)
				this.#boards.set(ref, {
					complete: undefined,
					partial: [],
					after: null,
				});
		}
		this.#viewer = viewer;
		const where = this.ports.where;
		const events: OrchestratorEvent[] = [];
		for (const ref of refs) {
			const page = reading.pages.get(ref);
			const state = this.#boards.get(ref);
			if (page === undefined || state === undefined) continue;
			state.title = page.title;
			state.partial.push(...page.entries);
			if (page.next !== null) {
				state.after = page.next;
				continue;
			}
			const pass = state.partial;
			state.partial = [];
			state.after = null;
			watchBoard(pass, viewer, this.#watched);
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
				events.push(...diffPullRequest(before, details, { viewer, where }));
			this.#pulls.set(id, details);
		}
		// Finished ones are no longer asked about.
		for (const [id, details] of [...this.#pulls])
			if (details.state !== "OPEN") {
				this.#pulls.delete(id);
				this.#watched.delete(id);
			}
		for (const event of events) this.ports.dispatch(event);
		this.ports.polled?.();
	}
}
