/**
 * The token index: every transcript file read so far, how far, and the
 * requests read out of them — once each.
 *
 * Kept so the Tokens view never reads a transcript twice: a file is read from
 * the byte it was read up to (`offset`), whole lines only, and the index is
 * saved beside `state.json` (`token-usage.json`), so a restart reads only
 * what was written since. A file that is shorter than its offset was
 * rewritten, and is read again from the start, its requests taken back first.
 *
 * **One request, once.** A request is its CLI's key (`tokenTranscripts.ts`)
 * within its machine and CLI: the lines of one streamed response, a resumed
 * session's copy of an earlier one, a Codex `token_count` written again — all
 * the same key. The first file to say a key owns it; a later saying of it
 * only raises a count that was short.
 *
 * **Bounded.** Requests older than `TOKEN_RETENTION_MS` are let go, and so is
 * a file nothing was written to since: what the view shows is at most that
 * far back.
 *
 * Pure: no clock (every operation is handed `now`), no I/O.
 */

import type { TokenCounts } from "./tokenPrices.js";
import type {
  TokenCli,
  TranscriptState,
  UsageEvent,
} from "./tokenTranscripts.js";

/** How far back the index keeps requests: 35 days. */
export const TOKEN_RETENTION_MS = 35 * 24 * 60 * 60 * 1000;
export const TOKEN_INDEX_VERSION = 1;

/** One transcript file, as the index knows it. */
export interface IndexedFile {
  /** `local`, or `ssh:<host>`. */
  readonly machine: string;
  readonly cli: TokenCli;
  /** Absolute, on its machine. */
  readonly path: string;
  /**
   * The session its usage counts toward: its own, or, for a subagent's file
   * (`<session>/subagents/agent-<id>.jsonl`), the session that started it.
   */
  readonly session: string;
  /** A subagent's file: the subagent's id. */
  readonly subagent?: string;
  /** What the subagent was asked to do (`agent-<id>.meta.json`). */
  subagentLabel?: string;
  /**
   * Read up to here: the byte after the last whole line read. This and the
   * fields below change in place as the file is read further, so the
   * requests that point at the file need no change.
   */
  offset: number;
  size: number;
  mtimeMs: number;
  state: TranscriptState;
}

/** One request, with the file that said it first. */
export interface IndexedRecord {
  readonly key: string;
  readonly at: number;
  readonly model: string;
  readonly counts: TokenCounts;
  readonly fast?: true;
  /** The subagent's id, inline (`isSidechain`) or its own file's. */
  readonly subagent?: string;
  readonly file: IndexedFile;
}

interface StoredRecord {
  readonly k: string;
  readonly t: number;
  readonly m: string;
  readonly c: readonly [number, number, number, number, number];
  readonly f?: 1;
  readonly s?: string;
}

interface StoredFile extends Omit<IndexedFile, "state"> {
  readonly state: TranscriptState;
  readonly records: readonly StoredRecord[];
}

export interface StoredTokenIndex {
  readonly version: typeof TOKEN_INDEX_VERSION;
  readonly files: readonly StoredFile[];
}

const fileKey = (machine: string, path: string): string =>
  `${machine}\u0000${path}`;
const recordKey = (machine: string, cli: TokenCli, key: string): string =>
  `${machine}\u0000${cli}\u0000${key}`;

const max = (a: TokenCounts, b: TokenCounts): TokenCounts => ({
  input: Math.max(a.input, b.input),
  output: Math.max(a.output, b.output),
  cacheRead: Math.max(a.cacheRead, b.cacheRead),
  cacheWrite5m: Math.max(a.cacheWrite5m, b.cacheWrite5m),
  cacheWrite1h: Math.max(a.cacheWrite1h, b.cacheWrite1h),
});

export class TokenIndex {
  readonly #files = new Map<string, IndexedFile>();
  /** Every request, by its machine, CLI and key. */
  readonly #records = new Map<string, IndexedRecord>();
  #changed = false;

  /** Whether anything changed since `markSaved`. */
  get changed(): boolean {
    return this.#changed;
  }

  markSaved(): void {
    this.#changed = false;
  }

  file(machine: string, path: string): IndexedFile | undefined {
    return this.#files.get(fileKey(machine, path));
  }

  files(): IterableIterator<IndexedFile> {
    return this.#files.values();
  }

  records(): IterableIterator<IndexedRecord> {
    return this.#records.values();
  }

  get size(): number {
    return this.#records.size;
  }

  /**
   * Where to read `file` from, now that it is `size` bytes: its offset, or 0
   * for a file new to the index or rewritten (its requests taken back).
   */
  startOf(
    file: Omit<IndexedFile, "offset" | "state" | "size" | "mtimeMs">,
    size: number,
  ): number {
    const known = this.file(file.machine, file.path);
    if (known === undefined) return 0;
    if (size >= known.offset) return known.offset;
    this.#forget(known);
    return 0;
  }

