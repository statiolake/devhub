/**
 * The GitHub source: the items — Issues and pull requests alike — the
 * invariant (`invariant.ts`) is read off, read and never written.
 *
 * **What is read.** The population is asked of GitHub directly: one search,
 * `is:open assignee:@me archived:false` (`SEARCH_QUERY`, 100 a page — one
 * page, as a rule), giving each open Issue and pull request assigned to the
 * viewer with its state, assignees and the Projects it is on (its
 * `projectItems`, each with its lane, the Status field). An item is in the
 * population when one of those is a registered Project (`[orchestrator.github]
 * projects`); an item on several is one item, with a lane on each. An Issue
 * and a pull request are one thing here, an **item**: a pull request is an
 * item as an Issue is, whether or not an Issue goes with it. With no Project
 * registered there is nothing to read, and the population is empty. No
 * Project is read in full: a Project of thousands of cards (Done, closed)
 * costs nothing more than one of ten.
 *
 * The items the open tasks link (`linked`) that the search did not give —
 * closed, merged, not assigned to the viewer — are read by URL
 * (`resource(url:)`, at most `MAX_LINKED_ITEMS` a request), so a task's
 * merged pull request or closed Issue is seen (staleness, `task.changed`).
 *
 * For each item, its pull request — a pull request item's own, an Issue's
 * the one that closes it (the open one, else the latest) — with the review
 * decision, unresolved conversations and checks (`nodes(ids:)` for at most
 * `MAX_WATCHED_PULLS` open pull requests the last pass named): read once a
 * pass, with its first page, never with every page.
 *
 * **One request per tick**, never two in flight, no `gh` subcommands (the
 * token is `gh auth token`'s, read as the Workspace watcher reads it, and the
 * request goes through the same client, `postGraphQl`). A **pass** is the
 * search's pages (one, as a rule), the first carrying the extras — the pull
 * request details, the linked items, and a look at each registered Project
 * (its title, or that GitHub has no such Project) — and the population is
 * known once its last page is read. Only when the pass found what the
 * extras did not cover yet (at launch: the pull requests just named) does
 * one request of extras alone follow it. So a pass is about one request.
 *
 * **Never silently unread.** Until the population is known, `state()` says
 * what is being read (`reading`: the search, and its page), and every
 * complaint names where it is from (`problem`: `Project acme/7: …`,
 * `searching: …`, `pull request details: …`, GitHub's own words) — a
 * Project GitHub answers as nothing (no such owner, no such Project, one the
 * token cannot see) included, and a missing `read:project` scope (which
 * `projectItems` needs) says how to add it.
 *
 * **The interval** is between passes: a pass's further pages, and the one
 * request of extras, follow the last answer at once (still one at a time);
 * a complete pass waits `[orchestrator.github] interval`. Either only ever
 * backs off (`nextDelay`): slower as `remaining` falls (mid-pass too: then
 * at the interval's pace), paused until `resetAt` when it is low, doubling
 * after a failure. A pass has a bounded number of requests, so nothing
 * here asks again and again at once.
 *
 * **It says nothing itself**: no event comes from here. What it read is
 * state (`items`), and the invariant reads it on every poll (`polled`).
 *
 * **Pause.** While the orchestrator's events are paused the source is
 * `suspended`: it does not poll at all, and keeps what it last read. A resume
 * polls at once (the rate limit permitting), and `caughtUp()` settles when
 * that poll is read. Stopping forgets.
 */

import {
	parseInterval,
	parseProjectRef,
} from "../../model/orchestratorSettings.js";
import type { GraphQlError } from "../shell/github.js";
import type { EventItem } from "./events.js";
import { issueUrlKey, type ItemFacts, type PullFacts } from "./invariant.js";

// --- what is read --------------------------------------------------------------

/** A pull request an Issue names as closing it, or a pull request item itself. */
export interface ItemPull {
	readonly id: string;
	readonly item: EventItem;
	readonly state: "OPEN" | "CLOSED" | "MERGED";
	readonly draft: boolean;
}

/** A Project an item is on, and its lane there. */
export interface ItemBoard {
	/** `owner/number`, as GitHub names it. */
	readonly ref: string;
	readonly title?: string;
	/** The Status field's option; null when none is set. */
	readonly lane: string | null;
}

