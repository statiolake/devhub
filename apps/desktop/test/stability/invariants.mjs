// The stability invariants, over the frames recorder.js kept. Pure: a list of
// frames in, a list of violations out, so it is tested on its own
// (invariants.test.mjs) and a failure can be re-checked from a saved log.
//
// One rule carries most of the weight — **one change, at most two forms**.
// Over a capture (one action), each watched element's form (its box, clip,
// radius, opacity, canvas digest) runs through a sequence of values; equal
// neighbours collapse. Absent counts as a value. A sequence of at most two
// runs is the element before and after the action: it appeared in its settled
// form, left from its form, or changed once. A third run is an intermediate
// form — drawn one way and then another (A B C), or flickering back (A B A):
// precisely "the first visible frame differs from the settled frame".
//
// Frames in declared motion do not count (recorder.js: an element under a
// finite Web Animation, or a frame with pane motion's pictures up). A motion
// is decoration over a layout that is already final (docs/motion.md, rule 5),
// so what is left out is only its own path; where it ends is still checked
// against what was there before.
//
// The other rules a scenario may ask for:
//   single    a role is never visible more than once at a time (doubled)
//   contain   [inner, outer]: in every frame both are visible, inner's box is
//             inside outer's (content uncovered or spilling out)
//   anchored  a role's elements keep their x, y and width, however their
//             height grows (a streamed message: rule 1, nothing pushed)
//   ignore    properties of a role left out of the comparison

export const PROPS = ["r", "clip", "radius", "op", "hash", "bg", "fg"];

const ABSENT = "∅";

function form(entry, props) {
  if (entry === undefined) return ABSENT;
  return JSON.stringify(props.map((p) => entry[p] ?? null));
}

function roleOf(key) {
  return key.slice(0, key.lastIndexOf("#"));
}

function keysOf(frames) {
  const keys = new Set();
  for (const frame of frames)
    for (const key of Object.keys(frame.els)) keys.add(key);
  return [...keys].sort();
}

function describe(entry) {
  if (entry === undefined) return "absent";
  const parts = [`@${entry.r.join(",")}`];
  if (entry.clip) parts.push(`clip=${entry.clip}`);
  if (entry.radius) parts.push(`radius=${entry.radius}`);
  if (entry.op !== undefined && entry.op !== 1)
    parts.push(`opacity=${entry.op}`);
  if (entry.hash) parts.push(`pixels=${entry.hash}`);
  if (entry.bg) parts.push(`bg=${entry.bg}`);
  if (entry.fg) parts.push(`fg=${entry.fg}`);
  return parts.join(" ");
}

/**
 * The violations in `frames` under `spec`:
 *   { ignore: { role: [prop] }, single: [role], contain: [[inner, outer]],
 *     anchored: [role], only: [role] }
 * Each is { rule, key, message, frames: [frame index] }.
 */
export function check(frames, spec = {}) {
  const out = [];
  const ignore = spec.ignore ?? {};
  const only = spec.only ? new Set(spec.only) : undefined;
  const counted = frames
    .map((frame, index) => ({ frame, index }))
    .filter(({ frame }) => !frame.motion);

  for (const key of keysOf(frames)) {
    const role = roleOf(key);
    if (only && !only.has(role)) continue;
    const props = PROPS.filter((p) => !(ignore[role] ?? []).includes(p));
    if (props.length === 0) continue;
    const runs = [];
    for (const { frame, index } of counted) {
      const entry = frame.els[key];
      if (entry?.m) continue;
      const value = form(entry, props);
      const tail = runs[runs.length - 1];
      if (tail && tail.value === value) continue;
      runs.push({ value, index, entry });
    }
    if (runs.length > 2) {
      const flicker = runs.length === 3 && runs[0].value === runs[2].value;
      out.push({
        rule: flicker ? "flicker" : "intermediate",
        key,
        message:
          `${key} took ${runs.length} forms for one action` +
          (flicker ? " (and went back)" : "") +
          ":\n" +
          runs
            .map((run) => `      frame ${run.index}: ${describe(run.entry)}`)
            .join("\n"),
        frames: runs.map((run) => run.index),
      });
    }
  }

  for (const role of spec.single ?? []) {
    for (const { frame, index } of counted) {
      const visible = Object.keys(frame.els).filter((k) => roleOf(k) === role);
      if (visible.length > 1) {
        out.push({
          rule: "doubled",
          key: role,
          message: `${role} was on screen ${visible.length} times at once in frame ${index}`,
          frames: [index],
        });
        break;
      }
    }
  }

  for (const [inner, outer] of spec.contain ?? []) {
    for (const { frame, index } of counted) {
      const a = frame.els[inner];
      const b = frame.els[outer];
      if (a === undefined || b === undefined || a.m || b.m) continue;
      const [ax, ay, aw, ah] = a.r;
      const [bx, by, bw, bh] = b.r;
      if (ax < bx || ay < by || ax + aw > bx + bw || ay + ah > by + bh) {
        out.push({
          rule: "uncovered",
          key: `${inner} in ${outer}`,
          message: `${inner} @${a.r.join(",")} spilled out of ${outer} @${b.r.join(",")} in frame ${index}`,
          frames: [index],
        });
        break;
      }
    }
  }

  for (const role of spec.anchored ?? []) {
    for (const key of keysOf(frames).filter((k) => roleOf(k) === role)) {
      let first;
      for (const { frame, index } of counted) {
        const entry = frame.els[key];
        if (entry === undefined || entry.m) continue;
        const [x, y, w] = entry.r;
        if (first === undefined) {
          first = { x, y, w, index };
        } else if (x !== first.x || y !== first.y || w !== first.w) {
          out.push({
            rule: "pushed",
            key,
            message: `${key} moved from @${first.x},${first.y} w${first.w} (frame ${first.index}) to @${x},${y} w${w} (frame ${index}) without a declared motion`,
            frames: [first.index, index],
          });
          break;
        }
      }
    }
  }
  return out;
}

/** Whether the last `quietMs` of `frames` (by their timestamps) saw no change. */
export function settledFor(frames, now, quietMs) {
  if (frames.length === 0) return true;
  return now - frames[frames.length - 1].t >= quietMs;
}
