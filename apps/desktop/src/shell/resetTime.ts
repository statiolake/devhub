/**
 * When a rate-limit window resets, as every readout of it says so: `14:30`
 * today, `Mon 14:30` another day. The Sidebar's usage tooltip and the
 * conversation header both use this, so a seven-day window's reset reads the
 * same in both and never as a bare time days away.
 */
export function resetTime(epochMs: number, now: number): string {
  const date = new Date(epochMs);
  const time = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return new Date(now).toDateString() === date.toDateString()
    ? time
    : `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
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
