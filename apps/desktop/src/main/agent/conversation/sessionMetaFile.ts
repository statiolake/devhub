/**
 * `session-meta.json`, beside `state.json`: the metadata of the Agents that
 * ran each CLI session, kept once the Agent is stopped or closed
 * (`model/sessionMeta.ts` has what is kept and for how long).
 *
 * Read once at startup. Each write replaces the file whole (a temporary file
 * renamed over it) and is synchronous, as `agentRecords.ts`'s are. A file
 * that does not read as this one is moved aside to `<path>.corrupt` and the
 * index starts empty; `refused` says so, for the caller to tell the person.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { AgentMeta } from "../../../model/agentMeta.js";
import {
	decodeSessionMeta,
	encodeSessionMeta,
	rememberSessionMeta,
	SessionMetaRefused,
	sessionMetaOf,
	type SessionMetaRecord,
} from "../../../model/sessionMeta.js";
import type { SessionNameKind } from "../../../model/sessionNames.js";

export class SessionMetaFile {
	readonly #path: string;
	readonly #now: () => number;
	#records: readonly SessionMetaRecord[];

	private constructor(
		path: string,
		records: readonly SessionMetaRecord[],
		now: () => number,
	) {
		this.#path = path;
		this.#records = records;
		this.#now = now;
	}

	static load(
		path: string,
		now: () => number = Date.now,
	): { readonly index: SessionMetaFile; readonly refused: string | undefined } {
		if (!existsSync(path))
			return { index: new SessionMetaFile(path, [], now), refused: undefined };
		try {
			const records = decodeSessionMeta(
				JSON.parse(readFileSync(path, "utf8")),
				now(),
			);
			return {
				index: new SessionMetaFile(path, records, now),
				refused: undefined,
			};
		} catch (error: unknown) {
			if (
				!(error instanceof SyntaxError || error instanceof SessionMetaRefused)
			)
				throw error;
			const aside = `${path}.corrupt`;
			renameSync(path, aside);
			return {
				index: new SessionMetaFile(path, [], now),
				refused: `${path} could not be read (${error.message}); it was moved to ${aside}, and the stopped sessions' metadata starts empty.`,
			};
		}
	}

	get path(): string {
		return this.#path;
	}

	/** Newest first. */
	get records(): readonly SessionMetaRecord[] {
		return this.#records;
	}

	of(kind: SessionNameKind, session: string): SessionMetaRecord | undefined {
		return sessionMetaOf(this.#records, kind, session);
	}

	/**
	 * The session's metadata is now `meta` (none: its entry goes), under
	 * `name`. Written at once when that changes anything; whether it did.
	 */
	remember(
		kind: SessionNameKind,
		session: string,
		meta: AgentMeta,
		name?: { readonly name: string; readonly named: boolean },
		managed = false,
		model?: string,
	): boolean {
		const next = rememberSessionMeta(this.#records, {
			kind,
			session,
			meta,
			...(managed ? { managed: true as const } : {}),
			...(model === undefined ? {} : { model }),
			...(name === undefined
				? {}
				: { name: name.name, ...(name.named ? { named: true } : {}) }),
			at: this.#now(),
		});
		if (next === this.#records) return false;
		this.#records = next;
		this.#write();
		return true;
	}

	#write(): void {
		mkdirSync(dirname(this.#path), { recursive: true });
		const temporary = `${this.#path}.tmp`;
		writeFileSync(temporary, encodeSessionMeta(this.#records));
		renameSync(temporary, this.#path);
	}
}
