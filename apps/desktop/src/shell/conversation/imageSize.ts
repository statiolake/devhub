/**
 * How big a picture is, read off its first bytes rather than off a decode.
 *
 * An `<img>` has no size until its picture is decoded, so one inserted bare
 * grows into place a frame or more later and pushes everything after it.
 * Every picture DevHub draws from its own bytes (a file an answer embeds, an
 * image a tool returned) has its size in its header: PNG's IHDR, GIF's
 * logical screen, JPEG's start-of-frame, WebP's VP8/VP8L/VP8X chunk, BMP's
 * info header, an SVG's `width`/`height` or `viewBox`. Read here, the room is
 * taken from the first frame (`Picture.tsx`, `docs/motion.md`).
 *
 * Nothing here decodes a picture or trusts a header further than its own
 * bounds: a header that does not parse is `undefined`, and the picture is
 * then drawn in a box of a fixed shape instead.
 */

export interface PictureSize {
  readonly width: number;
  readonly height: number;
}

/** The largest side any header is believed about; a bigger one is a lie. */
const MAX_SIDE = 1 << 16;

function sized(width: number, height: number): PictureSize | undefined {
  return Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0 &&
    width <= MAX_SIDE &&
    height <= MAX_SIDE
    ? { width, height }
    : undefined;
}

const ascii = (bytes: Uint8Array, at: number, text: string): boolean =>
  [...text].every((char, i) => bytes[at + i] === char.charCodeAt(0));

const u16be = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const u16le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u24le = (b: Uint8Array, at: number) =>
  b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
const u32be = (b: Uint8Array, at: number) =>
  ((b[at]! << 24) >>> 0) +
  ((b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!);
const i32le = (b: Uint8Array, at: number) =>
  b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24);

function pngSize(b: Uint8Array): PictureSize | undefined {
  if (b.length < 24 || !ascii(b, 1, "PNG") || !ascii(b, 12, "IHDR")) {
    return undefined;
  }
  return sized(u32be(b, 16), u32be(b, 20));
}

function gifSize(b: Uint8Array): PictureSize | undefined {
  if (b.length < 10 || !ascii(b, 0, "GIF8")) return undefined;
  return sized(u16le(b, 6), u16le(b, 8));
}

/** The first start-of-frame marker's size, walking the segments to it. */
function jpegSize(b: Uint8Array): PictureSize | undefined {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  let at = 2;
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) return undefined;
    const marker = b[at + 1]!;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    // Markers with no length: TEM and the restart markers.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = u16be(b, at + 2);
    const startOfFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (startOfFrame) return sized(u16be(b, at + 7), u16be(b, at + 5));
    if (length < 2) return undefined;
    at += 2 + length;
  }
  return undefined;
}

function webpSize(b: Uint8Array): PictureSize | undefined {
  if (b.length < 30 || !ascii(b, 0, "RIFF") || !ascii(b, 8, "WEBP")) {
    return undefined;
  }
  if (ascii(b, 12, "VP8 ")) {
    return sized(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  }
  if (ascii(b, 12, "VP8L")) {
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (ascii(b, 12, "VP8X")) {
    return sized(u24le(b, 24) + 1, u24le(b, 27) + 1);
  }
  return undefined;
}

function bmpSize(b: Uint8Array): PictureSize | undefined {
  if (b.length < 26 || !ascii(b, 0, "BM")) return undefined;
  return sized(Math.abs(i32le(b, 18)), Math.abs(i32le(b, 22)));
}

/** A picture's size from its bytes, when its header says it. */
export function pictureSizeOfBytes(bytes: Uint8Array): PictureSize | undefined {
  return (
    pngSize(bytes) ??
    gifSize(bytes) ??
    jpegSize(bytes) ??
    webpSize(bytes) ??
    bmpSize(bytes) ??
    svgSize(new TextDecoder("utf-8").decode(bytes.subarray(0, 4096)))
  );
}

/** A length in an SVG's own attribute: a plain number or pixels, nothing else. */
function svgLength(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/u.exec(value);
  return match === null ? undefined : Number(match[1]);
}

/**
 * An SVG's size as an `<img>` draws it: its `width` and `height` when both
 * are lengths, else its `viewBox` at the 300px an `<img>` gives a picture
 * that names only its shape.
 */
export function svgSize(text: string): PictureSize | undefined {
  const tag = /<svg\b[^>]*>/iu.exec(text)?.[0];
  if (tag === undefined) return undefined;
  const attribute = (name: string) =>
    new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "iu").exec(tag)?.[1];
  const width = svgLength(attribute("width"));
  const height = svgLength(attribute("height"));
  if (width !== undefined && height !== undefined) return sized(width, height);
  const box = attribute("viewBox")
    ?.trim()
    .split(/[\s,]+/u)
    .map(Number);
  if (box?.length !== 4) return undefined;
  const [, , boxWidth, boxHeight] = box as [number, number, number, number];
  if (!(boxWidth > 0 && boxHeight > 0)) return undefined;
  if (width !== undefined) return sized(width, (width * boxHeight) / boxWidth);
  if (height !== undefined) {
    return sized((height * boxWidth) / boxHeight, height);
  }
  return sized(300, (300 * boxHeight) / boxWidth);
}

/**
 * The bytes a header can be read from: enough of a `data:` URL's start. A
 * JPEG's frame can follow a large EXIF block, so its whole is read.
 */
function headerBytes(url: string): Uint8Array | undefined {
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || comma < 0) return undefined;
  const meta = url.slice(5, comma);
  const body = url.slice(comma + 1);
  if (!meta.endsWith(";base64")) {
    try {
      return new TextEncoder().encode(decodeURIComponent(body.slice(0, 8192)));
    } catch {
      return undefined;
    }
  }
  const jpeg = meta.startsWith("image/jpeg") || meta.startsWith("image/jpg");
  const take = jpeg ? body : body.slice(0, 64);
  try {
    return Uint8Array.from(
      atob(take.slice(0, take.length - (take.length % 4))),
      (c) => c.charCodeAt(0),
    );
  } catch {
    return undefined;
  }
}

/** A `data:` URL's picture size, when its header says it; any other URL's is not known. */
export function pictureSizeOfUrl(url: string): PictureSize | undefined {
  const bytes = headerBytes(url);
  return bytes === undefined ? undefined : pictureSizeOfBytes(bytes);
}
