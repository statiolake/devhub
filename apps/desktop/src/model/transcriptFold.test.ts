/**
 * `TranscriptFold`: the same fold as `applyEvent`, at a cost per event that
 * does not grow with the transcript, and snapshots that never change.
 */

import { describe, expect, it } from "vitest";
import {
  EMPTY_TRANSCRIPT,
  TranscriptFold,
  TranscriptInvariantError,
  applyEvent,
  entryId,
  type ConversationEvent,
  type Transcript,
} from "./conversation.js";

const READY: ConversationEvent = {
  type: "state",
  state: { phase: "ready", turn: "none" },
};
const RUNNING: ConversationEvent = {
  type: "state",
  state: { phase: "ready", turn: "running" },
};
const REWINDABLE: ConversationEvent = {
  type: "session",
  session: { ...EMPTY_TRANSCRIPT.session, canRewind: true },
};

function user(id: string): ConversationEvent {
  return {
    type: "entry",
    entry: {
      kind: "user",
      id: entryId(id),
      parent: null,
      text: `message ${id}`,
      images: [],
      origin: "person",
      rewindable: true,
    },
  };
}

function assistant(
  id: string,
  streaming: boolean,
  parent: string | null = null,
): ConversationEvent {
  return {
    type: "entry",
    entry: {
      kind: "assistant",
      id: entryId(id),
      parent: parent === null ? null : entryId(parent),
      blocks: [
        { kind: "thinking", text: "" },
        { kind: "text", markdown: "" },
      ],
      streaming,
    },
  };
}

function tool(
  id: string,
  status: "running" | "succeeded",
  parent: string | null = null,
): ConversationEvent {
  return {
    type: "entry",
    entry: {
      kind: "tool",
      id: entryId(id),
      parent: parent === null ? null : entryId(parent),
      tool: "Task",
      title: "Task: look",
      input: {},
      status,
      output: undefined,
      spawns: undefined,
      background: undefined,
      outsideSandbox: false,
      plan: undefined,
      denial: undefined,
      change: undefined,
      asked: undefined,
    },
  };
}

function delta(id: string, block: number, text: string): ConversationEvent {
  return { type: "text-delta", entry: entryId(id), block, text };
}

function turnEnd(id: string): ConversationEvent {
  return {
    type: "entry",
    entry: {
      kind: "turn-end",
      id: entryId(id),
      outcome: "completed",
      detail: undefined,
      usage: undefined,
      durationMs: 10,
      limit: undefined,
    },
  };
}

/** One turn of the shapes a stream has: a message, a call with a subagent, deltas, the end. */
function turn(n: number): ConversationEvent[] {
  return [
    user(`u${n}`),
    RUNNING,
    assistant(`a${n}`, true),
    delta(`a${n}`, 0, "think "),
    delta(`a${n}`, 1, "answer "),
    tool(`t${n}`, "running"),
    assistant(`s${n}`, true, `t${n}`),
    delta(`s${n}`, 1, "sub"),
    assistant(`s${n}`, false, `t${n}`),
    tool(`t${n}`, "succeeded"),
    delta(`a${n}`, 1, "more"),
    assistant(`a${n}`, false),
    turnEnd(`e${n}`),
    READY,
  ];
}

const STREAM: ConversationEvent[] = [
  REWINDABLE,
  READY,
  ...turn(1),
  ...turn(2),
  ...turn(3),
  RUNNING,
  { type: "rewound", from: entryId("u3") },
  READY,
  ...turn(4),
  user("u5"),
  RUNNING,
  assistant("a5", true),
  delta("a5", 1, "cut off"),
  tool("t5", "running"),
  { type: "restarted" },
  READY,
  ...turn(6),
  { type: "session-switched", session: "other" },
  ...turn(7),
];

