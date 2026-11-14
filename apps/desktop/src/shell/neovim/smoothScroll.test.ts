import { describe, expect, it } from "vitest";
import { landMaxMs } from "../landing";
import {
  restLines,
  EASE_MS,
  GLIDE_MS,
  LAND_GAP_MS,
  WHEEL_IDLE_MS,
  replied,
  coverage,
  isActive,
  newScrollView,
  shifted,
  step,
  wheeled,
} from "./smoothScroll";

const CH = 20;
const ROWS = 40;
const TEXT = ROWS * CH;

describe("pixel scrolling", () => {
  it("asks Neovim for a line ahead before the display can move", () => {
    const view = newScrollView();
    wheeled(view, 5, 0);
    const request = step(view, 1, CH, ROWS, 2);
    expect(request?.rows).toBe(2);
    // Nothing below the grid yet: the display waits for Neovim.
    expect(view.off).toBe(0);
    shifted(view, 2, CH, TEXT, 20);
    // The old view is the ghost; the display is where the wheel put it.
    expect(view.ghost).toBe(-40);
    step(view, 21, CH, ROWS, 2);
    expect(view.off).toBe(-35);
    expect(coverage(view)).toEqual({ lo: -40, hi: 0 });
  });

  it("follows the wheel pixel for pixel within what is drawn", () => {
    const view = newScrollView();
    wheeled(view, 5, 0);
    step(view, 0, CH, ROWS, 2);
    shifted(view, 2, CH, TEXT, 10);
    wheeled(view, 3, 16);
    step(view, 16, CH, ROWS, 2);
    expect(view.off).toBe(-32);
    wheeled(view, 3.3, 32);
    step(view, 32, CH, ROWS, 2);
    // Snapped to device pixels (dpr 2).
    expect(view.off).toBe(-28.5);
  });

  it("keeps how far the display went each way, from Neovim's view", () => {
    const view = newScrollView();
    wheeled(view, 5, 0);
    step(view, 0, CH, ROWS, 2);
    shifted(view, 2, CH, TEXT, 10);
    wheeled(view, 30, 16);
    step(view, 16, CH, ROWS, 2);
    // 35px down from where Neovim was: 5px short of its new topline.
    expect(view.reach).toEqual({ lo: -40, hi: -5 });
    wheeled(view, -20, 32);
    step(view, 32, CH, ROWS, 2);
    expect(view.reach).toEqual({ lo: -40, hi: -5 });
    // A new gesture starts from where the display is.
    wheeled(view, 1, 32 + WHEEL_IDLE_MS + 1);
    expect(view.reach).toEqual({ lo: view.off, hi: view.off });
  });

  it("brings Neovim to the next whole line the wheel was going at rest, and lands the display on it", () => {
    const view = newScrollView();
    wheeled(view, 5, 0);
    step(view, 0, CH, ROWS, 2);
    shifted(view, 2, CH, TEXT, 10);
    wheeled(view, 3, 16);
    step(view, 16, CH, ROWS, 2);
    expect(view.off).toBe(-32);
    const rest = 16 + WHEEL_IDLE_MS + 1;
    // 32 px short of the line Neovim is on, going down: Neovim one line
    // back (not two, to the nearest: the display would then go back 8 px
    // against the wheel), and the display on, 12 px, onto it: under way
    // in the frame it is asked in.
    const back = step(view, rest, CH, ROWS, 2);
    expect(back).toEqual({ rows: -1, exact: true, toward: 1 });
    shifted(view, -1, CH, TEXT, rest + 10);
    expect(view.off).toBeGreaterThan(-12);
    expect(view.off).toBeLessThan(0);
    step(view, rest + 11, CH, ROWS, 2);
    expect(view.off).toBeGreaterThan(-12);
    step(view, rest + 11 + landMaxMs(12), CH, ROWS, 2);
    expect(view.off).toBe(0);
    expect(isActive(view)).toBe(false);
  });

  it("eases a key's scroll from the old view without asking anything", () => {
    const view = newScrollView();
    shifted(view, 10, CH, TEXT, 1000);
    expect(view.off).toBe(-200);
    const request = step(view, 1000, CH, ROWS, 2);
    expect(request).toBeUndefined();
    // Already under way on the first frame.
    expect(view.off).toBeGreaterThan(-200);
    step(view, 1000 + EASE_MS, CH, ROWS, 2);
    expect(view.off).toBe(0);
    expect(view.ghost).toBeUndefined();
  });

  it("jumps when Neovim scrolls a whole window or more", () => {
    const view = newScrollView();
    shifted(view, ROWS, CH, TEXT, 0);
    expect(view.off).toBe(0);
    expect(view.ghost).toBeUndefined();
  });

  it("stops at the end of the buffer and turns back at once", () => {
    const view = newScrollView();
    wheeled(view, 30, 0);
    step(view, 0, CH, ROWS, 2);
    replied(view, 0, 0);
    expect(view.stuck).toBe(1);
    expect(view.want).toBe(0);
    wheeled(view, 10, 16);
    expect(step(view, 16, CH, ROWS, 2)).toBeUndefined();
    expect(view.off).toBe(0);
    wheeled(view, -10, 32);
    // As far ahead as the wheel goes in two round trips and a frame
    // (10px a frame, 30ms each way): 58px, and the 10px it asks for.
    expect(step(view, 32, CH, ROWS, 2)?.rows).toBe(-4);
  });

  it("waits for Neovim's answer however long it takes, then for its scroll", () => {
    const view = newScrollView();
    wheeled(view, 5, 0);
    expect(step(view, 0, CH, ROWS, 2)).toBeDefined();
    // A busy Neovim: no second request while the first is unanswered.
    wheeled(view, 5, 90);
    expect(step(view, 400, CH, ROWS, 2)).toBeUndefined();
    // Its own wheel was sent (not Normal mode) and nothing scrolled.
    replied(view, 2, 400);
    wheeled(view, 5, 410);
    expect(step(view, 410, CH, ROWS, 2)).toBeUndefined();
    wheeled(view, 5, 470);
    expect(step(view, 470, CH, ROWS, 2)).toBeDefined();
  });

  it("asks for as much as a flick needs, less than a window at a time", () => {
    const view = newScrollView();
    wheeled(view, 2000, 0);
    expect(step(view, 0, CH, ROWS, 2)?.rows).toBe(ROWS - 2);
  });
});

