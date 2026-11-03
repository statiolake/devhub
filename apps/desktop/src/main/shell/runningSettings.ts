/**
 * The settings DevHub is running on: one object in memory, and the only thing
 * in the app that reads `settings.toml`.
 *
 * It owns the whole of what "the settings" means at run time: reading the
 * file, validating it, the policy for a file it cannot use, the one notice
 * that says so, watching the file for edits, and telling whoever depends on
 * the settings that they changed. Everything else asks it (`config`) or
 * subscribes to it (`subscribe`). Nothing else opens, parses or re-validates
 * the file — not the window that is made before the controller, not the
 * Settings window, not a terminal or an Agent — and `runningSettings.guard.test.ts`
 * keeps it that way.
 *
 * `config` is always a `Config`. A file that cannot be used never leaves a
 * hole for a feature to fall into: at launch DevHub runs on the defaults, and
 * after that on the last settings it accepted, which is exactly what the one
 * notice about it says. That notice is the refusal's only consequence.
 *
 * There used to be more. The launch left the config `undefined`, and every
 * consumer decided for itself what no settings meant: the Agents' usage-limit
 * and cache settings threw the refusal at their caller — a GUI Agent's
 * conversation, which asks for them on every change, took that for a failure
 * it did not expect and stopped following its Agent ("Conversation stopped");
 * the appearance every terminal pane asks for threw it too, so no terminal
 * could draw; the profile list was "unavailable", so no Agent could be
 * started from the window or from the `devhub` command; and the window, made
 * before the controller, read the file a second time on its own.
 */

import type { AppErrorWire } from "../../ipc/appShell.js";
import {
	ConfigError,
	ConfigStore,
	defaultConfig,
	defaultConfigPaths,
	withProfileRuntimes,
	type Config,
	type ConfigDiagnostic,
	type ConfigScopeKey,
	type ContentRevision,
	type LoadedConfig,
} from "../../model/config.js";
import {
	DEFAULT_PROFILE,
	profileLocations,
	type ProfileLocations,
} from "../../model/profile.js";
import { settingsRefused } from "../../model/wire.js";
import { seedProfileSettings } from "../profileSeed.js";

/** What a subscriber is told. */
export interface SettingsListener {
	/**
	 * Settings were accepted, and DevHub runs on them from now on. `from` is
	 * where they came from: an edit to the file (seen by the watcher or by
	 * Settings' Reload), or the Settings window, which wrote the file itself.
	 */
	readonly accepted?: (config: Config, from: "file" | "settings") => void;
	/**
	 * The file was edited into something DevHub cannot use. Said once per
	 * refusal; what DevHub runs on has not changed.
	 */
	readonly refused?: (notice: AppErrorWire) => void;
}

/** What a consumer that only reads the settings needs of them. */
export interface SettingsReader {
	/** The settings DevHub is running on, now. Never missing. */
	readonly config: Config;
}

export class RunningSettings implements SettingsReader {
	#config: Config;
	/** Whether `#config` came from the file, rather than being the defaults. */
	#fromFile: boolean;
	/** The notice the launch raised, if it could not use the file. */
	readonly #launchRefusal: AppErrorWire | undefined;
	/** The last refusal said, so a file that stays broken is said once. */
	#lastRefusal: string | undefined;
	readonly #listeners = new Set<SettingsListener>();

	private constructor(
		private readonly store: ConfigStore,
		private readonly profile: ProfileLocations,
		loaded:
			| { readonly kind: "loaded"; readonly config: Config }
			| { readonly kind: "refused"; readonly diagnostic: ConfigDiagnostic },
	) {
		if (loaded.kind === "loaded") {
			this.#config = withProfileRuntimes(loaded.config, profile).config;
			this.#fromFile = true;
			this.#launchRefusal = undefined;
		} else {
			this.#config = withProfileRuntimes(defaultConfig(), profile).config;
			this.#fromFile = false;
			this.#launchRefusal = this.#notice(loaded.diagnostic);
			this.#lastRefusal = this.#launchRefusal.detail ?? undefined;
		}
	}

	/**
	 * The settings this run starts on, from this profile's file — seeding a new
	 * profile's file first. Never throws for the file: one DevHub cannot use
	 * is the defaults and a notice (`launchRefusal`), not a reason not to start.
	 */
	static async open(
		profile: ProfileLocations,
		home: string,
	): Promise<RunningSettings> {
		const seeded = seedProfileSettings(
			profile,
			profileLocations(DEFAULT_PROFILE, home),
		);
		if (seeded.kind === "copied") {
			console.log(
				`[devhub] profile ${profile.profile}: seeded ${seeded.to} from ${seeded.from}`,
			);
		}
		return RunningSettings.load(
			new ConfigStore(defaultConfigPaths(home)),
			profile,
		);
	}

