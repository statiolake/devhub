/**
 * One episode, one notice — the rule from `main/shell/machineConditions.ts`,
 * moved to the seam so no publisher can flap however fast it runs.
 *
 * `machineConditions.ts` got the rule right and got it right for one caller:
 * a machine that will not answer is raised once when an episode of failure
 * starts and never again while it holds, because the round that raised it runs
 * again a cadence tick later and will raise it again. That is not a property
 * of machines. It is a property of *every* app-scoped notice whose source is a
 * loop, and DevHub is full of loops — a reconcile cadence, an attach that
 * retries, an editor that restarts, a status poll. Each of them publishes a
 * failure that is not an event but a standing fact, and each of them would
 * have needed the same hysteresis written again.
 *
 * So it is written once, here, in front of the send. A publisher raises as
 * often as it likes and the page hears about it once.
 *
 * # Why this and not a stable identity alone
 *
 * A stable identity (`ipc/appShell.ts`) already stops the *worst* of it: the
 * toast stack keys by identity, so a re-raise of the same identity replaces
 * the notice in its slot rather than taking a node out and putting another in.
 * That makes the DOM stop blinking. It does not make the *sentence* stop
 * moving — the detail is the failing side's own words about this attempt, and
 * at twenty publishes a second a person watches a sentence churn even though
 * the node under it is the same one. Nor does it help two different codes
 * alternating, which is two identities and therefore a real remove and add.
 *
 * This fixes both, because it stops the publish rather than tidying up after
 * it. The episode keeps the words of its first publish, for exactly the reason
 * `machineConditions.ts` gives: a later failure that reads differently is the
 * same thing still failing, and the differing reason is worth having in the
 * log rather than on screen.
 *
 * # What ends an episode
 *
 * Two things, and both are evidence rather than a guess.
 *
 * The first is **quiet**. A publisher that has stopped publishing for
 * `quietMs` is a condition that has stopped holding; the next publish after
 * that is news. It is a timeout and not a success signal because there is no
 * success signal to have: `publishError` is told about failures and nothing
 * tells it when one stopped being true.
 *
 * The second is **the page saying the notice is off screen**. A person who
 * dismisses a notice, or who starts another action (which retires a failure —
 * `shell/alertLifetime.ts`), has emptied the slot, and a publisher that fails
 * again after that has something to say. Without it, a person who pressed
 * Retry inside the quiet window would clear the notice with their own gesture
 * and then never be told that the retry failed too — a failure suppressed into
 * silence, which is worse than the flicker this exists to stop.
 *
 * # Why it is here and not in main
 *
 * Because main is not the only publisher. The App Shell page raises its own
 * failures without main hearing about them — an unhandled rejection, a
 * sheet's action, a request main refused — and a
 * gate in `publishError` would have left every one of those unguarded. The
 * one place they all arrive is the hook that holds what is on screen, so that
 * is where the rule goes. Main publishes as often as it likes and writes down
 * every one of them, which is what makes the journal's rate the *real* rate
 * rather than the rate main allowed.
 */

/** How long a publisher must be quiet before its next word is news again. */
const QUIET_MS = 5_000;

export interface NoticeEpisodesOptions {
  readonly quietMs?: number;
  readonly now?: () => number;
}

export class NoticeEpisodes {
  /** When each standing identity was last published. */
  readonly #lastAt = new Map<string, number>();
  readonly #quietMs: number;
  readonly #now: () => number;

  constructor(options: NoticeEpisodesOptions = {}) {
    this.#quietMs = options.quietMs ?? QUIET_MS;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Whether this publish is the start of an episode, and so reaches the page.
   *
   * `false` is not a failure dropped: the notice it would have raised is
   * already on screen, saying the same thing about the same subject. The
   * words of this particular attempt go to the journal, which is where a
   * second reason is worth having.
   */
  begins(identity: string): boolean {
    const now = this.#now();
    const lastAt = this.#lastAt.get(identity);
    this.#lastAt.set(identity, now);
    return lastAt === undefined || now - lastAt >= this.#quietMs;
  }

  /** The page says this notice is no longer on screen. */
  ended(identity: string): void {
    this.#lastAt.delete(identity);
  }

  /**
   * Every episode in this channel is over.
   *
   * What the person's next action means for failures: they have moved on, so
   * a report about the last thing is in the way of the next, and everything
   * held back on the grounds that it was already on screen is held back no
   * longer. The shared lifetime rule forgets what was dismissed at exactly
   * the same moment and for exactly the same reason
   * (`shell/alertLifetime.ts`); two suppressions that forgot at different
   * moments would be two rules, and the one that forgot last would decide.
   */
  endedAll(): void {
    this.#lastAt.clear();
  }
}
