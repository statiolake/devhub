/**
 * The Tokens view's wire: who used how many tokens, as main adds them up
 * (`model/tokenReport.ts`) for the Task Manager's Tokens tab and for
 * `devhub --tell usage --by …`. See `docs/task-manager.md`, "Tokens".
 *
 * A report carries both views at once — the raw counts and the cache-aware,
 * price-weighted ones — so switching between them asks main for nothing.
 */

/** The time a report covers. */
export type TokenRangeKind = "window5h" | "today" | "week" | "days7" | "custom";

export const TOKEN_RANGE_KINDS: readonly TokenRangeKind[] = [
	"window5h",
	"today",
	"week",
	"days7",
	"custom",
];

/** What a report's rows are. */
export type TokenGrouping = "agent" | "task" | "workspace" | "role" | "model";

export const TOKEN_GROUPINGS: readonly TokenGrouping[] = [
	"agent",
	"task",
	"workspace",
	"role",
	"model",
];

/** Raw counts, or weighted by list price with the cache taken into account. */
export type TokenView = "raw" | "weighted";

/**
 * Who ran a session: the Orchestrator, an Agent it manages (a worker), an
 * Agent nobody manages, or no Agent of DevHub's (the CLI run outside it, or
 * before DevHub kept track).
 */
export type TokenRole = "orchestrator" | "worker" | "unmanaged" | "outside";

export interface TokenQueryWire {
	readonly range: TokenRangeKind;
	/** `custom`: ms since the epoch. */
	readonly from?: number;
	readonly to?: number;
	readonly by: TokenGrouping;
}

export interface TokenTotalsWire {
	/** Requests, once each. */
	readonly requests: number;
	/** Input neither read from the cache nor written to it. */
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite5m: number;
	readonly cacheWrite1h: number;
	/** All the input processed: input + cache reads + cache writes. */
	readonly processedInput: number;
	/** processedInput + output. */
	readonly total: number;
	/**
	 * The priced requests' input as tokens at base input price (cache reads
	 * at the model's read price, writes at 1.25× and 2×).
	 */
	readonly weightedInput: number;
	/** The priced requests' output. */
	readonly weightedOutput: number;
	/** Estimated list-price cost of the priced requests, in US dollars. */
	readonly cost: number;
	/** Tokens (`total`) of requests on a model with no pinned price. */
	readonly unpricedTokens: number;
	/** cacheRead / processedInput; null with no input. */
	readonly hitRate: number | null;
}

export type TokenRowKind =
	| "agent"
	| "task"
	| "workspace"
	| "role"
	| "model"
	| "main"
	| "subagent"
	| "none";

export interface TokenRowWire {
	/** Stable across refreshes, so an open row stays open. */
	readonly id: string;
	readonly kind: TokenRowKind;
	readonly label: string;
	/** The profile, machine, folder: what the row is, said more exactly. */
	readonly detail?: string;
	/** Models used, most used first, as the price table names them. */
	readonly models: readonly string[];
	readonly machines: readonly string[];
	readonly role?: TokenRole;
	readonly agentId?: string;
	readonly workspaceId?: string;
	readonly taskId?: number;
	readonly totals: TokenTotalsWire;
	/** `total` tokens per bucket of the range, oldest first. */
	readonly series: readonly number[];
	/** Estimated cost per bucket. */
	readonly costSeries: readonly number[];
	/** Agent rows: the main conversation and each subagent; others: agents. */
	readonly children: readonly TokenRowWire[];
}

export interface TokenPriceWire {
	readonly model: string;
	readonly label: string;
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite5m: number;
	readonly cacheWrite1h: number;
}

/** One place transcripts are read from, and how that went. */
export interface TokenSourceWire {
	readonly machine: string;
	readonly cli: "claude" | "codex";
	/** The CLI's config folder there. */
	readonly root: string;
	readonly files: number;
	/** When it was last read; absent: not yet. */
	readonly readAt?: number;
	/** Why the last reading failed. */
	readonly problem?: string;
	/** Some of its files are not read to their end yet (the first reading). */
	readonly catchingUp?: boolean;
}

export interface TokenReportWire {
	readonly takenAt: number;
	readonly range: {
		readonly kind: TokenRangeKind;
		readonly from: number;
		readonly to: number;
		/** "5-hour window", "Today", … */
		readonly label: string;
		/** Where its start came from: the plan window's reset, or a fallback. */
		readonly source: string;
		/** A plan window's: when it resets. */
		readonly resetsAt?: number;
	};
	readonly by: TokenGrouping;
	readonly bucketMs: number;
	/** Every request in the range, once — not the sum of the rows. */
	readonly totals: TokenTotalsWire;
	readonly rows: readonly TokenRowWire[];
	/** A request can count toward more than one task (task grouping). */
	readonly overlapping?: true;
	readonly prices: {
		readonly asOf: string;
		readonly rows: readonly TokenPriceWire[];
	};
	readonly sources: readonly TokenSourceWire[];
	/** How far back the index keeps requests, in ms. */
	readonly retentionMs: number;
}

export const TOKEN_USAGE_CHANNELS = {
	report: "devhub-task-manager:tokens",
	copy: "devhub-task-manager:tokens-copy",
} as const;

/** Tokens as the view writes them: 1,234 · 12.3K · 4.56M · 1.2B. */
export function formatTokens(tokens: number): string {
	const abs = Math.abs(tokens);
	if (abs < 1_000) return String(Math.round(tokens));
	if (abs < 1_000_000)
		return `${(tokens / 1_000).toFixed(abs < 10_000 ? 2 : abs < 100_000 ? 1 : 0)}K`;
	if (abs < 1_000_000_000)
		return `${(tokens / 1_000_000).toFixed(abs < 10_000_000 ? 2 : abs < 100_000_000 ? 1 : 0)}M`;
	return `${(tokens / 1_000_000_000).toFixed(2)}B`;
}

/** Dollars as the view writes them: $0.004 · $1.23 · $1,234. */
export function formatCost(dollars: number): string {
	if (dollars === 0) return "$0";
	if (dollars < 0.01) return `$${dollars.toFixed(3)}`;
	if (dollars < 1_000) return `$${dollars.toFixed(2)}`;
	return `$${Math.round(dollars).toLocaleString("en-US")}`;
}

/** A rate as a percent: 87%, 4.2%, —. */
export function formatRate(rate: number | null): string {
	if (rate === null) return "—";
	const percent = rate * 100;
	return `${percent.toFixed(percent >= 10 || percent === 0 ? 0 : 1)}%`;
}
