/**
 * Dictation into a field where something is written to send: the
 * conversation's composer, and the Orchestrator's answer to an escalation.
 * One microphone for both — the same button, language, waveform, tentative
 * words, shortcut (⌘⇧M in the field) and Esc — so the two cannot drift.
 *
 * `useFieldDictation` ties a recording (`useDictation.ts`) to one textarea:
 * the words go where the caret was when the recording started, phrase after
 * phrase, moved along by whatever is typed meanwhile (`placeDictation`), and
 * the caret follows them only if it was where they go. The field's owner
 * keeps its text; it is handed each change as an update of the text as it is
 * then, so words that arrive after a re-render land on the latest text.
 *
 * The box draws `DictationWaveform` behind the words while it records (give
 * it `data-dictating` then), `DictationTentative` for the words still being
 * recognised, and `DictationControls` beside its Send. The controls are
 * buttons, so a press on them is never taken for a press on the field
 * (`pressFocusesField`); the waveform takes no pointer, so a press on it is a
 * press on the box, which focuses the field and leaves the recording running.
 */

import {
  useCallback,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import type { VoiceApi, VoiceLanguage } from "../../ipc/voice";
import {
  DICTATION_KEY,
  hasDictated,
  isDictationKey,
  LANGUAGE_LABELS,
  nextLanguage,
  placeDictation,
  saveLanguage,
  savedLanguage,
  type DictationAnchor,
} from "./dictation";
import { MicIcon } from "./icons";
import { useDictation, type Dictation } from "./useDictation";

export interface FieldDictation {
  readonly dictation: Dictation;
  readonly language: VoiceLanguage;
  readonly cycleLanguage: () => void;
  /**
   * The field's own keys for dictation: ⌘⇧M starts or stops, Esc throws a
   * recording away (and goes no further, so it neither stops a turn nor
   * leaves the view). `true` when the key was dictation's.
   */
  readonly onKey: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** The field took the keyboard: someone who dictates is likely to again. */
  readonly onFieldFocus: () => void;
}

export function useFieldDictation({
  voice,
  reportFailure,
  field,
  text,
  setText,
  onWords,
}: {
  readonly voice: VoiceApi | undefined;
  readonly reportFailure: (error: unknown) => void;
  readonly field: RefObject<HTMLTextAreaElement | null>;
  /** The field's text as drawn, for a recording begun before it is mounted. */
  readonly text: string;
  /** Change the field's text, from what it is then. */
  readonly setText: (update: (current: string) => string) => void;
  /** Words went in. */
  readonly onWords?: () => void;
}): FieldDictation {
  const [language, setLanguage] = useState<VoiceLanguage>(() =>
    savedLanguage(storage()),
  );
  const anchor = useRef<DictationAnchor | undefined>(undefined);
  const dictation = useDictation({
    voice,
    language,
    reportFailure,
    onBegin: () => {
      const input = field.current;
      const current = input?.value ?? text;
      anchor.current = {
        start: input?.selectionStart ?? current.length,
        end: input?.selectionEnd ?? current.length,
        text: current,
      };
    },
    onWords: (words) => {
      const input = field.current;
      setText((current) => {
        const from = anchor.current ?? {
          start: current.length,
          end: current.length,
          text: current,
        };
        // The caret follows the words only if it was where they go: someone
        // typing elsewhere keeps their caret.
        const following =
          input === null ||
          document.activeElement !== input ||
          (input.selectionStart === input.selectionEnd &&
            input.selectionEnd === from.end &&
            current === from.text);
        const next = placeDictation(current, from, words);
        anchor.current = next.anchor;
        if (following)
          requestAnimationFrame(() => {
            input?.focus();
            input?.setSelectionRange(next.caret, next.caret);
          });
        return next.text;
      });
      onWords?.();
    },
  });
  const cycleLanguage = useCallback(() => {
    setLanguage((current) => {
      const next = nextLanguage(current);
      saveLanguage(storage(), next);
      return next;
    });
  }, []);
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (voice !== undefined && isDictationKey(event)) {
      event.preventDefault();
      dictation.toggle();
      return true;
    }
    if (event.key === "Escape" && dictation.cancel()) {
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    return false;
  };
  const onFieldFocus = () => {
    // The recogniser is loaded while they type, not when they press.
    if (voice !== undefined && hasDictated(storage())) dictation.warm();
  };
  return { dictation, language, cycleLanguage, onKey, onFieldFocus };
}

/** The words still being recognised, while there are any. */
export function DictationTentative({
  dictation,
}: {
  readonly dictation: Dictation;
}) {
  if (
    dictation.tentative === "" ||
    (dictation.phase !== "recording" && dictation.phase !== "transcribing")
  )
    return null;
  return (
    <div
      className="conversation-dictation-tentative"
      aria-live="polite"
      title="Still being recognised — goes in when you pause"
    >
      {dictation.tentative}
    </div>
  );
}

/** `localStorage`, where the page has one it may use. */
function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** What a press still waits on, as its tooltip says it; a press gives up (or stops). */
const WAITING_TITLES = {
  microphone: "Starting the microphone… — press again to give up",
  recogniser:
    "Starting speech recognition… — what you say is kept meanwhile; press to stop",
} as const;

const DICTATION_TITLES = {
  idle: `Dictate (${DICTATION_KEY})`,
  starting: "Opening the microphone… — press again to give up",
  recording: `Stop dictating (${DICTATION_KEY}) — Esc discards what is not in yet`,
  transcribing: "Finishing the last words on this Mac…",
} as const;

/**
 * The microphone and the language it listens for. The button is the state:
 * red from the frame after the press, pulsing while the microphone opens (a
 * second press gives up), with a halo of the level while it records (the
 * box behind the words draws what it hears, `DictationWaveform`), waiting
 * while it transcribes. In a build with no recogniser it is drawn
 * unavailable, and a press says why.
 */
export function DictationControls({
  dictation,
  language,
  disabled,
  cycleLanguage,
}: {
  readonly dictation: Dictation;
  readonly language: VoiceLanguage;
  readonly disabled: boolean;
  readonly cycleLanguage: () => void;
}) {
  const { phase, waitingFor } = dictation;
  const recording = phase === "recording";
  const unavailable = phase === "unavailable";
  return (
    <>
      {phase !== "unavailable" ? (
        <button
          type="button"
          className="conversation-dictation-language"
          aria-label={`Dictation language: ${LANGUAGE_LABELS[language]}`}
          title="The language dictation listens for — click to change"
          disabled={phase !== "idle"}
          onClick={cycleLanguage}
        >
          {LANGUAGE_LABELS[language]}
        </button>
      ) : null}
      <button
        type="button"
        className="conversation-dictation"
        data-phase={phase}
        aria-label={
          recording
            ? "Stop dictating"
            : phase === "starting"
              ? "Cancel dictation"
              : "Dictate"
        }
        aria-pressed={recording || phase === "starting"}
        // Unavailable is drawn so, and still pressed: the press says why.
        aria-disabled={unavailable || undefined}
        data-waiting={waitingFor}
        aria-busy={waitingFor !== undefined || undefined}
        title={
          unavailable
            ? dictation.reason
            : waitingFor !== undefined
              ? WAITING_TITLES[waitingFor]
              : DICTATION_TITLES[phase]
        }
        disabled={disabled || phase === "transcribing"}
        onClick={dictation.toggle}
        onPointerEnter={dictation.warm}
        onFocus={dictation.warm}
      >
        {waitingFor !== undefined ? (
          <span className="conversation-dictation-spinner" aria-hidden="true" />
        ) : (
          <MicIcon />
        )}
      </button>
    </>
  );
}
