/**
 * The GitHub source's last reading, kept per profile in
 * `<userData>/devhub/orchestrator-github.json`, so that an orchestrator that
 * goes on after DevHub was away — a restart, or a new orchestrator in the
 * same profile — is told what changed meanwhile instead of starting from a
 * fresh baseline.
 *
 * - Written after each successful poll, debounced (`SAVE_DEBOUNCE_MS`), and
 *   atomically: a temporary file renamed over it.
 * - Read when the source starts for an orchestrator. It is not used — the
 *   first poll is a baseline again — when it does not read, is of another
 *   version, names other boards than `[orchestrator.github] projects` now
 *   does, or is older than `STALE_SNAPSHOT_MS` (what changed in that long is
 *   history, not news). A different viewer login is caught on the first
 *   answer, which then is the baseline.
 * - Stopping the orchestrator forgets the source's memory but keeps the file.
 */

import { renameSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { BoardEntry, PullDetails, RequestedPull } from "./githubEvents.js";

export const SNAPSHOT_VERSION = 1;
/** Older than this, a snapshot is not diffed against: the poll is a baseline. */
export const STALE_SNAPSHOT_MS = 7 * 24 * 60 * 60_000;
/** How long a save waits for the next one. */
export const SAVE_DEBOUNCE_MS = 5_000;

export interface GitHubSnapshot {
	readonly version: typeof SNAPSHOT_VERSION;
	/** When the reading it holds was taken (ms since the epoch). */
	readonly savedAt: number;
	readonly viewer: string;
	/** `[orchestrator.github] projects` it was read for, sorted. */
	readonly projects: readonly string[];
	/** Each board's last full pass. */
	readonly boards: Readonly<Record<string, readonly BoardEntry[]>>;
	/** Cards and pull requests that related to the viewer. */
	readonly watched: readonly string[];
	readonly pulls: readonly PullDetails[];
	/** The review requests; null before the first reading of them. */
	readonly requested: readonly RequestedPull[] | null;
}

function sameProjects(a: readonly string[], b: readonly string[]): boolean {
	const left = [...a].sort();
	const right = [...b].sort();
	return (
		left.length === right.length &&
		left.every((one, index) => one === right[index])
	);
}

/**
 * A stored snapshot, if it may be diffed against now; else why not (said in
 * the log, and the first poll is a baseline).
 */
export function usableSnapshot(
	raw: unknown,
	projects: readonly string[],
	now: number,
): { readonly snapshot: GitHubSnapshot } | { readonly refused: string } {
	const one = raw as Partial<GitHubSnapshot> | null | undefined;
	if (
		typeof one !== "object" ||
		one === null ||
		one.version !== SNAPSHOT_VERSION ||
		typeof one.savedAt !== "number" ||
		typeof one.viewer !== "string" ||
		!Array.isArray(one.projects) ||
		typeof one.boards !== "object" ||
		one.boards === null ||
		!Array.isArray(one.watched) ||
		!Array.isArray(one.pulls) ||
		(one.requested !== null && !Array.isArray(one.requested))
	)
		return { refused: "the stored snapshot is not one this DevHub reads" };
	if (!sameProjects(one.projects, projects))
		return { refused: "the configured projects changed since it was stored" };
	if (now - one.savedAt > STALE_SNAPSHOT_MS)
		return {
			refused: `the stored snapshot is older than ${String(STALE_SNAPSHOT_MS / 86_400_000)} days`,
		};
	return { snapshot: one as GitHubSnapshot };
}

export interface SnapshotStore {
	/** What is stored, unread; undefined when nothing is. */
	load(): unknown;
	/** Store this, soon. */
	save(snapshot: GitHubSnapshot): void;
	/** Write a save still waiting, now. */
	flush(): void;
}

/** The file, written atomically and debounced. */
export class GitHubSnapshotFile implements SnapshotStore {
	#pending: GitHubSnapshot | undefined;
	#timer: { cancel(): void } | undefined;

	constructor(
		private readonly path: string,
		private readonly ports: {
			readonly setTimer: (ms: number, run: () => void) => { cancel(): void };
			readonly log?: (line: string) => void;
			readonly read?: (path: string) => string;
			readonly write?: (path: string, text: string) => void;
		},
	) {}

	load(): unknown {
		let text: string;
		try {
			text = (this.ports.read ?? ((path) => readFileSync(path, "utf8")))(
				this.path,
			);
		} catch {
			return undefined;
		}
		try {
			return JSON.parse(text) as unknown;
		} catch {
			this.ports.log?.(
				`[devhub] ${this.path} does not read as JSON: the next GitHub poll is a baseline`,
			);
			return undefined;
		}
	}

	save(snapshot: GitHubSnapshot): void {
		this.#pending = snapshot;
		this.#timer ??= this.ports.setTimer(SAVE_DEBOUNCE_MS, () => {
			this.#timer = undefined;
			this.flush();
		});
	}

	flush(): void {
		this.#timer?.cancel();
		this.#timer = undefined;
		const snapshot = this.#pending;
		if (snapshot === undefined) return;
		this.#pending = undefined;
		const text = JSON.stringify(snapshot);
		try {
			(this.ports.write ?? writeAtomically)(this.path, text);
		} catch (error) {
			this.ports.log?.(
				`[devhub] could not write ${this.path}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

function writeAtomically(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${String(process.pid)}.tmp`;
	writeFileSync(temporary, text, { mode: 0o600 });
	renameSync(temporary, path);
}
