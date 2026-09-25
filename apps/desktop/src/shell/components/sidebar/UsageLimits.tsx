/**
 * Claude's and Codex's rate limits, at the foot of the Sidebar.
 *
 * One quiet line — each CLI that has reported, and how much is used of its
 * window nearest the limit, the one that stops it first — with the detail on
 * hover, through the same tooltip every row uses: per CLI, every window it
 * reported (five-hour, seven-day, …), how much of it is used and when it
 * resets, or that no GUI Agent of that CLI has reported yet. The numbers are what the CLIs' GUI Agents last said
 * (`main/shell/usageLimits.ts`); DevHub does not ask the accounts itself, so
 * a CLI nobody has run as a GUI Agent is unknown, and says so, rather than
 * zero.
 *
 * Nothing at all is drawn while neither CLI has reported: a line that only
 * ever says "unknown" is noise in a column that is about Workspaces.
 */

import type { TooltipLineWire, UsageLimitsWire } from "../../../ipc/contract";
import { mostUsedRateLimit } from "../../../model/conversation";
import { resetTime } from "../../resetTime";

type Window = NonNullable<UsageLimitsWire["clis"][number]["windows"]>[number];

const CLI_NAMES = { claude: "Claude", codex: "Codex" } as const;

export function UsageLimits({
  limits,
  now = Date.now(),
}: {
  readonly limits: UsageLimitsWire;
  /** When "reset" is measured from; the clock, except in a test. */
  readonly now?: number;
}) {
  const summary = limits.clis
    .flatMap((one) => {
      const most = mostUsedRateLimit(one.windows ?? []);
      return most === undefined
        ? []
        : [`${CLI_NAMES[one.cli]} ${percent(most.usedPercent)}`];
    })
    .join(" · ");
  if (summary === "") return null;
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
    const windows = one.windows;
    if (windows === undefined) {
      return [
        name,
        {
          text: `No ${CLI_NAMES[one.cli]} GUI Agent has reported it yet`,
          style: "note",
        },
      ];
    }
    return [
      name,
      ...windows.flatMap((window): TooltipLineWire[] => [
        {
          text:
            window.usedPercent === undefined
              ? `${window.window}: use not reported`
              : `${window.window}: ${percent(window.usedPercent)} used`,
          style: "muted",
        },
        resetLine(window, now),
      ]),
    ];
  });
}

function resetLine(window: Window, now: number): TooltipLineWire {
  if (window.resetsAt === undefined) {
    return { text: "Reset time not reported", style: "muted" };
  }
  const at = resetTime(window.resetsAt, now);
  // A reading from before its window reset is history: the number above is
  // what was used then, and nothing newer has come in.
  return window.resetsAt <= now
    ? { text: `Reset ${at}; nothing reported since`, style: "note" }
    : { text: `Resets ${at}`, style: "muted" };
}
