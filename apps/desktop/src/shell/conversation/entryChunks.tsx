/**
 * The transcript's top-level entries, drawn in chunks of `CHUNK_SIZE`.
 *
 * The whole transcript stays in the document — find, a drag selection, a copy
 * and the browser's scroll anchoring all need every word of it there
 * (`ConversationSurface`) — but not as one flat list. With a few thousand
 * entries in one parent, every entry added cost 25–45 ms of style and layout:
 * Blink restyles all of a parent's children when one is inserted among them
 * under the transcript's sibling rules (`.conversation-entry +
 * .conversation-entry`, the spacing), and React went through every entry of
 * the list each frame. In chunks, an entry is added at the end of the last
 * chunk, where there is nothing after it to restyle, the transcript itself
 * holds a few dozen chunks, and React compares a chunk's entries and skips
 * every chunk whose entries are the ones it drew (docs/process-model.md,
 * phase 6c). The chunks are in a container of their own, so a new chunk is
 * added at its end too, never before the transcript's last lines (the
 * activity line, what is being sent): a chunk inserted before them restyled
 * every chunk.
 *
 * A chunk keeps its entries: it is named by the entry it starts with, and
 * the entries that start chunks are remembered from one draw to the next, so
 * an entry is never moved from one chunk to another (which would draw it
 * anew, its folds closed) — an entry inserted inside a chunk makes that chunk
 * longer. Only the last chunk is cut at `CHUNK_SIZE`.
 *
 * Spacing between entries is by their kinds and the kind before them
 * (`conversation.css`); across a chunk's edge the kind before is the chunk's
 * `data-after`.
 */

import { memo, useRef } from "react";
import type { EntryId, TranscriptEntry } from "../../model/conversation";
import { CHUNK_CLASS, CHUNKS_CLASS } from "./chunkElements";
import { EntryView, isDrawn } from "./EntryView";

/** How many top-level entries a chunk is cut at. */
export const CHUNK_SIZE = 50;

export interface EntryChunk {
  /** The entry it started with: its key. */
  readonly key: EntryId;
  readonly entries: readonly TranscriptEntry[];
  /** The kind of the last entry drawn before it, if any. */
  readonly after: TranscriptEntry["kind"] | undefined;
}

function sameEntries(
  a: readonly TranscriptEntry[],
  b: readonly TranscriptEntry[],
): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * `entries` in chunks: a new chunk at every entry in `starts` and wherever
 * the last chunk reaches `CHUNK_SIZE`. `starts` is updated to the entries
 * that start the chunks now; a chunk the same as one in `previous` is that
 * one, so it compares equal by identity.
 */
export function chunkEntries(
  entries: readonly TranscriptEntry[],
  starts: Set<EntryId>,
  previous: readonly EntryChunk[],
): EntryChunk[] {
  // Past the last remembered start, the chunks are cut by size; before it,
  // only where they started.
  let lastStart = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (starts.has(entries[index]!.id)) {
      lastStart = index;
      break;
    }
  }
  const kept = new Map(previous.map((chunk) => [chunk.key, chunk]));
  const chunks: EntryChunk[] = [];
  const nextStarts = new Set<EntryId>();
  let current: TranscriptEntry[] | undefined;
  let after: TranscriptEntry["kind"] | undefined;
  let lastDrawn: TranscriptEntry["kind"] | undefined;
  const close = () => {
    if (current === undefined) return;
    const key = current[0]!.id;
    const before = kept.get(key);
    chunks.push(
      before !== undefined &&
        before.after === after &&
        sameEntries(before.entries, current)
        ? before
        : { key, entries: current, after },
    );
  };
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (
      current === undefined ||
      starts.has(entry.id) ||
      (index > lastStart && current.length >= CHUNK_SIZE)
    ) {
      close();
      current = [];
      after = lastDrawn;
      nextStarts.add(entry.id);
    }
    current.push(entry);
    if (isDrawn(entry)) lastDrawn = entry.kind;
  }
  close();
  starts.clear();
  for (const id of nextStarts) starts.add(id);
  return chunks;
}

const ChunkView = memo(function ChunkView({
  chunk,
}: {
  readonly chunk: EntryChunk;
}) {
  return (
    <div className={CHUNK_CLASS} data-after={chunk.after}>
      {chunk.entries.map((entry) => (
        <EntryView key={entry.id} entry={entry} depth={0} />
      ))}
    </div>
  );
});

/** The top-level entries, chunked; stable chunks are not drawn again. */
export function ChunkedEntries({
  entries,
}: {
  readonly entries: readonly TranscriptEntry[];
}) {
  const starts = useRef(new Set<EntryId>());
  const drawn = useRef<readonly EntryChunk[]>([]);
  const last = useRef<
    | {
        readonly entries: readonly TranscriptEntry[];
        readonly chunks: readonly EntryChunk[];
      }
    | undefined
  >(undefined);
  if (last.current?.entries !== entries) {
    const chunks = chunkEntries(entries, starts.current, drawn.current);
    drawn.current = chunks;
    last.current = { entries, chunks };
  }
  return (
    <div className={CHUNKS_CLASS}>
      {last.current.chunks.map((chunk) => (
        <ChunkView key={chunk.key} chunk={chunk} />
      ))}
    </div>
  );
}
