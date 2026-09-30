/**
 * What one CLI's rate-limit row in the Sidebar says, decided in one place:
 * which window it shows, what that window reads now, how the row is
 * coloured, and the caption that says why when the colour is not the shown
 * window's own.
 *
 * The row shows the CLI's shortest window — the five-hour one over the
 * seven-day one — since that is the number that moves. The length is the
 * CLI's own, decoded with the window (`durationMinutes`: Codex's
 * `windowDurationMins`, Claude's `five_hour` and `seven_day`); a window of no
 * known length comes after every one whose length is known, and between
 * those the first reported is shown.
 *
 * A reading whose reset has passed is history, and says nothing about now
 * except that its window has started again: the account reports an unstarted
 * window as nothing at all, so the last reading is what stays. The shown
 * window is still the shortest one then — it does not give way to a longer
 * window — and reads as reset, `0% (reset)`, faded because it is inferred and
 * not read.
 *
 * The colour is the strictest level (`usageLevel.ts`) among every window, a
 * reset one counting as empty, so a weekly window near its end still turns
 * the row. When that colour comes from a window other than the shown one, the
 * caption names it by the CLI's own label: *Approaching 7-day limit*, *7-day
 * limit nearly reached*.
 */

import { usageLevel, type UsageLevel } from "../../usageLevel";

export interface UsageWindow {
  readonly window: string;
  readonly durationMinutes?: number | undefined;
  readonly usedPercent?: number | undefined;
  readonly resetsAt?: number | undefined;
}

export interface UsageRow {
  /** The shown window's label. */
  readonly window: string;
  /** How much of it is used now: 0 once it has reset. */
  readonly usedPercent: number | undefined;
  /** When it resets, while that is known and still ahead. */
  readonly resetsAt: number | undefined;
  /** Its last reading's reset has passed: it has started again since. */
  readonly stale: boolean;
  readonly level: UsageLevel;
  /** Why the row is coloured, when another window than the shown one is the reason. */
  readonly caption: string | undefined;
}

const RANK: Readonly<Record<UsageLevel, number>> = { calm: 0, near: 1, at: 2 };

export function usageRow(
  windows: readonly UsageWindow[],
  now: number,
): UsageRow | undefined {
  const readings = windows.map((one) => asOf(one, now));
  const shown = readings.reduce<Reading | undefined>(
    (shortest, one) =>
      shortest === undefined || one.minutes < shortest.minutes ? one : shortest,
    undefined,
  );
  if (shown === undefined) return undefined;
  const strictest = readings.reduce((most, one) =>
    RANK[one.level] > RANK[most.level] ? one : most,
  );
  return {
    window: shown.window,
    usedPercent: shown.usedPercent,
    resetsAt: shown.resetsAt,
    stale: shown.stale,
    level: strictest.level,
    caption:
      RANK[strictest.level] > RANK[shown.level]
        ? caption(strictest.window, strictest.level)
        : undefined,
  };
}

interface Reading {
  readonly window: string;
  /** The window's length; a window of no known length is longer than any. */
  readonly minutes: number;
  readonly usedPercent: number | undefined;
  readonly resetsAt: number | undefined;
  readonly stale: boolean;
  readonly level: UsageLevel;
}

/** What a window's last reading says of it now. */
function asOf(one: UsageWindow, now: number): Reading {
  const minutes = one.durationMinutes ?? Infinity;
  const stale = one.resetsAt !== undefined && one.resetsAt <= now;
  const usedPercent = stale ? 0 : one.usedPercent;
  return {
    window: one.window,
    minutes,
    usedPercent,
    resetsAt: stale ? undefined : one.resetsAt,
    stale,
    level: usageLevel(usedPercent),
  };
}

function caption(label: string, level: UsageLevel): string {
  return level === "at"
    ? `${label.charAt(0).toUpperCase()}${label.slice(1)} limit nearly reached`
    : `Approaching ${label} limit`;
}
