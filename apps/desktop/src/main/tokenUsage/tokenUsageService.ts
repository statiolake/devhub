/**
 * Keeps the token index (`model/tokenIndex.ts`) up with the transcripts, and
 * answers reports from it (`model/tokenReport.ts`).
 *
 * Main keeps no timer for it, as for the rest of the Task Manager: a reading
 * is asked for — by the Tokens tab while it is visible, by `devhub --tell
 * usage --by …` — and one reading at a time is made, a second ask waiting on
 * the one under way. A reading lists each CLI folder's transcripts and reads
 * each file only from where it was last read, at most `CHUNK_BYTES` of it, so
 * a first reading of months of transcripts catches up over a few readings
 * rather than holding one up (the source says it is `catchingUp`).
 *
 * **SSH hosts are read lazily**: through the host's `Runtime`, only when a
 * report is asked for, and not more often than `REMOTE_EVERY_MS`; this Mac's
 * folders at every reading.
 *
 * **Who ran a session** is kept here too (`owners`): what DevHub saw an Agent
 * run, written down each reading, so a session's tokens stay the Agent's after
 * it is closed and after a restart. The index and the owners are saved
 * together (`token-usage.json` beside `state.json`), at most every
 * `SAVE_EVERY_MS`, so a restart reads only what was written since.
 */

import {
	TOKEN_RETENTION_MS,
	TokenIndex,
	type IndexedFile,
} from "../../model/tokenIndex.js";
import {
	buildTokenReport,
	resolveRange,
	type PlanWindows,
	type SessionOwner,
	type TokenTask,
	type TokenWorkspace,
} from "../../model/tokenReport.js";
import {
	claudeUsage,
	codexUsage,
	wholeLines,
	type TokenCli,
	type TranscriptState,
} from "../../model/tokenTranscripts.js";
import type {
	TokenQueryWire,
	TokenReportWire,
	TokenSourceWire,
} from "../../ipc/tokenUsage.js";
import {
	READ_BUDGET_BYTES,
	type ListedFile,
	type ReadRequest,
	type TranscriptMachine,
	type TranscriptRoot,
} from "./transcriptMachine.js";

/** How much of one file one reading reads. */
export const CHUNK_BYTES = 4 * 1024 * 1024;
/** How much one reading reads of one source, at most. */
const SOURCE_BUDGET_BYTES = {
	local: 96 * 1024 * 1024,
	remote: 16 * 1024 * 1024,
};
/** An SSH host's folders are read again no sooner than this. */
export const REMOTE_EVERY_MS = 60_000;
export const SAVE_EVERY_MS = 30_000;
/** How many sessions' owners are remembered. */
const OWNER_LIMIT = 4_000;
const SAVED_VERSION = 1;

export interface TokenSource {
	readonly root: TranscriptRoot;
	readonly machine: TranscriptMachine;
}

/** What a report needs of the app besides the index. */
export interface TokenReportContext {
	readonly tasks: readonly TokenTask[];
	readonly workspaces: readonly TokenWorkspace[];
	readonly windows: PlanWindows;
	/** Who ran a session DevHub has no owner of its own for (tasks, session metadata). */
	readonly ownerOf?: (
		machine: string,
		cli: string,
		session: string,
	) => SessionOwner | undefined;
}

export interface TokenUsageDeps {
	/** Every folder to read, now. */
	sources(): Promise<readonly TokenSource[]>;
	load(): Promise<unknown>;
	save(value: unknown): Promise<void>;
	now(): number;
}

/** A transcript's path, as what it is a transcript of. */
export interface TranscriptOf {
	readonly session: string;
	readonly subagent?: string;
}

/**
 * Claude: `<root>/projects/<project>/<session>.jsonl`, or a subagent's,
 * `<root>/projects/<project>/<session>/subagents/agent-<id>.jsonl`. Codex:
 * `rollout-<time>-<thread>.jsonl`. Anything else is not a transcript.
 */
