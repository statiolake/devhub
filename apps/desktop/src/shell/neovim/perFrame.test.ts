import { describe, expect, it } from "vitest";
import { PerFrame } from "./perFrame";

/** A frame clock the test turns. */
function frames() {
  let queued: (() => void)[] = [];
  return {
    schedule: (fn: () => void) => {
      queued.push(fn);
    },
    frame: () => {
      const run = queued;
      queued = [];
      for (const fn of run) fn();
    },
    get waiting() {
      return queued.length;
    },
  };
}

describe("the pointer's moves, one a frame", () => {
  it("sends a frame's first move at once", () => {
    const clock = frames();
    const sent: number[] = [];
    const moves = new PerFrame<number>((v) => sent.push(v), clock.schedule);
    moves.push(1);
    expect(sent).toEqual([1]);
  });

  it("sends only the newest of the rest, the next frame", () => {
    const clock = frames();
    const sent: number[] = [];
    const moves = new PerFrame<number>((v) => sent.push(v), clock.schedule);
    moves.push(1);
    moves.push(2);
    moves.push(3);
    moves.push(4);
    expect(sent).toEqual([1]);
    clock.frame();
    expect(sent).toEqual([1, 4]);
    // A frame with no move ends the run: the next move goes at once.
    clock.frame();
    expect(clock.waiting).toBe(0);
    moves.push(5);
    expect(sent).toEqual([1, 4, 5]);
  });

  it("sends a waiting move before the release, and not again", () => {
    const clock = frames();
    const sent: number[] = [];
    const moves = new PerFrame<number>((v) => sent.push(v), clock.schedule);
    moves.push(1);
    moves.push(2);
    moves.flush();
    expect(sent).toEqual([1, 2]);
    clock.frame();
    expect(sent).toEqual([1, 2]);
  });
});