/**
 * A Neovim that answers every request in the next frame: the wheel events
 * `[dy, at ms]` given in, frames run until the display rests. Answers the
 * rows Neovim scrolled in all and the display's offset frame by frame
 * (from where it started: up positive, as the text moves).
 */
function run(
  events: readonly (readonly [number, number])[],
  glide = true,
): { rows: number; seen: number[]; rest: number } {
  const view = newScrollView();
  let rows = 0;
  let asked: number | undefined;
  const seen: number[] = [];
  const queue = [...events];
  for (let now = 0; now < 2000; now += 8) {
    while (queue.length > 0 && queue[0][1] <= now) {
      const [dy, at] = queue.shift()!;
      wheeled(view, dy, at, CH, glide);
    }
    if (asked !== undefined) {
      replied(view, 1, now);
      shifted(view, asked, CH, TEXT, now);
      rows += asked;
      asked = undefined;
    }
    const request = step(view, now, CH, ROWS, 2);
    if (request) asked = request.rows;
    seen.push(rows * CH + view.off);
    if (queue.length === 0 && asked === undefined && !isActive(view))
      return { rows, seen, rest: now };
  }
  return { rows, seen, rest: Infinity };
}

describe("a wheel tick", () => {
  it("of a few pixels moves a whole line, gliding there", () => {
    const { rows, seen, rest } = run([[4, 0]]);
    expect(rows).toBe(1);
    expect(seen.at(-1)).toBe(CH);
    // Never back, never past the line: one motion, decelerating.
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
      expect(seen[i]).toBeLessThanOrEqual(CH);
    }
    // Most of the way within the first frames, there by the glide's end.
    const at = (ms: number) => seen[Math.round(ms / 8)] ?? seen.at(-1);
    expect(at(48)).toBeGreaterThan(CH * 0.6);
    expect(at(GLIDE_MS + 16)).toBe(CH);
    expect(rest).toBeLessThanOrEqual(GLIDE_MS + 2 * 16);
  });

  it("of many pixels lands on the nearest whole line, never back", () => {
    // A Linux notch: 120 px, 6 lines at 20 px.
    const { rows, seen } = run([[120, 0]]);
    expect(rows).toBe(6);
    expect(seen.at(-1)).toBe(6 * CH);
    for (let i = 1; i < seen.length; i += 1)
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    const { rows: more } = run([[115, 0]]);
    expect(more).toBe(6);
  });

  it("does not jump ahead while Neovim draws the rows it goes to", () => {
    const { seen } = run([[4, 0]]);
    const first = seen.find((v) => v > 0)!;
    // Its first frame is the curve's first step, not where it would be by
    // the time the rows came.
    expect(first).toBeLessThan(CH * 0.5);
  });

  it("never shows past what is drawn when Neovim scrolls mid-glide", () => {
    // Ticks and swipes either way, Neovim answering each request 8 to 48 ms
    // later: glides are cut by scrolls. A glide's start moves with the
    // scroll, and the curve from there passed through rows that neither
    // the canvas nor the ghost has (a band of background at the top of the
    // window, in the stability suite's motion checks).
    let seed = 1;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let trial = 0; trial < 200; trial += 1) {
      const view = newScrollView();
      const scrolls: { at: number; rows: number }[] = [];
      for (let now = 0; now < 480; now += 8) {
        if (random() < 0.3) {
          const dy = (random() < 0.5 ? -1 : 1) * (random() < 0.5 ? 4 : 40);
          wheeled(view, dy, now, CH);
        }
        while (scrolls.length > 0 && scrolls[0]!.at <= now) {
          replied(view, 1, now);
          shifted(view, scrolls.shift()!.rows, CH, TEXT, now);
        }
        const ask = step(view, now, CH, ROWS, 2);
        if (ask)
          scrolls.push({
            at: now + 8 + Math.floor(random() * 40),
            rows: ask.rows,
          });
        const { lo, hi } = coverage(view);
        expect(view.off).toBeGreaterThanOrEqual(lo);
        expect(view.off).toBeLessThanOrEqual(hi);
      }
    }
  });

  it("at the end of the buffer comes to rest", () => {
    const view = newScrollView();
    wheeled(view, 4, 0, CH);
    step(view, 0, CH, ROWS, 2);
    replied(view, 0, 8);
    let now = 8;
    while (isActive(view) && now < 1000) {
      now += 8;
      step(view, now, CH, ROWS, 2);
    }
    expect(isActive(view)).toBe(false);
    expect(view.off).toBe(0);
  });

  it("up as down", () => {
    expect(run([[-4, 0]]).rows).toBe(-1);
  });

  it("each tick of a slowly turned wheel is a line", () => {
    const { rows, seen } = run([
      [4, 0],
      [4, 80],
      [4, 160],
    ]);
    expect(rows).toBe(3);
    expect(seen.at(-1)).toBe(3 * CH);
  });

  it("a swipe follows its pixels: the first line ahead, then by the pixel", () => {
    // 1.5 px a frame for 50 frames: 75 px, 3.75 lines; at rest the nearest
    // line, 4.
    const events = Array.from({ length: 50 }, (_, i) => [1.5, i * 8] as const);
    const { rows, seen } = run(events);
    expect(rows).toBe(4);
    expect(seen.at(-1)).toBe(4 * CH);
  });

  it("with Reduce Motion it lands on its line at once", () => {
    const { rows, seen } = run([[4, 0]], false);
    expect(rows).toBe(1);
    expect(seen.find((v) => v > 0)).toBe(CH);
  });

  it("settles the way the display was going, never back", () => {
    expect(restLines(7, 15, 1)).toBe(1);
    expect(restLines(-7, 15, -1)).toBe(-1);
    expect(restLines(-32, 20, 1)).toBe(-1);
    expect(restLines(32, 20, -1)).toBe(1);
    expect(restLines(0.4, 15, 1)).toBe(0);
    expect(restLines(9, 15, 0)).toBe(1);
  });
});

