/**
 * Back and Forward, as a browser has them, over the places DevHub has shown.
 *
 * DevHub's shell shows one thing at a time in its content area: a Workspace's
 * workbench, an Agent on its own, or the two side by side. That *selection*
 * (`AppModel.selection`) is the shell's whole notion of "where you are", so it
 * is also the whole of what an entry here is — there is no second record of
 * pages next to it to drift out of step with it. This module is generic over
 * the entry so that it stays a list and a cursor and nothing else: what makes
 * two entries the same, and whether one still names something, are questions
 * the model answers and hands in.
 *
 * The rules are the ones every browser has taught everyone, because a
 * history that behaves differently from that one is a history people stop
 * trusting:
 *
 * - **A visit after going back cuts off what was ahead.** Forward is "undo my
 *   Back", and once you have gone somewhere new there is nothing it could
 *   undo.
 * - **A place is somewhere you were, not somewhere you passed.** The model
 *   records a place when the person *does* something there — a key, a click,
 *   a scroll inside it — or arrives there on purpose (a new Agent, an opened
 *   Workspace), never because the selection passed over it
 *   (`Cmd+Q N/P`, a Sidebar row). So the place on screen may be one history
 *   has no entry for (`here`, below): Back from it goes to the latest place
 *   recorded, which is the cursor's own entry, and Forward is what it was.
 * - **Going back or forward is not a visit.** The cursor moves, and the
 *   selection follows it; nothing is recorded.
 * - **The same place twice in a row is one entry.** Clicking the row you are
 *   on, or a revision that changed something other than the selection, is not
 *   somewhere to go back to.
 * - **A place that has gone is skipped, not refused.** A closed Agent or
 *   Workspace stays in the list — removing it would make the person's
 *   position jump under them — and Back steps over it to the nearest place
 *   that is still there. A button that is enabled only to do nothing would be
 *   a lie, so `canGoBack` answers the same question Back acts on.
 * - **It is bounded.** The oldest entries fall off the front; a history
 *   nobody will step back through a hundred times is not worth keeping.
 *
 * It is not persisted. The state file says where the window was, and that is
 * where it opens; a history of Agents that may not come back after a restart
 * would mostly be entries to skip, so it starts again with every launch.
 */

/** How many entries are kept. The oldest goes first. */
export const NAVIGATION_HISTORY_LIMIT = 100;

export type NavigationDirection = "back" | "forward";

export interface NavigationHistoryOptions<T> {
  /** Whether two entries are the same place. */
  readonly same: (left: T, right: T) => boolean;
  readonly limit?: number;
}

export class NavigationHistory<T> {
  private entries: T[];
  private index: number;
  private readonly same: (left: T, right: T) => boolean;
  private readonly limit: number;

  constructor(initial: T, options: NavigationHistoryOptions<T>) {
    this.same = options.same;
    this.limit = Math.max(1, options.limit ?? NAVIGATION_HISTORY_LIMIT);
    this.entries = [initial];
    this.index = 0;
  }

  /** Where the cursor is: the place on screen, as far as history knows. */
  get current(): T {
    return this.entries[this.index];
  }

  /** For tests and for reading: every entry, oldest first. */
  get list(): readonly T[] {
    return this.entries;
  }

  get position(): number {
    return this.index;
  }

  /**
   * Note that the selection is now `entry`.
   *
   * `replace` is for a move that is not a new place: the model passes it when
   * the selection changes within the same arrangement — the keyboard moving
   * between the halves of one split — so the entry is updated in place and
   * Back still means "the place before this split".
   *
   * Answers whether anything changed.
   */
  visit(entry: T, replace = false): boolean {
    if (this.same(this.current, entry)) return false;
    if (replace) {
      this.entries[this.index] = entry;
      return true;
    }
    this.entries.splice(this.index + 1);
    this.entries.push(entry);
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }
    this.index = this.entries.length - 1;
    return true;
  }

  /**
   * Start again from `entry`, with nothing behind or ahead.
   *
   * For the launch: the selection the state file restored is where history
   * begins, not a step after the Scratch the model is built on.
   */
  reset(entry: T): void {
    this.entries = [entry];
    this.index = 0;
  }

  /**
   * The index Back or Forward would land on, or nothing.
   *
   * `here` is the place on screen. When it is not the cursor's entry — the
   * selection moved on without anything being done there — Back starts at the
   * cursor's own entry, the last place that was recorded.
   */
  private target(
    direction: NavigationDirection,
    exists: (entry: T) => boolean,
    here: T,
  ): number | undefined {
    const step = direction === "back" ? -1 : 1;
    const start =
      direction === "back" && !this.same(this.current, here)
        ? this.index
        : this.index + step;
    for (let at = start; at >= 0 && at < this.entries.length; at += step) {
      const entry = this.entries[at];
      // A neighbour that is the place on screen is no move: two entries can
      // become the same once what was between them has been skipped.
      if (!exists(entry) || this.same(entry, here)) continue;
      return at;
    }
    return undefined;
  }

  /** Whether `go(direction)` would go anywhere. */
  can(
    direction: NavigationDirection,
    exists: (entry: T) => boolean,
    here: T = this.current,
  ): boolean {
    return this.target(direction, exists, here) !== undefined;
  }

  /**
   * Move the cursor, and say where to: the caller then selects it.
   *
   * Nothing when there is nowhere to go, and then the cursor has not moved.
   */
  go(
    direction: NavigationDirection,
    exists: (entry: T) => boolean,
    here: T = this.current,
  ): T | undefined {
    const at = this.target(direction, exists, here);
    if (at === undefined) return undefined;
    this.index = at;
    return this.entries[at];
  }
}
