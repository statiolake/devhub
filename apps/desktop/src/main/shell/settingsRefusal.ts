/**
 * Why this run is not on the settings file, said once and the same way
 * everywhere.
 *
 * Three places find out that `settings.toml` cannot be used: the launch that
 * could not load it, the watcher that saw an edit it could not load, and
 * anything that needs settings while there are none (`requireConfig`). They
 * used to say it three ways — nothing at all at launch, "config: unknown_key"
 * from the watcher, and a bare "the native app shell is unavailable" from the
 * first page that asked for its appearance, which being last was the one left
 * on screen. Now all three answer with the one notice `settingsRefused`
 * builds, naming the file, the key and the reason.
 */

import type { AppErrorWire } from "../../ipc/appShell.js";
import { ConfigError, type ConfigDiagnostic } from "../../model/config.js";
import { settingsRefused } from "../../model/wire.js";

export class SettingsRefusal {
	/** The refusal this run is on the defaults because of, if it is. */
	#current: AppErrorWire | undefined;

	constructor(private readonly file: string) {}

	/** The launch could not load the file, so this run is on the defaults. */
	atLaunch(error: unknown): AppErrorWire {
		// A load that failed for a reason the store did not name is still the
		// file not loading; the log has the error itself.
		const diagnostic: ConfigDiagnostic =
			error instanceof ConfigError ? error.diagnostic : { code: "io" };
		this.#current = settingsRefused(this.file, diagnostic, "the defaults");
		return this.#current;
	}

	/**
	 * An edit to the file could not be loaded. `running` is whether this run
	 * has accepted settings, which stay in effect; without them it is still on
	 * the defaults, and this is now the reason why.
	 */
	onReload(diagnostic: ConfigDiagnostic, running: boolean): AppErrorWire {
		if (running) {
			return settingsRefused(
				this.file,
				diagnostic,
				"the last accepted settings",
			);
		}
		this.#current = settingsRefused(this.file, diagnostic, "the defaults");
		return this.#current;
	}

	/** Settings were accepted: nothing is refused any more. */
	accepted(): void {
		this.#current = undefined;
	}

	/** What anything that needs settings answers with while there are none. */
	required(): AppErrorWire {
		if (this.#current === undefined) {
			throw new Error("DevHub has no settings and no refusal to say why");
		}
		return this.#current;
	}
}