/** One item (Issue or pull request) as read. */
export interface ReadItem {
	readonly kind: "issue" | "pr";
	/** Its node id. */
	readonly id: string;
	readonly item: EventItem;
	readonly state: "OPEN" | "CLOSED" | "MERGED";
	readonly draft: boolean;
	readonly assignees: readonly string[];
	/** For an Issue: the pull requests that close it. */
	readonly linked: readonly ItemPull[];
	/** Every Project it is on (registered or not), with its lane on each. */
	readonly boards: readonly ItemBoard[];
}

/** A pull request's review state. */
export interface PullDetails {
	readonly id: string;
	readonly state: "OPEN" | "CLOSED" | "MERGED";
	readonly draft: boolean;
	readonly reviewDecision: string | null;
	readonly unresolved: number;
	/** The head commit's rollup: SUCCESS, FAILURE, ERROR, PENDING, EXPECTED. */
	readonly checks: string | null;
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
	/** The search's page, when it was asked. */
	readonly search?: {
		readonly items: readonly ReadItem[];
		readonly next: string | null;
	};
	/** The linked items read by URL, by the URL asked (as asked). */
	readonly linked: ReadonlyMap<string, ReadItem>;
	/** The registered Projects looked at: their titles. */
	readonly titles: ReadonlyMap<string, string>;
	readonly pulls: ReadonlyMap<string, PullDetails>;
	/** GitHub's complaints that did not stop the answer (a Project it cannot read). */
	readonly problems: readonly string[];
}

// --- the query -------------------------------------------------------------------

/** The population, as GitHub's search says it. */
export const SEARCH_QUERY = "is:open assignee:@me archived:false";
/** One page of the search. */
export const ITEMS_PER_PAGE = 100;
/** How many pull requests have their details read in a request. */
export const MAX_WATCHED_PULLS = 50;
/** How many linked items outside the search are read by URL in a request. */
export const MAX_LINKED_ITEMS = 20;
/** How many Projects an item's lanes are read on. */
export const MAX_ITEM_PROJECTS = 20;

const BOARDS = `projectItems(first:${String(MAX_ITEM_PROJECTS)}, includeArchived:false){ nodes{
        status: fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue{ name } }
        project{ number title owner{ ... on Organization{ login } ... on User{ login } } } } }`;

const ITEM = `__typename
    ... on Issue{ id number title url state repository{ nameWithOwner }
      assignees(first:10){ nodes{ login } }
      closedByPullRequestsReferences(first:5, includeClosedPrs:true){
        nodes{ id number title url state isDraft repository{ nameWithOwner } } }
      ${BOARDS} }
    ... on PullRequest{ id number title url state isDraft repository{ nameWithOwner }
      assignees(first:10){ nodes{ login } }
      ${BOARDS} }`;

const PULL_DETAILS = `id state isDraft reviewDecision
  reviewThreads(first:100){ nodes{ isResolved } }
  commits(last:1){ nodes{ commit{ statusCheckRollup{ state } } } }`;

/** What one request asks: any of the search's page, and the extras. */
export interface GitHubAsk {
	/** The search's page: where it starts (null: the first). */
	readonly search?: { readonly after: string | null };
	/** The registered Projects to look at (title, or that there is none). */
	readonly boards?: readonly {
		readonly owner: string;
		readonly number: number;
	}[];
	/** Linked items' URLs, read by URL. */
	readonly linked?: readonly string[];
	/** Pull request node ids, for their details. */
	readonly pulls?: readonly string[];
}

