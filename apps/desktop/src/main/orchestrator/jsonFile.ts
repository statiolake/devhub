/**
 * The orchestrator's small JSON stores on disk (`orchestrator-memos.json`,
 * `orchestrator-work.json`): read once, written whole and atomically (a
 * temporary file renamed over it) on every change, and a file that does not
 * read moved aside as `.corrupt` and said, the store starting empty.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface JsonFileIo {
	readonly exists: (path: string) => boolean;
	readonly read: (path: string) => string;
	readonly write: (path: string, text: string) => void;
	readonly moveAside: (path: string, to: string) => void;
}

export const DISK_IO: JsonFileIo = {
	exists: existsSync,
	read: (path) => readFileSync(path, "utf8"),
	write: (path, text) => {
		mkdirSync(dirname(path), { recursive: true });
		const temporary = `${path}.${String(process.pid)}.tmp`;
		writeFileSync(temporary, text, { mode: 0o600 });
		renameSync(temporary, path);
	},
	moveAside: (path, to) => {
		renameSync(path, to);
	},
};

/**
 * One versioned file: `load` hands `decode` the parsed JSON (which throws a
 * `TypeError` for a file that is not this one) and `save` writes `encode`'s.
 */
export class VersionedJsonFile<T> {
	/** Said once, by `load`, when the file did not read. */
	refused: string | undefined;

	constructor(
		readonly path: string,
		private readonly what: string,
		private readonly empty: () => T,
		private readonly decode: (value: unknown) => T,
		private readonly io: JsonFileIo = DISK_IO,
		private readonly log: (line: string) => void = () => undefined,
	) {}

	load(): T {
		if (!this.io.exists(this.path)) return this.empty();
		try {
			return this.decode(JSON.parse(this.io.read(this.path)));
		} catch (error: unknown) {
			if (!(error instanceof SyntaxError || error instanceof TypeError))
				throw error;
			const aside = `${this.path}.corrupt`;
			try {
				this.io.moveAside(this.path, aside);
			} catch {
				// Gone already: nothing to move.
			}
			this.refused = `${this.path} could not be read (${error.message}); it was moved to ${aside}, and the ${this.what} start empty.`;
			return this.empty();
		}
	}

	write(value: unknown): void {
		try {
			this.io.write(this.path, JSON.stringify(value));
		} catch (error: unknown) {
			this.log(
				`[devhub] could not write ${this.path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}