describe("a TranscriptFold", () => {
  it("folds a stream to what applyEvent folds it to, at every step", () => {
    const fold = new TranscriptFold();
    let pure: Transcript = EMPTY_TRANSCRIPT;
    for (const event of STREAM) {
      pure = applyEvent(pure, event);
      fold.apply(event);
      expect(fold.current).toEqual(pure);
    }
    expect(fold.snapshot().entries.map((each) => each.id)).toEqual([
      "u7",
      "a7",
      "t7",
      "s7",
      "e7",
    ]);
  });

  it("gives snapshots that later events never change, and the same snapshot until an event", () => {
    const fold = new TranscriptFold();
    const kept: [Transcript, string][] = [];
    for (const event of STREAM) {
      fold.apply(event);
      const snapshot = fold.snapshot();
      expect(fold.snapshot()).toBe(snapshot);
      kept.push([snapshot, JSON.stringify(snapshot)]);
    }
    for (const [snapshot, json] of kept)
      expect(JSON.stringify(snapshot)).toBe(json);
  });

  it("never changes the transcript it started from", () => {
    const fold = new TranscriptFold();
    for (const event of STREAM.slice(0, 20)) fold.apply(event);
    const start = fold.snapshot();
    const json = JSON.stringify(start);
    const other = new TranscriptFold(start);
    for (const event of STREAM.slice(20)) other.apply(event);
    expect(JSON.stringify(start)).toBe(json);
  });

  it("is left as it was by an event that does not fold", () => {
    const fold = new TranscriptFold();
    for (const event of turn(1)) fold.apply(event);
    const before = JSON.stringify(fold.current);
    const refusals: ConversationEvent[] = [
      delta("a1", 1, "late"),
      delta("nope", 0, "x"),
      tool("u1", "running"),
      assistant("child", false, "a1"),
      { type: "rewound", from: entryId("a1") },
      { type: "request-closed", request: "r" as never },
    ];
    for (const event of refusals) {
      expect(() => fold.apply(event)).toThrow(TranscriptInvariantError);
      expect(JSON.stringify(fold.current)).toBe(before);
    }
    fold.apply(user("u2"));
    expect(fold.entry(entryId("u2"))?.kind).toBe("user");
    expect(fold.entry(entryId("nope"))).toBeUndefined();
  });

  it("finds an entry again after a rewind took it back and it came again", () => {
    const fold = new TranscriptFold();
    for (const event of [REWINDABLE, READY, ...turn(1), ...turn(2)])
      fold.apply(event);
    fold.apply({ type: "rewound", from: entryId("u2") });
    expect(fold.entry(entryId("a2"))).toBeUndefined();
    for (const event of turn(2)) fold.apply(event);
    expect(fold.current.entries.map((each) => each.id)).toEqual([
      "u1",
      "a1",
      "t1",
      "s1",
      "e1",
      "u2",
      "a2",
      "t2",
      "s2",
      "e2",
    ]);
  });
});

/**
 * The reason it exists: with `applyEvent` a delta into a conversation of
 * n entries cost a copy and a scan of n, so a long transcript made every
 * event slower. Here the cost of an event at 200 000 entries is measured
 * against the cost at 2 000; a fold that copied or scanned would be ~100
 * times slower at the larger size.
 */
describe("a TranscriptFold's cost per event", () => {
  /** A fold with `turns` finished turns (five entries each), and one streaming message. */
  function long(turns: number): TranscriptFold {
    const fold = new TranscriptFold();
    fold.apply(READY);
    for (let n = 0; n < turns; n += 1) {
      fold.apply(user(`u${n}`));
      fold.apply(assistant(`a${n}`, false));
      fold.apply(tool(`t${n}`, "succeeded"));
      fold.apply(assistant(`s${n}`, false, `t${n}`));
      fold.apply(turnEnd(`e${n}`));
    }
    fold.apply(user("live-user"));
    fold.apply(RUNNING);
    fold.apply(assistant("live", true));
    return fold;
  }

  /** The best of a few rounds of `events` events, in ms per event. */
  function perEvent(fold: TranscriptFold, events: number): number {
    let best = Number.POSITIVE_INFINITY;
    for (let round = 0; round < 5; round += 1) {
      const started = performance.now();
      for (let n = 0; n < events; n += 1) {
        fold.apply(delta("live", 1, "x"));
        // A tool updated in place far from the end, as a subagent's is.
        fold.apply(tool("t1", "succeeded"));
      }
      best = Math.min(best, (performance.now() - started) / events);
    }
    return best;
  }

  it("does not grow with the transcript", () => {
    const small = long(400);
    const large = long(40_000);
    expect(large.current.entries.length).toBe(200_002);
    perEvent(small, 200);
    const atSmall = perEvent(small, 2_000);
    const atLarge = perEvent(large, 2_000);
    // Equal in principle; the margin is for the garbage collector and a
    // busy machine, and still far below the factor of 100 a copy would cost.
    expect(atLarge).toBeLessThan(Math.max(atSmall * 10, 0.01));
  });

  it("copies the entries once per snapshot, not once per event", () => {
    const fold = long(40_000);
    const started = performance.now();
    for (let frame = 0; frame < 20; frame += 1) {
      for (let n = 0; n < 500; n += 1) fold.apply(delta("live", 1, "x"));
      fold.snapshot();
    }
    // 10 000 events with 20 copies of 200 000 entries; a copy per event would
    // be 2 * 10^9 element copies, minutes rather than milliseconds.
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
