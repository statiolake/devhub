/**
 * An ASCII-capable input source for as long as a chord is armed.
 *
 * # Why this exists
 *
 * A chord is Cmd+Q and then a plain key — `s`, `1`, `]`, Shift+J. With an
 * input method on (Japanese, say), macOS hands every key to the input method
 * before the application: Chromium calls `interpretKeyEvents:` first, and a
 * key the input method takes comes back as a "process key" that Chromium
 * never routes through `PreHandleKeyboardEvent`. That is where Electron's
 * `before-input-event` comes from, so DevHub never sees the second stroke at
 * all — it becomes preedit text in whatever was focused. The prefix does
 * arrive, because an input method leaves Command-modified keys alone.
 *
 * So the prefix is the one moment DevHub can act, and what it does is take the
 * input method out of the way: when the chord arms, an ASCII-capable input
 * source is selected; when the chord is over, the one that was there before is
 * selected again. Nothing about the second stroke has to be guessed from a
 * physical key, because it arrives as a character like any other.
 *
 * # When a chord is over
 *
 * Whenever the router stops being armed, for whatever reason — the chord ran,
 * it was cancelled by a key that completes nothing, the second passed, the
 * table changed, or DevHub stopped being the active application. The router
 * says so (`ArmingListener`) and this does not ask why: every exit restores the
 * same way, so no exit can be the one that forgets to.
 *
 * The second passing is the one exit no key announces, so it has a timer of
 * its own, set to the router's deadline.
 *
 * # Only what DevHub put there
 *
 * The previous source is selected again only if the source is still the one
 * DevHub selected. Somebody who switched input source in the meantime — from
 * the menu bar, with their own shortcut — chose that, and putting theirs back
 * over it would be DevHub fighting them. That check and the select are one
 * step on the far side (`InputSourcePort.restore`), so nothing can change the
 * source between the two.
 *
 * # One request at a time
 *
 * Every request to the port waits for the one before it. A chord can be over
 * before the switch it armed has been answered, and the next can arm before
 * that restore has been; run out of order, a restore would land after the
 * next switch and put the input method back in the middle of a chord.
 *
 * # When it cannot
 *
 * The first failure is said once, through the root surface, and after it
 * nothing more is asked of the port: a helper that is missing will be missing
 * for every chord, and a notice per chord would be the same sentence on a
 * loop. Chords themselves go on working for anyone whose input source is
 * already ASCII-capable; what is gone is the switch, and the notice says so.
 *
 * # The race that is accepted
 *
 * The switch takes as long as macOS takes to select an input source —
 * `TISSelectInputSource`, measured at 2–27 ms with a median of about 15 ms on
 * an Apple Silicon Mac; the pipe to the helper adds hundredths of a
 * millisecond. A second key pressed faster than that after the prefix still
 * reaches the input method and is lost to the chord, which then times out. A
 * person's gap between releasing Cmd+Q and the next key is several times that,
 * so this is left as it is rather than papered over.
 */

/** DevHub selected an ASCII-capable source, and this is what to undo. */
export interface InputSourceSwitch {
	/** The source that was selected before DevHub's. */
	readonly previous: string;
	/** The ASCII-capable source DevHub selected. */
	readonly selected: string;
}

/**
 * The macOS input source, as DevHub is allowed to touch it.
 *
 * Both operations are a check and a change done as one step, and both reject
 * when they could not be done at all.
 */
export interface InputSourcePort {
	/**
	 * Select an ASCII-capable source, unless the current one is one already.
	 *
	 * Answers what was switched, or nothing when nothing needed to be.
	 */
	selectAscii(): Promise<InputSourceSwitch | undefined>;
	/**
	 * Select `previous` again — only if `selected` is still the current source.
	 *
	 * Answers `kept` when it was not, and so nothing was changed.
	 */
	restore(change: InputSourceSwitch): Promise<"restored" | "kept">;
}

/** What the router says about the prefix. See `KeyRouter`. */
export interface ArmingListener {
	/** The prefix is armed until `deadline` (the router's clock, ms). */
	armed(deadline: number): void;
	/** It is not armed any more, for whatever reason. */
	disarmed(): void;
}

export class ChordInputSource implements ArmingListener {
	/**
	 * The switch made for the chord armed now, answered or still on its way;
	 * nothing when no chord is armed.
	 */
	private held: Promise<InputSourceSwitch | undefined> | undefined;
	/** The last request made of the port. Every request waits for it. */
	private tail: Promise<unknown> = Promise.resolve();
	private timeout: ReturnType<typeof setTimeout> | undefined;
	private failed = false;

	constructor(
		private readonly port: InputSourcePort,
		/** The root surface. Called at most once. */
		private readonly report: (failure: unknown) => void,
		private readonly now: () => number = Date.now,
	) {}

	armed(deadline: number): void {
		this.clearTimeout();
		this.timeout = setTimeout(
			() => {
				this.disarmed();
			},
			Math.max(0, deadline - this.now()),
		);
		if (this.failed || this.held !== undefined) return;
		this.held = this.enqueue(() => this.port.selectAscii());
	}

	disarmed(): void {
		this.clearTimeout();
		const held = this.held;
		if (held === undefined) return;
		this.held = undefined;
		void this.enqueue(async () => {
			const change = await held;
			if (change !== undefined) await this.port.restore(change);
		});
	}

	private clearTimeout(): void {
		if (this.timeout === undefined) return;
		clearTimeout(this.timeout);
		this.timeout = undefined;
	}

	/**
	 * Run one request after the last, and say its failure — the first one.
	 *
	 * A failed request resolves to nothing, which is what a caller waiting on
	 * it can do with it: there is no switch to undo when none was made.
	 */
	private enqueue<T>(request: () => Promise<T>): Promise<T | undefined> {
		const next = this.tail.then(async () => {
			if (this.failed) return undefined;
			try {
				return await request();
			} catch (failure) {
				// Not a recovery: the port is not asked again, and the reason goes
				// to the one place failures are drawn.
				this.failed = true;
				this.report(failure);
				return undefined;
			}
		});
		this.tail = next;
		return next;
	}
}
