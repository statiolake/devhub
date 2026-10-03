/**
 * The microphone half of dictation (see `dictation.ts` for the whole of it).
 *
 * A recording is the microphone's samples, collected as they come and
 * nothing else: no stream to main, no partial transcripts. When it ends they
 * are joined, brought down to 16 kHz and 16 bits, and handed to main in one
 * piece. The microphone is released the moment the recording ends — the
 * menu bar's orange dot goes out then, not when the transcript comes back.
 *
 * The samples are read with a `ScriptProcessorNode`. It is deprecated in
 * favour of the `AudioWorklet`, which needs a module loaded by URL into the
 * audio thread; for a buffer that only collects, the main-thread callback is
 * the same result with nothing to load, and Chromium still ships it.
 *
 * Echo cancellation and noise suppression are asked for: the composer is used
 * with the speakers on and a fan running, and Whisper is better on what the
 * browser's own processing leaves than on the raw signal. Auto gain is not:
 * it pumps the level in pauses, which Whisper hears as words.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  VOICE_MAX_SECONDS,
  type VoiceApi,
  type VoiceLanguage,
} from "../../ipc/voice";
import {
  concatenate,
  dictationFailure,
  downsample,
  level as levelOf,
  pcm16,
} from "./dictation";

export type DictationPhase =
  /** No recogniser in this build, or no bridge: the button says why. */
  | "unavailable"
  | "idle"
  /** Waiting for the microphone: the permission prompt, or the device opening. */
  | "starting"
  | "recording"
  | "transcribing";

interface Recording {
  readonly stream: MediaStream;
  readonly context: AudioContext;
  readonly chunks: Float32Array[];
  readonly stop: () => void;
}

export interface Dictation {
  readonly phase: DictationPhase;
  /** Why dictation is unavailable, when it is. */
  readonly reason: string | undefined;
  /** How loud the microphone is right now, 0 to 1, while recording. */
  readonly level: number;
  /** Start a recording, or end the one running and transcribe it. */
  readonly toggle: () => void;
  /** Throw the running recording away. `false` when there was none. */
  readonly cancel: () => boolean;
}

export function useDictation(options: {
  readonly voice: VoiceApi | undefined;
  readonly language: VoiceLanguage;
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
  const recording = useRef<Recording | undefined>(undefined);
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

  const release = useCallback((): Recording | undefined => {
    const current = recording.current;
    recording.current = undefined;
    if (current === undefined) return undefined;
    current.stop();
    for (const track of current.stream.getTracks()) track.stop();
    void current.context.close().catch(() => undefined);
    setLevel(0);
    return current;
  }, []);

  // A composer that goes away does not leave the microphone open.
  useEffect(() => () => void release(), [release]);

  const fail = useCallback(
    (stage: "permission" | "open" | "transcribe", error: unknown) => {
      setPhase("idle");
      latest.current.reportFailure(dictationFailure(stage, error));
    },
    [],
  );

  const finish = useCallback(() => {
    const done = release();
    if (done === undefined || voice === undefined) return;
    const samples = downsample(
      concatenate(done.chunks),
      done.context.sampleRate,
    );
    if (samples.length === 0) {
      setPhase("idle");
      return;
    }
    setPhase("transcribing");
    void voice.transcribe(pcm16(samples), language).then(
      (result) => {
        setPhase("idle");
        if (!result.ok) {
          fail("transcribe", new Error(result.reason));
          return;
        }
        if (result.value !== "") latest.current.onWords(result.value);
      },
      (error: unknown) => {
        setPhase("idle");
        latest.current.reportFailure(error);
      },
    );
  }, [fail, language, release, voice]);

  const start = useCallback(async () => {
    if (voice === undefined) return;
    setPhase("starting");
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
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const chunks: Float32Array[] = [];
    let recorded = 0;
    const limit = VOICE_MAX_SECONDS * context.sampleRate;
    processor.onaudioprocess = (event) => {
      const chunk = new Float32Array(event.inputBuffer.getChannelData(0));
      chunks.push(chunk);
      recorded += chunk.length;
      setLevel(levelOf(chunk));
      // Main refuses a longer one; it is ended here, and kept, instead.
      if (recorded >= limit) finish();
    };
    source.connect(processor);
    // A processor that goes nowhere is not run; its output is silence.
    processor.connect(context.destination);
    recording.current = {
      stream,
      context,
      chunks,
      stop: () => {
        processor.onaudioprocess = null;
        source.disconnect();
        processor.disconnect();
      },
    };
    setPhase("recording");
  }, [fail, finish, voice]);

  const toggle = useCallback(() => {
    if (phase === "idle") {
      void start().catch((error: unknown) => {
        release();
        setPhase("idle");
        latest.current.reportFailure(error);
      });
    } else if (phase === "recording") finish();
  }, [finish, phase, release, start]);

  const cancel = useCallback((): boolean => {
    if (release() === undefined) return false;
    setPhase("idle");
    return true;
  }, [release]);

  return { phase, reason, level, toggle, cancel };
}
