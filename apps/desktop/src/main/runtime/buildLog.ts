/**
 * A dev container's build log: what `devcontainer up` said, on this Mac.
 *
 * The CLI prints its log — the image pull, the build, the lifecycle commands
 * the definition asks for — on stderr while it runs, and its one JSON answer
 * on stdout at the end. DevHub runs it (on this Mac, or on an SSH host through
 * that host's master), so DevHub is the one place that sees it. Each bring-up
 * writes it here as it arrives, so the editor that asked can follow it live
 * (`extensions/devhub-remote`'s Dev Containers output) and anybody can read it
 * afterwards — after a build that failed above all.
 *
 * One file per container (`containerBuildLogPath`), replaced by each
 * bring-up: the log a person wants is the last one. Replaced as a new file
 * rather than truncated, so a reader following the old one can tell by its
 * identity that a new bring-up has begun.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ContainerHostId } from "../../model/domain.js";

/**
 * Where a container's build log is, under this profile's data directory:
 * named by a hash of the container's id, because the id is the folder, the
 * definition and the host, spelled as hex far longer than a file name.
 */
export function containerBuildLogPath(
	userDataDirectory: string,
	host: ContainerHostId,
): string {
	const name = createHash("sha256").update(host).digest("hex").slice(0, 32);
	return join(userDataDirectory, "devhub", "dev-container-logs", `${name}.log`);
}

/**
 * One bring-up's log, open for writing.
 *
 * Synchronous writes: a chunk is on disk when the CLI's next one arrives, so
 * a reader polling the file sees the build as it goes, and the order is the
 * CLI's. A write that fails throws — a log that silently stops is a log that
 * lies about where the build got to.
 */
export class BuildLogFile {
	readonly #fd: number;

	private constructor(fd: number) {
		this.#fd = fd;
	}

	/** Replace the file with a new one that starts with `command`. */
	static begin(path: string, command: string): BuildLogFile {
		mkdirSync(dirname(path), { recursive: true });
		rmSync(path, { force: true });
		const log = new BuildLogFile(openSync(path, "wx"));
		log.write(`$ ${command}\n# ${new Date().toISOString()}\n\n`);
		return log;
	}

	write(chunk: Uint8Array | string): void {
		writeSync(
			this.#fd,
			typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
		);
	}

	/** Say how it ended, and close the file. */
	end(outcome: string): void {
		try {
			this.write(`\n# ${outcome}\n`);
		} finally {
			closeSync(this.#fd);
		}
	}
}
