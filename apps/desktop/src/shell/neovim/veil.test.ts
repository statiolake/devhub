import { describe, expect, it } from "vitest";
import { veilMargin, veilMask, veilPad, veilSigma } from "./veil";

const decode = (mask: string | undefined) =>
  decodeURIComponent(
    mask?.replace(/^url\("data:image\/svg\+xml,|"\)$/g, "") ?? "",
  );

describe("the backdrop under notifications", () => {
  const sigma = veilSigma(18);

  it("is feathered by a quarter line and reaches past the text by 1.5 σ", () => {
    expect(sigma).toBe(4.5);
    expect(veilPad(sigma)).toEqual({ x: 6.75, y: 2.25 });
    expect(veilMargin(sigma)).toBe(21);
  });

  it("is one capsule per line, as long as that line", () => {
    const svg = decode(
      veilMask(
        [
          { x: 100, y: 0, w: 200, h: 18, opacity: 1 },
          { x: 250, y: 18, w: 50, h: 18, opacity: 1 },
          { x: 120, y: 36, w: 180, h: 18, opacity: 0.5 },
        ],
        320,
        60,
        sigma,
      ),
    );
    const rects = [...svg.matchAll(/<rect ([^/]*)\/>/g)].map((m) => m[1]);
    expect(rects).toHaveLength(3);
    // The short middle line's capsule starts where its text does, not
    // where its neighbours' do: no hull, no rectangle.
    expect(rects[1]).toContain('x="243.3"');
    expect(rects[1]).toContain('width="63.5"');
    expect(rects[1]).toContain('rx="11.3"');
    expect(rects[2]).toContain('fill-opacity="0.5"');
    expect(svg).toContain('<feGaussianBlur stdDeviation="4.5"/>');
  });

  it("is nothing when no line shows", () => {
    expect(
      veilMask([{ x: 0, y: 0, w: 10, h: 18, opacity: 0 }], 50, 50, sigma),
    ).toBeUndefined();
  });
});
