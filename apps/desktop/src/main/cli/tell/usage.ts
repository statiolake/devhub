/**
 * `devhub --tell usage`: each CLI's plan limits, as the Sidebar's readout has
 * them (`main/shell/usageLimits.ts`), with how old they are. It only reads
 * the readout: what the background readers (`usageReaders.ts`) and the GUI
 * Agents last said. It never makes a read of its own.
 *
 * Text is one line per CLI:
 *
 *     claude: 5-hour 16% resets 19:20, 7-day 39% resets 11-08 10:00 · read 14:02 (2 min ago)
 *     codex: no plan limits · read 14:01 (3 min ago)
 *
 * `--json` is `UsageJson`: every field always there, `null` for what is not
 * known.
 */

import type { UsageReport } from "../../shell/usageLimits.js";
import { clockAt, excerpt } from "../../orchestrator/events.js";

export interface UsageWindowJson {
	/** `5-hour`, `7-day`, or the CLI's own name for it. */
	readonly window: string;
	readonly durationMinutes: number | null;
	/** 0–100, as last read. */
	readonly usedPercent: number | null;
	/** ISO 8601. */
	readonly resetsAt: string | null;
	/** Its reset has passed: the window has started again since this reading. */
	readonly reset: boolean;
	/** When this reading was last taken or confirmed (ISO 8601). */
	readonly seenAt: string | null;
	readonly ageSeconds: number | null;
}

export interface UsageCliJson {
	/** `claude`, `codex`. */
	readonly cli: string;
	/**
	 * `limits`: the sign-in has plan limits (its windows are below);
	 * `no_plan_limits`: an API key, Bedrock; null: not known.
	 */
	readonly plan: "limits" | "no_plan_limits" | null;
	readonly windows: readonly UsageWindowJson[];
	/** When DevHub's own reader last read the account (ISO 8601). */
	readonly lastReadAt: string | null;
	/** Since the newest of `lastReadAt` and the windows' `seenAt`. */
	readonly ageSeconds: number | null;
	/** The reader's latest attempt, when that gave nothing: when, and why. */
	readonly problem: { readonly at: string; readonly text: string } | null;
	/** `no_plan_limits`, or `cli_not_found`: the command is not on this Mac. */
	readonly note: "no_plan_limits" | "cli_not_found" | null;
}

export interface UsageJson {
	readonly schema: 1;
	/** When this answer was made (ISO 8601). */
	readonly at: string;
	readonly clis: readonly UsageCliJson[];
}

const iso = (ms: number | undefined): string | null =>
	ms === undefined ? null : new Date(ms).toISOString();

const age = (ms: number | undefined, now: number): number | null =>
	ms === undefined ? null : Math.max(0, Math.round((now - ms) / 1000));

/** `just now`, `3 min ago`, `2 h 5 min ago`. */
function ago(ms: number, now: number): string {
	const minutes = Math.floor((now - ms) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${String(minutes)} min ago`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest === 0
		? `${String(hours)} h ago`
		: `${String(hours)} h ${String(rest)} min ago`;
}

function percent(used: number | undefined): string {
	return used === undefined ? "?%" : `${String(Math.round(used))}%`;
}

export function usageJson(report: UsageReport, now: number): UsageJson {
	return {
		schema: 1,
		at: new Date(now).toISOString(),
		clis: report.clis.map((one) => {
			const windows = one.windows ?? [];
			const newest = Math.max(
				one.reader?.readAt ?? -Infinity,
				...windows.map((window) => window.seenAt ?? -Infinity),
			);
			return {
				cli: one.cli,
				plan:
					windows.length > 0
						? "limits"
						: one.note === "no_plan_limits"
							? "no_plan_limits"
							: null,
				windows: windows.map((window) => ({
					window: window.window,
					durationMinutes: window.durationMinutes ?? null,
					usedPercent: window.usedPercent ?? null,
					resetsAt: iso(window.resetsAt),
					reset: window.resetsAt !== undefined && window.resetsAt <= now,
					seenAt: iso(window.seenAt),
					ageSeconds: age(window.seenAt, now),
				})),
				lastReadAt: iso(one.reader?.readAt),
				ageSeconds: Number.isFinite(newest) ? age(newest, now) : null,
				problem:
					one.reader?.problem === undefined
						? null
						: {
								at: new Date(one.reader.problem.at).toISOString(),
								text: one.reader.problem.text,
							},
				note: one.note ?? null,
			};
		}),
	};
}

/** One line per CLI. */
export function usageText(report: UsageReport, now: number): string {
	return report.clis
		.map((one) => {
			const windows = (one.windows ?? []).map((window) =>
				window.resetsAt !== undefined && window.resetsAt <= now
					? `${window.window} reset ${clockAt(window.resetsAt, now)} (was ${percent(window.usedPercent)})`
					: `${window.window} ${percent(window.usedPercent)}${
							window.resetsAt === undefined
								? ""
								: ` resets ${clockAt(window.resetsAt, now)}`
						}`,
			);
			const what =
				windows.length > 0
					? windows.join(", ")
					: one.note === "no_plan_limits"
						? "no plan limits"
						: one.note === "cli_not_found"
							? "not read: its command is not on this Mac"
							: "not known yet";
			const readAt = one.reader?.readAt;
			const parts = [
				`${one.cli}: ${what}`,
				...(readAt === undefined
					? one.note === "cli_not_found"
						? []
						: ["never read"]
					: [`read ${clockAt(readAt, now)} (${ago(readAt, now)})`]),
				...(one.reader?.problem === undefined
					? []
					: [`last attempt: ${excerpt(one.reader.problem.text, 160)}`]),
			];
			return parts.join(" · ");
		})
		.join("\n");
}
