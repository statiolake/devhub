/** How near a reset is still said by the clock rather than by the date. */
const CLOCK_HORIZON_MS = 12 * 60 * 60_000;

/**
 * When a rate-limit window resets, as every readout of it says so: the time,
 * `16:50`, when the reset is within twelve hours of now, even past midnight;
 * the date alone, `10/3` in the reader's locale, when it is further off. A
 * reset hours away is planned around by the clock, one days away by the day,
 * and a weekly or monthly window reads the same way as a five-hour one does
 * once it is that close. A reset already past reads by the same distance, so
 * the one that just went by is still a time. The Sidebar's usage row and its
 * tooltip both use this, so one reset never reads two ways.
 *
 * The time is on the 24-hour clock, so the Sidebar's one-line row never
 * carries an AM/PM it has no room for.
 */
export function resetTime(epochMs: number, now: number): string {
  const date = new Date(epochMs);
  return Math.abs(epochMs - now) <= CLOCK_HORIZON_MS
    ? date.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
    : date.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
}

/**
 * When something timed by a reset happens, as a conversation line says it
 * (*resuming at 16:50*): the time within twelve hours of now, as `resetTime`
 * says it; the short date and the time further off, `10/3 16:50`, since the
 * line says when something will be done, not only which day.
 */
export function clockTime(epochMs: number, now: number): string {
  const date = new Date(epochMs);
  const time = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return Math.abs(epochMs - now) <= CLOCK_HORIZON_MS
    ? time
    : `${date.toLocaleDateString(undefined, { month: "numeric", day: "numeric" })} ${time}`;
}

/**
 * How long until a rate-limit window resets, in the largest two units that
 * say it: `in 2h 10m`, `in 3d 4h`, `in 12m`, `in under a minute`. For a reset
 * that is still ahead; one already past is history, and its readout says so
 * instead.
 */
export function resetsIn(epochMs: number, now: number): string {
  const minutes = Math.floor((epochMs - now) / 60_000);
  if (minutes < 1) return "in under a minute";
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  const rest = minutes % 60;
  if (days > 0) return hours > 0 ? `in ${days}d ${hours}h` : `in ${days}d`;
  if (hours > 0) return rest > 0 ? `in ${hours}h ${rest}m` : `in ${hours}h`;
  return `in ${rest}m`;
}
