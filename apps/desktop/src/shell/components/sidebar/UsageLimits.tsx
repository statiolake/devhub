/**
 * Claude's and Codex's rate limits, at the foot of the Sidebar.
 *
 * One quiet line — each CLI that has reported, and how much of its limit is
 * used — with the detail on hover, through the same tooltip every row uses:
 * per CLI, how much is used and when it resets, or that no GUI Agent of that
 * CLI has reported yet. The numbers are what the CLIs' GUI Agents last said
 * (`main/shell/usageLimits.ts`); DevHub does not ask the accounts itself, so
 * a CLI nobody has run as a GUI Agent is unknown, and says so, rather than
 * zero.
 *
 * Nothing at all is drawn while neither CLI has reported: a line that only
 * ever says "unknown" is noise in a column that is about Workspaces.
 */

import type { TooltipLineWire, UsageLimitsWire } from "../../../ipc/contract";

const CLI_NAMES = { claude: "Claude", codex: "Codex" } as const;

export function UsageLimits({
  limits,
  now = Date.now(),
}: {
  readonly limits: UsageLimitsWire;
  /** When "reset" is measured from; the clock, except in a test. */
  readonly now?: number;
}) {
  const reported = limits.clis.filter((one) => one.limit !== undefined);
  if (reported.length === 0) return null;
  const summary = reported
    .map((one) => `${CLI_NAMES[one.cli]} ${percent(one.limit?.usedPercent)}`)
    .join(" · ");
  return (
    <div
      className="sidebar-usage"
      role="status"
      aria-label={`Usage limits: ${summary}`}
      data-tooltip-lines={JSON.stringify(tooltipLines(limits, now))}
    >
      {summary}
    </div>
  );
}

function percent(used: number | undefined): string {
  return used === undefined ? "?" : `${String(Math.round(used))}%`;
}

function tooltipLines(
  limits: UsageLimitsWire,
  now: number,
): readonly TooltipLineWire[] {
  return limits.clis.flatMap((one): TooltipLineWire[] => {
    const name: TooltipLineWire = {
      text: `${CLI_NAMES[one.cli]} usage limit`,
      style: "name",
    };
    const limit = one.limit;
    if (limit === undefined) {
      return [
        name,
        {
          text: `No ${CLI_NAMES[one.cli]} GUI Agent has reported it yet`,
          style: "note",
        },
      ];
    }
    const used =
      limit.usedPercent === undefined
        ? "Use not reported"
        : `${percent(limit.usedPercent)} used`;
    return [name, { text: used, style: "muted" }, resetLine(limit, now)];
  });
}

function resetLine(
  limit: NonNullable<UsageLimitsWire["clis"][number]["limit"]>,
  now: number,
): TooltipLineWire {
  if (limit.resetsAt === undefined) {
    return { text: "Reset time not reported", style: "muted" };
  }
  const at = when(limit.resetsAt, now);
  // A reading from before its window reset is history: the number above is
  // what was used then, and nothing newer has come in.
  return limit.resetsAt <= now
    ? { text: `Reset ${at}; nothing reported since`, style: "note" }
    : { text: `Resets ${at}`, style: "muted" };
}

/** `14:30` today, `Mon 14:30` another day. */
function when(epochMs: number, now: number): string {
  const date = new Date(epochMs);
  const time = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return new Date(now).toDateString() === date.toDateString()
    ? time
    : `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}
