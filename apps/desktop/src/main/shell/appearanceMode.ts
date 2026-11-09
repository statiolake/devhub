/**
 * Which appearance DevHub runs in, and the one place that says so.
 *
 * `nativeTheme.themeSource` is a process-wide fact: it decides what Electron
 * reports the system appearance to be — to every native surface DevHub draws
 * and to every page's `prefers-color-scheme`. It is one value for the whole
 * application, and this class is the one thing that writes it.
 *
 * So this is not a palette and it paints nothing directly. It sets what the
 * appearance *is*, and DevHub picks the half of `[appearance] theme` from
 * that (`shellTheme.ts`, on `nativeTheme`'s `updated`). Choosing Dark here
 * recolours DevHub at once.
 */

/** What DevHub tells Electron, for each appearance it can be asked for. */
const THEME_SOURCE: Readonly<Record<string, string>> = {
	// `system` is the only value under which Electron reports the real OS.
	auto: "system",
	light: "light",
	dark: "dark",
};

export class AppearanceMode {
	private write: ((value: unknown) => void) | undefined;
	private mode = "auto";

	/**
	 * Take ownership of `themeSource`, from the fence that took it off everyone
	 * else.
	 *
	 * Called once, from `installAppFence()`, before any workbench exists. The
	 * appearance starts at `auto` because the config has not been read yet, and
	 * `auto` is both its default and the honest answer: report the OS until
	 * somebody says otherwise.
	 */
	own(writer: (value: unknown) => void): void {
		if (this.write) {
			throw new Error("DevHub's appearance already has an owner");
		}
		this.write = writer;
		writer(THEME_SOURCE[this.mode]);
	}

	/**
	 * Run in the appearance the config asks for.
	 *
	 * Called with `appearance.mode` when the config is first read and again
	 * every time it is saved, so a change takes effect without a restart:
	 * assigning `themeSource` makes Electron fire `nativeTheme`'s `updated`
	 * event, and that is what carries the new appearance into each workbench and
	 * back out to the shell's chrome.
	 *
	 * An unknown mode is a broken invariant rather than something to work
	 * around. The config loader rejects anything but these three, so arriving
	 * here with a fourth means the two lists have drifted apart, and the useful
	 * thing to do is say so where it happened.
	 */
	apply(mode: string): void {
		const source = THEME_SOURCE[mode];
		if (source === undefined) {
			throw new Error(`DevHub has no appearance called ${mode}`);
		}
		this.mode = mode;
		// Before `installAppFence()` there is nothing to write to. That cannot
		// happen in the app, where the fence is installed before the config is
		// read, and remembering the answer is enough if it ever does: taking
		// ownership applies whatever the latest one is.
		this.write?.(source);
	}

	/** The appearance DevHub is running in. */
	current(): string {
		return this.mode;
	}
}

let currentMode: AppearanceMode | undefined;

export function appearanceMode(): AppearanceMode {
	currentMode ??= new AppearanceMode();
	return currentMode;
}
