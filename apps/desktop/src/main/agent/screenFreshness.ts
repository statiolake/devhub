/**
 * Which Agents are worth reading the screen of this round.
 *
 * The reconciler runs every 300 ms and used to `capture-pane` every Agent on
 * every round, whatever they were doing. Three Agents sitting at a prompt cost
 * nine hundred tmux processes a minute — a fork and an exec each, fifteen a
 * second, from an app nobody was touching. That is most of what an idle DevHub
 * costs, and all of it was spent to learn that nothing had changed.
 *
 * tmux already knows whether anything has changed: `#{window_activity}` is
 * when the pane last wrote, and the listing every round runs anyway carries it
 * for free. A pane that has not written has the screen it had, so the status
 * DevHub last read from it is still the status.
 *
 * The one thing that has to be got right is the *trailing* frame. The marker
 * has one-second resolution, so a screen read at 12:00:03.100 and a line
 * written at 12:00:03.900 both belong to second 3: the marker never moves
 * again, and a naive "capture when the marker changed" would hold a screen
 * that is one frame stale for as long as the Agent stays quiet — a row stuck
 * on `working` for an Agent that has finished. So a capture only settles the
 * second it was taken in once that second is over, and until then the Agent is
 * read again. It costs one extra capture per burst of output and it is the
 * difference between an optimisation and a bug.
 */

/** What a reader must supply. Injected so a test owns the clock. */
export type Clock = () => number;

interface Settled {
	/** The marker the last capture was taken against. */
	readonly marker: string;
	/** The whole second the last capture was taken in. */
	readonly capturedAtSecond: number;
}

export class AgentScreenFreshness {
	readonly #settled = new Map<string, Settled>();
	readonly #clock: Clock;

	constructor(clock: Clock = Date.now) {
		this.#clock = clock;
	}

	/**
	 * Whether this round should read the Agent's screen.
	 *
	 * `undefined` for the marker means the runtime did not report one. That is
	 * answered with `true` — a reader that cannot tell whether something
	 * changed must assume it did, which is exactly the behaviour there was
	 * before the marker existed.
	 */
	shouldCapture(agentId: string, marker: string | undefined): boolean {
		if (marker === undefined) return true;
		const settled = this.#settled.get(agentId);
		if (settled === undefined) return true;
		if (settled.marker !== marker) return true;
		// The marker names a second the last capture was taken *inside*, so
		// more output may have landed after it and before that second ended.
		// One more read, once the second is over, settles it.
		return settled.capturedAtSecond <= Number(marker);
	}

	/** Record that the screen was read, against the marker it was read for. */
	captured(agentId: string, marker: string | undefined): void {
		if (marker === undefined) {
			// Nothing to compare a future round against, so nothing is
			// remembered: the next round asks again, as it must.
			this.#settled.delete(agentId);
			return;
		}
		this.#settled.set(agentId, {
			marker,
			capturedAtSecond: Math.floor(this.#clock() / 1000),
		});
	}

	/** An Agent that ended. Its screen is not coming back. */
	forget(agentId: string): void {
		this.#settled.delete(agentId);
	}
}
