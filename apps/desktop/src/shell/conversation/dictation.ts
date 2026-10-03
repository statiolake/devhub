/**
 * Dictation into the composer: what is recorded, how it is sent, and where
 * the words land.
 *
 * The microphone button (or ⌘⇧M) starts a recording; the same button or key
 * ends it and sends it to main, which transcribes it on this Mac with the
 * bundled whisper.cpp (`ipc/voice.ts`, `main/voice/whisper.ts`). Esc throws a
 * recording away. While it records the button is red and pulses with the
 * level of what it hears, so it is plain the microphone is open; while main
 * transcribes, the button waits.
 *
 * The words go where the caret was when the recording ended — over the
 * selection, if there was one — with a space put in at either seam where
 * Latin text meets Latin text (`model/spokenText.ts`), and the caret after
 * them. They are not sent: dictation fills the composer, the person reads it,
 * and ⌘Return sends as it always does.
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