/**
 * A Neovim over a buffer whose lines take `heights` rows each (a wrapped
 * line more than one; past them, one each) and whose view can go from row 0
 * to row `last`, answering each request `rtt` ms later as `SCROLL_LUA`
 * does: by whole lines, at least the rows asked; an exact request no
 * further than asked unless that would go back against `toward`. Frames
 * every 16 ms; the display's place (rows scrolled and its offset, down
 * positive) frame by frame.
 */
function glide(
  events: readonly (readonly [number, number])[],
  options: { heights?: readonly number[]; last?: number; rtt?: number } = {},
) {
  const { heights = [], last = 100_000, rtt = 30 } = options;
  const view = newScrollView();
  const height = (line: number) => heights[line] ?? 1;
  // Topline as a line, and as rows from the top.
  let line = 0;
  let top = 0;
  // The rows Neovim's scrolls have shown so far.
  let shown = 0;
  let answer: { at: number; rows: number; code: number } | undefined;
  const seen: { t: number; at: number }[] = [];
  const queue = [...events];
  const scroll = (n: number, exact: boolean, toward: number) => {
    let done = 0;
    while (done < Math.abs(n)) {
      const d = n > 0 ? height(line) : line > 0 ? height(line - 1) : 0;
      if (d === 0 || (n > 0 && top + d > last)) break;
      if (exact && done + d > Math.abs(n) && n > 0 !== toward > 0) break;
      line += Math.sign(n);
      top += Math.sign(n) * d;
      done += d;
    }
    return Math.sign(n) * done;
  };
  let inputEnd = 0;
  for (let now = 0; now < 4000; now += 16) {
    while (queue.length > 0 && queue[0]![1] <= now) {
      const [dy, at] = queue.shift()!;
      wheeled(view, dy, at, CH);
      inputEnd = at;
    }
    if (answer && answer.at <= now) {
      replied(view, answer.code, now);
      if (answer.rows !== 0) shifted(view, answer.rows, CH, TEXT, now);
      shown += answer.rows;
      answer = undefined;
    }
    const request = step(view, now, CH, ROWS, 2);
    if (request) {
      const rows = scroll(request.rows, request.exact, request.toward ?? 0);
      answer = { at: now + rtt, rows, code: rows !== 0 ? 1 : 0 };
    }
    seen.push({ t: now, at: shown * CH + view.off });
    if (queue.length === 0 && !answer && !isActive(view))
      return { seen, top, rest: now, inputEnd, view };
  }
  return { seen, top, rest: Infinity, inputEnd, view };
}

