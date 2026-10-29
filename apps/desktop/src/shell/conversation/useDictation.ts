/**
 * The microphone half of dictation (see `dictation.ts` for the whole of it).
 *
 * A recording is streamed: the microphone's samples are brought down to
 * 16 kHz as they come (`StreamingDownsampler`) and sent to main as 16-bit PCM
 * about four times a second, and main answers with what it has heard so far
 * (`VoiceUpdate`). Each update's committed words are handed to the composer
 * as they arrive — only what is new — and its tentative words are kept here
 * for the composer to show. When the recording ends, main transcribes what is
 * left and answers the whole; what of it the composer has not had yet is
 * handed over then. The microphone is released the moment the recording ends
 * — the menu bar's orange dot goes out then, not when the last words come
 * back.
 *
 * A press shows at once and captures at once. The button turns to the
 * recording colour in the frame after the press ("starting"); the
 * recognition session (`begin`), the microphone permission and the device
 * are asked for together, and what the microphone hears is kept from the
 * moment it opens — before main has answered `begin` — and sent once it has.
 * The first press in a page also pays for Chromium's audio service and its
 * device list (a few hundred milliseconds, measured under Electron), so the
 * moment the microphone is likely to be used — the pointer on it, the
 * composer focused by someone who dictates — warms those, and main's
 * recogniser, ahead of the press (`warm`). A microphone that does not open
 * within `MICROPHONE_OPEN_MS` is given up on and said so, and a second press
 * while it opens gives up too.
 *
 * The level drawn under the words (`DictationWaveform`) is read from an
 * `AnalyserNode` on the same source, by that component's own animation
 * frames: nothing here re-renders the composer per chunk of audio.
 *
 * The samples are read with a `ScriptProcessorNode`. It is deprecated in
 * favour of the `AudioWorklet`, which needs a module loaded by URL into the
 * audio thread; for a callback that only copies and forwards, the main-thread
 * callback is the same result with nothing to load, and Chromium still ships
 * it. Its buffer is 2048 frames (~43 ms at 48 kHz), so what is sent lags the
 * voice by a few tens of milliseconds at most.
 *
 * Echo cancellation and noise suppression are asked for: the composer is used
 * with the speakers on and a fan running, and Whisper is better on what the
 * browser's own processing leaves than on the raw signal. Auto gain is not:
 * it pumps the level in pauses, which Whisper hears as words.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  VOICE_MAX_SECONDS,
  VOICE_SAMPLE_RATE,
  type VoiceApi,
  type VoiceLanguage,
  type VoiceResult,
} from "../../ipc/voice";
import {
  concatenate,
  dictationFailure,
  dictationUnavailable,
  markDictated,
  MICROPHONE_OPEN_MS,
  pcm16,
  StreamingDownsampler,
} from "./dictation";

export type DictationPhase =
  /** No recogniser in this build, or no bridge: a press says why. */
  | "unavailable"
  | "idle"
  /** Pressed: the microphone is opening (the permission prompt, the device). */
  | "starting"
  | "recording"
  /** Recording ended; main is transcribing the last words. */
  | "transcribing";

/** How much audio is collected before it is sent to main, in seconds. */
const SEND_EVERY_SECONDS = 0.25;

/** One press: the session main opens for it, once main has answered. */
interface Attempt {
  cancelled: boolean;
  readonly session: Promise<VoiceResult<number>>;
  id: number | undefined;
}

interface Recording {
  readonly attempt: Attempt;
  readonly stream: MediaStream;
  readonly context: AudioContext;
  /** Sends what is collected and not yet sent, once the session is known. */
  readonly flush: () => void;
  readonly stop: () => void;
}

export interface Dictation {
  readonly phase: DictationPhase;
  /** Why dictation is unavailable, when it is. */
  readonly reason: string | undefined;
  /** The microphone's level, to draw, while recording. */
  readonly analyser: AnalyserNode | undefined;
  /** The words since the last pause, which may still change. */
  readonly tentative: string;
  /** Start a recording, end the one running, or give up on one opening. */
  readonly toggle: () => void;
  /** Throw away what is not committed and end the recording. `false` when there was none. */
  readonly cancel: () => boolean;
  /** The microphone may be used soon: have main load the recogniser, and the page its audio. */
  readonly warm: () => void;
}

/** `localStorage`, where the page has one it may use. */
function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** After the next frame is painted. */
function painted(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== "function") {
      setTimeout(resolve, 0);
      return;
    }
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

function whenIdle(work: () => void): void {
  if (typeof requestIdleCallback === "function")
    requestIdleCallback(work, { timeout: 1_000 });
  else setTimeout(work, 50);
}

let audioPrimed = false;

/**
 * Chromium's audio service and its list of devices, brought up once per page:
 * a first `AudioContext` blocks the page while the service starts, and a first
 * `getUserMedia` waits on the device list. Neither opens the microphone.
 */
function primeAudio(): void {
  if (audioPrimed) return;
  audioPrimed = true;
  whenIdle(() => {
    try {
      void new AudioContext().close().catch(() => undefined);
    } catch {
      // No audio here: the press says so.
    }
    void navigator.mediaDevices?.enumerateDevices?.().catch(() => undefined);
  });
}

