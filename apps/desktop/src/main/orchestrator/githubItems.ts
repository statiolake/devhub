/**
 * The GitHub source: the items — Issues and pull requests alike — the
 * invariant (`invariant.ts`) is read off, read and never written.
 *
 * **What is read.** The items of the registered Projects
 * (`[orchestrator.github] projects`): each card that is an Issue or a pull
 * request, with its state, assignees and its lane (Status) on that Project.
 * The population is those that are open and assigned to the viewer; an item
 * on several Projects is one item, with a lane on each. An Issue and a pull
 * request are one thing here, an **item**: a pull request card is an item as
 * an Issue is, whether or not an Issue goes with it. With no Project
 * registered there is nothing to read, and the population is empty.
 *
 * For each item, its pull request — a pull request item's own, an Issue's
 * the one that closes it (the open one, else the latest) — with the review
 * decision, unresolved conversations and checks (`nodes(ids:)` for the open
 * pull requests the last reading named).
 *
 * **One request per tick**, never two in flight, no `gh` subcommands (the
 * token is `gh auth token`'s, read as the Workspace watcher reads it, and the
 * request goes through the same client, `postGraphQl`): a page (100) of each
 * Project still being read in this **pass**, and the population is known
 * once every Project has been read in full. A pass starts with every
 * registered Project at its first page; a Project leaves it when its last
 * page is read (or GitHub answers it as nothing), and the pass is complete
 * when none is left. A request that fails halves the page from then on
 * (down to `MIN_ITEMS_PER_PAGE`, until the source stops): a Project too big
 * to answer in time is read in smaller pages, not asked the same again
 * forever.
 *
 * **Never silently unread.** Until the population is known, `state()` says
 * what is being read (`reading`: each Project not read in full yet, and the
 * page it is on), and every complaint names where it is from (`problem`:
 * `Project acme/7: …`, `pull request details: …`, GitHub's own words) — a
 * Project GitHub answers as nothing (no such owner, no such Project, one the
 * token cannot see) included, and a missing `read:project` scope says how
 * to add it.
 *
 * **The interval** is between passes, not pages: while a pass is mid-way,
 * the next page is asked as soon as the last one answered (still one at a
 * time); once it is complete, the next pass waits
 * `[orchestrator.github] interval`. Either only ever backs off (`nextDelay`):
 * slower as `remaining` falls (mid-pass too: then at the interval's pace),
 * paused until `resetAt` when it is low, doubling after a failure. So a
 * Project of 500 items is known a few requests after launch, not five
 * intervals.
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
import type { ItemFacts, PullFacts } from "./invariant.js";

// --- what is read --------------------------------------------------------------

/** A pull request an Issue names as closing it, or a pull request item itself. */
export interface ItemPull {
	readonly id: string;
	readonly item: EventItem;
	readonly state: "OPEN" | "CLOSED" | "MERGED";
	readonly draft: boolean;
}

/** One item (Issue or pull request) as one card reads it. */
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
}

/** A card on a Project: its item and its lane there. */
export interface BoardCard {
	readonly item: ReadItem;
	/** The Status field's option; null when none is set. */
	readonly lane: string | null;
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
	/** Per Project (`owner/number`): the page read, and where the next starts. */
	readonly pages: ReadonlyMap<
		string,
		{
			readonly title: string;
			readonly cards: readonly BoardCard[];
			readonly next: string | null;
		}
	>;
	readonly pulls: ReadonlyMap<string, PullDetails>;
	/** GitHub's complaints that did not stop the answer (a Project it cannot read). */
	readonly problems: readonly string[];
}

// --- the query -------------------------------------------------------------------

/** One page of a Project. */
export const ITEMS_PER_PAGE = 100;
/** The smallest page a run of failures shrinks it to. */
export const MIN_ITEMS_PER_PAGE = 10;
/** How many pull requests have their details read each tick. */
export const MAX_WATCHED_PULLS = 60;