/** The one request of a tick. */
export function githubQuery(ask: GitHubAsk): {
	readonly query: string;
	readonly variables: Record<string, unknown>;
} {
	const declarations: string[] = [];
	const selections: string[] = [];
	const variables: Record<string, unknown> = {};
	if (ask.search !== undefined) {
		declarations.push("$q:String!", "$after:String");
		variables["q"] = SEARCH_QUERY;
		variables["after"] = ask.search.after;
		selections.push(
			`search(type:ISSUE, query:$q, first:${String(ITEMS_PER_PAGE)}, after:$after){
    pageInfo{ hasNextPage endCursor } nodes{ ${ITEM} } }`,
		);
	}
	for (const [index, board] of (ask.boards ?? []).entries()) {
		const at = String(index);
		declarations.push(`$o${at}:String!`, `$n${at}:Int!`);
		variables[`o${at}`] = board.owner;
		variables[`n${at}`] = board.number;
		selections.push(
			`p${at}: repositoryOwner(login:$o${at}){ ... on ProjectV2Owner{ projectV2(number:$n${at}){ title } } }`,
		);
	}
	for (const [index, url] of (ask.linked ?? []).entries()) {
		const at = String(index);
		declarations.push(`$u${at}:URI!`);
		variables[`u${at}`] = url;
		selections.push(`l${at}: resource(url:$u${at}){ ${ITEM} }`);
	}
	if ((ask.pulls ?? []).length > 0) {
		declarations.push("$pulls:[ID!]!");
		variables["pulls"] = ask.pulls;
		selections.push(
			`pulls: nodes(ids:$pulls){ ... on PullRequest{ ${PULL_DETAILS} } }`,
		);
	}
	const query = `query${declarations.length === 0 ? "" : `(${declarations.join(",")})`}{
  viewer{ login }
  rateLimit{ cost remaining limit resetAt }
  ${selections.join("\n  ")}
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

function itemState(value: unknown): "OPEN" | "CLOSED" | "MERGED" {
	const state = str(value)?.toUpperCase();
	return state === "MERGED" ? "MERGED" : state === "CLOSED" ? "CLOSED" : "OPEN";
}

function boardsOf(node: Json): ItemBoard[] {
	return nodes(node["projectItems"]).flatMap((one): ItemBoard[] => {
		const project = record(one["project"]);
		const owner = login(project?.["owner"]);
		const number = num(project?.["number"]);
		if (owner === undefined || number <= 0) return [];
		const title = str(project?.["title"]);
		return [
			{
				ref: `${owner}/${String(number)}`,
				...(title === undefined ? {} : { title }),
				lane: str(record(one["status"])?.["name"]) ?? null,
			},
		];
	});
}

/** An Issue or a pull request node, as read; undefined for anything else. */
export function parseItem(node: Json | undefined): ReadItem | undefined {
	if (node === undefined) return undefined;
	const type = str(node["__typename"]);
	const id = str(node["id"]);
	if (id === undefined || (type !== "Issue" && type !== "PullRequest"))
		return undefined;
	return {
		kind: type === "Issue" ? "issue" : "pr",
		id,
		item: itemOf(node),
		state: itemState(node["state"]),
		draft: node["isDraft"] === true,
		assignees: nodes(node["assignees"]).flatMap((one) => {
			const name = login(one);
			return name === undefined ? [] : [name];
		}),
		linked: nodes(node["closedByPullRequestsReferences"]).flatMap(
			(pull): ItemPull[] => {
				const pullId = str(pull["id"]);
				return pullId === undefined
					? []
					: [
							{
								id: pullId,
								item: itemOf(pull),
								state: itemState(pull["state"]),
								draft: pull["isDraft"] === true,
							},
						];
			},
		),
		boards: boardsOf(node),
	};
}

export function parseDetails(node: Json): PullDetails | undefined {
	const id = str(node["id"]);
	if (id === undefined) return undefined;
	const commit = record(nodes(node["commits"])[0]?.["commit"]);
	const rollup = record(commit?.["statusCheckRollup"]);
	return {
		id,
		state: itemState(node["state"]),
		draft: node["isDraft"] === true,
		reviewDecision: str(node["reviewDecision"]) ?? null,
		unresolved: nodes(node["reviewThreads"]).filter(
			(one) => one["isResolved"] === false,
		).length,
		checks: str(rollup?.["state"])?.toUpperCase() ?? null,
	};
}

/** What a missing `read:project` scope is fixed with. */
export const PROJECT_SCOPE_HINT =
	"run `gh auth refresh -s read:project` (Projects need the read:project scope)";

/** What the request asked, by the names its answer's fields carry. */
export interface AskedNames {
	/** The registered Projects looked at (`p0` is the first). */
	readonly boards: readonly string[];
	/** The linked items' URLs (`l0` is the first). */
	readonly linked: readonly string[];
}

/**
 * One of GitHub's complaints, saying where it is from: the Project its
 * `path` names (`p0`), the search, a linked item (`l0`), the pull request
 * details, or the whole request.
 */
export function problemOf(error: GraphQlError, asked: AskedNames): string {
	const head = error.path?.[0];
	const at = typeof head === "string" ? /^([pl])(\d+)$/u.exec(head) : null;
	const board = at?.[1] === "p" ? asked.boards[Number(at[2])] : undefined;
	const link = at?.[1] === "l" ? asked.linked[Number(at[2])] : undefined;
	const where =
		board !== undefined
			? `Project ${board}`
			: link !== undefined
				? `linked item ${link}`
				: head === "search"
					? "searching"
					: head === "pulls"
						? "pull request details"
						: undefined;
	const scope =
		error.type === "INSUFFICIENT_SCOPES" ||
		/read:project/u.test(error.message ?? "");
	const message = error.message ?? error.type ?? "an error without a message";
	return [
		where === undefined ? `GitHub: ${message}` : `${where}: ${message}`,
		...(scope ? [PROJECT_SCOPE_HINT] : []),
	].join(" — ");
}

/** An answer, as the source reads it. Throws only when it has no data at all. */
export function parseReading(
	answer: {
		readonly data?: unknown;
		readonly errors?: readonly GraphQlError[] | null;
	},
	asked: AskedNames & { readonly search: boolean },
): GitHubReading {
	const data = record(answer.data);
	const errors = answer.errors ?? [];
	const problems = errors.map((one) => problemOf(one, asked));
	const viewer = login(data?.["viewer"]);
	if (data === undefined || viewer === undefined)
		throw new Error(
			problems.length > 0
				? problems.join("; ")
				: "GitHub answered without data.",
		);
	const rate = record(data["rateLimit"]);
	const titles = new Map<string, string>();
	for (const [index, board] of asked.boards.entries()) {
		const at = `p${String(index)}`;
		const project = record(record(data[at])?.["projectV2"]);
		if (project !== undefined) {
			titles.set(board, str(project["title"]) ?? board);
			continue;
		}
		// Said only when GitHub did not: an owner it does not know, or a
		// Project the token cannot see, is answered as nothing at all.
		if (!errors.some((one) => one.path === undefined || one.path[0] === at))
			problems.push(
				`Project ${board}: GitHub answered no such Project (no owner ${JSON.stringify(parseProjectRef(board)?.owner ?? board)}, or no Project ${String(parseProjectRef(board)?.number ?? "")} this token can read)`,
			);
	}
	const linked = new Map<string, ReadItem>();
	for (const [index, url] of asked.linked.entries()) {
		const item = parseItem(record(data[`l${String(index)}`]));
		if (item !== undefined) linked.set(url, item);
	}
	let search: GitHubReading["search"];
	if (asked.search) {
		const found = record(data["search"]);
		const pageInfo = record(found?.["pageInfo"]);
		search = {
			items: nodes(found).flatMap((node) => {
				const item = parseItem(node);
				return item === undefined ? [] : [item];
			}),
			next:
				pageInfo?.["hasNextPage"] === true
					? (str(pageInfo["endCursor"]) ?? null)
					: null,
		};
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
		...(search === undefined ? {} : { search }),
		linked,
		titles,
		pulls,
		problems,
	};
}

// --- facts -----------------------------------------------------------------------

const FAILING = new Set([
	"FAILURE",
	"ERROR",
	"CANCELLED",
	"TIMED_OUT",
	"STARTUP_FAILURE",
	"ACTION_REQUIRED",
]);

/** A pull request's review decision, as a fact says it. */
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

/** A checks rollup, as a fact says it. */
function checksWord(rollup: string | null): PullFacts["checks"] {
	if (rollup === null) return "none";
	if (rollup === "SUCCESS") return "passing";
	if (FAILING.has(rollup)) return "failing";
	return "pending";
}

function same(a: string | undefined, b: string): boolean {
	return a !== undefined && a.toLowerCase() === b.toLowerCase();
}

/** The pull request an item's facts carry: its own, or the one closing it. */
function pullOf(item: ReadItem): ItemPull | undefined {
	if (item.kind === "pr")
		return {
			id: item.id,
			item: item.item,
			state: item.state,
			draft: item.draft,
		};
	return item.linked.find((one) => one.state === "OPEN") ?? item.linked.at(-1);
}

/** The registered ref an item's Project is, if any (owners match in any case). */
function registeredRef(
	board: ItemBoard,
	registered: readonly string[],
): string | undefined {
	return registered.find(
		(ref) => ref.toLowerCase() === board.ref.toLowerCase(),
	);
}

/** An item's URL key (`issueUrlKey`), as agents' links are matched. */
function keyOf(item: ReadItem): string {
	return item.item.url === undefined ? "" : issueUrlKey(item.item.url);
}

// --- the interval ----------------------------------------------------------------

/** The most a failure backs off to. */
export const MAX_BACKOFF_MS = 15 * 60_000;

/**
 * How long until the next tick: the base, slower as the rate limit runs
 * down, paused until it resets when it is low; never faster than the base —
 * except mid-pass (`midPass`), when the rest of the pass is asked at once
 * while the rate limit is healthy (at least half left) and nothing failed.
 */
export function nextDelay(
	baseMs: number,
	rate: RateLimit | undefined,
	now: number,
	failures = 0,
	midPass = false,
): { readonly ms: number; readonly why: string } {
	if (failures > 0)
		return {
			ms: Math.min(MAX_BACKOFF_MS, baseMs * 2 ** Math.min(failures, 10)),
			why: `backing off after ${String(failures)} failure(s)`,
		};
	const atOnce = { ms: 0, why: "reading the rest of the pass" };
	if (rate === undefined)
		return midPass ? atOnce : { ms: baseMs, why: "base interval" };
	const floor = Math.max(100, rate.cost * 20);
	if (rate.remaining <= floor && rate.resetAt > now)
		return {
			ms: Math.max(baseMs, rate.resetAt - now + 5_000),
			why: `rate limit low (${String(rate.remaining)} left): paused until it resets`,
		};
	const share = rate.limit > 0 ? rate.remaining / rate.limit : 1;
	const factor = share < 0.1 ? 4 : share < 0.25 ? 2 : share < 0.5 ? 1.5 : 1;
	if (midPass && factor === 1) return atOnce;
	return {
		ms: Math.round(baseMs * factor),
		why:
			factor === 1
				? "base interval"
				: `rate limit at ${String(Math.round(share * 100))}%: ${String(factor)}× slower`,
	};
}

/** Whether the rate limit is low enough that polling waits for its reset. */
function rateLimited(rate: RateLimit | undefined, now: number): boolean {
	return (
		rate !== undefined &&
		rate.remaining <= Math.max(100, rate.cost * 20) &&
		rate.resetAt > now
	);
}

// --- the poller ------------------------------------------------------------------

export interface GitHubSourcePorts {
	/** `[orchestrator.github]` now. */
	readonly settings: () => {
		readonly projects: readonly string[];
		readonly interval: string;
	};
	/** The item URLs managed agents are linked to (meta `issue=`). */
	readonly linked?: () => readonly string[];
	/** The token, or why there is none (said once). */
	readonly token: () => Promise<
		{ readonly token: string } | { readonly problem: string }
	>;
	readonly post: (
		body: { readonly query: string; readonly variables: unknown },
		token: string,
	) => Promise<{
		readonly data?: unknown;
		readonly errors?: readonly GraphQlError[] | null;
	}>;
	readonly setTimer: (ms: number, run: () => void) => { cancel(): void };
	/** A poll has been read: what `items` gives may have moved. */
	readonly polled?: () => void;
	/** How it stands (`state()`) moved. */
	readonly changed?: () => void;
	readonly now?: () => number;
	readonly log?: (line: string) => void;
}

/**
 * How the source stands: `active` polls; `suspended` (events paused) asks
 * nothing and keeps what it last read; `idle` (no orchestrator, or no
 * Project registered) has forgotten it.
 */
export type GitHubPolling = "active" | "suspended" | "idle";

/** How the last request went: answered, failed, or still out. */
export type GitHubPollOutcome = "ok" | "failed" | "in_flight";

/** A registered Project, with the title GitHub gave it. */
export interface ProjectSeen {
	readonly ref: string;
	readonly title?: string;
}

export class GitHubItemSource {
	#mode: GitHubPolling = "idle";
	#inFlight: Promise<void> | undefined;
	#timer: { cancel(): void } | undefined;
	#failures = 0;
	#rate: RateLimit | undefined;
	#viewer: string | undefined;
	/** The last complete search: the population's candidates. */
	#complete: readonly ReadItem[] | undefined;
	/** The pass being read, page by page. */
	#partial: ReadItem[] = [];
	#after: string | null = null;
	/** Pages of the pass under way read so far; 0 between passes. */
	#page = 0;
	/** The pass just completed found what its extras did not cover. */
	#extrasDue = false;
	/** Linked items read by URL, by their URL key. */
	#linkedItems = new Map<string, ReadItem>();
	/** What the last extras asked: linked URL keys, pull request ids. */
	#askedLinked = new Set<string>();
	#askedPulls = new Set<string>();
	#titles = new Map<string, string>();
	#pulls = new Map<string, PullDetails>();
	#problem: string | undefined;
	/** When `#problem` was first said. */
	#problemAt: number | undefined;
	/** When the last request was sent. */
	#lastAt: number | undefined;
	#outcome: GitHubPollOutcome | undefined;
	#nextAt: number | undefined;
	/** The poll a resume asked for, until it is done. */
	#catchUp: Promise<void> | undefined;

	constructor(private readonly ports: GitHubSourcePorts) {}

	#now(): number {
		return (this.ports.now ?? Date.now)();
	}

	/**
	 * Poll while there is an orchestrator and a Project to read, suspended
	 * while its events are paused; else stop and forget. Resuming polls at
	 * once (unless the rate limit says to wait), and `caughtUp()` settles
	 * when that poll is read.
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
		if (mode === "suspended") {
			this.#timer?.cancel();
			this.#timer = undefined;
			this.#nextAt = undefined;
		} else if (from === "idle") this.#schedule(0);
		else this.#resume();
		this.ports.changed?.();
	}

	/** The poll a resume started, done. */
	caughtUp(): Promise<void> {
		return this.#catchUp ?? Promise.resolve();
	}

	/** Stop and forget. */
	stop(): void {
		const was = this.#mode;
		this.#mode = "idle";
		this.#timer?.cancel();
		this.#timer = undefined;
		this.#viewer = undefined;
		this.#forget();
		this.#failures = 0;
		this.#problem = undefined;
		this.#problemAt = undefined;
		this.#nextAt = undefined;
		this.#catchUp = undefined;
		if (was !== "idle") this.ports.changed?.();
	}

	#forget(): void {
		this.#complete = undefined;
		this.#partial = [];
		this.#after = null;
		this.#page = 0;
		this.#extrasDue = false;
		this.#linkedItems = new Map();
		this.#askedLinked = new Set();
		this.#askedPulls = new Set();
		this.#titles = new Map();
		this.#pulls = new Map();
	}

	/** Back from a pause: poll now. */
	#resume(): void {
		const now = this.#now();
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
		/** When the last request was sent. */
		readonly lastAt?: number;
		/** How it went. */
		readonly lastOutcome?: GitHubPollOutcome;
		/** When the next request is to be sent; never before `lastAt`. */
		readonly nextAt?: number;
		readonly rateLimit?: RateLimit;
		/** What went wrong at the last poll, and where (`Project acme/7: …`). */
		readonly problem?: string;
		/** Since when that has been so. */
		readonly problemAt?: number;
		/** Until the population is known: what is being read (the search, its page). */
		readonly reading?: string;
		/** The open items assigned to the viewer on the Projects, once read in full. */
		readonly assigned?: number;
		/** The registered Projects, with the titles GitHub gave. */
		readonly projects: readonly ProjectSeen[];
	} {
		const items = this.#mode === "idle" ? undefined : this.items();
		const reading =
			this.#mode !== "active" || items !== undefined
				? undefined
				: `searching the open items assigned to me, page ${String(this.#page + 1)}`;
		const nextAt =
			this.#nextAt === undefined || this.#outcome === "in_flight"
				? undefined
				: Math.max(this.#nextAt, this.#lastAt ?? this.#nextAt);
		return {
			mode: this.#mode,
			running: this.#mode === "active",
			...(this.#lastAt === undefined ? {} : { lastAt: this.#lastAt }),
			...(this.#outcome === undefined ? {} : { lastOutcome: this.#outcome }),
			...(nextAt === undefined ? {} : { nextAt }),
			...(this.#rate === undefined ? {} : { rateLimit: this.#rate }),
			...(this.#problem === undefined
				? {}
				: {
						problem: this.#problem,
						...(this.#problemAt === undefined
							? {}
							: { problemAt: this.#problemAt }),
					}),
			...(reading === undefined ? {} : { reading }),
			...(items === undefined
				? {}
				: {
						assigned: items.filter(
							(one) =>
								one.state === "open" &&
								one.assignedToMe &&
								one.projects.length > 0,
						).length,
					}),
			projects: this.#boardRefs().map((ref) => {
				const title = this.#titles.get(ref);
				return { ref, ...(title === undefined ? {} : { title }) };
			}),
		};
	}

	/**
	 * The population as last read — the open items assigned to the viewer on
	 * a registered Project, with their lane on each and their pull request —
	 * and the items managed agents are linked to outside it (closed,
	 * unassigned, or on no registered Project: `projects` empty). Undefined
	 * until the search has been read in full once. With no Project
	 * registered: none — the population is empty.
	 */
	items(): readonly ItemFacts[] | undefined {
		const viewer = this.#viewer;
		const relevant = this.#relevant();
		if (relevant === undefined || viewer === undefined)
			return relevant === undefined ? undefined : [];
		return relevant.map(({ item, projects }) => {
			const pull = pullOf(item);
			return {
				item: item.item,
				kind: item.kind,
				state:
					item.state === "OPEN"
						? "open"
						: item.state === "MERGED"
							? "merged"
							: "closed",
				assignedToMe: item.assignees.some((name) => same(name, viewer)),
				projects,
				...(pull === undefined ? {} : { pull: this.#pullFacts(pull) }),
			};
		});
	}

	/**
	 * The items `items` gives, as read, with their registered Projects: the
	 * searched ones on a registered Project, and the linked ones (searched,
	 * or read by URL). Undefined until the search was read in full; empty
	 * with no Project registered.
	 */
	#relevant():
		| readonly {
				readonly item: ReadItem;
				readonly projects: readonly { project: string; lane: string | null }[];
		  }[]
		| undefined {
		const refs = this.#boardRefs();
		if (refs.length === 0) return [];
		const found = this.#complete;
		if (this.#viewer === undefined || found === undefined) return undefined;
		const linked = this.#linked();
		const out = new Map<
			string,
			{ item: ReadItem; projects: { project: string; lane: string | null }[] }
		>();
		const add = (item: ReadItem) => {
			if (out.has(item.id)) return;
			const projects = item.boards.flatMap((board) => {
				const ref = registeredRef(board, refs);
				return ref === undefined ? [] : [{ project: ref, lane: board.lane }];
			});
			if (projects.length === 0 && !linked.has(keyOf(item))) return;
			out.set(item.id, { item, projects });
		};
		for (const item of found) add(item);
		const searched = this.#searchedKeys();
		for (const [key, item] of this.#linkedItems)
			if (linked.has(key) && !searched.has(key)) add(item);
		return [...out.values()];
	}

	#pullFacts(pull: ItemPull): PullFacts {
		const details = this.#pulls.get(pull.id);
		const state = details?.state ?? pull.state;
		return {
			number: pull.item.number,
			...(pull.item.url === undefined ? {} : { url: pull.item.url }),
			state:
				state === "MERGED"
					? "merged"
					: state === "CLOSED"
						? "closed"
						: (details?.draft ?? pull.draft)
							? "draft"
							: "open",
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

	/** The items managed agents are linked to: URL key → URL. */
	#linked(): Map<string, string> {
		const out = new Map<string, string>();
		for (const url of this.ports.linked?.() ?? [])
			if (/^https?:\/\//u.test(url.trim()))
				out.set(issueUrlKey(url), url.trim());
		return out;
	}

	#searchedKeys(): Set<string> {
		return new Set((this.#complete ?? []).map(keyOf));
	}

	/** Linked items the last complete search did not give: read by URL. */
	#uncovered(): string[] {
		const searched = this.#searchedKeys();
		return [...this.#linked()]
			.filter(([key]) => !searched.has(key))
			.map(([, url]) => url)
			.slice(0, MAX_LINKED_ITEMS);
	}

	/** The open pull requests the items name: their details are read. */
	#watchedPulls(): string[] {
		const ids = new Set<string>();
		for (const { item } of this.#relevant() ?? []) {
			const pull = pullOf(item);
			if (pull !== undefined && pull.state === "OPEN") ids.add(pull.id);
		}
		return [...ids].slice(0, MAX_WATCHED_PULLS);
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
		if (problem !== undefined && problem !== this.#problem) {
			this.ports.log?.(`[devhub] orchestrator GitHub items: ${problem}`);
			this.#problemAt = this.#now();
		}
		if (problem === undefined) this.#problemAt = undefined;
		this.#problem = problem;
	}

	/** One request. Never two at once; none unless active. */
	async tick(): Promise<void> {
		if (this.#mode !== "active" || this.#inFlight !== undefined) return;
		const base = parseInterval(this.ports.settings().interval) ?? 90_000;
		this.#lastAt = this.#now();
		this.#outcome = "in_flight";
		this.#nextAt = undefined;
		this.ports.changed?.();
		const reading = this.#read();
		this.#inFlight = reading;
		try {
			await reading;
			this.#failures = 0;
			this.#outcome = "ok";
		} catch (error) {
			this.#failures += 1;
			this.#outcome = "failed";
			this.#say(error instanceof Error ? error.message : String(error));
		} finally {
			this.#inFlight = undefined;
		}
		// Suspended or stopped meanwhile: no next tick until it is resumed.
		if (this.#mode !== "active") {
			this.ports.changed?.();
			return;
		}
		const delay = nextDelay(
			base,
			this.#rate,
			this.#now(),
			this.#failures,
			this.#page > 0 || this.#extrasDue,
		);
		this.#schedule(delay.ms);
		this.ports.changed?.();
	}

	/** What this tick asks: the pass's next page, or its extras alone. */
	#ask(registered: readonly string[]): GitHubAsk {
		if (this.#page > 0) return { search: { after: this.#after } };
		const extras: GitHubAsk = {
			boards: registered.map((ref) => parseProjectRef(ref)!),
			linked: this.#uncovered(),
			pulls: this.#watchedPulls(),
		};
		return this.#extrasDue ? extras : { search: { after: null }, ...extras };
	}

	async #read(): Promise<void> {
		// A promise from the first line on: `tick` holds it as the one in flight.
		await Promise.resolve();
		const registered = this.#boardRefs();
		const credentials = await this.ports.token();
		if ("problem" in credentials) throw new Error(credentials.problem);
		const ask = this.#ask(registered);
		const asked = {
			search: ask.search !== undefined,
			boards: ask.boards === undefined ? [] : registered,
			linked: ask.linked ?? [],
		};
		const answer = await this.ports.post(githubQuery(ask), credentials.token);
		// Stopped while it was asked: what it says is nobody's.
		if (this.#mode === "idle") return;
		const reading = parseReading(answer, asked);
		this.#say(
			reading.problems.length === 0 ? undefined : reading.problems.join("; "),
		);
		this.#rate = reading.rateLimit ?? this.#rate;
		this.#apply(reading, ask);
	}

	#apply(reading: GitHubReading, ask: GitHubAsk): void {
		if (this.#viewer !== undefined && !same(this.#viewer, reading.viewer)) {
			this.ports.log?.(
				`[devhub] orchestrator GitHub items: the viewer is ${reading.viewer} now, not ${this.#viewer}`,
			);
			this.#forget();
			this.#viewer = reading.viewer;
			return;
		}
		this.#viewer = reading.viewer;
		const extras = ask.boards !== undefined;
		if (extras) {
			this.#extrasDue = false;
			for (const [ref, title] of reading.titles) this.#titles.set(ref, title);
			// The linked items read now are what is known of them; one no longer
			// asked (linked no more, or found by the search) is let go.
			const read = new Map<string, ReadItem>();
			for (const [url, item] of reading.linked)
				read.set(issueUrlKey(url), item);
			this.#linkedItems = read;
			this.#askedLinked = new Set((ask.linked ?? []).map(issueUrlKey));
			this.#askedPulls = new Set(ask.pulls ?? []);
			for (const [id, details] of reading.pulls) this.#pulls.set(id, details);
		}
		const page = reading.search;
		if (page !== undefined) {
			this.#partial.push(...page.items);
			if (page.next !== null) {
				this.#after = page.next;
				this.#page += 1;
			} else {
				this.#complete = this.#partial;
				this.#partial = [];
				this.#after = null;
				this.#page = 0;
				// What the extras did not ask yet: one request of them follows.
				this.#extrasDue =
					this.#watchedPulls().some((id) => !this.#askedPulls.has(id)) ||
					this.#uncovered().some(
						(url) => !this.#askedLinked.has(issueUrlKey(url)),
					);
			}
		}
		const watched = new Set(this.#watchedPulls());
		for (const id of [...this.#pulls.keys()])
			if (!watched.has(id)) this.#pulls.delete(id);
		this.ports.polled?.();
	}
}
