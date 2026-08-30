/**
 * One-time move of DevHub's VS Code user data to its final home.
 *
 * DevHub used to be two things sharing one data directory: a web-era editor
 * server, whose state lived in `<data>/editor` (`server-data`, `client-data`,
 * `cli-data`, `connection-token`, `origin-port`, `surface-registry.json` and a
 * `User` profile of its own), and the desktop app, whose VS Code profile lived
 * in `<data>/user-data`. The web era is gone, so `editor` is free to mean the
 * only editor there is — and the profile belongs under it, at
 * `<data>/editor/User/settings.json`, which is where a person editing settings
 * on disk expects to find them.
 *
 * The migration runs before anything reads the path: the web-era directory is
 * removed, then `user-data` is renamed into place. Either step failing throws.
 * There is deliberately no fallback to the old location — two paths that could
 * hold the profile would be two truths, and the next question would be which
 * one the app actually read.
 */

import { existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Move `<data>/user-data` to `userDataPath` if the profile still lives there.
 *
 * A no-op once migrated, and a no-op for a directory that is already `user-data`
 * (a scratch `--user-data-dir` pointed straight at one).
 */
export function migrateUserDataDirectory(userDataPath: string): void {
	const dataDirectory = dirname(userDataPath);
	const legacyProfile = join(dataDirectory, "user-data");
	if (legacyProfile === userDataPath) {
		return;
	}

	// The whole precondition, and deliberately only about the old path: a
	// `User` directory under `user-data` is the desktop profile, because
	// nothing else puts one there and the migration moves it away for good.
	// The destination is not consulted — the web-era `editor` directory has a
	// `User` of its own (the server's profile), so its presence would say
	// "already migrated" about exactly the case that still needs migrating.
	if (!existsSync(join(legacyProfile, "User"))) {
		return;
	}

	if (existsSync(userDataPath)) {
		rmSync(userDataPath, { recursive: true });
		console.log(`[devhub] user data: removed web-era ${userDataPath}`);
	}

	renameSync(legacyProfile, userDataPath);
	console.log(
		`[devhub] user data: migrated ${legacyProfile} -> ${userDataPath}`,
	);
}
