/**
 * Claude's and Codex's rate limits, at the foot of the Sidebar.
 *
 * One slim row per CLI that has reported: its name, a bar of how much is used
 * of its window that resets soonest, the percentage and when that window
 * resets, `12% (until 16:50)`: the time when the reset is later today, the
 * date alone when it is another day (`resetTime.ts`, the words the tooltip
 * uses too). A reset that is unknown or already past has no parenthesis
 * rather than a guess. The row is coloured by the strictest of the CLI's
 * current windows, and when that is not the shown one a small caption under
 * the bar names it, *Approaching 7-day limit* (`usageRow.ts` decides all
 * three). On the rail the names and numbers go and the bars stay, one per
 * CLI, so a limit coming close still shows.
 *
 * The rows share one grid, so every bar has the same edges whatever the
 * width of the words beside it; when the column is narrow the parenthesis
 * gives way before the percentage or the bar.
 *
 * The detail is on hover, through the same tooltip every row uses: per CLI,
 * every window it reported (five-hour, seven-day, …) as a labelled bar with
 * its reset, or that no GUI Agent of that CLI has reported yet. The numbers
 * are what the CLIs' GUI Agents last said (`main/shell/usageLimits.ts`);
 * DevHub does not ask the accounts itself, so a CLI nobody has run as a GUI
 * Agent is unknown, and says so, rather than zero.
 *
 * Nothing at all is drawn while neither CLI has reported: a readout that only
 * ever says "unknown" is noise in a column that is about Workspaces.
 */

import { useEffect, useState, type CSSProperties } from "react";
import type { TooltipLineWire, UsageLimitsWire } from "../../../ipc/contract";
import { resetTime } from "../../resetTime";
import { usageRow, type UsageRow } from "./usageRow";

type Window = NonNullable<UsageLimitsWire["clis"][number]["windows"]>[number];

const CLI_NAMES = { claude: "Claude", codex: "Codex" } as const;

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
      : [{ cli: one.cli, ...shown, until: until(shown, at) }];
  });
  if (rows.length === 0) return null;
  const spoken = rows
    .map(
      (row) =>
        `${CLI_NAMES[row.cli]} ${percent(row.window.usedPercent)}${
          row.stale ? " before its last reset" : ""
        }${row.until === undefined ? "" : ` until ${row.until}`}${
          row.caption === undefined ? "" : `, ${row.caption.toLowerCase()}`
        }`,
    )
    .join(", ");
  return (
    <div
      className="sidebar-usage"
      role="status"
      aria-label={`Usage limits: ${spoken}`}
      data-tooltip-lines={JSON.stringify(tooltipLines(limits))}
    >
      {rows.map((row) => (
        <div
          key={row.cli}
          className="sidebar-usage-cli"
          data-level={row.level}
          data-stale={row.stale || undefined}
        >
          <span className="sidebar-usage-name">{CLI_NAMES[row.cli]}</span>
          <span className="sidebar-usage-track" aria-hidden="true">
            <span
              className="sidebar-usage-fill"
              style={
                {
                  "--usage-fill": `${Math.min(Math.max(row.window.usedPercent ?? 0, 0), 100)}%`,
                } as CSSProperties
              }
            />
          </span>
          <span className="sidebar-usage-value">
            {percent(row.window.usedPercent)}
          </span>
          {row.until === undefined ? null : (
            <span className="sidebar-usage-reset">
              ({`until ${row.until}`})
            </span>
          )}
          {row.caption === undefined ? null : (
            <span className="sidebar-usage-caption">{row.caption}</span>
          )}
        </div>
      ))}
    </div>
  );
}

/** When the shown window resets, while that is known and still ahead. */
function until(shown: UsageRow<Window>, now: number): string | undefined {
  const resetsAt = shown.window.resetsAt;
  return resetsAt === undefined || shown.stale
    ? undefined
    : resetTime(resetsAt, now);
}

function percent(used: number | undefined): string {
  return used === undefined ? "?" : `${String(Math.round(used))}%`;
}

/**
 * The hover: per CLI, its name and a bar per window. The words about time are
 * the tooltip page's, worked out as it draws (`TooltipMeterLineWire`).
 */
function tooltipLines(limits: UsageLimitsWire): readonly TooltipLineWire[] {
  return limits.clis.flatMap((one): TooltipLineWire[] => {
    const name: TooltipLineWire = { text: CLI_NAMES[one.cli], style: "name" };
    const windows = one.windows;
    if (windows === undefined) {
      return [
        name,
        {
          text: `Not reported yet: no ${CLI_NAMES[one.cli]} GUI Agent has said`,
          style: "note",
        },
      ];
    }
    return [
      name,
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
