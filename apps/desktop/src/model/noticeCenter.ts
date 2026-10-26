/**
 * The notice center: what the application said recently, newest first.
 *
 * A toast is on screen for a while and then hides itself; hiding is not
 * dismissing, so what it said is kept here, where it can be read again,
 * copied, and — while it is still in force — acted on. Memory only and
 * bounded: a list of what happened this run, not a log (main's log is that).
 *
 * Pure, so the rules are tested without a page: one entry per notice that
 * reached the screen; a notice whose words moved while it stood is the same
 * entry; an entry is `current` until what it reports is over (a failure until
 * the person's next action or a newer failure, a condition until its source
 * retracts it) and `read` once the person has seen it.
 */

/** `general.notice_seconds`: how long a toast stays up; `0` is for ever. */
export const DEFAULT_NOTICE_SECONDS = 8;

/** The most entries kept; the oldest goes first. */
export const NOTICE_CENTER_LIMIT = 100;

export interface CenterEntry<N extends { readonly identity: string }> {
  /** Unique within the run, so two episodes of one notice are two rows. */
  readonly key: number;
  readonly notice: N;
  /** When it reached the screen, in ms since the epoch. */
  readonly at: number;
  readonly read: boolean;
  /** Still in force: its actions still mean something. */
  readonly current: boolean;
}

export type NoticeCenter<N extends { readonly identity: string }> =
  readonly CenterEntry<N>[];

/**
 * A notice reached the screen.
 *
 * The newest current entry with the same identity is the same notice, so it
 * is updated in place (its words may have moved) rather than added again.
 */
export function noticeShown<N extends { readonly identity: string }>(
  center: NoticeCenter<N>,
  notice: N,
  at: number,
  key: number,
): NoticeCenter<N> {
  const index = center.findIndex(
    (entry) => entry.current && entry.notice.identity === notice.identity,
  );
  if (index >= 0) {
    const entry = center[index];
    if (entry?.notice === notice) return center;
    return center.map((each, i) => (i === index ? { ...each, notice } : each));
  }
  return [{ key, notice, at, read: false, current: true }, ...center].slice(
    0,
    NOTICE_CENTER_LIMIT,
  );
}

/** What these entries report is over: they stay, as history, without actions. */
export function noticesEnded<N extends { readonly identity: string }>(
  center: NoticeCenter<N>,
  ended: (notice: N) => boolean,
): NoticeCenter<N> {
  if (!center.some((entry) => entry.current && ended(entry.notice))) {
    return center;
  }
  return center.map((entry) =>
    entry.current && ended(entry.notice) ? { ...entry, current: false } : entry,
  );
}

/** The person has seen these: one identity's current entry, or all of them. */
export function noticesRead<N extends { readonly identity: string }>(
  center: NoticeCenter<N>,
  identity?: string,
): NoticeCenter<N> {
  const matches = (entry: CenterEntry<N>) =>
    !entry.read &&
    (identity === undefined ||
      (entry.current && entry.notice.identity === identity));
  if (!center.some(matches)) return center;
  return center.map((entry) =>
    matches(entry) ? { ...entry, read: true } : entry,
  );
}

export function noticeRemoved<N extends { readonly identity: string }>(
  center: NoticeCenter<N>,
  key: number,
): NoticeCenter<N> {
  return center.filter((entry) => entry.key !== key);
}

export function unreadCount<N extends { readonly identity: string }>(
  center: NoticeCenter<N>,
): number {
  return center.filter((entry) => !entry.read).length;
}
