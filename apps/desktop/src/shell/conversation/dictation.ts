/**
 * Dictation into the composer: what is recorded, how it is sent, and where
 * the words land.
 *
 * The microphone button (or ⌘⇧M) starts a recording; the same button or key
 * ends it. While it records, the audio streams to main a few times a second
 * and main transcribes it as it comes, on this Mac, with the bundled
 * whisper.cpp kept loaded (`ipc/voice.ts`, `main/voice/dictationStream.ts`).
 * While it records the button is red and pulses with the level of what it
 * hears, so it is plain the microphone is open; after it ends, while main
 * finishes the last words, the button waits.
 *
 * The words come in two kinds. What the person said before their last pause
 * is committed: it goes into the composer as soon as main has it, and does
 * not change. What they are saying now is tentative: it is shown, lighter,
 * under the composer, rewritten as it is heard, and goes in when they pause
 * or stop. Esc throws away what is not committed yet and ends the recording.
 *
 * The committed words go where the caret was when the recording started —
 * over the selection, if there was one — each phrase after the last, with a
 * space put in at either seam where Latin text meets Latin text
 * (`model/spokenText.ts`). Typing elsewhere in the composer meanwhile is
 * kept: the place the next phrase goes moves with the text around it
 * (`shiftAnchor`). They are not sent: dictation fills the composer, the
 * person reads it, and ⌘Return sends as it always does.
 *
 * Which language Whisper listens for is the small label beside the button:
 * Auto, 日本語 or English, chosen by clicking it and kept for this Mac
 * (`localStorage`, a per-viewer convenience). Auto is right for both
 * languages almost always; the others are for an utterance too short to
 * tell, or an accent Whisper reads as the other language.
 *
 * This module is the part with no browser in it; `useDictation.ts` is the
 * part with the microphone.
 */

import {
  VOICE_LANGUAGES,
  VOICE_SAMPLE_RATE,
  type VoiceLanguage,
} from "../../ipc/voice";
import { needsSpace } from "../../model/spokenText";
import { UserFacingFailure } from "../failure";

export const MICROPHONE_DENIED_TITLE = "Microphone access is denied.";
export const VOICE_FAILED_TITLE = "Voice input failed.";

/**
 * A dictation failure as the person should read it.
 *
 * Refused access — macOS said no (`requestMicrophone`), or Chromium refused
 * `getUserMedia` with `NotAllowedError` — says so, and offers the one place it
 * can be undone: System Settings' Microphone pane. Anything else is a voice
 * failure with its own words under it, and no button: neither "Try Again" nor
 * DevHub's settings would change the outcome.
 */
export function dictationFailure(
  stage: "permission" | "open" | "transcribe",
  error: unknown,
): UserFacingFailure {
  const message = error instanceof Error ? error.message : String(error);
  const denied =
    stage === "permission" ||
    (stage === "open" &&
      error instanceof Error &&
      (error.name === "NotAllowedError" || error.name === "SecurityError"));
  if (denied) {
    return new UserFacingFailure(
      MICROPHONE_DENIED_TITLE,
      stage === "permission"
        ? message
        : `The microphone could not be opened: ${message}. Allow DevHub in System Settings → Privacy & Security → Microphone, then try again.`,
      ["open_microphone_settings"],
    );
  }
  return new UserFacingFailure(
    VOICE_FAILED_TITLE,
    stage === "open"
      ? `The microphone could not be opened: ${message}`
      : message,
    [],
  );
}

/** How the shortcut is written wherever the composer names it. */
export const DICTATION_KEY = "⌘⇧M";

/** Whether a key press is the dictation shortcut. `code`, so a layout or an input method cannot move it. */
export function isDictationKey(event: {
  readonly code: string;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
}): boolean {
  return (
    event.code === "KeyM" &&
    event.metaKey &&
    event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey
  );
}

/**
 * `samples` at `fromRate`, at 16 kHz.
 *
 * The microphone runs at whatever the hardware runs at — 48 kHz on a MacBook,
 * 44.1 on many headsets — and Whisper wants 16. Each output sample is the mean
 * of the input samples its interval covers: a box filter, which is enough of
 * a low-pass for speech (whose energy is well under the 8 kHz the new rate
 * keeps) and costs one pass.
 */
export function downsample(
  samples: Float32Array,
  fromRate: number,
  toRate: number = VOICE_SAMPLE_RATE,
): Float32Array {
  if (fromRate === toRate) return samples;
  if (fromRate < toRate)
    throw new Error(`cannot upsample from ${fromRate} Hz to ${toRate} Hz`);
  const ratio = fromRate / toRate;
  const length = Math.floor(samples.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j]!;
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

/** Float samples in [-1, 1] as 16-bit little-endian PCM bytes, clipped. */
export function pcm16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const clipped = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(
      i * 2,
      Math.round(clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff),
      true,
    );
  }
  return bytes;
}

/**
 * `downsample` for a recording that arrives in pieces: what does not fill a
 * whole output sample is kept for the next piece, so the pieces join with
 * no click and no drift.
 */
