// @vitest-environment jsdom

/**
 * A picture takes its room before it is decoded (docs/motion.md, "Reserved
 * space for late content"): its size read off its header, or a box of a
 * fixed shape that its picture can only deepen. jsdom lays nothing out, so
 * this holds what decides the box: the size on the element, or the box's
 * shape, the same before and after the picture arrives.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { pictureSizeOfBytes, pictureSizeOfUrl, svgSize } from "./imageSize";
import { BOX_RATIO, boxRatio, Picture } from "./Picture";

afterEach(cleanup);

const bytes = (...parts: (number | string)[]): Uint8Array =>
  Uint8Array.from(
    parts.flatMap((part) =>
      typeof part === "string"
        ? [...part].map((char) => char.charCodeAt(0))
        : [part],
    ),
  );

const be32 = (n: number) => [
  n >>> 24,
  (n >>> 16) & 255,
  (n >>> 8) & 255,
  n & 255,
];
const le16 = (n: number) => [n & 255, n >>> 8];
const be16 = (n: number) => [n >>> 8, n & 255];

const PNG = bytes(
  137,
  "PNG\r\n",
  26,
  10,
  ...be32(13),
  "IHDR",
  ...be32(640),
  ...be32(480),
  8,
  6,
  0,
  0,
  0,
);
const GIF = bytes("GIF89a", ...le16(32), ...le16(16), 0, 0, 0);
const JPEG = bytes(
  0xff,
  0xd8,
  // An APP0 segment the walk steps over.
  0xff,
  0xe0,
  ...be16(16),
  "JFIF",
  0,
  1,
  1,
  0,
  0,
  1,
  0,
  1,
  0,
  0,
  0xff,
  0xc0,
  ...be16(17),
  8,
  ...be16(300),
  ...be16(1200),
  3,
  0,
  0,
  0,
  0,
  0,
  0,
);
const WEBP_X = bytes(
  "RIFF",
  0,
  0,
  0,
  0,
  "WEBP",
  "VP8X",
  10,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0x1f,
  3,
  0,
  0xdf,
  1,
  0,
);
const BMP = bytes(
  "BM",
  ...new Array(16).fill(0),
  100,
  0,
  0,
  0,
  0x9c,
  0xff,
  0xff,
  0xff,
);

const dataUrl = (type: string, data: Uint8Array) =>
  `data:${type};base64,${btoa(String.fromCharCode(...data))}`;

describe("a picture's size, read off its header", () => {
  it("reads PNG, GIF, JPEG, WebP and BMP headers", () => {
    expect(pictureSizeOfBytes(PNG)).toEqual({ width: 640, height: 480 });
    expect(pictureSizeOfBytes(GIF)).toEqual({ width: 32, height: 16 });
    expect(pictureSizeOfBytes(JPEG)).toEqual({ width: 1200, height: 300 });
    expect(pictureSizeOfBytes(WEBP_X)).toEqual({ width: 800, height: 480 });
    // A bottom-up BMP has a negative height; it is the same size.
    expect(pictureSizeOfBytes(BMP)).toEqual({ width: 100, height: 100 });
  });

  it("reads an SVG's own lengths, else its viewBox at an image's 300px", () => {
    expect(svgSize('<svg width="120" height="40px">')).toEqual({
      width: 120,
      height: 40,
    });
    expect(svgSize('<svg viewBox="0 0 200 100">')).toEqual({
      width: 300,
      height: 150,
    });
    expect(svgSize('<svg width="50%" height="1em">')).toBeUndefined();
  });

  it("does not believe a header that does not parse", () => {
    expect(pictureSizeOfBytes(bytes(137, "PNG"))).toBeUndefined();
    expect(pictureSizeOfBytes(bytes(0xff, 0xd8, 0xff, 0xc0))).toBeUndefined();
    expect(pictureSizeOfUrl("https://example.com/a.png")).toBeUndefined();
  });

  it("reads a data: URL's", () => {
    expect(pictureSizeOfUrl(dataUrl("image/png", PNG))).toEqual({
      width: 640,
      height: 480,
    });
    expect(pictureSizeOfUrl(dataUrl("image/jpeg", JPEG))).toEqual({
      width: 1200,
      height: 300,
    });
  });
});

describe("a picture's room", () => {
  it("is its own size from the first frame when its header says it", () => {
    const { container } = render(
      <Picture src={dataUrl("image/png", PNG)} alt="plot" boxed={false} />,
    );
    const image = container.querySelector("img")!;
    expect(image).toHaveClass("conversation-picture");
    expect(image).toHaveAttribute("width", "640");
    expect(image).toHaveAttribute("height", "480");
  });

  it("is a box of the same shape while it is read and once it has arrived", () => {
    const { container, rerender } = render(
      <Picture src={undefined} alt="plot" boxed />,
    );
    const box = container.querySelector(".conversation-picture-box")!;
    expect(box).toHaveAttribute("aria-busy", "true");
    const reading = (box as HTMLElement).style.aspectRatio;
    expect(Number(reading)).toBe(BOX_RATIO);
    rerender(<Picture src={dataUrl("image/png", PNG)} alt="plot" boxed />);
    expect(container.querySelector(".conversation-picture-box")).toBe(box);
    // 640×480 is the box's own shape: arriving changes nothing.
    expect((box as HTMLElement).style.aspectRatio).toBe(reading);
    // A wider one is drawn inside it, the box as it was.
    rerender(<Picture src={dataUrl("image/jpeg", JPEG)} alt="plot" boxed />);
    expect((box as HTMLElement).style.aspectRatio).toBe(reading);
  });

  it("only deepens, and no further than a square", () => {
    expect(boxRatio(undefined)).toBe(BOX_RATIO);
    expect(boxRatio({ width: 1920, height: 400 })).toBe(BOX_RATIO);
    expect(boxRatio({ width: 400, height: 1920 })).toBe(1);
    expect(boxRatio({ width: 640, height: 480 })).toBeLessThanOrEqual(
      BOX_RATIO,
    );
  });

  it("is a box for a picture from the web, deepened by what it loads as", () => {
    const { container } = render(
      <Picture src="https://example.com/tall.png" alt="tall" boxed />,
    );
    const box = container.querySelector<HTMLElement>(
      ".conversation-picture-box",
    )!;
    const image = box.querySelector("img")!;
    Object.defineProperty(image, "naturalWidth", { value: 300 });
    Object.defineProperty(image, "naturalHeight", { value: 600 });
    fireEvent.load(image);
    expect(Number(box.style.aspectRatio)).toBe(1);
  });
});