/** A trackpad's flick: `first` px a frame, its momentum decaying by `decay` a frame. */
function flick(first: number, decay = 0.92, from = 0) {
  const events: [number, number][] = [];
  for (let d = first, at = from; Math.abs(d) >= 0.25; d *= decay, at += 16)
    events.push([d, at]);
  return events;
}

/** What the motion does after its input ended: steps (px a frame), the largest change of step, a stop followed by a move. */
function ending(seen: readonly { t: number; at: number }[], inputEnd: number) {
  const steps = seen.slice(1).map((s, i) => ({
    t: s.t,
    d: s.at - seen[i]!.at,
  }));
  // From where the input ended, or its last fast frame (a frame takes in
  // as many events as came: a swipe's steps are as uneven as they are).
  const ended = steps.findIndex((s) => s.t > inputEnd);
  let slow = 0;
  steps.forEach((s, i) => {
    if (Math.abs(s.d) >= 6) slow = i + 1;
  });
  const end = Math.min(ended < 0 ? steps.length : ended, slow);
  let jump = 0;
  let restarted = false;
  let stopped = false;
  for (let i = Math.max(1, end); i < steps.length; i += 1) {
    jump = Math.max(jump, Math.abs(steps[i]!.d) - Math.abs(steps[i - 1]!.d));
    if (stopped && Math.abs(steps[i]!.d) > 0.5) restarted = true;
    if (Math.abs(steps[i]!.d) === 0 && Math.abs(steps[i - 1]!.d) === 0)
      stopped = true;
  }
  return { steps, jump, restarted };
}

function monotonic(seen: readonly { at: number }[], dir: number): boolean {
  return seen.every((s, i) => i === 0 || dir * (s.at - seen[i - 1]!.at) >= 0);
}