	/** `open`, on a store the caller made: the tests' way in. */
	static async load(
		store: ConfigStore,
		profile: ProfileLocations,
	): Promise<RunningSettings> {
		try {
			const loaded = (await store.load()).config;
			const overridden = withProfileRuntimes(
				loaded,
				profile,
			).overriddenSocketName;
			if (overridden !== undefined) {
				console.log(
					`[devhub] profile ${profile.profile}: runtimes.tmux_socket_name = "${overridden}" is ignored here; this profile uses "${profile.tmuxSocketName}"`,
				);
			}
			const migration = store.lastMigration();
			if (migration.kind === "migrated") {
				console.log(
					`[devhub] settings: folded ${migration.from} into settings.toml and kept the old file as ${migration.to}`,
				);
			}
			return new RunningSettings(store, profile, {
				kind: "loaded",
				config: loaded,
			});
		} catch (error) {
			// Said here too, because a person who cannot open Settings still has
			// the log.
			console.error("[devhub] settings could not be read:", error);
			// A load that failed for a reason the store did not name is still
			// the file not loading; the log has the error itself.
			const diagnostic: ConfigDiagnostic =
				error instanceof ConfigError ? error.diagnostic : { code: "io" };
			return new RunningSettings(store, profile, {
				kind: "refused",
				diagnostic,
			});
		}
	}

	/** The settings DevHub is running on, now. Never missing. */
	get config(): Config {
		return this.#config;
	}

	/** The file. */
	get file(): string {
		return this.store.paths.file;
	}

	/** Why this run started on the defaults, when it did. */
	get launchRefusal(): AppErrorWire | undefined {
		return this.#launchRefusal;
	}

	/** Be told when the settings change, or when an edit is refused. */
	subscribe(listener: SettingsListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/**
	 * Follow edits made outside the app: every `intervalMs`, `check`. The
	 * returned function stops it.
	 */
	watch(intervalMs: number): () => void {
		const timer = setInterval(
			() => {
				// A subscriber that throws is a failure of that subscriber, and
				// it goes to the main process's root like any other.
				void this.check().catch((error: unknown) => {
					queueMicrotask(() => {
						throw error;
					});
				});
			},
			Math.max(10, intervalMs),
		);
		// A settings poll must never be the reason the process stays alive.
		(timer as unknown as { unref?: () => void }).unref?.();
		return () => {
			clearInterval(timer);
		};
	}

	/**
	 * Read the file again. An edit DevHub can use is adopted and said to every
	 * subscriber; one it cannot is said (once) and changes nothing DevHub runs
	 * on. Resolves either way: a refused file is a notice, not a failure.
	 */
	async check(): Promise<void> {
		let outcome: Awaited<ReturnType<ConfigStore["reload"]>>;
		try {
			outcome = await this.store.reload();
		} catch (error) {
			this.#refuse(
				error instanceof ConfigError ? error.diagnostic : { code: "io" },
			);
			return;
		}
		if (outcome.kind === "applied") {
			this.#accept(outcome.loaded.config, "file");
		}
	}

	// The Settings window is the file's editor. What follows is what it edits
	// with: the file as it was last accepted, and writes that are adopted the
	// moment they land.

	/**
	 * The file as DevHub last accepted it, with the revision a write must be
	 * made over. A file DevHub has never been able to use has none, and the
	 * editor is told why — the same diagnostic the notice names — rather than
	 * the file being read again behind the watcher's back.
	 */
	editing(): LoadedConfig {
		const loaded = this.store.current();
		if (loaded === undefined) {
			throw new ConfigError(this.store.lastDiagnostic() ?? { code: "io" });
		}
		return loaded;
	}

	/** What is wrong with the file now, if anything is. */
	diagnostic(): ConfigDiagnostic | undefined {
		return this.store.lastDiagnostic();
	}

	/** Write `config` over `revision`; DevHub runs on it from now on. */
	async save(revision: ContentRevision, config: Config): Promise<LoadedConfig> {
		const saved = await this.store.save(revision, config);
		this.#accept(saved.config, "settings");
		return saved;
	}

	/** Put `keys` back to their defaults in the file; DevHub runs on the result. */
	async resetScope(
		revision: ContentRevision,
		keys: readonly ConfigScopeKey[],
	): Promise<LoadedConfig> {
		const saved = await this.store.resetScope(revision, keys);
		this.#accept(saved.config, "settings");
		return saved;
	}

	#accept(accepted: Config, from: "file" | "settings"): void {
		this.#config = withProfileRuntimes(accepted, this.profile).config;
		this.#fromFile = true;
		this.#lastRefusal = undefined;
		this.#tell((listener) => listener.accepted?.(this.#config, from));
	}

	#refuse(diagnostic: ConfigDiagnostic): void {
		const notice = this.#notice(diagnostic);
		// The watcher reads the file every few seconds, and a file that stays
		// broken is the same refusal each time: it is said once.
		if (notice.detail === this.#lastRefusal) return;
		this.#lastRefusal = notice.detail ?? undefined;
		this.#tell((listener) => listener.refused?.(notice));
	}

	/**
	 * Every subscriber is told, whichever of them throws; the first failure is
	 * rethrown once they all have been.
	 */
	#tell(each: (listener: SettingsListener) => void): void {
		let failure: { readonly error: unknown } | undefined;
		for (const listener of [...this.#listeners]) {
			try {
				each(listener);
			} catch (error) {
				failure ??= { error };
			}
		}
		if (failure !== undefined) throw failure.error;
	}

	/**
	 * The one notice, naming the file, the key and the reason, and what DevHub
	 * is running on instead: the defaults until a file has been accepted, the
	 * last accepted settings after.
	 */
	#notice(diagnostic: ConfigDiagnostic): AppErrorWire {
		return settingsRefused(
			this.store.paths.file,
			diagnostic,
			this.#fromFile ? "the last accepted settings" : "the defaults",
		);
	}
}
