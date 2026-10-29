/**
 * What the microphone hears, drawn behind the words while dictating.
 *
 * A strip of thin bars across the composer's box, the newest at its right
 * edge, flowing left as the voice goes on, each as tall as how loud that
 * moment was: so a glance says the microphone is open and hearing, and a
 * pause reads as a pause. It is the box's background, under the text and the
 * controls, in the accent at low contrast, and older bars fade toward the
 * left; it takes no pointer and changes no layout.
 *
 * The level is read from an `AnalyserNode` on the microphone's source, once a
 * frame (`requestAnimationFrame`, held to about 60 a second), and drawn on a
 * canvas — no React render per frame. The same level is put on the box as
 * `--dictation-level`, for the microphone button's halo. Under Reduce Motion
 * nothing flows: a level meter along the box's bottom edge, its length the
 * level, a few times a second.
 *
 * Mounted only while recording: unmounted, it has stopped its frames, let go
 * of the box's `--dictation-level`, and costs nothing.
 */

import { useEffect, useRef } from "react";

/** One bar and the gap after it, in CSS pixels. */
export const BAR_PX = 4;
/** A bar's own width, in CSS pixels. */
export const BAR_WIDTH_PX = 2;
/** New bars a second: how fast the strip flows (`BAR_PX` × this px/s). */
export const BARS_PER_SECOND = 30;
/** The quietest level drawn above nothing, in dBFS. */
const FLOOR_DB = -60;
/** The level drawn as the full height, in dBFS. */
const CEILING_DB = -12;
/** Frames closer than this are skipped: a 120 Hz display draws at 60. */
const MIN_FRAME_MS = 15;
/** Under Reduce Motion, the meter changes at most this often. */
const STILL_FRAME_MS = 150;
/** Bars kept: wider than any box. */
const HISTORY = 1_024;

/** How loud `samples` are, 0 (silence, or below -60 dBFS) to 1. */
export function levelOf(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / (CEILING_DB - FLOOR_DB)));
}

/** A bar for each kept level, newest at the right edge; what is off the left edge is not drawn. */
export interface Bar {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Older bars fade toward the left edge. */
  readonly alpha: number;
}

/**
 * The bars for `levels` (oldest first) in a box `width` × `height` CSS px,
 * shifted left by `progress` (0 to 1) of a bar while the next is due, so the
 * strip moves smoothly between bars.
 */
export function waveBars(
  levels: readonly number[],
  width: number,
  height: number,
  progress = 0,
): readonly Bar[] {
  const bars: Bar[] = [];
  const middle = height / 2;
  const tallest = height * 0.72;
  const shift = progress * BAR_PX;
  for (let back = 0; back < levels.length; back += 1) {
    const x = width - BAR_WIDTH_PX - back * BAR_PX - shift;
    if (x + BAR_WIDTH_PX < 0) break;
    const level = levels[levels.length - 1 - back]!;
    const tall = Math.max(1, level * tallest);
    bars.push({
      x,
      y: middle - tall / 2,
      width: BAR_WIDTH_PX,
      height: tall,
      alpha: 0.2 + 0.8 * Math.max(0, x / width),
    });
  }
  return bars;
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function DictationWaveform({
  analyser,
}: {
  readonly analyser: AnalyserNode;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element) throw new Error("the dictation waveform was not mounted");
    const host = element.parentElement;
    const drawing = element.getContext("2d");
    if (!drawing) return;
    const still = reducedMotion();
    const samples = new Float32Array(analyser.fftSize);
    const levels: number[] = [];
    let colour = "";
    let colourAt = -Infinity;
    let lastFrame = -Infinity;
    let lastBar: number | undefined;
    let shownLevel = -1;
    let level = 0;
    let frame = 0;

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      if (now - lastFrame < (still ? STILL_FRAME_MS : MIN_FRAME_MS)) return;
      lastFrame = now;
      analyser.getFloatTimeDomainData(samples);
      const heard = levelOf(samples);
      // Quick to rise, slower to fall: speech reads as words, not flicker.
      level = heard > level ? heard : level * 0.7 + heard * 0.3;
      if (Math.abs(level - shownLevel) >= 0.02) {
        shownLevel = level;
        host?.style.setProperty("--dictation-level", level.toFixed(2));
      }
      // The theme may change while recording; reading it is not free.
      if (now - colourAt > 500) {
        colourAt = now;
        colour = getComputedStyle(element).color;
      }
      const scale = window.devicePixelRatio || 1;
      const width = element.clientWidth;
      const height = element.clientHeight;
      const pixelsWide = Math.round(width * scale);
      const pixelsHigh = Math.round(height * scale);
      if (element.width !== pixelsWide) element.width = pixelsWide;
      if (element.height !== pixelsHigh) element.height = pixelsHigh;
      drawing.setTransform(scale, 0, 0, scale, 0, 0);
      drawing.clearRect(0, 0, width, height);
      drawing.fillStyle = colour;
      if (still) {
        drawing.globalAlpha = 1;
        drawing.fillRect(0, height - 2, Math.round(level * width), 2);
        return;
      }
      const due = 1_000 / BARS_PER_SECOND;
      // The first frame draws the first bar: the strip shows at once.
      lastBar ??= now - due;
      while (now - lastBar >= due) {
        levels.push(level);
        lastBar += due;
      }
      if (levels.length > HISTORY) levels.splice(0, levels.length - HISTORY);
      for (const bar of waveBars(
        levels,
        width,
        height,
        (now - lastBar) / due,
      )) {
        drawing.globalAlpha = bar.alpha;
        drawing.fillRect(bar.x, bar.y, bar.width, bar.height);
      }
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      host?.style.removeProperty("--dictation-level");
    };
  }, [analyser]);
  return (
    <canvas
      ref={canvas}
      className="conversation-dictation-wave"
      aria-hidden="true"
    />
  );
}
