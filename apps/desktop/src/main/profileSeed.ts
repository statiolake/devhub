/**
 * A new profile's first settings.
 *
 * A profile that starts with an empty `~/.config/devhub-<profile>/` starts with
 * no shell, no workspace sources and no Agent profiles — which is not a second
 * DevHub, it is an unconfigured one, and the first thing anybody would do is
 * copy the file across by hand. So the first launch does it: the default
 * profile's `settings.toml` is copied in, once, when the new profile's
 * directory holds no settings of its own.
 *
 * Copied, never symlinked. The two profiles are meant to drift — that is what
 * a development profile is for — and a symlink would make every experiment in
 * the development DevHub a change to the production one, silently, including
 * the ones made from its Settings window.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	CONFIG_FILE_NAME,
	LEGACY_CONFIG_FILE_NAME,
	LOCAL_CONFIG_FILE_NAME,
} from "../model/config.js";
import type { ProfileLocations } from "../model/profile.js";

export type SeedOutcome =
	/** The default profile: its settings are the ones being copied *from*. */
	| { kind: "default-profile" }
	/** The profile already has settings; nothing was touched. */
	| { kind: "already-configured" }
	/** There was nothing to copy — a first DevHub on this machine. */
	| { kind: "nothing-to-copy" }
	| { kind: "copied"; from: string; to: string };

function hasSettings(directory: string): boolean {
	return [
		CONFIG_FILE_NAME,
		LOCAL_CONFIG_FILE_NAME,
		LEGACY_CONFIG_FILE_NAME,
	].some((name) => existsSync(join(directory, name)));
}

/**
 * Seed `locations`' settings directory from `defaultLocations`', if it is new.
 *
 * Returns what it did rather than only doing it, so the caller can say so and
 * the tests can pin it.
 */
export function seedProfileSettings(
	locations: ProfileLocations,
	defaultLocations: ProfileLocations,
): SeedOutcome {
	if (locations.isDefault) {
		return { kind: "default-profile" };
	}
	if (hasSettings(locations.configDirectory)) {
		return { kind: "already-configured" };
	}
	const from = join(defaultLocations.configDirectory, CONFIG_FILE_NAME);
	if (!existsSync(from)) {
		return { kind: "nothing-to-copy" };
	}
	const to = join(locations.configDirectory, CONFIG_FILE_NAME);
	mkdirSync(locations.configDirectory, { recursive: true, mode: 0o700 });
	copyFileSync(from, to);
	return { kind: "copied", from, to };
}
