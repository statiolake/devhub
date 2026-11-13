/**
 * `devhub --tell usage --by agent|task|workspace|role|model [--since …]
 * [--until …] [--cache raw|weighted]`: who used how many tokens, as the Task
 * Manager's Tokens tab adds them up (`model/tokenReport.ts`). Any of those
 * flags (or `--tokens`) asks for tokens; `usage` alone is still the plan
 * limits (`usage.ts`).
 *
 * `--since`: `window` (Claude's current 5-hour window, the default), `today`,
 * `week` (Claude's weekly window), `7d`, a duration back from now (`90m`,
 * `12h`, `3d`), or a date and time (`2026-11-12`, `2026-11-12T09:00`).
 *
 * Text is a table, one row per Agent (task, …), heaviest first, its
 * subagents or Agents indented under it, and the total — every request once,
 * not the rows added up. `--json` is `TokensJson`.
 */

import {
	formatCost,
	formatRate,
	formatTokens,
	type TokenGrouping,
	type TokenRangeKind,
	type TokenReportWire,
	type TokenRowWire,
	type TokenTotalsWire,
	type TokenView,
} from "../../../ipc/tokenUsage.js";
import { clockAt } from "../../orchestrator/events.js";
import { modelLabel } from "../../../model/tokenPrices.js";

/** What `--since` said, before it is resolved against now. */
export type TokenSince =
	| { readonly range: Exclude<TokenRangeKind, "custom"> }
	| { readonly agoMs: number }
	| { readonly at: number };

const NAMED: Readonly<Record<string, Exclude<TokenRangeKind, "custom">>> = {
	window: "window5h",
	"5h-window": "window5h",
	"5-hour": "window5h",
	today: "today",
	week: "week",
	"7d": "days7",
};

/** `--since`'s value, or undefined: not one. */
export function parseSince(value: string): TokenSince | undefined {
	const named = NAMED[value.toLowerCase()];
	if (named !== undefined) return { range: named };
	const ago = /^(\d+(?:\.\d+)?)(m|h|d)$/u.exec(value);
	if (ago) {
		const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[ago[2] as "m"];
		return { agoMs: Number(ago[1]) * unit };
	}
	if (/^\d{4}-\d{2}-\d{2}/u.test(value)) {
		// A date alone is local midnight, as a person means it.
		const at = Date.parse(
			/^\d{4}-\d{2}-\d{2}$/u.test(value) ? `${value}T00:00` : value,
		);
		if (Number.isFinite(at)) return { at };
	}
	return undefined;
}

/** `--until`'s value: a date and time. */
export function parseUntil(value: string): number | undefined {
	const at = Date.parse(
		/^\d{4}-\d{2}-\d{2}$/u.test(value) ? `${value}T00:00` : value,
	);
	return Number.isFinite(at) ? at : undefined;
}

export interface TokensJson extends TokenReportWire {
	readonly schema: 1;
	/** The view the text was in: what `--cache` said. */
	readonly cache: TokenView;
	readonly rangeIso: { readonly from: string; readonly to: string };
	/** Always: the cost is an estimate at list price. */
	readonly costNote: string;
}

export const COST_NOTE =
	"Estimated at Anthropic's API list price; a Claude plan is not billed this, its 5-hour and weekly windows are what limit it.";

export function tokensJson(
	report: TokenReportWire,
	cache: TokenView,
): TokensJson {
	return {
		schema: 1,
		cache,
		rangeIso: {
			from: new Date(report.range.from).toISOString(),
			to: new Date(report.range.to).toISOString(),
		},
		costNote: COST_NOTE,
		...report,
	};
}

const COLUMNS: Readonly<
	Record<TokenView, readonly [string, (t: TokenTotalsWire) => string][]>
> = {
	raw: [
		["input", (t) => formatTokens(t.input)],
		["cache read", (t) => formatTokens(t.cacheRead)],
		["cache write", (t) => formatTokens(t.cacheWrite5m + t.cacheWrite1h)],
		["output", (t) => formatTokens(t.output)],
		["total", (t) => formatTokens(t.total)],
	],
	weighted: [
		["weighted in", (t) => formatTokens(t.weightedInput)],
		["output", (t) => formatTokens(t.output)],
		["hit rate", (t) => formatRate(t.hitRate)],
		["est. cost", (t) => formatCost(t.cost)],
	],
};

const BY_WORD: Readonly<Record<TokenGrouping, string>> = {
	agent: "agent",
	task: "task",
	workspace: "workspace",
	role: "role",
	model: "model",
};

function nameOf(row: TokenRowWire): string {
	const models =
		row.models.length > 0 ? ` [${row.models.map(modelLabel).join(", ")}]` : "";
	return `${row.label}${row.detail === undefined ? "" : ` (${row.detail})`}${row.kind === "agent" ? models : ""}`;
}

/** The report as a table. */
export function tokensText(
	report: TokenReportWire,
	cache: TokenView,
	now: number,
): string {
	const columns = COLUMNS[cache];
	const sorted = (rows: readonly TokenRowWire[]) =>
		cache === "weighted"
			? [...rows].sort((a, b) => b.totals.cost - a.totals.cost)
			: rows;
	const lines: [string, string[]][] = [];
	for (const row of sorted(report.rows)) {
		lines.push([nameOf(row), columns.map(([, cell]) => cell(row.totals))]);
		for (const child of sorted(row.children))
			lines.push([
				`  ${nameOf(child)}`,
				columns.map(([, cell]) => cell(child.totals)),
			]);
	}
	lines.push(["Total", columns.map(([, cell]) => cell(report.totals))]);
	const width = Math.min(
		56,
		Math.max(4, ...lines.map(([name]) => name.length)),
	);
	const cut = (name: string) =>
		name.length > width ? `${name.slice(0, width - 1)}…` : name;
	const widths = columns.map(([head], index) =>
		Math.max(head.length, ...lines.map(([, cells]) => cells[index]!.length)),
	);
	const format = (name: string, cells: readonly string[]) =>
		[
			cut(name).padEnd(width),
			...cells.map((cell, index) => cell.padStart(widths[index]!)),
		].join("  ");
	const head = `Tokens · ${report.range.label} ${clockAt(report.range.from, now)}–${clockAt(report.range.to, now)} (${report.range.source}${report.range.resetsAt === undefined ? "" : `, resets ${clockAt(report.range.resetsAt, now)}`}) · by ${BY_WORD[report.by]} · ${cache === "raw" ? "without cache weighting" : "cache-aware"}`;
	const notes = [
		...(report.rows.length === 0 ? ["No requests in this range."] : []),
		...(cache === "weighted"
			? [
					`${COST_NOTE} Prices of ${report.prices.asOf}.`,
					...(report.totals.unpricedTokens > 0
						? [
								`${formatTokens(report.totals.unpricedTokens)} tokens on models with no pinned price are not in the cost.`,
							]
						: []),
				]
			: []),
		...(report.overlapping
			? [
					"An agent bound to two tasks at once counts toward both: the rows add up to more than the total.",
				]
			: []),
		...report.sources.flatMap((source) => [
			...(source.problem === undefined
				? []
				: [
						`${source.cli} on ${source.machine} (${source.root}) could not be read: ${source.problem}`,
					]),
			...(source.catchingUp === true
				? [
						`${source.cli} on ${source.machine}: still reading older transcripts; the figures will grow.`,
					]
				: []),
		]),
	];
	return [
		head,
		format(
			"",
			columns.map(([name]) => name),
		),
		...lines.map(([name, cells]) => format(name, cells)),
		...notes,
	].join("\n");
}
