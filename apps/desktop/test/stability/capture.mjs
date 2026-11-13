// One recorded action, on one or more pages at once: throttle each page,
// start its recorder and its screencast, act, wait until no page has changed
// for a while, and hand back each page's frames and pictures.
import { readFileSync } from "node:fs";

const recorderSource = readFileSync(
  new URL("./recorder.js", import.meta.url),
  "utf8",
)
  .trim()
  .replace(/;$/, "");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function begin(client, watch, rate, screencast) {
  const shots = [];
  let off = () => {};
  await client.send("Emulation.setCPUThrottlingRate", { rate });
  // The recorder first: its first frames hold the loops (a spinner, a
  // caret's blink), so no picture of the screencast catches them turning.
  await client.eval(`(${recorderSource})(${JSON.stringify(watch)})`);
  await sleep(100);
  if (screencast) {
    off = client.on("Page.screencastFrame", (params) => {
      shots.push({
        t: params.metadata.timestamp * 1000,
        png: Buffer.from(params.data, "base64"),
      });
      client
        .send("Page.screencastFrameAck", { sessionId: params.sessionId })
        .catch(() => {});
    });
    await client.send("Page.startScreencast", {
      format: "png",
      everyNthFrame: 1,
    });
  }
  return { client, shots, off, screencast };
}

async function idleFor(client) {
  return client.eval(
    "(() => { const f = window.__stability; return f ? performance.timeOrigin + performance.now() - f.lastT() : 0; })()",
  );
}

/**
 * `sessions`: [{ client, watch }] — watch is { roles, motionMarkers }.
 * `act`: async () => void. Options: rate (CPU throttling), quietMs (how long
 * nothing may change before the pages count as settled, at 1x; longer under
 * throttling), waitFor (a page expression that must hold, on the first
 * session's page, before settling is looked for), timeoutMs.
 */
export async function capture(
  sessions,
  act,
  {
    rate = 1,
    quietMs = 600,
    waitFor,
    timeoutMs = 20_000,
    screencast = true,
  } = {},
) {
  const live = [];
  try {
    for (const { client, watch } of sessions)
      live.push(await begin(client, watch, rate, screencast));
    // The pages at rest before the action: the recorders' first frames, and
    // the loops held.
    await sleep(250 + 50 * rate);
    const actionAt = await live[0].client.eval(
      "performance.timeOrigin + performance.now()",
    );
    await act();
    const quiet = quietMs * Math.max(1, rate / 2);
    const deadline = Date.now() + timeoutMs;
    let settled = false;
    let waited = waitFor === undefined;
    while (Date.now() < deadline) {
      await sleep(100);
      if (!waited) {
        waited = Boolean(await live[0].client.eval(waitFor));
        continue;
      }
      const idle = await Promise.all(live.map((s) => idleFor(s.client)));
      if (idle.every((ms) => ms >= quiet)) {
        settled = true;
        break;
      }
    }
    const out = [];
    for (const session of live) {
      const { frames, rafs } = await session.client.eval(
        "window.__stability.take()",
      );
      if (session.screencast) await session.client.send("Page.stopScreencast");
      // Frames from the last one before the action on: that one is "before".
      let first = 0;
      for (let i = 0; i < frames.length; i++)
        if (frames[i].t <= actionAt) first = i;
      const kept = frames.slice(first);
      const from = (kept[0]?.t ?? actionAt) - 20;
      // Screencast frames do not always arrive in the order they were drawn.
      const shots = session.shots
        .filter((shot) => shot.t >= from)
        .sort((a, b) => a.t - b.t);
      out.push({
        frames: kept,
        shots,
        rafs,
        settled: settled && waited,
        actionAt,
      });
    }
    return out;
  } finally {
    for (const session of live) {
      session.off();
      await session.client
        .send("Emulation.setCPUThrottlingRate", { rate: 1 })
        .catch(() => {});
    }
  }
}

// An animated element's picture reaches past its box by its shadow.
const SHADOW = 24;
const overlaps = (a, b) =>
  a[0] - SHADOW < b[0] + b[2] &&
  b[0] < a[0] + a[2] + SHADOW &&
  a[1] - SHADOW < b[1] + b[3] &&
  b[1] < a[1] + a[3] + SHADOW;

/**
 * Whether a declared motion ran in `rect` around time `t` (for the picture
 * check): pane motion anywhere, or a moving element over the region.
 */
export function motionAt(frames, rect) {
  return (t) => {
    let at = -1;
    for (let i = 0; i < frames.length; i++) if (frames[i].t <= t) at = i;
    for (let i = Math.max(0, at - 1); i <= at + 1 && i < frames.length; i++) {
      const frame = frames[i];
      if (frame.motion) return true;
      if ((frame.anim ?? []).some((r) => overlaps(r, rect))) return true;
    }
    return false;
  };
}
