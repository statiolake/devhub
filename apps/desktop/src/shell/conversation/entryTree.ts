/**
 * The transcript as the page walks it: each entry's children, and the
 * requests about each tool call.
 *
 * `childrenOf` in `model/conversation.ts` answers the same question for one
 * parent by scanning every entry, which is right for a reading taken once and
 * quadratic for a page that draws every parent. This groups the entries in
 * one pass instead — and hands back the previous group for any parent whose
 * children did not change, so a delta to one answer leaves every other entry's
 * props as they were and `memo` can skip them.
 */

import {
  latestPlan,
  type EntryId,
  type PendingRequest,
  type Transcript,
  type TranscriptEntry,
} from "../../model/conversation";

export interface EntryTree {
  /** The entries directly under a parent, `null` being the top level. */
  readonly children: ReadonlyMap<EntryId | null, readonly TranscriptEntry[]>;
  /** The open requests about each tool call, in the order they opened. */
  readonly requests: ReadonlyMap<EntryId, readonly PendingRequest[]>;
  /** The open requests about no tool call, drawn after the last entry. */
  readonly unattached: readonly PendingRequest[];
  /** The entry the Agent's plan last stood on (`latestPlan`), whose checklist is drawn unfolded. */
  readonly latestPlan: EntryId | undefined;
}

export const NO_ENTRIES: readonly TranscriptEntry[] = [];
export const NO_REQUESTS: readonly PendingRequest[] = [];

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function reuse<K, T>(
  grouped: Map<K, T[]>,
  previous: ReadonlyMap<K, readonly T[]> | undefined,
): Map<K, readonly T[]> {
  const kept = new Map<K, readonly T[]>();
  for (const [key, items] of grouped) {
    const before = previous?.get(key);
    kept.set(key, before && sameItems(before, items) ? before : items);
  }
  return kept;
}

export function entryTree(
  transcript: Transcript,
  previous: EntryTree | undefined,
): EntryTree {
  const children = new Map<EntryId | null, TranscriptEntry[]>();
  for (const entry of transcript.entries) {
    const parent = entry.kind === "turn-end" ? null : entry.parent;
    let group = children.get(parent);
    if (!group) {
      group = [];
      children.set(parent, group);
    }
    group.push(entry);
  }
  const requests = new Map<EntryId, PendingRequest[]>();
  const unattached: PendingRequest[] = [];
  for (const request of transcript.requests) {
    if (request.entry === undefined) {
      unattached.push(request);
      continue;
    }
    let group = requests.get(request.entry);
    if (!group) {
      group = [];
      requests.set(request.entry, group);
    }
    group.push(request);
  }
  return {
    children: reuse(children, previous?.children),
    requests: reuse(requests, previous?.requests),
    unattached:
      previous && sameItems(previous.unattached, unattached)
        ? previous.unattached
        : unattached,
    latestPlan: latestPlan(transcript)?.entry,
  };
}

/** The parents whose part of the tree is not the same between two trees. */
export function changedParts(
  before: EntryTree,
  after: EntryTree,
): ReadonlySet<EntryId> {
  const changed = new Set<EntryId>();
  const compare = <K extends EntryId | null, T>(
    a: ReadonlyMap<K, readonly T[]>,
    b: ReadonlyMap<K, readonly T[]>,
  ) => {
    for (const [id, items] of b) {
      if (id !== null && a.get(id) !== items) changed.add(id);
    }
    for (const id of a.keys()) {
      if (id !== null && !b.has(id)) changed.add(id);
    }
  };
  compare(before.children, after.children);
  compare(before.requests, after.requests);
  if (before.latestPlan !== after.latestPlan) {
    if (before.latestPlan !== undefined) changed.add(before.latestPlan);
    if (after.latestPlan !== undefined) changed.add(after.latestPlan);
  }
  return changed;
}

/**
 * The tree as the tool calls read it, each its own part: the value being
 * drawn (read by what draws after it in the same pass) and, once committed,
 * a word to the readers of each part that changed — and to no other. Every
 * tool call of a long transcript reads the tree, and telling all of them on
 * every frame had each one look its part up to find the few that moved.
 */
export class EntryTreeStore {
  #value: EntryTree;
  #published: EntryTree;
  readonly #listeners = new Map<EntryId, Set<() => void>>();

  constructor(value: EntryTree) {
    this.#value = value;
    this.#published = value;
  }

  readonly get = (): EntryTree => this.#value;

  set(value: EntryTree): void {
    this.#value = value;
  }

  /** The value is committed: the readers of each part that changed compare what they read. */
  publish(): void {
    const before = this.#published;
    const after = this.#value;
    this.#published = after;
    if (before === after) return;
    for (const id of changedParts(before, after)) {
      const readers = this.#listeners.get(id);
      if (readers) for (const listener of [...readers]) listener();
    }
  }

  subscribe(id: EntryId, listener: () => void): () => void {
    let readers = this.#listeners.get(id);
    if (readers === undefined) {
      readers = new Set();
      this.#listeners.set(id, readers);
    }
    readers.add(listener);
    return () => {
      readers.delete(listener);
      if (readers.size === 0) this.#listeners.delete(id);
    };
  }
}
