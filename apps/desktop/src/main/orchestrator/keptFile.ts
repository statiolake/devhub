/**
 * `agent keep`'s keepings on disk, so a restart of DevHub keeps them:
 * `<userData>/devhub/orchestrator-kept.json`, per profile, written whole and
 * atomically (a temporary file renamed over it) on every change.
 *
 * Each is an agent id (an agent keeps its id across a restart, `state.json`),
 * the orchestrator's note, when, and the agent's state when it was kept: the
 * keeping ends when that state changes (`InvariantWatch`). A file that does
 * not read is moved aside (`.corrupt`) and said; the keepings start empty,
 * and the agents are said again.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { KeptAgent } from "./invariant.js";

export const KEPT_FILE_VERSION = 1;

/** Where the watch keeps its keepings: `InvariantWatchPorts.kept`. */
export interface KeptStore {
	load(): ReadonlyMap<string, KeptAgent>;
	save(kept: ReadonlyMap<string, KeptAgent>): void;
}

export interface KeptFileIo {
	readonly exists: (path: string) => boolean;
	readonly read: (path: string) => string;
	readonly write: (path: string, text: string) => void;
	readonly moveAside: (path: string, to: string) => void;
}

const DISK: KeptFileIo = {
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

/** The file's keepings, or why they do not read. */
export function keptFromJson(value: unknown): Map<string, KeptAgent> {
	const file = value as { version?: unknown; kept?: unknown } | null;
	if (
		typeof file !== "object" ||
		file === null ||
		file.version !== KEPT_FILE_VERSION ||
		typeof file.kept !== "object" ||
		file.kept === null
	)
		throw new TypeError(
			`not a version ${String(KEPT_FILE_VERSION)} keepings file`,
		);
	const out = new Map<string, KeptAgent>();
	for (const [agentId, one] of Object.entries(file.kept)) {
		const kept = one as Partial<KeptAgent> | null;
		if (
			typeof kept?.note !== "string" ||
			typeof kept.at !== "number" ||
			typeof kept.facts !== "string"
		)
			throw new TypeError(`the keeping of ${agentId} does not read`);
		out.set(agentId, { note: kept.note, at: kept.at, facts: kept.facts });
	}
	return out;
}

export class KeptFile implements KeptStore {
	/** Said once, by `load`, when the file did not read. */
	refused: string | undefined;

	constructor(
		private readonly path: string,
		private readonly io: KeptFileIo = DISK,
		private readonly log: (line: string) => void = () => undefined,
	) {}

	load(): ReadonlyMap<string, KeptAgent> {
		if (!this.io.exists(this.path)) return new Map();
		try {
			return keptFromJson(JSON.parse(this.io.read(this.path)));
		} catch (error: unknown) {
			if (!(error instanceof SyntaxError || error instanceof TypeError))
				throw error;
			const aside = `${this.path}.corrupt`;
			this.io.moveAside(this.path, aside);
			this.refused = `${this.path} could not be read (${error.message}); it was moved to ${aside}, and no agent is kept.`;
			return new Map();
		}
	}

	save(kept: ReadonlyMap<string, KeptAgent>): void {
		try {
			this.io.write(
				this.path,
				JSON.stringify({
					version: KEPT_FILE_VERSION,
					kept: Object.fromEntries(kept),
				}),
			);
		} catch (error: unknown) {
			this.log(
				`[devhub] could not write ${this.path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}