  /**
   * What was read of a file: `consumed` more bytes from `start`, the
   * requests in them, and what its lines said. Requests older than
   * `now - TOKEN_RETENTION_MS` are not kept.
   */
  ingest(
    file: Omit<IndexedFile, "offset" | "state" | "size" | "mtimeMs"> & {
      readonly subagentLabel?: string;
    },
    read: {
      readonly start: number;
      readonly consumed: number;
      readonly size: number;
      readonly mtimeMs: number;
      readonly state: TranscriptState;
      readonly events: readonly UsageEvent[];
    },
    now: number,
  ): IndexedFile {
    const before = this.file(file.machine, file.path);
    const entry: IndexedFile = before ?? {
      ...file,
      offset: 0,
      size: 0,
      mtimeMs: 0,
      state: {},
    };
    if (file.subagentLabel !== undefined)
      entry.subagentLabel = file.subagentLabel;
    entry.offset = read.start + read.consumed;
    entry.size = read.size;
    entry.mtimeMs = read.mtimeMs;
    entry.state = read.state;
    this.#files.set(fileKey(file.machine, file.path), entry);
    const cutoff = now - TOKEN_RETENTION_MS;
    for (const event of read.events) {
      if (event.at < cutoff) continue;
      this.#add(entry, event);
    }
    if (read.consumed > 0 || before === undefined) this.#changed = true;
    return entry;
  }

  #add(file: IndexedFile, event: UsageEvent): void {
    const key = recordKey(file.machine, file.cli, event.key);
    const known = this.#records.get(key);
    const subagent = event.subagent ?? file.subagent;
    if (known !== undefined) {
      const counts = max(known.counts, event.counts);
      if (
        counts.input !== known.counts.input ||
        counts.output !== known.counts.output ||
        counts.cacheRead !== known.counts.cacheRead ||
        counts.cacheWrite5m !== known.counts.cacheWrite5m ||
        counts.cacheWrite1h !== known.counts.cacheWrite1h
      ) {
        this.#records.set(key, { ...known, counts });
      }
      return;
    }
    this.#records.set(key, {
      key: event.key,
      at: event.at,
      model: event.model,
      counts: event.counts,
      ...(event.fast ? { fast: true as const } : {}),
      ...(subagent === undefined ? {} : { subagent }),
      file,
    });
  }

  #forget(file: IndexedFile): void {
    for (const [key, record] of this.#records)
      if (record.file === file) this.#records.delete(key);
    this.#files.delete(fileKey(file.machine, file.path));
    this.#changed = true;
  }

  /** Let go of what is older than the retention, and files that are gone. */
  prune(now: number, gone: readonly IndexedFile[] = []): void {
    const cutoff = now - TOKEN_RETENTION_MS;
    for (const file of gone) this.#forget(file);
    for (const [key, record] of this.#records)
      if (record.at < cutoff) {
        this.#records.delete(key);
        this.#changed = true;
      }
    for (const file of [...this.#files.values()])
      if (file.mtimeMs < cutoff) this.#forget(file);
  }

  toJSON(): StoredTokenIndex {
    const byFile = new Map<IndexedFile, StoredRecord[]>();
    for (const record of this.#records.values()) {
      const list = byFile.get(record.file) ?? [];
      byFile.set(record.file, list);
      const { input, output, cacheRead, cacheWrite5m, cacheWrite1h } =
        record.counts;
      list.push({
        k: record.key,
        t: record.at,
        m: record.model,
        c: [input, output, cacheRead, cacheWrite5m, cacheWrite1h],
        ...(record.fast ? { f: 1 as const } : {}),
        ...(record.subagent === undefined ? {} : { s: record.subagent }),
      });
    }
    return {
      version: TOKEN_INDEX_VERSION,
      files: [...this.#files.values()].map((file) => ({
        ...file,
        records: byFile.get(file) ?? [],
      })),
    };
  }

  /**
   * An index from what `toJSON` wrote; an empty one for anything else (an
   * older version, a file cut short): the transcripts are read again, which
   * is slower and loses nothing.
   */
  static fromJSON(value: unknown): TokenIndex {
    const index = new TokenIndex();
    const stored = value as Partial<StoredTokenIndex> | null;
    if (
      stored === null ||
      typeof stored !== "object" ||
      stored.version !== TOKEN_INDEX_VERSION ||
      !Array.isArray(stored.files)
    )
      return index;
    for (const one of stored.files) {
      if (
        typeof one !== "object" ||
        typeof one.path !== "string" ||
        typeof one.machine !== "string" ||
        (one.cli !== "claude" && one.cli !== "codex") ||
        typeof one.session !== "string" ||
        typeof one.offset !== "number" ||
        !Array.isArray(one.records)
      )
        continue;
      const { records, ...rest } = one;
      const file: IndexedFile = { ...rest, state: rest.state ?? {} };
      index.#files.set(fileKey(file.machine, file.path), file);
      for (const record of records) {
        if (
          typeof record?.k !== "string" ||
          typeof record.t !== "number" ||
          !Array.isArray(record.c)
        )
          continue;
        const [input, output, cacheRead, cacheWrite5m, cacheWrite1h] =
          record.c.map((n: unknown) => (typeof n === "number" ? n : 0));
        index.#records.set(recordKey(file.machine, file.cli, record.k), {
          key: record.k,
          at: record.t,
          model: typeof record.m === "string" ? record.m : "unknown",
          counts: {
            input: input ?? 0,
            output: output ?? 0,
            cacheRead: cacheRead ?? 0,
            cacheWrite5m: cacheWrite5m ?? 0,
            cacheWrite1h: cacheWrite1h ?? 0,
          },
          ...(record.f === 1 ? { fast: true as const } : {}),
          ...(typeof record.s === "string" ? { subagent: record.s } : {}),
          file,
        });
      }
    }
    return index;
  }
}
