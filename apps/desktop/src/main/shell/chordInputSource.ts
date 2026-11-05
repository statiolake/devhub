/**
 * An ASCII-capable input source as soon as a chord arms.
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
 * source is selected. Nothing about the second stroke has to be guessed from a
 * physical key, because it arrives as a character like any other.
 *
 * # Nothing is put back
 *
 * The source stays ASCII-capable after the chord. Selecting the previous one
 * again when the chord was over turned the input method back on at moments
 * the person had not asked for — after a chord that moved focus somewhere
 * else, or when DevHub stopped being the active application mid-chord — and
 * the person turns their input method on themselves when they want it, as
 * they would after any other shortcut. A select is idempotent and the only
 * request there is, so there is no ordering between requests to keep either.
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
 * reaches the input method and is lost to the chord, which then stays armed until the next key. A
 * person's gap between releasing Cmd+Q and the next key is several times that,
 * so this is left as it is rather than papered over.
 */

/** The macOS input source, as DevHub is allowed to touch it. */
export interface InputSourcePort {
	/**
	 * Select an ASCII-capable source, unless the current one is one already.
	 * Rejects when it could not be done at all.
	 */
	selectAscii(): Promise<void>;
}

/** What the router says about the prefix. See `KeyRouter`. */
export interface ArmingListener {
	/** The prefix is armed, and stays so until it is completed or cancelled. */
	armed(): void;
	/** It is not armed any more, for whatever reason. */
	disarmed(): void;
}

export class ChordInputSource {
	private failed = false;

	constructor(
		private readonly port: InputSourcePort,
		/** The root surface. Called at most once. */
		private readonly report: (failure: unknown) => void,
	) {}

	armed(): void {
		if (this.failed) return;
		this.port.selectAscii().catch((failure: unknown) => {
			// Not a recovery: the port is not asked again, and the reason goes
			// to the one place failures are drawn.
			if (this.failed) return;
			this.failed = true;
			this.report(failure);
		});
	}
}
