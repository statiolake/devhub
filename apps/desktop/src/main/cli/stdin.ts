/**
 * `devhub -`: what is piped into the command, as an editor.
 *
 * This is `code -`, and it works the way `code -` works, for the reason
 * `code -` works that way: the only channel a running workbench has for "open
 * this" is `vscode:openFiles`, which carries a *resource* — an untitled editor
 * with contents in it is not something that message can express. So the bytes
 * are spooled to a file first, and then the ordinary open path runs on that
 * file. Nothing downstream of here knows the path came from a pipe, which is
 * exactly the point: `devhub -` lands where a loose file lands, by the same
 * rule, because it *is* a loose file by the time the app is asked.
 *
 * Two deliberate differences from upstream, both in the direction of saying
 * less that is untrue:
 *
 *  - Upstream decodes stdin through the terminal's encoding and re-encodes it.
 *    On a UTF-8 terminal — every one this app runs on — that is a round trip
 *    to the same bytes, and on anything else it is a guess that quietly
 *    corrupts binary input. The bytes are written through unchanged instead,
 *    so `devhub -` shows you what you piped, whatever it was.
 *  - Upstream opens the editor and streams into it, which means a large input
 *    appears in an editor that keeps growing. The whole of stdin is read
 *    before the app is asked, so the editor is opened once, complete. The
 *    input is never held in memory — it goes to disk as it arrives — so
 *    "large" is bounded by the temp directory, not by the process.
 *
 * The spool file is left behind, as upstream leaves its own: the editor is
 * looking at it, and deleting a file out from under an open editor is how you
 * get an editor that cannot be saved.
 */

import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * A fresh path in `directory` for one run's worth of stdin.
 *
 * Named after the command rather than after nothing, because it is what the
 * editor's tab will say, and "where did this come from" should be answerable
 * from the tab alone.
 */
export function stdinSpoolPath(directory: string): string {
	return join(directory, `devhub-stdin-${randomBytes(6).toString("hex")}`);
}

/**
 * Read `source` to its end into a new file at `path`.
 *
 * `wx` because the path is fresh: a spool file that already exists means the
 * random name collided or something else is writing there, and appending this
 * run's input to another one's is worse than failing. 0600 for the same reason
 * the control socket is: whatever was piped in is the user's, and the temp
 * directory is not private.
 */
export async function spoolStdin(
	source: Readable,
	path: string,
): Promise<void> {
	await pipeline(source, createWriteStream(path, { flags: "wx", mode: 0o600 }));
}
