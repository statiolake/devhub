/**
 * Claude's and Codex's rate limits, at the foot of the Sidebar.
 *
 * One slim row per CLI that has reported: its name, a bar of how much is used
 * of its shortest window (the five-hour one over the seven-day one), the
 * percentage and when that window resets, `12% (until 16:50)`: the time when
 * the reset is later today, the date alone when it is another day
 * (`resetTime.ts`, the words the tooltip uses too). A reset that is unknown
 * has no parenthesis rather than a guess; one that has passed means the
 * window has started again since its last reading, and the row says so,
 * faded, `0% (reset)`. The row is coloured by the strictest of the CLI's
 * windows, and when that is not the shown one a small caption under
 * the bar names it, *Approaching 7-day limit* (`usageRow.ts` decides all
 * three). On the rail the names and numbers go and the bars stay, one per
 * CLI, so a limit coming close still shows.
 *
 * The rows share one grid, so every bar has the same edges whatever the
 * width of the words beside it; when the column is narrow the parenthesis
 * gives way before the percentage or the bar.
 *
 * A CLI whose sign-in has no plan limits (an API key, Bedrock) and no
 * reading of any window has a quiet row saying so, *No plan limits*, and no
 * bar; on the rail it has nothing.
 *
 * The detail is on hover, through the same tooltip every row uses: per CLI,
 * every window it reported (five-hour, seven-day, …) as a labelled bar with
 * its reset, and what DevHub's reader of the account said besides — no plan
 * limits, or a command that is not on this Mac — or that nothing has been
 * read yet. The numbers are what DevHub's background reader of each account
 * and the CLIs' GUI Agents last said, merged per window
 * (`main/shell/usageLimits.ts`); a CLI nothing has read is unknown, and says
 * so, rather than zero.
 *
 * The tooltip also says, per CLI, when DevHub's reader last read the account
 * (*Updated 14:02 · 3 min ago*) and, when its latest attempt gave nothing, why
 * (*Not refreshed since: …*, the failure or the CLI's own "could not fetch"). A
 * row whose reader has not managed to read for `OUTDATED_MS` is faded a
 * little, as the reset one is, so a number that has stopped moving does not
 * pass for a current one.
 *
 * Nothing at all is drawn while neither CLI has anything to say: a readout
 * that only ever says "unknown" is noise in a column that is about Workspaces.
 */

import { useEffect, useState, type CSSProperties } from "react";
import type { TooltipLineWire, UsageLimitsWire } from "../../../ipc/contract";
import { clockTime, resetTime } from "../../resetTime";
import { usageRow, type UsageRow } from "./usageRow";

const CLI_NAMES = { claude: "Claude", codex: "Codex" } as const;

const NO_PLAN_LIMITS = "No plan limits";

/** What the tooltip says of a CLI besides its windows. */
const NOTES = {
  no_plan_limits: (cli: string) =>
    `No plan limits for this ${cli} sign-in: an API key or a cloud provider`,
  cli_not_found: (cli: string) =>
    `Not read: the first ${cli} profile's command is not on this Mac`,
} as const;

/**
 * How long the reader may go without a reading, while its attempts give
 * nothing, before the row says its number is old: a few of its attempts, so
 * one that failed once does not flicker the row.
 */
export const OUTDATED_MS = 10 * 60_000;

/** The longest reason the tooltip quotes; a CLI's stderr can run on. */
const PROBLEM_CHARS = 300;

type CliLimits = UsageLimitsWire["clis"][number];

/** Whether a CLI's reader has not read for a while and its latest attempt gave nothing. */
function outdated(one: CliLimits, now: number): boolean {
  const reader = one.reader;
  if (reader?.problem === undefined) return false;
  return reader.readAt === undefined || now - reader.readAt >= OUTDATED_MS;
}

