/**
 * When a rate-limit window resets, as every readout of it says so: the time,
 * `16:50`, when that is later today; the date alone, `10/3` in the reader's
 * locale, when it is another day. A reset days away is planned around by the
 * day, not the minute, and a weekly or monthly window reads the same way as a
 * five-hour one does once its day has come. The Sidebar's usage row and its
 * tooltip both use this, so one reset never reads two ways.
 *
 * Days are the reader's local calendar days; the time is on the 24-hour
 * clock, so the Sidebar's one-line row never carries an AM/PM it has no room
 * for.
 */
export function resetTime(epochMs: number, now: number): string {
  const date = new Date(epochMs);
  return new Date(now).toDateString() === date.toDateString()
    ? date.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
    : date.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
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
