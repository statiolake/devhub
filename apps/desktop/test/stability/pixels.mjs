// The composited picture: a page's screencast frames (CDP
// Page.startScreencast, PNG), decoded here and digested per region. An
// element's own geometry cannot show what is drawn *over* or *under* it — a
// window's bare cells showing for a few frames before its view covers them is
// two elements each with one form — so the picture is checked too, by the
// same rule: a region shows at most two pictures for one action.
import { inflateSync } from "node:zlib";

/** Decode an 8-bit, non-interlaced RGB or RGBA PNG (what Chromium sends). */
export function decodePng(buffer) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const colour = data[9];
      if (depth !== 8 || data[12] !== 0 || (colour !== 2 && colour !== 6)) {
        throw new Error(
          `unsupported PNG (depth ${depth}, colour ${colour}, interlace ${data[12]})`,
        );
      }
      channels = colour === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(
      raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)),
    );
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = (line[i] + add) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = line[x * channels];
      out[o + 1] = line[x * channels + 1];
      out[o + 2] = line[x * channels + 2];
      out[o + 3] = channels === 4 ? line[x * channels + 3] : 255;
    }
    prev = line;
  }
  return { width, height, data: out };
}

/** A digest of the pixels of `image` inside `rect` ([x, y, w, h], CSS px = device px at scale 1). */
export function regionDigest(image, rect) {
  const [rx, ry, rw, rh] = rect.map(Math.round);
  const x0 = Math.max(0, rx);
  const y0 = Math.max(0, ry);
  const x1 = Math.min(image.width, rx + rw);
  const y1 = Math.min(image.height, ry + rh);
  let h = 0x811c9dc5;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * image.width + x) * 4;
      h ^= image.data[o] | (image.data[o + 1] << 8) | (image.data[o + 2] << 16);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h.toString(16);
}

/**
 * The pictures each region showed, as runs, over screencast `shots`
 * ({ t, png }), leaving out those taken while a declared motion ran over
 * the region (`motion(rect)(t)`). Returns violations as invariants.mjs words
 * them.
 */
export function checkRegions(shots, regions, motion) {
  const out = [];
  const decoded = shots.map((shot) => ({
    ...shot,
    image: decodePng(shot.png),
  }));
  for (const region of regions) {
    const moving = motion(region.rect);
    const runs = [];
    decoded.forEach((shot, index) => {
      if (!region.still && moving(shot.t)) return;
      const value = regionDigest(shot.image, region.rect);
      const tail = runs[runs.length - 1];
      if (tail && tail.value === value) return;
      runs.push({ value, index });
    });
    // A still region (rows nothing in the step may change: the command
    // line's below a window that scrolls) shows one picture throughout.
    if (region.still && runs.length > 1) {
      out.push({
        rule: "changed",
        key: region.name,
        message: `region ${region.name} @${region.rect.join(",")} should not change in this step and showed ${runs.length} pictures (screencast frames ${runs.map((r) => r.index).join(", ")})`,
        frames: [],
        shots: runs.map((r) => r.index),
      });
      continue;
    }
    if (runs.length > 2) {
      out.push({
        rule: "picture",
        key: region.name,
        message: `region ${region.name} @${region.rect.join(",")} showed ${runs.length} pictures for one action (screencast frames ${runs.map((r) => r.index).join(", ")})`,
        frames: [],
        shots: runs.map((r) => r.index),
      });
    }
  }
  return out;
}

/**
 * A digest of each pixel row of `image` inside `rect` ([x, y, w, h], device
 * px), top to bottom: what the coherence check (`coherent` in run.mjs)
 * compares row by row.
 */
export function rowDigests(image, rect) {
  const [rx, ry, rw, rh] = rect.map(Math.round);
  const x0 = Math.max(0, rx);
  const x1 = Math.min(image.width, rx + rw);
  const out = [];
  for (let y = Math.max(0, ry); y < Math.min(image.height, ry + rh); y++) {
    let h = 0x811c9dc5;
    for (let x = x0; x < x1; x++) {
      const o = (y * image.width + x) * 4;
      h ^= image.data[o] | (image.data[o + 1] << 8) | (image.data[o + 2] << 16);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out.push(h.toString(16));
  }
  return out;
}

// The view-close check (scenariosViewClose.mjs): column bands, and how
// near a channel is to count as the same colour or as another.
const BAND = 16; // device px wide
const NEAR = 10; // a channel this close is the same colour
const FAR = 40; // a channel this far is another colour

const at = (image, x, y) => (y * image.width + x) * 4;
const diff = (a, oa, b, ob) =>
  Math.max(
    Math.abs(a.data[oa] - b.data[ob]),
    Math.abs(a.data[oa + 1] - b.data[ob + 1]),
    Math.abs(a.data[oa + 2] - b.data[ob + 2]),
  );

/**
 * The column bands of `rect` in which `frame` shows the cells: of the
 * pixels where `cells` differs from both `view` and `behind`, at least
 * half as `cells` has them (and at least `min` of them).
 */
export function cellBands(frame, refs, rect, min = 40) {
  const { view, cells, behind } = refs;
  const [rx, ry, rw, rh] = rect;
  const x1 = Math.min(rx + rw, frame.width, cells.width);
  const y1 = Math.min(ry + rh, frame.height, cells.height);
  const out = [];
  for (let bx = Math.max(0, rx); bx < x1; bx += BAND) {
    let own = 0;
    let shown = 0;
    for (let y = Math.max(0, ry); y < y1; y++) {
      for (let x = bx; x < Math.min(bx + BAND, x1); x++) {
        const o = at(cells, x, y);
        if (diff(cells, o, view, o) < FAR || diff(cells, o, behind, o) < FAR)
          continue;
        own += 1;
        if (diff(frame, at(frame, x, y), cells, o) <= NEAR) shown += 1;
      }
    }
    if (own >= min && shown * 2 >= own) out.push({ x: bx, own, shown });
  }
  return out;
}
