/**
 * The profile's locations, for the shell.
 *
 * `dev.sh` has to know the user-data and extensions directories before the app
 * exists — they are command-line arguments to it — so it cannot ask the running
 * DevHub. Rather than spelling the paths a second time in shell, where they
 * would be one rename away from disagreeing with `model/profile.ts`, it runs
 * this and evals the answer: one derivation, two readers.
 *
 *     DEVHUB_PROFILE=dev ELECTRON_RUN_AS_NODE=1 <electron> out/main/profilePaths.js
 */

import { activeProfile } from "../model/profile.js";

function quote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

const locations = activeProfile();
const lines = [
	`DEVHUB_PROFILE_NAME=${quote(locations.profile)}`,
	`DEVHUB_APPLICATION_NAME=${quote(locations.applicationName)}`,
	`DEVHUB_DATA_DIR=${quote(locations.dataDirectory)}`,
	`DEVHUB_USER_DATA_DIR=${quote(locations.userDataDirectory)}`,
	`DEVHUB_EXTENSIONS_DIR=${quote(locations.extensionsDirectory)}`,
	`DEVHUB_CONFIG_DIR=${quote(locations.configDirectory)}`,
	`DEVHUB_TMUX_SOCKET_NAME=${quote(locations.tmuxSocketName)}`,
];
process.stdout.write(`${lines.join("\n")}\n`);