export function transcriptOf(
	cli: TokenCli,
	root: string,
	path: string,
): TranscriptOf | undefined {
	if (cli === "codex") {
		const match =
			/(?:^|\/)rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([^/]+)\.jsonl$/u.exec(
				path,
			);
		return match ? { session: match[1]! } : undefined;
	}
	const prefix = `${root}/projects/`;
	if (!path.startsWith(prefix)) return undefined;
	const parts = path.slice(prefix.length).split("/");
	if (parts.length === 2 && parts[1]!.endsWith(".jsonl"))
		return { session: parts[1]!.slice(0, -".jsonl".length) };
	const sub = /^agent-(.+)\.jsonl$/u.exec(parts[3] ?? "");
	if (parts.length === 4 && parts[2] === "subagents" && sub)
		return { session: parts[1]!, subagent: sub[1]! };
	return undefined;
}

const sourceKey = (root: TranscriptRoot) =>
	`${root.machine}\u0000${root.cli}\u0000${root.root}`;
const ownerKey = (machine: string, cli: string, session: string) =>
	`${machine}\u0000${cli}\u0000${session}`;

interface OwnerEntry extends SessionOwner {
	readonly at: number;
}

/** What a subagent was asked to do, from its `agent-<id>.meta.json`. */
export function subagentLabel(meta: Buffer): string | undefined {
	try {
		const value = JSON.parse(meta.toString("utf8")) as Record<string, unknown>;
		const description = value["description"];
		const type = value["agentType"];
		if (typeof description === "string" && description.trim() !== "")
			return description.trim();
		if (typeof type === "string" && type !== "") return type;
	} catch {
		// Not there yet, or cut short: the subagent is named by its id.
	}
	return undefined;
}

export class TokenUsageService {
	#index = new TokenIndex();
	readonly #owners = new Map<string, OwnerEntry>();
	readonly #status = new Map<string, TokenSourceWire>();
	readonly #remoteAt = new Map<string, number>();
	/** Subagent meta files already looked at, so a missing one is not asked again. */
	readonly #labelsAsked = new Set<string>();
	#loaded: Promise<void> | undefined;
	#reading: Promise<void> | undefined;
	#savedAt = 0;
	#ownersChanged = false;

	constructor(private readonly deps: TokenUsageDeps) {}

	get index(): TokenIndex {
		return this.#index;
	}

