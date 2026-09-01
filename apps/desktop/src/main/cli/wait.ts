/**
 * `devhub --wait <file>`: not returning until the file has been closed.
 *
 * This is what makes `EDITOR='devhub --wait'` work. `git commit` runs the
 * editor and reads the message back when the editor *exits*, so a command that
 * opens a tab and returns immediately gives git an empty message and a commit
 * nobody wrote. The command has to stay alive exactly as long as the person is
 * still typing.
 *
 * The mechanism is upstream's, and it is upstream's because the workbench
 * already implements the interesting half of it. The CLI creates an empty
 * marker file and names it in the open request; `vscode:openFiles` already
 * carries that name as `filesToWait`; and `window.ts` responds by watching the
 * editors it opened and deleting the marker once they are closed — including
 * deleting it straight away if the editor could not be opened at all, so a
 * file that fails to open ends the wait instead of hanging it. Nothing in
 * DevHub had to learn what waiting means; the field simply had to be passed
 * along, which is why so little of this lands outside the CLI.
 *
 * So the CLI's whole job is to notice the marker go away. It polls, rather
 * than watching the directory: a watcher would be a second thing that also
 * claims to know when the wait is over, and on a filesystem where the watcher
 * misses an event the two would disagree — one saying "still editing" forever
 * while the file has been closed for ten minutes. One question, asked on a
 * timer, cannot disagree with itself. The interval is short enough that
 * closing a tab and getting the shell prompt back feels immediate, and the
 * cost of asking is one `stat` on a file in a directory this process made.
 *
 * The other way a wait can end is that DevHub is no longer there to close
 * anything. A person who quits DevHub with the commit message still open would
 * otherwise be left with a terminal that never comes back, and no clue why, so
 * the socket is asked on the same timer and its disappearance ends the wait
 * with a sentence and a failing status. The marker is checked first, so a
 * DevHub that deletes the marker and quits in the same instant still counts as
 * having finished the job.
 */

import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { socketAnswers } from "./launch.js";

/**
 * How often the marker and DevHub are asked about.
 *
 * Upstream uses a second; this is shorter because the whole experience of
 * `--wait` is the gap between closing the tab and getting the prompt back, and
 * a quarter second is under what anyone notices.
 */
export const WAIT_POLL_MS = 250;

/** The two questions a wait is made of, and the clock it asks them on. */
export interface WaitWorld {
	/** Whether the marker file is still there. */
	markerExists(): Promise<boolean>;
	/** Whether DevHub is still answering its socket. */
	devhubAnswers(): Promise<boolean>;
	pause(ms: number): Promise<void>;
}

/**
 * Wait until the file is closed, or until there is no DevHub left to close it.
 *
 * Returns when the marker is gone. Throws — rather than returning quietly —
 * when DevHub went away first, because the person's edit did not happen and a
 * zero exit status would tell `git commit` that it did.
 */
export async function waitForClose(world: WaitWorld): Promise<void> {
	for (;;) {
		// The marker first, always: a DevHub that deleted the marker and quit
		// in the same moment did the thing that was asked, and the order of two
		// checks is not a reason to report a failure.
		if (!(await world.markerExists())) return;
		if (!(await world.devhubAnswers())) {
			throw new Error(
				"DevHub stopped while the file was still open, so it was never closed and nothing was saved by closing it.",
			);
		}
		await world.pause(WAIT_POLL_MS);
	}
}

/** The real thing: a file on disk, a socket, and the clock. */
export function markerWorld(markerPath: string, socketPath: string): WaitWorld {
	return {
		markerExists: () =>
			access(markerPath).then(
				() => true,
				// Not a swallowed failure: whether the file is there is the
				// question, and an error answering it is the answer "no".
				() => false,
			),
		devhubAnswers: () => socketAnswers(socketPath),
		pause: (ms) =>
			new Promise((resolve) => {
				setTimeout(resolve, ms);
			}),
	};
}

/**
 * Make the marker, in a directory of this command's own.
 *
 * It gets a directory to itself rather than sitting loose in the temp folder
 * because the marker's absence is the signal: something else clearing out
 * `/tmp` mid-edit would tell the CLI the file had been closed when it had not.
 * A directory made per run, 0700, keeps the signal ours to send.
 */
export async function createMarker(
	temporaryDirectory: string,
): Promise<string> {
	const directory = join(
		temporaryDirectory,
		`devhub-wait-${randomBytes(6).toString("hex")}`,
	);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const marker = join(directory, "marker");
	await writeFile(marker, "", { flag: "wx", mode: 0o600 });
	return marker;
}

/**
 * Take the marker's directory away again.
 *
 * Called however the wait ended, including badly: a marker left behind is
 * litter, and a marker left behind by a *failed* run is litter that looks like
 * an edit somebody is still in the middle of.
 */
export async function removeMarker(markerPath: string): Promise<void> {
	await rm(dirname(markerPath), { recursive: true, force: true });
}
