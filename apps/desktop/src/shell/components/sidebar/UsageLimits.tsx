/**
 * Claude's and Codex's rate limits, at the foot of the Sidebar.
 *
 * One slim row per CLI that has reported: its name, a bar of how much is used
 * of its window nearest the limit — the one that stops it first — the
 * percentage and when that window resets, `79% (until 16:50)`: the time when
 * the reset is later today, the date alone when it is another day
 * (`resetTime.ts`, the words the tooltip uses too). A reset that is unknown or
 * already past has no parenthesis rather than a guess. The row stays one line;
 * when the column is narrow the parenthesis gives way before the percentage.
 * The bar is the column's quiet ink until the window is near its end
 * (`usageLevel.ts`). On the rail the names and numbers go and the bars stay,
 * one per CLI, so a limit coming close still shows.
 *
 * The detail is on hover, through the same tooltip every row uses: per CLI,
 * every window it reported (five-hour, seven-day, …) as a labelled bar with
 * its reset, or that no GUI Agent of that CLI has reported yet. The numbers
 * are what the CLIs' GUI Agents last said (`main/shell/usageLimits.ts`);
 * DevHub does not ask the accounts itself, so a CLI nobody has run as a GUI
 * Agent is unknown, and says so, rather than zero.
 *
 * A reading whose reset has passed is history: what was used then, with
 * nothing newer reported. The row shows the window nearest its limit among
 * the readings still current, and only when every reading is history the
 * nearest of those, faded.
 *
 * Nothing at all is drawn while neither CLI has reported: a readout that only
 * ever says "unknown" is noise in a column that is about Workspaces.
 */

import { useEffect, useState, type CSSProperties } from "react";
import type { TooltipLineWire, UsageLimitsWire } from "../../../ipc/contract";
import { mostUsedRateLimit } from "../../../model/conversation";
import { resetTime } from "../../resetTime";
import { usageLevel } from "../../usageLevel";

type Window = NonNullable<UsageLimitsWire["clis"][number]["windows"]>[number];

const CLI_NAMES = { claude: "Claude", codex: "Codex" } as const;

function isHistory(window: Window, now: number): boolean {
  return window.resetsAt !== undefined && window.resetsAt <= now;
}

/** The window a CLI's row shows, and whether that reading is history. */
function shownWindow(
  windows: readonly Window[],
  now: number,
): { readonly window: Window; readonly stale: boolean } | undefined {
  const current = mostUsedRateLimit(
    windows.filter((window) => !isHistory(window, now)),
  );
  if (current !== undefined) return { window: current, stale: false };
  const past = mostUsedRateLimit(windows);
  return past === undefined ? undefined : { window: past, stale: true };
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
    const shown = shownWindow(one.windows ?? [], at);
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
        }${row.until === undefined ? "" : ` until ${row.until}`}`,
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
          // History is not a warning: what was near its limit then is not now.
          data-level={row.stale ? "calm" : usageLevel(row.window.usedPercent)}
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
        </div>
      ))}
    </div>
  );
}

/** When the shown window resets, while that is known and still ahead. */
function until(
  shown: { readonly window: Window; readonly stale: boolean },
  now: number,
): string | undefined {
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