	#load(): Promise<void> {
		this.#loaded ??= this.deps.load().then(
			(value) => {
				const saved = value as {
					version?: number;
					index?: unknown;
					owners?: unknown;
				} | null;
				if (saved?.version !== SAVED_VERSION) return;
				this.#index = TokenIndex.fromJSON(saved.index);
				if (Array.isArray(saved.owners))
					for (const one of saved.owners as [string, OwnerEntry][])
						if (
							Array.isArray(one) &&
							typeof one[0] === "string" &&
							typeof one[1]?.name === "string"
						)
							this.#owners.set(one[0], one[1]);
			},
			() => undefined,
		);
		return this.#loaded;
	}

	/** What DevHub sees each Agent run now: kept as the session's owner. */
	observe(
		running: readonly {
			readonly cli: string;
			readonly session: string;
			readonly owner: SessionOwner;
		}[],
	): void {
		const now = this.deps.now();
		for (const one of running) {
			const key = ownerKey(one.owner.machine, one.cli, one.session);
			const known = this.#owners.get(key);
			if (
				known !== undefined &&
				known.name === one.owner.name &&
				known.role === one.owner.role &&
				known.agentId === one.owner.agentId &&
				known.workspaceLabel === one.owner.workspaceLabel &&
				now - known.at < 60 * 60_000
			)
				continue;
			this.#owners.delete(key);
			this.#owners.set(key, { ...one.owner, at: now });
			this.#ownersChanged = true;
		}
		while (this.#owners.size > OWNER_LIMIT) {
			const oldest = this.#owners.keys().next().value;
			if (oldest === undefined) break;
			this.#owners.delete(oldest);
		}
	}

	ownerOf(
		machine: string,
		cli: string,
		session: string,
	): SessionOwner | undefined {
		return this.#owners.get(ownerKey(machine, cli, session));
	}

	/** One reading: this Mac's folders, and the hosts' when they are due. */
	refresh(options: { readonly remote?: "due" | "now" } = {}): Promise<void> {
		if (this.#reading) return this.#reading;
		const reading = this.#read(options.remote ?? "due").finally(() => {
			this.#reading = undefined;
		});
		this.#reading = reading;
		return reading;
	}

	async #read(remote: "due" | "now"): Promise<void> {
		await this.#load();
		const now = this.deps.now();
		const sources = await this.deps.sources();
		await Promise.all(
			sources.map(async (source) => {
				const key = sourceKey(source.root);
				const local = source.root.machine === "local";
				if (!local && remote === "due") {
					const last = this.#remoteAt.get(key);
					if (last !== undefined && now - last < REMOTE_EVERY_MS) return;
				}
				if (!local) this.#remoteAt.set(key, now);
				try {
					const catchingUp = await this.#readSource(source, now);
					this.#status.set(key, {
						...source.root,
						files: this.#filesOf(source.root),
						readAt: now,
						...(catchingUp ? { catchingUp: true } : {}),
					});
				} catch (error: unknown) {
					// Said with the source; the next reading tries again.
					this.#status.set(key, {
						...source.root,
						files: this.#filesOf(source.root),
						...(this.#status.get(key)?.readAt === undefined
							? {}
							: { readAt: this.#status.get(key)!.readAt! }),
						problem: error instanceof Error ? error.message : String(error),
					});
				}
			}),
		);
		// Sources no longer asked about are not said.
		const asked = new Set(sources.map((source) => sourceKey(source.root)));
		for (const key of this.#status.keys())
			if (!asked.has(key)) this.#status.delete(key);
		await this.#saveIfDue(now);
	}

	#filesOf(root: TranscriptRoot): number {
		let files = 0;
		for (const file of this.#index.files())
			if (
				file.machine === root.machine &&
				file.cli === root.cli &&
				file.path.startsWith(`${root.root}/`)
			)
				files += 1;
		return files;
	}

	/** Whether some of its files are left to read. */
	async #readSource(source: TokenSource, now: number): Promise<boolean> {
		const { root } = source;
		const days = Math.ceil(TOKEN_RETENTION_MS / (24 * 60 * 60 * 1000)) + 1;
		const listed = await source.machine.list(root, days);
		const metas = new Set(
			listed
				.filter((one) => one.path.endsWith(".meta.json"))
				.map((one) => one.path),
		);
		const wanted: { file: ListedFile; of: TranscriptOf; start: number }[] = [];
		for (const file of listed) {
			if (!file.path.endsWith(".jsonl")) continue;
			const of = transcriptOf(root.cli, root.root, file.path);
			if (of === undefined) continue;
			const known = this.#index.file(root.machine, file.path);
			if (known !== undefined && known.offset === file.size) continue;
			const start = this.#index.startOf(
				{ machine: root.machine, cli: root.cli, path: file.path, ...of },
				file.size,
			);
			if (start >= file.size) continue;
			wanted.push({ file, of, start });
		}
		// The most recently written first: what is going on now is shown first.
		wanted.sort((a, b) => b.file.mtimeMs - a.file.mtimeMs);
		const budget =
			root.machine === "local"
				? SOURCE_BUDGET_BYTES.local
				: SOURCE_BUDGET_BYTES.remote;
		let spent = 0;
		let left = false;
		const batches: (typeof wanted)[] = [[]];
		for (const one of wanted) {
			const length = Math.min(CHUNK_BYTES, one.file.size - one.start);
			if (spent + length > budget) {
				left = true;
				break;
			}
			if (one.start + length < one.file.size) left = true;
			spent += length;
			const batch = batches[batches.length - 1]!;
			const size = batch.reduce(
				(sum, b) => sum + Math.min(CHUNK_BYTES, b.file.size - b.start),
				0,
			);
			if (size + length > READ_BUDGET_BYTES) batches.push([one]);
			else batch.push(one);
		}
		for (const batch of batches) {
			if (batch.length === 0) continue;
			const requests: ReadRequest[] = batch.map((one) => ({
				path: one.file.path,
				offset: one.start,
				length: Math.min(CHUNK_BYTES, one.file.size - one.start),
			}));
			const labels = new Map<string, string>();
			for (const one of batch) {
				if (one.of.subagent === undefined) continue;
				const meta = one.file.path.replace(/\.jsonl$/u, ".meta.json");
				const known = this.#index.file(root.machine, one.file.path);
				if (
					known?.subagentLabel !== undefined ||
					!metas.has(meta) ||
					this.#labelsAsked.has(meta)
				)
					continue;
				this.#labelsAsked.add(meta);
				labels.set(one.file.path, meta);
				requests.push({ path: meta, offset: 0, length: 16 * 1024 });
			}
			const reads = await source.machine.read(requests);
			for (const one of batch) {
				const data = reads.get(one.file.path);
				if (data === undefined) continue;
				const known = this.#index.file(root.machine, one.file.path);
				const meta = labels.get(one.file.path);
				const label = meta === undefined ? undefined : reads.get(meta);
				this.#ingest(
					{ root, ...one, data, state: known?.state },
					label === undefined ? undefined : subagentLabel(label),
					now,
				);
				// Parsing is main's own time: a file at a time, between turns.
				await new Promise((resolve) => setImmediate(resolve));
			}
		}
		return left;
	}

	#ingest(
		read: {
			readonly root: TranscriptRoot;
			readonly file: ListedFile;
			readonly of: TranscriptOf;
			readonly start: number;
			readonly data: Buffer;
			readonly state: TranscriptState | undefined;
		},
		label: string | undefined,
		now: number,
	): IndexedFile {
		const { root, file, of, start } = read;
		let state: TranscriptState = start === 0 ? {} : (read.state ?? {});
		let data: Uint8Array = read.data;
		let skipped = 0;
		// A line longer than a whole chunk was being passed over: up to its end.
		if (state.skipToLine === true) {
			const end = data.indexOf(10);
			if (end < 0) {
				skipped = data.length;
				data = new Uint8Array();
			} else {
				skipped = end + 1;
				data = data.subarray(end + 1);
				const { skipToLine: _, ...rest } = state;
				state = rest;
			}
		}
		const lines = wholeLines(data);
		let consumed = skipped + lines.bytes;
		if (lines.bytes === 0 && skipped === 0 && data.length >= CHUNK_BYTES) {
			// One line is longer than a chunk: no request's usage is that
			// long, so it is passed over rather than read whole.
			consumed = data.length;
			state = { ...state, skipToLine: true };
		}
		const parsed =
			root.cli === "claude"
				? claudeUsage(lines.text, state)
				: codexUsage(lines.text, state);
		return this.#index.ingest(
			{
				machine: root.machine,
				cli: root.cli,
				path: file.path,
				session: of.session,
				...(of.subagent === undefined ? {} : { subagent: of.subagent }),
				...(label === undefined ? {} : { subagentLabel: label }),
			},
			{
				start,
				consumed,
				size: file.size,
				mtimeMs: file.mtimeMs,
				state: parsed.state,
				events: parsed.events,
			},
			now,
		);
	}

	async #saveIfDue(now: number): Promise<void> {
		if (!this.#index.changed && !this.#ownersChanged) return;
		if (now - this.#savedAt < SAVE_EVERY_MS) return;
		await this.save();
	}

	/** Save now (the index and the owners), once the saved one was read. */
	async save(): Promise<void> {
		// Nothing was read this run: what is saved stays as it is.
		if (this.#loaded === undefined) return;
		await this.#loaded;
		const now = this.deps.now();
		this.#savedAt = now;
		this.#index.prune(now);
		const cutoff = now - TOKEN_RETENTION_MS;
		for (const [key, owner] of this.#owners)
			if (owner.at < cutoff) this.#owners.delete(key);
		this.#index.markSaved();
		this.#ownersChanged = false;
		await this.deps.save({
			version: SAVED_VERSION,
			index: this.#index.toJSON(),
			owners: [...this.#owners.entries()],
		});
	}

	sources(): readonly TokenSourceWire[] {
		return [...this.#status.values()];
	}

	/** A report, from the index as the latest reading left it. */
	report(query: TokenQueryWire, context: TokenReportContext): TokenReportWire {
		const now = this.deps.now();
		return buildTokenReport({
			records: this.#index.records(),
			ownerOf: (machine, cli, session) =>
				this.ownerOf(machine, cli, session) ??
				context.ownerOf?.(machine, cli, session),
			tasks: context.tasks,
			workspaces: context.workspaces,
			range: resolveRange(query.range, now, context.windows, {
				...(query.from === undefined ? {} : { from: query.from }),
				...(query.to === undefined ? {} : { to: query.to }),
			}),
			by: query.by,
			takenAt: now,
			sources: this.sources(),
		});
	}
}
