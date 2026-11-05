/**
 * The GitHub source: the items — Issues and pull requests alike — the
 * invariant (`invariant.ts`) is read off, read and never written.
 *
 * **What is read.** Every open Issue or pull request assigned to the viewer,
 * GitHub-wide (`is:open assignee:@me`, as one search): the population. And
 * each item an agent is linked to (its meta `issue=`) that the search did not
 * return — closed, or no longer assigned — looked up by its URL, so the
 * invariant can say why it is outside. An Issue and a pull request are one
 * thing here, an **item**: a pull request assigned to the viewer is an item
 * as an Issue is, whether or not an Issue goes with it.
 *
 * For each item: its state, assignees, its lane on each watched Project
 * (`[orchestrator.github] projects`: the Projects are only where lanes are
 * read from, never what decides the population), and its pull request — a
 * pull request item's own, an Issue's the one that closes it (the open one,
 * else the latest) — with the review decision, unresolved conversations and
 * checks (`nodes(ids:)` for the pull requests the last reading named).
 *
 * **One request per tick**, never two in flight, no `gh` subcommands (the
 * token is `gh auth token`'s, read as the Workspace watcher reads it, and the
 * request goes through the same client, `postGraphQl`). More than a page
 * (100) of assigned items is read a page a tick, and the population is known
 * once the whole of it has been read.
 *
 * **The interval** starts at `[orchestrator.github] interval` and only ever
 * backs off from it (`nextDelay`): slower as `remaining` falls, paused until
 * `resetAt` when it is low, doubling after a failure.
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

/** One item (Issue or pull request) as one tick reads it. */
export interface ReadItem {
	readonly kind: "issue" | "pr";
	/** Its node id. */
	readonly id: string;
	readonly item: EventItem;
	readonly state: "OPEN" | "CLOSED" | "MERGED";
	readonly draft: boolean;
	readonly assignees: readonly string[];
	/** Each Project it is on (`OWNER/NUMBER`) and its Status there. */
	readonly projects: readonly {
		readonly ref: string;
		readonly title?: string;
		readonly lane: string | null;
	}[];
	/** For an Issue: the pull requests that close it. */
	readonly linked: readonly ItemPull[];
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
	/** One page of the items assigned to the viewer, and where the next starts. */
	readonly assigned: readonly ReadItem[];
	readonly next: string | null;
	/** The linked items looked up by URL: undefined where GitHub has none. */
	readonly looked: ReadonlyMap<string, ReadItem | undefined>;
	readonly pulls: ReadonlyMap<string, PullDetails>;
	/** GitHub's complaints that did not stop the answer. */
	readonly problems: readonly string[];
}

// --- the query -------------------------------------------------------------------

/** One page of the assigned items. */
export const ITEMS_PER_PAGE = 100;
/** How many linked items are looked up by URL in one tick. */
export const MAX_LOOKUPS = 20;
/** How many pull requests have their details read each tick. */
export const MAX_WATCHED_PULLS = 60;
/** The search the population is. */
export const ASSIGNED_QUERY = "is:open assignee:@me archived:false";

const PROJECTS = `projectItems(first:10){ nodes{
    project{ number title owner{ ... on Organization{ login } ... on User{ login } } }
    status: fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue{ name } } } }`;

const ITEM = `... on Issue{ __typename id number title url state repository{ nameWithOwner }
    assignees(first:10){ nodes{ login } }
    ${PROJECTS}
    closedByPullRequestsReferences(first:5, includeClosedPrs:true){
      nodes{ id number title url state isDraft repository{ nameWithOwner } } } }
  ... on PullRequest{ __typename id number title url state isDraft repository{ nameWithOwner }
    assignees(first:10){ nodes{ login } }
    ${PROJECTS} }`;

const PULL_DETAILS = `id state isDraft reviewDecision
  reviewThreads(first:100){ nodes{ isResolved } }
  commits(last:1){ nodes{ commit{ statusCheckRollup{ state } } } }`;