export class StreamingDownsampler {
  /** Input samples not yet averaged into an output sample. */
  private carry = new Float32Array(0);
  /** Input samples before `carry`, and output samples made: the box edges are global, so pieces cannot drift. */
  private consumed = 0;
  private made = 0;

  constructor(
    private readonly fromRate: number,
    private readonly toRate: number = VOICE_SAMPLE_RATE,
  ) {
    if (fromRate < toRate)
      throw new Error(`cannot upsample from ${fromRate} Hz to ${toRate} Hz`);
  }

  push(samples: Float32Array): Float32Array {
    if (this.fromRate === this.toRate) return samples;
    const input = concatenate([this.carry, samples]);
    const ratio = this.fromRate / this.toRate;
    const out: number[] = [];
    for (;;) {
      const start = Math.floor(this.made * ratio) - this.consumed;
      const end = Math.floor((this.made + 1) * ratio) - this.consumed;
      if (end > input.length) break;
      let sum = 0;
      for (let j = start; j < end; j++) sum += input[j]!;
      out.push(end > start ? sum / (end - start) : 0);
      this.made++;
    }
    const keepFrom = Math.floor(this.made * ratio) - this.consumed;
    this.carry = input.slice(keepFrom);
    this.consumed += keepFrom;
    return Float32Array.from(out);
  }
}

/**
 * Where `at`, an index into `before`, is in `after`: `before` with one
 * stretch of it replaced (whatever the person typed, pasted or deleted). An
 * index before the change stays; one after it moves with the text after it;
 * one inside the change goes to the end of what replaced it.
 */
export function shiftAnchor(before: string, after: string, at: number): number {
  if (before === after) return at;
  let prefix = 0;
  const shortest = Math.min(before.length, after.length);
  while (prefix < shortest && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix++;
  if (at <= prefix) return at;
  if (at >= before.length - suffix) return at + after.length - before.length;
  return after.length - suffix;
}

/**
 * Where the next committed words of a dictation go, and the text as it was
 * when the last went in — so whatever was typed since can be allowed for.
 * `start` to `end` is replaced: the selection, the first time; empty after.
 */
export interface DictationAnchor {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** `words` put in at `anchor` in `text`, allowing for edits since; and where the next words go. */
export function placeDictation(
  text: string,
  anchor: DictationAnchor,
  words: string,
): {
  readonly text: string;
  readonly caret: number;
  readonly anchor: DictationAnchor;
} {
  const start = Math.min(
    text.length,
    shiftAnchor(anchor.text, text, anchor.start),
  );
  const end = Math.max(
    start,
    Math.min(text.length, shiftAnchor(anchor.text, text, anchor.end)),
  );
  const next = insertDictation(text, start, end, words);
  return {
    ...next,
    anchor: { start: next.caret, end: next.caret, text: next.text },
  };
}

/** Chunks as they were recorded, as one array. */
export function concatenate(chunks: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(
    chunks.reduce((total, chunk) => total + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** The loudness of a chunk, 0 to 1, for the button's pulse: RMS, scaled so speech fills it. */
export function level(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.min(1, Math.sqrt(sum / samples.length) * 6);
}

/**
 * `text` with `words` put in place of `[start, end)`, and where the caret
 * goes after them. A space is added at a seam only where `needsSpace` says
 * one belongs; nothing at the seams is taken away.
 */
export function insertDictation(
  text: string,
  start: number,
  end: number,
  words: string,
): { readonly text: string; readonly caret: number } {
  if (words === "") return { text, caret: end };
  const before = text.slice(0, start);
  const after = text.slice(end);
  const lead = needsSpace(before.at(-1) ?? "", words[0]!) ? " " : "";
  const trail = needsSpace(words.at(-1)!, after[0] ?? "") ? " " : "";
  const inserted = `${lead}${words}${trail}`;
  return {
    text: `${before}${inserted}${after}`,
    caret: before.length + inserted.length,
  };
}

/** The language after `language`, for the label that cycles through them. */
export function nextLanguage(language: VoiceLanguage): VoiceLanguage {
  const index = VOICE_LANGUAGES.indexOf(language);
  return VOICE_LANGUAGES[(index + 1) % VOICE_LANGUAGES.length]!;
}

export const LANGUAGE_LABELS: Readonly<Record<VoiceLanguage, string>> = {
  auto: "Auto",
  ja: "日本語",
  en: "English",
};

const LANGUAGE_KEY = "devhub.dictation.language";

/** The language chosen on this Mac, or `auto`. Storage may be unavailable; that is `auto` too. */
export function savedLanguage(
  storage: Pick<Storage, "getItem"> | undefined,
): VoiceLanguage {
  try {
    const saved = storage?.getItem(LANGUAGE_KEY);
    return VOICE_LANGUAGES.includes(saved as VoiceLanguage)
      ? (saved as VoiceLanguage)
      : "auto";
  } catch {
    return "auto";
  }
}

export function saveLanguage(
  storage: Pick<Storage, "setItem"> | undefined,
  language: VoiceLanguage,
): void {
  try {
    storage?.setItem(LANGUAGE_KEY, language);
  } catch {
    // A preference that is not kept is the same preference next time: auto.
  }
}