const CONTENT = `content{
    __typename
    ... on Issue{ id number title url state repository{ nameWithOwner }
      assignees(first:10){ nodes{ login } }
      closedByPullRequestsReferences(first:5, includeClosedPrs:true){
        nodes{ id number title url state isDraft repository{ nameWithOwner } } } }
    ... on PullRequest{ id number title url state isDraft repository{ nameWithOwner }
      assignees(first:10){ nodes{ login } } } }`;

const CARD = `status: fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue{ name } }
  ${CONTENT}`;

const PULL_DETAILS = `id state isDraft reviewDecision
  reviewThreads(first:100){ nodes{ isResolved } }
  commits(last:1){ nodes{ commit{ statusCheckRollup{ state } } } }`;

/** The one request of a tick: each Project's next page, and the details. */
export function githubQuery(
	boards: readonly {
		readonly owner: string;
		readonly number: number;
		readonly after: string | null;
	}[],
	pulls: readonly string[],
	perPage: number = ITEMS_PER_PAGE,
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
    items(first:${String(perPage)}, after:$a${at}){ pageInfo{ hasNextPage endCursor } nodes{ ${CARD} } } } } }`,
		);
	}
	declarations.push("$pulls:[ID!]!", "$wantPulls:Boolean!");
	variables["pulls"] = pulls;
	variables["wantPulls"] = pulls.length > 0;
	const query = `query(${declarations.join(",")}){
  viewer{ login }
  rateLimit{ cost remaining limit resetAt }
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

/** An Issue or a pull request node, as read; undefined for anything else (a draft card). */
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

/**
 * One of GitHub's complaints, saying where it is from: the Project its
 * `path` names (`p0` is the first registered), the pull request details,
 * or the whole request.
 */
export function problemOf(
	error: GraphQlError,
	boards: readonly string[],
): string {
	const head = error.path?.[0];
	const index =
		typeof head === "string" ? /^p(\d+)$/u.exec(head)?.[1] : undefined;
	const where =
		index !== undefined && boards[Number(index)] !== undefined
			? `Project ${boards[Number(index)]!}`
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
	boards: readonly string[],
): GitHubReading {
	const data = record(answer.data);
	const problems = (answer.errors ?? []).map((one) => problemOf(one, boards));
	const viewer = login(data?.["viewer"]);
	if (data === undefined || viewer === undefined)
		throw new Error(
			problems.length > 0
				? problems.join("; ")
				: "GitHub answered without data.",
		);
	const rate = record(data["rateLimit"]);
	const pages = new Map<
		string,
		{ title: string; cards: BoardCard[]; next: string | null }
	>();
	for (const [index, board] of boards.entries()) {
		const at = `p${String(index)}`;
		const project = record(record(data[at])?.["projectV2"]);
		if (project === undefined) {
			// Said only when GitHub did not: an owner it does not know, or a
			// Project the token cannot see, is answered as nothing at all.
			if (
				!(answer.errors ?? []).some(
					(one) => one.path === undefined || one.path[0] === at,
				)
			)
				problems.push(
					`Project ${board}: GitHub answered no such Project (no owner ${JSON.stringify(parseProjectRef(board)?.owner ?? board)}, or no Project ${String(parseProjectRef(board)?.number ?? "")} this token can read)`,
				);
			continue;
		}
		const items = record(project["items"]);
		const pageInfo = record(items?.["pageInfo"]);
		pages.set(board, {
			title: str(project["title"]) ?? board,
			cards: nodes(items).flatMap((node) => {
				const item = parseItem(record(node["content"]));
				return item === undefined
					? []
					: [{ item, lane: str(record(node["status"])?.["name"]) ?? null }];
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

/** A registered Project, with the title GitHub gave it. */
export interface ProjectSeen {
	readonly ref: string;
	readonly title?: string;
}

interface BoardState {
	title?: string;
	/** The last full pass; undefined until the first. */
	complete: readonly BoardCard[] | undefined;
	/** The pass being read, page by page. */
	partial: BoardCard[];
	after: string | null;
	/** Pages of the pass being read, read so far. */
	pages: number;
}

function freshBoard(): BoardState {
	return { complete: undefined, partial: [], after: null, pages: 0 };
}

export class GitHubItemSource {
	#mode: GitHubPolling = "idle";
	#inFlight: Promise<void> | undefined;
	#timer: { cancel(): void } | undefined;
	#failures = 0;
	#rate: RateLimit | undefined;
	#viewer: string | undefined;
	#boards = new Map<string, BoardState>();
	#pulls = new Map<string, PullDetails>();
	#problem: string | undefined;
	/** When `#problem` was first said. */
	#problemAt: number | undefined;
	#lastAt: number | undefined;
	/**
	 * The Projects still to be read in the pass under way; undefined (or
	 * empty) between passes: the next request starts one.
	 */
	#pass: Set<string> | undefined;
	/** The page size: halved by each failure, for the rest of the run. */
	#perPage = ITEMS_PER_PAGE;
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
		this.#boards = new Map();
		this.#pulls = new Map();
		this.#pass = undefined;
		this.#failures = 0;
		this.#perPage = ITEMS_PER_PAGE;
		this.#problem = undefined;
		this.#problemAt = undefined;
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
		/** What went wrong at the last poll, and where (`Project acme/7: …`). */
		readonly problem?: string;
		/** Since when that has been so. */
		readonly problemAt?: number;
		/**
		 * Until the population is known: what is being read — each Project
		 * not read in full yet, and its page (`Project acme/7, page 2`).
		 */
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
				: this.#reading();
		return {
			mode: this.#mode,
			running: this.#mode === "active",
			...(this.#lastAt === undefined ? {} : { lastAt: this.#lastAt }),
			...(this.#nextAt === undefined ? {} : { nextAt: this.#nextAt }),
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
							(one) => one.state === "open" && one.assignedToMe,
						).length,
					}),
			projects: this.#boardRefs().map((ref) => {
				const title = this.#boards.get(ref)?.title;
				return { ref, ...(title === undefined ? {} : { title }) };
			}),
		};
	}

	/** Each Project not read in full yet, and the page it is on. */
	#reading(): string {
		const pending = this.#boardRefs().filter(
			(ref) => this.#boards.get(ref)?.complete === undefined,
		);
		const page = ` (pages of ${String(this.#perPage)})`;
		return (
			pending
				.map(
					(ref) =>
						`Project ${ref}, page ${String((this.#boards.get(ref)?.pages ?? 0) + 1)}`,
				)
				.join("; ") + page
		);
	}

	/**
	 * Every item on the registered Projects as last read, with its lane on
	 * each and its pull request; undefined until every Project has been read
	 * in full (the population is not known before). With no Project
	 * registered: none — the population is empty.
	 */
	items(): readonly ItemFacts[] | undefined {
		const refs = this.#boardRefs();
		if (refs.length === 0) return [];
		const viewer = this.#viewer;
		if (viewer === undefined) return undefined;
		const byId = new Map<
			string,
			{ item: ReadItem; projects: { project: string; lane: string | null }[] }
		>();
		for (const ref of refs) {
			const cards = this.#boards.get(ref)?.complete;
			if (cards === undefined) return undefined;
			for (const card of cards) {
				const one = byId.get(card.item.id) ?? { item: card.item, projects: [] };
				one.projects.push({ project: ref, lane: card.lane });
				byId.set(card.item.id, one);
			}
		}
		return [...byId.values()].map(({ item, projects }) => {
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
		const reading = this.#read();
		this.#inFlight = reading;
		try {
			await reading;
			this.#failures = 0;
		} catch (error) {
			this.#failures += 1;
			// Too much to answer in time is one cause: ask for less.
			this.#perPage = Math.max(
				MIN_ITEMS_PER_PAGE,
				Math.floor(this.#perPage / 2),
			);
			this.#say(error instanceof Error ? error.message : String(error));
		} finally {
			this.#inFlight = undefined;
			this.#lastAt = this.#now();
		}
		this.ports.changed?.();
		// Suspended or stopped meanwhile: no next tick until it is resumed.
		if (this.#mode !== "active") return;
		const delay = nextDelay(
			base,
			this.#rate,
			this.#now(),
			this.#failures,
			(this.#pass?.size ?? 0) > 0,
		);
		this.#schedule(delay.ms);
	}

	/** The open pull requests the items name: their details are read. */
	#watchedPulls(): string[] {
		const ids = new Set<string>();
		for (const state of this.#boards.values())
			for (const card of [...(state.complete ?? []), ...state.partial]) {
				const pull = pullOf(card.item);
				if (pull !== undefined && pull.state === "OPEN") ids.add(pull.id);
			}
		return [...ids].slice(0, MAX_WATCHED_PULLS);
	}

	async #read(): Promise<void> {
		// A promise from the first line on: `tick` holds it as the one in flight.
		await Promise.resolve();
		const registered = this.#boardRefs();
		for (const ref of [...this.#boards.keys()])
			if (!registered.includes(ref)) this.#boards.delete(ref);
		// The pass under way: the Projects not read in full in it yet, and one
		// registered meanwhile; between passes, every Project starts one.
		const pass = this.#pass;
		const refs =
			pass === undefined || pass.size === 0
				? registered
				: registered.filter((ref) => pass.has(ref) || !this.#boards.has(ref));
		const credentials = await this.ports.token();
		if ("problem" in credentials) throw new Error(credentials.problem);
		const boards = refs.map((ref) => {
			const state = this.#boards.get(ref) ?? freshBoard();
			this.#boards.set(ref, state);
			const parsed = parseProjectRef(ref)!;
			return { owner: parsed.owner, number: parsed.number, after: state.after };
		});
		const request = githubQuery(boards, this.#watchedPulls(), this.#perPage);
		const answer = await this.ports.post(request, credentials.token);
		// Stopped while it was asked: what it says is nobody's.
		if (this.#mode === "idle") return;
		const reading = parseReading(answer, refs);
		this.#say(
			reading.problems.length === 0 ? undefined : reading.problems.join("; "),
		);
		this.#rate = reading.rateLimit ?? this.#rate;
		this.#apply(reading, refs);
	}

	#apply(reading: GitHubReading, refs: readonly string[]): void {
		if (this.#viewer !== undefined && !same(this.#viewer, reading.viewer)) {
			this.ports.log?.(
				`[devhub] orchestrator GitHub items: the viewer is ${reading.viewer} now, not ${this.#viewer}`,
			);
			this.#boards = new Map(refs.map((ref) => [ref, freshBoard()]));
			this.#pulls = new Map();
		}
		this.#viewer = reading.viewer;
		// A Project leaves the pass with its last page, or when GitHub answers
		// it as nothing (said as a problem; the next pass asks it again).
		this.#pass = new Set();
		for (const ref of refs) {
			const page = reading.pages.get(ref);
			const state = this.#boards.get(ref);
			if (page === undefined || state === undefined) continue;
			state.title = page.title;
			state.partial.push(...page.cards);
			state.pages += 1;
			if (page.next !== null) {
				state.after = page.next;
				this.#pass.add(ref);
				continue;
			}
			state.complete = state.partial;
			state.partial = [];
			state.after = null;
			state.pages = 0;
		}
		for (const [id, details] of reading.pulls) this.#pulls.set(id, details);
		const named = new Set(this.#watchedPulls());
		for (const id of [...this.#pulls.keys()])
			if (!named.has(id) && this.#pulls.get(id)?.state === "OPEN")
				this.#pulls.delete(id);
		this.ports.polled?.();
	}
}