/** For tests: the next warm-up primes the page's audio again. */
export function resetAudioPrimingForTests(): void {
  audioPrimed = false;
}

class MicrophoneTimeout extends Error {
  constructor() {
    super(
      `the microphone did not open within ${String(MICROPHONE_OPEN_MS / 1000)} seconds`,
    );
    this.name = "MicrophoneTimeout";
  }
}

function openMicrophone(): Promise<MediaStream> {
  const opening = navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
    },
  });
  return new Promise((resolve, reject) => {
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      reject(new MicrophoneTimeout());
    }, MICROPHONE_OPEN_MS);
    opening.then(
      (stream) => {
        clearTimeout(timer);
        // Opened after it was given up on: closed again at once.
        if (late) for (const track of stream.getTracks()) track.stop();
        else resolve(stream);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function useDictation(options: {
  readonly voice: VoiceApi | undefined;
  readonly language: VoiceLanguage;
  /** A recording has started: the words that follow go where the caret is now. */
  readonly onBegin: () => void;
  /** More committed words, in order: only what is new since the last call. */
  readonly onWords: (words: string) => void;
  readonly reportFailure: (error: unknown) => void;
}): Dictation {
  const { voice, language } = options;
  const [phase, setPhase] = useState<DictationPhase>(
    voice === undefined ? "unavailable" : "idle",
  );
  const [reason, setReason] = useState<string | undefined>(
    voice === undefined ? "Dictation is not available here." : undefined,
  );
  const [analyser, setAnalyser] = useState<AnalyserNode | undefined>(undefined);
  const [tentative, setTentative] = useState("");
  /** The press being answered: opening, recording or transcribing. */
  const attempt = useRef<Attempt | undefined>(undefined);
  const recording = useRef<Recording | undefined>(undefined);
  /** The session whose words are being handed over, and how much of its committed text has been. */
  const delivery = useRef<{ session: number; delivered: number } | undefined>(
    undefined,
  );
  /** When main was last asked to warm up: hovering the button asks at most once a minute. */
  const warmed = useRef(-Infinity);
  // The latest callbacks, so a recording that ends after a re-render hands
  // its words to the composer as it is now.
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    if (voice === undefined) return;
    let live = true;
    void voice.status().then(
      (status) => {
        if (!live || status.available) return;
        setPhase("unavailable");
        setReason(status.reason);
      },
      (error: unknown) => latest.current.reportFailure(error),
    );
    return () => {
      live = false;
    };
  }, [voice]);

  /** Hand over what of `committed` the composer has not had yet. */
  const deliver = useCallback((session: number, committed: string) => {
    const current = delivery.current;
    if (current?.session !== session) return;
    if (committed.length <= current.delivered) return;
    const fresh = committed.slice(current.delivered).trimStart();
    current.delivered = committed.length;
    if (fresh !== "") latest.current.onWords(fresh);
  }, []);

  useEffect(() => {
    if (voice === undefined) return;
    return voice.onUpdate((session, update) => {
      if (delivery.current?.session !== session) return;
      deliver(session, update.committed);
      setTentative(update.tentative);
    });
  }, [deliver, voice]);

  /** The microphone closed: what was collected is sent if it can be. */
  const release = useCallback((): Recording | undefined => {
    const current = recording.current;
    recording.current = undefined;
    if (current === undefined) return undefined;
    current.flush();
    current.stop();
    for (const track of current.stream.getTracks()) track.stop();
    void current.context.close().catch(() => undefined);
    setAnalyser(undefined);
    return current;
  }, []);

  /** The press given up on: the microphone closed, main's session dropped. */
  const abandon = useCallback(
    (given: Attempt) => {
      given.cancelled = true;
      if (attempt.current === given) attempt.current = undefined;
      if (recording.current?.attempt === given) release();
      if (given.id !== undefined) voice?.cancel(given.id);
      if (delivery.current?.session === given.id) delivery.current = undefined;
    },
    [release, voice],
  );

  // A composer that goes away does not leave the microphone open.
  useEffect(
    () => () => {
      const current = attempt.current;
      if (current !== undefined) abandon(current);
      delivery.current = undefined;
    },
    [abandon],
  );

  const fail = useCallback(
    (stage: "permission" | "open" | "transcribe", error: unknown) => {
      setPhase("idle");
      setTentative("");
      latest.current.reportFailure(dictationFailure(stage, error));
    },
    [],
  );

  const finish = useCallback(() => {
    const done = release();
    if (done === undefined || voice === undefined) return;
    const given = done.attempt;
    setPhase("transcribing");
    const ended = async (): Promise<VoiceResult<string> | undefined> => {
      const begun = await given.session;
      // Refused, or given up on: said where that was found.
      if (!begun.ok || given.cancelled) return undefined;
      done.flush();
      return voice.end(begun.value);
    };
    void ended().then(
      (result) => {
        if (result === undefined || given.cancelled) return;
        if (attempt.current === given) attempt.current = undefined;
        setPhase("idle");
        setTentative("");
        if (!result.ok) {
          delivery.current = undefined;
          fail("transcribe", new Error(result.reason));
          return;
        }
        deliver(given.id!, result.value);
        delivery.current = undefined;
      },
      (error: unknown) => {
        if (attempt.current === given) attempt.current = undefined;
        setPhase("idle");
        setTentative("");
        delivery.current = undefined;
        latest.current.reportFailure(error);
      },
    );
  }, [deliver, fail, release, voice]);

  const warm = useCallback(() => {
    if (voice === undefined) return;
    primeAudio();
    if (Date.now() - warmed.current < 60_000) return;
    warmed.current = Date.now();
    voice.warm();
  }, [voice]);

  const start = useCallback(async () => {
    if (voice === undefined) return;
    // Everything the press waits on is asked for now, together.
    const given: Attempt = {
      cancelled: false,
      session: voice.begin(language),
      id: undefined,
    };
    attempt.current = given;
    setPhase("starting");
    setTentative("");
    latest.current.onBegin();
    warmed.current = Date.now();
    voice.warm();
    markDictated(storage());

    void given.session.then(
      (begun) => {
        if (given.cancelled) {
          if (begun.ok) voice.cancel(begun.value);
          return;
        }
        if (!begun.ok) {
          abandon(given);
          fail("transcribe", new Error(begun.reason));
          return;
        }
        given.id = begun.value;
        delivery.current = { session: begun.value, delivered: 0 };
        // What was heard while main answered goes now.
        if (recording.current?.attempt === given) recording.current.flush();
      },
      (error: unknown) => {
        if (given.cancelled) return;
        abandon(given);
        setPhase("idle");
        latest.current.reportFailure(error);
      },
    );

    const permission = await voice.requestMicrophone();
    if (given.cancelled) return;
    if (!permission.ok) {
      abandon(given);
      fail("permission", new Error(permission.reason));
      return;
    }
    const opening = openMicrophone();
    // The press is drawn before the audio service is asked for a context: a
    // first one blocks the page while the service starts.
    await painted();
    if (given.cancelled) {
      void opening.then(
        (stream) => stream.getTracks().forEach((track) => track.stop()),
        () => undefined,
      );
      return;
    }
    const context = new AudioContext();
    let stream: MediaStream;
    try {
      stream = await opening;
    } catch (error: unknown) {
      void context.close().catch(() => undefined);
      if (given.cancelled) return;
      abandon(given);
      fail("open", error);
      return;
    }
    if (given.cancelled) {
      for (const track of stream.getTracks()) track.stop();
      void context.close().catch(() => undefined);
      return;
    }

    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(2048, 1, 1);
    const level = context.createAnalyser();
    level.fftSize = 1024;
    level.smoothingTimeConstant = 0;
    const downsampler = new StreamingDownsampler(context.sampleRate);
    let pending: Float32Array[] = [];
    let pendingLength = 0;
    let sent = 0;
    const flush = () => {
      if (pendingLength === 0 || given.id === undefined) return;
      const samples = concatenate(pending);
      pending = [];
      pendingLength = 0;
      sent += samples.length;
      voice.audio(given.id, pcm16(samples));
    };
    const limit = VOICE_MAX_SECONDS * VOICE_SAMPLE_RATE;
    processor.onaudioprocess = (event) => {
      const chunk = new Float32Array(event.inputBuffer.getChannelData(0));
      const samples = downsampler.push(chunk);
      pending.push(samples);
      pendingLength += samples.length;
      if (pendingLength >= SEND_EVERY_SECONDS * VOICE_SAMPLE_RATE) flush();
      // Main keeps no more; the recording is ended here, and kept, instead.
      if (sent + pendingLength >= limit) finish();
    };
    source.connect(processor);
    source.connect(level);
    // A processor that goes nowhere is not run; its output is silence.
    processor.connect(context.destination);
    recording.current = {
      attempt: given,
      stream,
      context,
      flush,
      stop: () => {
        processor.onaudioprocess = null;
        source.disconnect();
        processor.disconnect();
      },
    };
    setAnalyser(level);
    setPhase("recording");
  }, [abandon, fail, finish, language, voice]);

  const cancel = useCallback((): boolean => {
    const given = attempt.current;
    if (given === undefined || phase === "transcribing") return false;
    abandon(given);
    delivery.current = undefined;
    setTentative("");
    setPhase("idle");
    return true;
  }, [abandon, phase]);

  const toggle = useCallback(() => {
    if (phase === "unavailable") {
      latest.current.reportFailure(
        dictationUnavailable(reason ?? "Dictation is not available here."),
      );
    } else if (phase === "idle") {
      void start().catch((error: unknown) => {
        const given = attempt.current;
        if (given !== undefined) abandon(given);
        setPhase("idle");
        latest.current.reportFailure(error);
      });
    } else if (phase === "starting") cancel();
    else if (phase === "recording") finish();
  }, [abandon, cancel, finish, phase, reason, start]);

  return { phase, reason, analyser, tentative, toggle, cancel, warm };
}
