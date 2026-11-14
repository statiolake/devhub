// The invariants of things in motion — a scroll, a stream — checked on every
// frame motionRecorder.js sampled, not only on the first and the settled one
// (invariants.mjs). Pure: samples in, violations out (motionInvariants.test.mjs).
//
//   aligned    what is anchored to text moves with it in the same frame: an
//              anchor's distance from its window's text origin never changes
//              while it is on screen (a hover over its line, a card, a mark)
//   monotonic  a window's text moves one way for one gesture: no frame goes
//              back, none goes past where it ends (no overshoot)
//   rest       the motion ends exactly at Neovim's line: no display offset
//              and no ghost of the old view left
//   covered    every frame, a scrolling window's port is wholly covered by
//              its canvas and the ghost of its last view: no blank band at
//              the seam
//   kept       a scroller's items (a conversation's entries) keep their place
//              in its content once there; only the last may grow

const TOL = 0.5;

function windows(sample) {
  const out = new Map();
  for (const ed of sample.editors ?? []) {
    for (const g of ed.grids)
      out.set(`${ed.key}:${g.grid}`, { ...g, ch: ed.ch });
  }
  return out;
}

/** The window an anchor is over, in this sample: the one whose canvas holds its left edge and top. */
function under(sample, r) {
  for (const [key, g] of windows(sample)) {
    const [x, y, w, h] = g.port ?? g.canvas;
    if (r[0] >= x && r[0] < x + w && r[1] >= y - 1 && r[1] < y + h) return key;
  }
  return undefined;
}

export function checkMotion(samples, spec = {}) {
  const out = [];
  const say = (rule, key, message, at) =>
    out.push({ rule, key, message, frames: at });

  // aligned
  if (spec.aligned !== false) {
    const seen = new Map();
    samples.forEach((s, i) => {
      for (const [key, r] of Object.entries(s.anchors ?? {})) {
        const win = under(s, r);
        if (win === undefined) continue;
        const g = windows(s).get(win);
        const d = r[1] - g.origin;
        const before = seen.get(key);
        if (before === undefined || before.win !== win) {
          seen.set(key, { win, d, i });
          continue;
        }
        if (Math.abs(before.d - d) > TOL && !before.said) {
          before.said = true;
          say(
            "misaligned",
            key,
            `${key} is ${d}px from its text in frame ${i}, ${before.d}px in frame ${before.i}: it moved apart from what it is anchored to`,
            [before.i, i],
          );
        }
      }
    });
  }

  // monotonic, rest, covered
  const tracks = new Map();
  samples.forEach((s, i) => {
    for (const [key, g] of windows(s)) {
      const list = tracks.get(key) ?? [];
      list.push({ i, g });
      tracks.set(key, list);
      if (spec.covered !== false && g.port) {
        const [, py, , ph] = g.port;
        const spans = [g.canvas, g.ghost]
          .filter(Boolean)
          .map(([, y, , h]) => [Math.max(y, py), Math.min(y + h, py + ph)]);
        spans.sort((a, b) => a[0] - b[0]);
        let reach = py;
        let gap;
        for (const [a, b] of spans) {
          if (a > reach + TOL) {
            gap = [reach, a];
            break;
          }
          reach = Math.max(reach, b);
        }
        if (!gap && reach < py + ph - TOL) gap = [reach, py + ph];
        if (gap) {
          say(
            "uncovered",
            key,
            `${key}: rows ${gap[0]}..${gap[1]} of its port are covered by neither its canvas nor its ghost in frame ${i}`,
            [i],
          );
        }
      }
    }
  });
  for (const [key, list] of tracks) {
    if (list.length < 2) continue;
    const first = list[0].g.origin;
    const last = list[list.length - 1].g;
    if (spec.monotonic !== false) {
      const dir = Math.sign(last.origin - first);
      let prev = first;
      for (const { i, g } of list) {
        const step = g.origin - prev;
        if (dir !== 0 && Math.sign(step) === -dir && Math.abs(step) > TOL) {
          say(
            "reversed",
            key,
            `${key}'s text went back ${Math.abs(step)}px in frame ${i} (moving ${dir < 0 ? "up" : "down"})`,
            [i],
          );
          break;
        }
        if (dir !== 0 && (g.origin - last.origin) * dir > TOL) {
          say(
            "overshoot",
            key,
            `${key}'s text went ${Math.abs(g.origin - last.origin)}px past where it ended, in frame ${i}`,
            [i],
          );
          break;
        }
        prev = g.origin;
      }
    }
    if (spec.rest !== false && (Math.abs(last.off) > TOL || last.ghost)) {
      say(
        "unsettled",
        key,
        `${key} ended ${last.off}px off Neovim's line${last.ghost ? ", its ghost still shown" : ""}`,
        [list[list.length - 1].i],
      );
    }
  }

  // kept
  for (const name of spec.kept ?? []) {
    const firstAt = [];
    samples.forEach((s, i) => {
      const sc = s.scrollers?.[name];
      if (!sc || sc.moving) return;
      sc.items.forEach(([top], k) => {
        const isLast = k === sc.items.length - 1;
        if (firstAt[k] === undefined) firstAt[k] = { top, i };
        else if (
          !isLast &&
          Math.abs(firstAt[k].top - top) > TOL &&
          !firstAt[k].said
        ) {
          firstAt[k].said = true;
          say(
            "pushed",
            `${name}[${k}]`,
            `${name} item ${k} moved in its content from ${firstAt[k].top} (frame ${firstAt[k].i}) to ${top} (frame ${i})`,
            [firstAt[k].i, i],
          );
        }
      });
    });
  }
  return out;
}
