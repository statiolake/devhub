/**
 * The entry tree as the tool calls read it: a commit tells the readers of
 * the parts that changed, and no other.
 */

import { describe, expect, it, vi } from "vitest";
import { entryId } from "../../model/conversation";
import { EntryTreeStore, changedParts, entryTree } from "./entryTree";
import { assistant, put, tool, transcriptOf } from "./transcriptFixtures";

const a = tool("a", "Bash: ls");
const b = tool("b", "Bash: pwd");
const underA = (id: string, text: string) =>
  put(assistant(id, text, { parent: "a" }));

describe("the entry tree's store", () => {
  it("tells the readers of the calls whose children changed, and no other", () => {
    const first = entryTree(
      transcriptOf([put(a), put(b), underA("a1", "one")]),
      undefined,
    );
    const second = entryTree(
      transcriptOf([put(a), put(b), underA("a1", "one"), underA("a2", "two")]),
      first,
    );
    expect([...changedParts(first, second)]).toEqual([entryId("a")]);
    const store = new EntryTreeStore(first);
    const readsA = vi.fn();
    const readsB = vi.fn();
    store.subscribe(entryId("a"), readsA);
    store.subscribe(entryId("b"), readsB);
    store.set(second);
    expect(store.get()).toBe(second);
    store.publish();
    expect(readsA).toHaveBeenCalledTimes(1);
    expect(readsB).not.toHaveBeenCalled();
    // Committed again with nothing new: nobody is told.
    store.publish();
    expect(readsA).toHaveBeenCalledTimes(1);
  });

  it("tells a call that lost its children, and the calls the plan moved between", () => {
    const withChildren = entryTree(
      transcriptOf([put(a), underA("a1", "one")]),
      undefined,
    );
    const without = entryTree(transcriptOf([put(a)]), withChildren);
    expect([...changedParts(withChildren, without)]).toEqual([entryId("a")]);
    const planned = (id: string) =>
      put(tool(id, "TodoWrite", { plan: [{ text: "x", status: "pending" }] }));
    const onA = entryTree(transcriptOf([planned("a"), put(b)]), undefined);
    const onB = entryTree(transcriptOf([planned("a"), planned("b")]), onA);
    expect(new Set(changedParts(onA, onB))).toEqual(
      new Set([entryId("a"), entryId("b")]),
    );
  });
});
