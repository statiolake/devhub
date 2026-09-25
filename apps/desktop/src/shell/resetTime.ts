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
