// @vitest-environment jsdom

/**
 * The waveform behind the words while dictating (`DictationWaveform.tsx`):
 * the level as the analyser reads it, the bars newest-right and flowing left,
 * one drawing per animation frame and none once it is gone, the level handed
 * to the box for the button's halo, and a still meter under Reduce Motion.
 *
 * jsdom has no Web Audio, no canvas and no frames: the analyser is a fake
 * whose loudness the test sets, the canvas context records what is filled,
 * and the frames are run by the test.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BAR_PX,
  BAR_WIDTH_PX,
  BARS_PER_SECOND,
  DictationWaveform,
  levelOf,
  waveBars,
} from "./DictationWaveform";

/** The frames asked for and not yet run. */
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
/** What each frame filled, cleared at each clearRect. */
let filled: { x: number; y: number; width: number; height: number }[] = [];
let reduce = false;

function runFrame(at: number) {
  const due = [...frames.values()];
  frames = new Map();
  for (const callback of due) callback(at);
}

/** An analyser whose input is a steady `amplitude`. */
function fakeAnalyser(amplitude = { value: 0 }) {
  const analyser = {
    fftSize: 1024,
    getFloatTimeDomainData: vi.fn((into: Float32Array) => {
      into.fill(amplitude.value);
    }),
  };
  return { analyser: analyser as unknown as AnalyserNode, amplitude };
}

beforeEach(() => {
  frames = new Map();
  filled = [];
  reduce = false;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query.includes("reduce"),
  }));
  const context = {
    setTransform() {},
    clearRect() {
      filled = [];
    },
    fillRect(x: number, y: number, width: number, height: number) {
      filled.push({ x, y, width, height });
    },
    fillStyle: "",
    globalAlpha: 1,
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  // A box 200 × 40.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(200);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(40);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function drawInBox(analyser: AnalyserNode) {
  const view = render(
    <div className="conversation-composer-box">
      <DictationWaveform analyser={analyser} />
    </div>,
  );
  const box = view.container.querySelector<HTMLElement>(
    ".conversation-composer-box",
  )!;
  return { ...view, box };
}

describe("the level", () => {
  it("reads silence as nothing, a voice as some, and loud as all", () => {
    expect(levelOf(new Float32Array(512))).toBe(0);
    // -60 dBFS is the floor; about -20 dBFS is most of the way up.
    expect(levelOf(new Float32Array(512).fill(0.0005))).toBe(0);
    const voice = levelOf(new Float32Array(512).fill(0.1));
    expect(voice).toBeGreaterThan(0.5);
    expect(voice).toBeLessThan(1);
    expect(levelOf(new Float32Array(512).fill(0.5))).toBe(1);
  });
});

describe("the bars", () => {
  it("puts the newest at the right edge and the older ones leftward, fading", () => {
    const bars = waveBars([0.1, 0.5, 1], 100, 40);
    expect(bars).toHaveLength(3);
    expect(bars[0]!.x).toBe(100 - BAR_WIDTH_PX);
    expect(bars[1]!.x).toBe(100 - BAR_WIDTH_PX - BAR_PX);
    // Newest first: the loudest is the tallest, centred.
    expect(bars[0]!.height).toBeGreaterThan(bars[1]!.height);
    expect(bars[0]!.y + bars[0]!.height / 2).toBe(20);
    expect(bars[2]!.alpha).toBeLessThan(bars[0]!.alpha);
  });

  it("draws silence as a hairline, never as nothing", () => {
    expect(waveBars([0], 100, 40)[0]!.height).toBe(1);
  });

  it("moves left smoothly between one bar and the next", () => {
    const resting = waveBars([1], 100, 40, 0)[0]!.x;
    expect(waveBars([1], 100, 40, 0.5)[0]!.x).toBe(resting - BAR_PX / 2);
  });

  it("draws no more than fit in the box", () => {
    const many = Array.from({ length: 500 }, () => 0.5);
    expect(waveBars(many, 100, 40).length).toBeLessThanOrEqual(
      Math.ceil(100 / BAR_PX) + 1,
    );
  });
});

describe("the waveform", () => {
  it("draws what it hears on each frame, flowing left as time passes", () => {
    const { analyser, amplitude } = fakeAnalyser();
    drawInBox(analyser);
    expect(frames.size).toBe(1);
    amplitude.value = 0.1;
    runFrame(1_000);
    const first = filled.map((bar) => bar.x);
    expect(first.length).toBeGreaterThan(0);
    expect(Math.max(...first)).toBe(200 - BAR_WIDTH_PX);
    runFrame(1_000 + 5_000 / BARS_PER_SECOND);
    // More bars, the earlier ones further left.
    expect(filled.length).toBeGreaterThan(first.length);
    expect(Math.min(...filled.map((bar) => bar.x))).toBeLessThan(
      Math.min(...first),
    );
    // Each frame asks for the next.
    expect(frames.size).toBe(1);
  });

  it("hands the level to the box for the button's halo", () => {
    const { analyser, amplitude } = fakeAnalyser();
    const { box } = drawInBox(analyser);
    amplitude.value = 0.5;
    runFrame(1_000);
    expect(box.style.getPropertyValue("--dictation-level")).toBe("1.00");
  });

  it("skips frames closer than a 60 Hz display's", () => {
    const { analyser } = fakeAnalyser();
    drawInBox(analyser);
    runFrame(1_000);
    runFrame(1_004);
    runFrame(1_008);
    expect(analyser.getFloatTimeDomainData).toHaveBeenCalledTimes(1);
  });

  it("stops its frames and lets go of the level when it goes", () => {
    const { analyser, amplitude } = fakeAnalyser();
    const { box, unmount } = drawInBox(analyser);
    amplitude.value = 0.2;
    runFrame(1_000);
    expect(box.style.getPropertyValue("--dictation-level")).not.toBe("");
    unmount();
    expect(frames.size).toBe(0);
    expect(box.style.getPropertyValue("--dictation-level")).toBe("");
    runFrame(2_000);
    expect(analyser.getFloatTimeDomainData).toHaveBeenCalledTimes(1);
  });

  it("under Reduce Motion is a still level meter, a few times a second", () => {
    reduce = true;
    const { analyser, amplitude } = fakeAnalyser();
    drawInBox(analyser);
    amplitude.value = 0.5;
    runFrame(1_000);
    expect(filled).toEqual([{ x: 0, y: 38, width: 200, height: 2 }]);
    runFrame(1_050);
    expect(analyser.getFloatTimeDomainData).toHaveBeenCalledTimes(1);
    amplitude.value = 0;
    runFrame(1_200);
    expect(filled[0]!.width).toBeLessThan(200);
  });
});
