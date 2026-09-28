/**
 * What one CLI's rate-limit row in the Sidebar says, decided in one place:
 * which window it shows, how it is coloured, and the caption that says why
 * when the colour is not the shown window's own.
 *
 * The row shows the window that resets soonest among the readings still
 * current — the five-hour one, usually — since that is the number that moves.
 * Its colour is the strictest level (`usageLevel.ts`) among every current
 * window, so a weekly window near its end still turns the row. When that
 * colour comes from a window other than the shown one, the caption names it
 * by the CLI's own label: *Approaching 7-day limit*, *7-day limit nearly
 * reached*.
 *
 * A reading whose reset has passed is history. Only when every reading is
 * history does the row show one — the nearest its limit, faded — and history
 * is never a warning: calm, with no caption.
 */

import { mostUsedRateLimit } from "../../../model/conversation";
import { usageLevel, type UsageLevel } from "../../usageLevel";

export interface UsageWindow {
  readonly window: string;
  readonly usedPercent?: number | undefined;
  readonly resetsAt?: number | undefined;
}

export interface UsageRow<W extends UsageWindow> {
  readonly window: W;
  readonly stale: boolean;
  readonly level: UsageLevel;
  /** Why the row is coloured, when another window than the shown one is the reason. */
  readonly caption: string | undefined;
}

const RANK: Readonly<Record<UsageLevel, number>> = { calm: 0, near: 1, at: 2 };

export function usageRow<W extends UsageWindow>(
  windows: readonly W[],
  now: number,
): UsageRow<W> | undefined {
  const current = windows.filter(
    (one) => one.resetsAt === undefined || one.resetsAt > now,
  );
  if (current.length === 0) {
    const past = mostUsedRateLimit(windows);
    return past === undefined
      ? undefined
      : { window: past, stale: true, level: "calm", caption: undefined };
  }
  const shown = current.reduce((soonest, one) =>
    resetsBefore(one, soonest) ? one : soonest,
  );
  const shownLevel = usageLevel(shown.usedPercent);
  const strictest = current.reduce((most, one) =>
    RANK[usageLevel(one.usedPercent)] > RANK[usageLevel(most.usedPercent)]
      ? one
      : most,
  );
  const level = usageLevel(strictest.usedPercent);
  return {
    window: shown,
    stale: false,
    level,
    caption:
      RANK[level] > RANK[shownLevel]
        ? caption(strictest.window, level)
        : undefined,
  };
}

/** Whether `one` resets before `other`: an unknown reset is last, a tie goes to the more used. */
function resetsBefore(one: UsageWindow, other: UsageWindow): boolean {
  const a = one.resetsAt ?? Infinity;
  const b = other.resetsAt ?? Infinity;
  return a === b ? (one.usedPercent ?? -1) > (other.usedPercent ?? -1) : a < b;
}

function caption(label: string, level: UsageLevel): string {
  return level === "at"
    ? `${label.charAt(0).toUpperCase()}${label.slice(1)} limit nearly reached`
    : `Approaching ${label} limit`;
}