/** How long ago, in the largest two units: `3 min ago`, `2 h 5 min ago`. */
function ago(epochMs: number, now: number): string {
  const minutes = Math.floor((now - epochMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? `${String(hours)} h ago`
    : `${String(hours)} h ${String(rest)} min ago`;
}

/** The clock, a minute at a time: a reading turns into history on its own. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function UsageLimits({
  limits,
  now,
}: {
  readonly limits: UsageLimitsWire;
  /** When "history" is measured from; the clock, except in a test. */
  readonly now?: number;
}) {
  const clock = useMinuteClock();
  const at = now ?? clock;
  const rows = limits.clis.flatMap((one) => {
    const shown = usageRow(one.windows ?? [], at);
    return shown === undefined
      ? []
      : [
          {
            cli: one.cli,
            ...shown,
            until: until(shown, at),
            outdated: outdated(one, at),
            readAt: one.reader?.readAt,
          },
        ];
  });
  // Windows are the reading when there are any; the note is what is left.
  const planless = limits.clis.filter(
    (one) =>
      one.note === "no_plan_limits" && !rows.some((row) => row.cli === one.cli),
  );
  if (rows.length === 0 && planless.length === 0) return null;
  const spoken = [
    ...rows.map(
      (row) =>
        `${CLI_NAMES[row.cli]} ${percent(row.usedPercent)}${
          row.until === undefined ? "" : ` ${row.until}`
        }${row.caption === undefined ? "" : `, ${row.caption.toLowerCase()}`}${
          row.outdated
            ? row.readAt === undefined
              ? ", not refreshed"
              : `, not refreshed since ${clockTime(row.readAt, at)}`
            : ""
        }`,
    ),
    ...planless.map((one) => `${CLI_NAMES[one.cli]} ${NO_PLAN_LIMITS}`),
  ].join(", ");
  return (
    <div
      className="sidebar-usage"
      role="status"
      aria-label={`Usage limits: ${spoken}`}
      data-tooltip-lines={JSON.stringify(tooltipLines(limits, at))}
    >
      {rows.map((row) => (
        <div
          key={row.cli}
          className="sidebar-usage-cli"
          data-level={row.level}
          data-stale={row.stale || undefined}
          data-outdated={row.outdated || undefined}
        >
          <span className="sidebar-usage-name">{CLI_NAMES[row.cli]}</span>
          <span className="sidebar-usage-track" aria-hidden="true">
            <span
              className="sidebar-usage-fill"
              style={
                {
                  "--usage-fill": `${Math.min(Math.max(row.usedPercent ?? 0, 0), 100)}%`,
                } as CSSProperties
              }
            />
          </span>
          <span className="sidebar-usage-value">
            {percent(row.usedPercent)}
          </span>
          {row.until === undefined ? null : (
            <span className="sidebar-usage-reset">({row.until})</span>
          )}
          {row.caption === undefined ? null : (
            <span className="sidebar-usage-caption">{row.caption}</span>
          )}
        </div>
      ))}
      {planless.map((one) => (
        <div key={one.cli} className="sidebar-usage-cli" data-planless="true">
          <span className="sidebar-usage-name">{CLI_NAMES[one.cli]}</span>
          <span className="sidebar-usage-note">{NO_PLAN_LIMITS}</span>
        </div>
      ))}
    </div>
  );
}

/** When the shown window resets, or that it has; nothing when that is unknown. */
function until(shown: UsageRow, now: number): string | undefined {
  if (shown.stale) return "reset";
  return shown.resetsAt === undefined
    ? undefined
    : `until ${resetTime(shown.resetsAt, now)}`;
}

function percent(used: number | undefined): string {
  return used === undefined ? "?" : `${String(Math.round(used))}%`;
}

/**
 * The hover: per CLI, its name and a bar per window. The words about time are
 * the tooltip page's, worked out as it draws (`TooltipMeterLineWire`).
 */
function tooltipLines(
  limits: UsageLimitsWire,
  now: number,
): readonly TooltipLineWire[] {
  return limits.clis.flatMap((one): TooltipLineWire[] => {
    const name: TooltipLineWire = { text: CLI_NAMES[one.cli], style: "name" };
    const windows = one.windows ?? [];
    const note: TooltipLineWire[] =
      one.note !== undefined
        ? [{ text: NOTES[one.note](CLI_NAMES[one.cli]), style: "note" }]
        : windows.length === 0
          ? [{ text: "Not read yet", style: "note" }]
          : [];
    return [
      name,
      ...note,
      ...readerLines(one, now),
      ...windows.map(
        (window): TooltipLineWire => ({
          kind: "meter",
          label: window.window,
          ...(window.usedPercent === undefined
            ? {}
            : { usedPercent: window.usedPercent }),
          ...(window.resetsAt === undefined
            ? {}
            : { resetsAt: window.resetsAt }),
        }),
      ),
    ];
  });
}

/**
 * When the reader last read a CLI's account, and why its latest attempt gave
 * nothing, when it did.
 */
function readerLines(one: CliLimits, now: number): TooltipLineWire[] {
  const reader = one.reader;
  if (reader === undefined) return [];
  const lines: TooltipLineWire[] = [];
  if (reader.readAt !== undefined) {
    lines.push({
      text: `Updated ${clockTime(reader.readAt, now)} · ${ago(reader.readAt, now)}`,
      style: "muted",
    });
  }
  if (reader.problem !== undefined) {
    const text =
      reader.problem.text.length > PROBLEM_CHARS
        ? `${reader.problem.text.slice(0, PROBLEM_CHARS - 1)}…`
        : reader.problem.text;
    lines.push({
      text: `${
        reader.readAt === undefined ? "Could not read" : "Not refreshed since"
      } (tried ${clockTime(reader.problem.at, now)}): ${text}`,
      style: "note",
    });
  }
  return lines;
}