/** The one request of a tick: a page of the assigned items, the lookups, the details. */
export function githubQuery(
	after: string | null,
	lookups: readonly string[],
	pulls: readonly string[],
): { readonly query: string; readonly variables: Record<string, unknown> } {
	const declarations = [
		"$after:String",
		"$pulls:[ID!]!",
		"$wantPulls:Boolean!",
	];
	const variables: Record<string, unknown> = {
		after,
		pulls,
		wantPulls: pulls.length > 0,
	};
	const selections: string[] = [];
	for (const [index, url] of lookups.entries()) {
		const at = String(index);
		declarations.push(`$u${at}:URI!`);
		variables[`u${at}`] = url;
		selections.push(`l${at}: resource(url:$u${at}){ ${ITEM} }`);
	}
	const query = `query(${declarations.join(",")}){
  viewer{ login }
  rateLimit{ cost remaining limit resetAt }
  assigned: search(type:ISSUE, query:${JSON.stringify(ASSIGNED_QUERY)}, first:${String(ITEMS_PER_PAGE)}, after:$after){
    pageInfo{ hasNextPage endCursor } nodes{ ${ITEM} } }
  ${selections.join("\n  ")}
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

function itemState(value: unknown): "OPEN" | "CLOSED" | "MERGED" {
	const state = str(value)?.toUpperCase();
	return state === "MERGED" ? "MERGED" : state === "CLOSED" ? "CLOSED" : "OPEN";
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
		projects: nodes(node["projectItems"]).flatMap((one) => {
			const project = record(one["project"]);
			const owner = login(project?.["owner"]);
			const number = num(project?.["number"]);
			if (project === undefined || owner === undefined || number === 0)
				return [];
			const title = str(project["title"]);
			return [
				{
					ref: `${owner}/${String(number)}`,
					...(title === undefined ? {} : { title }),
					lane: str(record(one["status"])?.["name"]) ?? null,
				},
			];
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

/** An answer, as the source reads it. Throws only when it has no data at all. */
export function parseReading(
	answer: {
		readonly data?: unknown;
		readonly errors?:
			| readonly { readonly message?: string; readonly type?: string }[]
			| null;
	},
	lookups: readonly string[],
): GitHubReading {
	const data = record(answer.data);
	const problems = (answer.errors ?? []).flatMap((one) =>
		one.message === undefined ? [] : [one.message],
	);
	const viewer = login(data?.["viewer"]);
	if (data === undefined || viewer === undefined)
		throw new Error(problems[0] ?? "GitHub answered without data.");
	const rate = record(data["rateLimit"]);
	const search = record(data["assigned"]);
	const pageInfo = record(search?.["pageInfo"]);
	const looked = new Map<string, ReadItem | undefined>();
	for (const [index, url] of lookups.entries())
		looked.set(url, parseItem(record(data[`l${String(index)}`])));
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
		assigned: nodes(search).flatMap((node) => {
			const item = parseItem(node);
			return item === undefined ? [] : [item];
		}),
		next:
			pageInfo?.["hasNextPage"] === true
				? (str(pageInfo["endCursor"]) ?? null)
				: null,
		looked,
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
	/** The URLs agents are linked to (their meta `issue=`). */
	readonly linked: () => readonly string[];
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
 * nothing and keeps what it last read; `idle` (no orchestrator) has
 * forgotten it.
 */
export type GitHubPolling = "active" | "suspended" | "idle";

/** A watched Project, as the items read name it. */
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
	/** The last full pass of the assigned items; undefined before the first. */
	#assigned: readonly ReadItem[] | undefined;
	/** The pass being read, page by page. */
	#partial: ReadItem[] = [];
	#after: string | null = null;
	/** Linked items looked up by URL key: undefined where GitHub has none. */
	#looked = new Map<string, ReadItem | undefined>();
	#pulls = new Map<string, PullDetails>();
	#problem: string | undefined;
	#lastAt: number | undefined;
	#nextAt: number | undefined;
	/** The poll a resume asked for, until it is done. */
	#catchUp: Promise<void> | undefined;

	constructor(private readonly ports: GitHubSourcePorts) {}

	#now(): number {
		return (this.ports.now ?? Date.now)();
	}

	/**
	 * Poll while there is an orchestrator, suspended while its events are
	 * paused; else stop and forget. Resuming polls at once (unless the rate
	 * limit says to wait), and `caughtUp()` settles when that poll is read.
	 */
	follow(active: boolean, paused = false): void {
		const mode: GitHubPolling = !active
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
		this.#assigned = undefined;
		this.#partial = [];
		this.#after = null;
		this.#looked = new Map();
		this.#pulls = new Map();
		this.#failures = 0;
		this.#nextAt = undefined;
		this.#catchUp = undefined;
		if (was !== "idle") this.ports.changed?.();
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
		readonly lastAt?: number;
		readonly nextAt?: number;
		readonly rateLimit?: RateLimit;
		readonly problem?: string;
		/** The open items assigned to the viewer, once read in full. */
		readonly assigned?: number;
		/** The watched Projects, with the titles the items gave. */
		readonly projects: readonly ProjectSeen[];
	} {
		return {
			mode: this.#mode,
			running: this.#mode === "active",
			...(this.#lastAt === undefined ? {} : { lastAt: this.#lastAt }),
			...(this.#nextAt === undefined ? {} : { nextAt: this.#nextAt }),
			...(this.#rate === undefined ? {} : { rateLimit: this.#rate }),
			...(this.#problem === undefined ? {} : { problem: this.#problem }),
			...(this.#assigned === undefined
				? {}
				: { assigned: this.#assigned.length }),
			projects: this.#projectRefs().map((ref) => {
				const title = this.#all()
					.flatMap((one) => one.projects)
					.find((one) => one.ref.toLowerCase() === ref.toLowerCase())?.title;
				return { ref, ...(title === undefined ? {} : { title }) };
			}),
		};
	}

	#all(): readonly ReadItem[] {
		return [
			...(this.#assigned ?? []),
			...[...this.#looked.values()].filter(
				(one): one is ReadItem => one !== undefined,
			),
		];
	}

	/**
	 * Every item as last read — the open ones assigned to the viewer, and the
	 * linked ones looked up — with its lanes and its pull request; undefined
	 * until the assigned items have been read in full (the population is not
	 * known before).
	 */
	items(): readonly ItemFacts[] | undefined {
		const viewer = this.#viewer;
		if (viewer === undefined || this.#assigned === undefined) return undefined;
		const watched = new Set(
			this.#projectRefs().map((one) => one.toLowerCase()),
		);
		const out: ItemFacts[] = [];
		const seen = new Set<string>();
		for (const one of this.#all()) {
			if (seen.has(one.id)) continue;
			seen.add(one.id);
			const pull = pullOf(one);
			out.push({
				item: one.item,
				kind: one.kind,
				open: one.state === "OPEN",
				assignedToMe: one.assignees.some((name) => same(name, viewer)),
				projects: one.projects
					.filter((project) => watched.has(project.ref.toLowerCase()))
					.map((project) => ({ project: project.ref, lane: project.lane })),
				...(pull === undefined ? {} : { pull: this.#pullFacts(pull) }),
			});
		}
		return out;
	}

	/** A linked URL GitHub was asked about and has no item for. */
	missing(url: string): boolean {
		const key = issueUrlKey(url);
		return this.#looked.has(key) && this.#looked.get(key) === undefined;
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

	#projectRefs(): string[] {
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
			this.ports.log?.(`[devhub] orchestrator GitHub items: ${problem}`);
		this.#problem = problem;
	}

	/** One request. Never two at once; none unless active. */
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

	/** The linked URLs the assigned items do not cover, to look up. */
	#lookups(): string[] {
		const assigned = new Set(
			(this.#assigned ?? []).flatMap((one) =>
				one.item.url === undefined ? [] : [issueUrlKey(one.item.url)],
			),
		);
		const out = new Set<string>();
		for (const url of this.ports.linked()) {
			const key = issueUrlKey(url);
			if (!assigned.has(key)) out.add(key);
		}
		return [...out].slice(0, MAX_LOOKUPS);
	}

	/** The pull requests whose details are read: those the items name. */
	#watchedPulls(): string[] {
		const ids = new Set<string>();
		for (const one of [...this.#all(), ...this.#partial]) {
			const pull = pullOf(one);
			if (pull !== undefined && pull.state === "OPEN") ids.add(pull.id);
		}
		return [...ids].slice(0, MAX_WATCHED_PULLS);
	}

	async #read(): Promise<void> {
		// A promise from the first line on: `tick` holds it as the one in flight.
		await Promise.resolve();
		const credentials = await this.ports.token();
		if ("problem" in credentials) throw new Error(credentials.problem);
		const lookups = this.#lookups();
		const request = githubQuery(this.#after, lookups, this.#watchedPulls());
		const answer = await this.ports.post(request, credentials.token);
		// Stopped while it was asked: what it says is nobody's.
		if (this.#mode === "idle") return;
		const reading = parseReading(answer, lookups);
		this.#say(reading.problems[0]);
		this.#rate = reading.rateLimit ?? this.#rate;
		this.#apply(reading);
	}

	#apply(reading: GitHubReading): void {
		if (this.#viewer !== undefined && !same(this.#viewer, reading.viewer)) {
			this.ports.log?.(
				`[devhub] orchestrator GitHub items: the viewer is ${reading.viewer} now, not ${this.#viewer}`,
			);
			this.#assigned = undefined;
			this.#partial = [];
			this.#after = null;
			this.#looked = new Map();
			this.#pulls = new Map();
		}
		this.#viewer = reading.viewer;
		this.#partial.push(...reading.assigned);
		if (reading.next !== null) this.#after = reading.next;
		else {
			this.#assigned = this.#partial;
			this.#partial = [];
			this.#after = null;
		}
		// What is no longer linked is not kept.
		const linked = new Set(this.ports.linked().map(issueUrlKey));
		for (const key of [...this.#looked.keys()])
			if (!linked.has(key)) this.#looked.delete(key);
		for (const [url, item] of reading.looked) this.#looked.set(url, item);
		for (const [id, details] of reading.pulls) this.#pulls.set(id, details);
		const named = new Set(this.#watchedPulls());
		for (const id of [...this.#pulls.keys()])
			if (!named.has(id) && this.#pulls.get(id)?.state === "OPEN")
				this.#pulls.delete(id);
		this.ports.polled?.();
	}
}