describe("a gesture's landing", () => {
  it("lands a flick on a row in its own deceleration, Neovim there", () => {
    const { seen, top, rest, inputEnd, view } = glide(flick(37));
    const end = seen.at(-1)!.at;
    expect(rest).toBeLessThan(Infinity);
    expect(end % CH).toBe(0);
    expect(top * CH).toBe(end);
    expect(view.off).toBe(0);
    expect(monotonic(seen, 1)).toBe(true);
    // Never past where it ends.
    expect(Math.max(...seen.map((s) => s.at))).toBe(end);
    const { jump, restarted } = ending(seen, inputEnd);
    // No stop and second move, no step bigger than the one before by more
    // than a pixel (the old settle: a stop of 110 ms and more, then a step
    // several times the last).
    expect(restarted).toBe(false);
    expect(jump).toBeLessThanOrEqual(1);
  });

  it("never goes back when its request is answered after the wheel took over", () => {
    // A pause of a little over 40 ms lands, and asks Neovim back to the
    // row; the wheel turns on before the answer, a tick gliding ahead.
    // Neovim then comes back behind the display: the display waits there
    // for the rows, it does not go back.
    const view = newScrollView();
    let shown = 0;
    let at = 0;
    const seen: number[] = [];
    const frame = (now: number) => {
      const ask = step(view, now, CH, ROWS, 2);
      seen.push(shown * CH + view.off);
      return ask;
    };
    wheeled(view, 30, 0, CH);
    frame(0);
    replied(view, 1, 10);
    shifted(view, 8, CH, TEXT, 10);
    shown += 8;
    for (at = 16; at <= 96; at += 16) {
      wheeled(view, 20, at, CH);
      const ask = frame(at);
      if (ask) {
        replied(view, 1, at + 4);
        shifted(view, ask.rows, CH, TEXT, at + 4);
        shown += ask.rows;
      }
    }
    // The pause: a landing asks Neovim back.
    let back: ReturnType<typeof step>;
    for (at = 112; at <= 400 && !back?.exact; at += 16) {
      back = frame(at);
      if (back && !back.exact) {
        replied(view, 1, at + 4);
        shifted(view, back.rows, CH, TEXT, at + 4);
        shown += back.rows;
      }
    }
    expect(back?.exact).toBe(true);
    expect(back!.rows).toBeLessThan(0);
    // The wheel again, a tick, before the answer.
    wheeled(view, 50, at, CH);
    frame(at);
    frame(at + 16);
    frame(at + 32);
    replied(view, 1, at + 40);
    shifted(view, back!.rows, CH, TEXT, at + 40);
    shown += back!.rows;
    at += 32;
    for (let now = at + 16; now < at + 400; now += 16) {
      const ask = frame(now);
      if (ask) {
        replied(view, 1, now + 4);
        shifted(view, ask.rows, CH, TEXT, now + 4);
        shown += ask.rows;
      }
    }
    expect(
      monotonic(
        seen.map((v) => ({ at: v })),
        1,
      ),
    ).toBe(true);
  });

  it("takes a momentum's late small events as the momentum, not a tick", () => {
    // A busy page: the tail's events 80 ms apart. Each would be a tick and
    // a line's glide; while the momentum lands they go on landing it.
    const events = flick(37).map(([d, at], i): [number, number] => [
      d,
      i > 30 ? at + (i - 30) * 64 : at,
    ]);
    const { seen, top, inputEnd } = glide(events);
    expect(top * CH).toBe(seen.at(-1)!.at);
    expect(monotonic(seen, 1)).toBe(true);
    const { restarted, jump } = ending(seen, inputEnd);
    expect(restarted).toBe(false);
    expect(jump).toBeLessThanOrEqual(1);
  });

  it("takes the last of a momentum it landed past without moving again", () => {
    // Landed a few pixels past where the wheel is (the momentum died a
    // little faster than it seemed to): its last events are what it
    // already went, not a start of their own onto the next row.
    const view = newScrollView();
    view.dir = 1;
    view.wheelAt = 0;
    view.speed = 0.05;
    view.peak = { speed: 2, at: -500 };
    view.landed = true;
    view.settled = true;
    view.credit = 0.6;
    for (const at of [16, 32]) {
      wheeled(view, 0.28, at, CH);
      expect(step(view, at, CH, ROWS, 2)).toBeUndefined();
      expect(view.off).toBe(0);
    }
    expect(view.land).toBeUndefined();
  });

  it("goes up as down", () => {
    const { seen, top, inputEnd } = glide(flick(-30));
    const end = seen.at(-1)!.at;
    expect(end % CH).toBe(0);
    expect(top * CH).toBe(end);
    expect(monotonic(seen, -1)).toBe(true);
    const { jump, restarted } = ending(seen, inputEnd);
    expect(restarted).toBe(false);
    expect(jump).toBeLessThanOrEqual(1);
  });

  it("over a slow link too, waiting at what is drawn", () => {
    // Neovim 180 ms away: the display waits for rows now and then, as it
    // does while following the wheel, and lands on Neovim's row.
    const { seen, top } = glide(flick(37), { rtt: 180 });
    expect(top * CH).toBe(seen.at(-1)!.at);
    expect(seen.at(-1)!.at % CH).toBe(0);
    expect(monotonic(seen, 1)).toBe(true);
  });

  it("over wrapped lines lands on a line's start, still in one motion", () => {
    // Lines of one, two and three rows: Neovim rests only at their starts.
    const heights = Array.from({ length: 400 }, (_, i) =>
      i % 5 === 0 ? 3 : i % 3 === 0 ? 2 : 1,
    );
    const starts = new Set<number>();
    for (let i = 0, r = 0; i < heights.length; r += heights[i]!, i += 1)
      starts.add(r);
    for (const first of [37, 29, 23]) {
      const { seen, top, inputEnd } = glide(flick(first), { heights });
      const end = seen.at(-1)!.at;
      expect(starts.has(end / CH)).toBe(true);
      expect(top * CH).toBe(end);
      expect(monotonic(seen, 1)).toBe(true);
      const { restarted, jump } = ending(seen, inputEnd);
      expect(restarted).toBe(false);
      expect(jump).toBeLessThanOrEqual(2);
    }
  });

  it("into the end of the buffer lands where it ends, no further and no bounce", () => {
    const { seen, top, inputEnd } = glide(flick(37), { last: 12 });
    const end = seen.at(-1)!.at;
    expect(top).toBe(12);
    expect(end).toBe(12 * CH);
    expect(monotonic(seen, 1)).toBe(true);
    expect(Math.max(...seen.map((s) => s.at))).toBe(end);
    expect(ending(seen, inputEnd).restarted).toBe(false);
  });

  it("into the top of the buffer the same", () => {
    const { seen, top } = glide(flick(-37));
    expect(top).toBe(0);
    expect(seen.at(-1)!.at).toBe(0);
    expect(monotonic(seen, -1)).toBe(true);
    expect(Math.min(...seen.map((s) => s.at))).toBe(0);
  });

  it("of a burst that stops at once eases onto the next row, not back", () => {
    const events = Array.from({ length: 10 }, (_, i) => [13, i * 16] as const);
    const { seen, top, rest, inputEnd } = glide(events);
    const end = seen.at(-1)!.at;
    expect(end).toBe(7 * CH);
    expect(top * CH).toBe(end);
    expect(monotonic(seen, 1)).toBe(true);
    expect(ending(seen, inputEnd).restarted).toBe(false);
    expect(rest - inputEnd).toBeLessThan(LAND_GAP_MS + landMaxMs(CH) + 100);
  });

  it("gives way to the wheel mid-landing, from where the display is", () => {
    // A flick, and before it has landed a second one the same way, then
    // a turn back.
    const second = flick(37, 0.92, 520);
    const { seen, top } = glide([...flick(37), ...second]);
    const firstEnd = second[0]![1];
    const until = seen.filter((s) => s.t <= firstEnd + 400);
    expect(monotonic(until, 1)).toBe(true);
    expect(top * CH).toBe(seen.at(-1)!.at);
    const back = glide([...flick(37), [-4, 700]]);
    expect(back.top * CH).toBe(back.seen.at(-1)!.at);
    expect(back.seen.at(-1)!.at % CH).toBe(0);
  });

  it("leaves a notch's glide alone: one line, nothing more asked", () => {
    const { seen, top } = glide([[4, 0]]);
    expect(top).toBe(1);
    expect(seen.at(-1)!.at).toBe(CH);
  });
});
