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
} from "../../ipc/voice";
import {
  concatenate,
  dictationFailure,
  level as levelOf,
  pcm16,
  StreamingDownsampler,
} from "./dictation";

export type DictationPhase =
  /** No recogniser in this build, or no bridge: the button says why. */
  | "unavailable"
  | "idle"
  /** Waiting for the microphone: the permission prompt, or the device opening. */
  | "starting"
  | "recording"
  /** Recording ended; main is transcribing the last words. */
  | "transcribing";

/** How much audio is collected before it is sent to main, in seconds. */
const SEND_EVERY_SECONDS = 0.25;

interface Recording {
  readonly session: number;
  readonly stream: MediaStream;
  readonly context: AudioContext;
  /** Sends what is collected and not yet sent. */
  readonly flush: () => void;
  readonly stop: () => void;
}

export interface Dictation {
  readonly phase: DictationPhase;
  /** Why dictation is unavailable, when it is. */
  readonly reason: string | undefined;
  /** How loud the microphone is right now, 0 to 1, while recording. */
  readonly level: number;
  /** The words since the last pause, which may still change. */
  readonly tentative: string;
  /** Start a recording, or end the one running. */
  readonly toggle: () => void;
  /** Throw away what is not committed and end the recording. `false` when there was none. */
  readonly cancel: () => boolean;
  /** The microphone may be used soon: have main load the recogniser. */
  readonly warm: () => void;
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
  const [level, setLevel] = useState(0);
  const [tentative, setTentative] = useState("");
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

  const release = useCallback((): Recording | undefined => {
    const current = recording.current;
    recording.current = undefined;
    if (current === undefined) return undefined;
    current.flush();
    current.stop();
    for (const track of current.stream.getTracks()) track.stop();
    void current.context.close().catch(() => undefined);
    setLevel(0);
    return current;
  }, []);

  // A composer that goes away does not leave the microphone open.
  useEffect(
    () => () => {
      const done = release();
      if (done !== undefined) voice?.cancel(done.session);
      delivery.current = undefined;
    },
    [release, voice],
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
    setPhase("transcribing");
    void voice.end(done.session).then(
      (result) => {
        setPhase("idle");
        setTentative("");
        if (!result.ok) {
          delivery.current = undefined;
          fail("transcribe", new Error(result.reason));
          return;
        }
        deliver(done.session, result.value);
        delivery.current = undefined;
      },
      (error: unknown) => {
        setPhase("idle");
        setTentative("");
        delivery.current = undefined;
        latest.current.reportFailure(error);
      },
    );
  }, [deliver, fail, release, voice]);

  const warm = useCallback(() => {
    if (voice === undefined || Date.now() - warmed.current < 60_000) return;
    warmed.current = Date.now();
    voice.warm();
  }, [voice]);

  const start = useCallback(async () => {
    if (voice === undefined) return;
    setPhase("starting");
    warm();
    const permission = await voice.requestMicrophone();
    if (!permission.ok) {
      fail("permission", new Error(permission.reason));
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        },
      });
    } catch (error: unknown) {
      fail("open", error);
      return;
    }
    const begun = await voice.begin(language);
    if (!begun.ok) {
      for (const track of stream.getTracks()) track.stop();
      fail("transcribe", new Error(begun.reason));
      return;
    }
    const session = begun.value;
    delivery.current = { session, delivered: 0 };
    setTentative("");
    latest.current.onBegin();

    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(2048, 1, 1);
    const downsampler = new StreamingDownsampler(context.sampleRate);
    let pending: Float32Array[] = [];
    let pendingLength = 0;
    let sent = 0;
    const flush = () => {
      if (pendingLength === 0) return;
      const samples = concatenate(pending);
      pending = [];
      pendingLength = 0;
      sent += samples.length;
      voice.audio(session, pcm16(samples));
    };
    const limit = VOICE_MAX_SECONDS * VOICE_SAMPLE_RATE;
    processor.onaudioprocess = (event) => {
      const chunk = new Float32Array(event.inputBuffer.getChannelData(0));
      setLevel(levelOf(chunk));
      const samples = downsampler.push(chunk);
      pending.push(samples);
      pendingLength += samples.length;
      if (pendingLength >= SEND_EVERY_SECONDS * VOICE_SAMPLE_RATE) flush();
      // Main keeps no more; the recording is ended here, and kept, instead.
      if (sent + pendingLength >= limit) finish();
    };
    source.connect(processor);
    // A processor that goes nowhere is not run; its output is silence.
    processor.connect(context.destination);
    recording.current = {
      session,
      stream,
      context,
      flush,
      stop: () => {
        processor.onaudioprocess = null;
        source.disconnect();
        processor.disconnect();
      },
    };
    setPhase("recording");
  }, [fail, finish, language, voice, warm]);

  const toggle = useCallback(() => {
    if (phase === "idle") {
      void start().catch((error: unknown) => {
        const done = release();
        if (done !== undefined) voice?.cancel(done.session);
        setPhase("idle");
        latest.current.reportFailure(error);
      });
    } else if (phase === "recording") finish();
  }, [finish, phase, release, start, voice]);

  const cancel = useCallback((): boolean => {
    const done = release();
    if (done === undefined) return false;
    voice?.cancel(done.session);
    delivery.current = undefined;
    setTentative("");
    setPhase("idle");
    return true;
  }, [release, voice]);

  return { phase, reason, level, tentative, toggle, cancel, warm };
}
