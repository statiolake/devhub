/**
 * The wizard on screen: one picker at a time, and a panel while something slow
 * is happening.
 *
 * There is deliberately nothing here but presentation. Which question comes
 * next, what happens to the answer and what a failure means all live in the
 * flow's steps (`wizardFlow.ts`), so this component is the same for every flow and
 * a flow can be tested without a screen.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Picker } from "./Picker";
import {
  runWizard,
  WIZARD_BACK,
  type WizardAnswer,
  type WizardPrompt,
  type WizardStep,
} from "./wizardFlow";

export interface WizardProps {
  /** The first question. Everything after it is that step's answer. */
  readonly start: WizardStep;
  /** The flow ended: finished, escaped out of, or failed. */
  readonly onFinished: () => void;
}

type Screen =
  | {
      readonly kind: "prompt";
      readonly step: number;
      readonly prompt: WizardPrompt;
      readonly failure: string | undefined;
      readonly answer: (answer: WizardAnswer) => void;
      readonly back: () => void;
    }
  | { readonly kind: "working"; readonly message: string };

export function Wizard({ start, onFinished }: WizardProps) {
  const [screen, setScreen] = useState<Screen>();
  // The flow is started once and outlives every render of it. A second run
  // would ask the same questions into a presenter nobody is reading.
  const started = useRef(false);
  const finish = useRef(onFinished);
  finish.current = onFinished;

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    let step = 0;
    void runWizard(start, {
      prompt: (prompt, failure) =>
        new Promise<WizardAnswer>((resolve, reject) => {
          step += 1;
          setScreen({
            kind: "prompt",
            step,
            prompt,
            failure,
            answer: resolve,
            back: () => {
              reject(WIZARD_BACK);
            },
          });
        }),
      working: async (message, task) => {
        setScreen({ kind: "working", message });
        return task();
      },
      // A failure with no words of its own is rethrown by the runner, and
      // reaches the root handler as an unhandled rejection — the one place the
      // shell draws a failure it cannot explain. It is not caught here, where
      // the only thing to do with it would be to hide it.
    }).finally(() => {
      finish.current();
    });
  }, [start]);

  if (!screen) return null;
  if (screen.kind === "working") {
    return createPortal(
      <div className="mac-scrim mac" role="presentation">
        <section
          className="mac-sheet picker wizard-working"
          role="dialog"
          aria-modal="true"
          aria-label={screen.message}
        >
          <span className="mac-spinner" aria-hidden="true" />
          <p className="mac-caption" role="status">
            {screen.message}
          </p>
        </section>
      </div>,
      document.body,
    );
  }

  return (
    <Picker
      // A new question is a new field: the remount is what clears what was
      // typed into the last one, and what puts the caret after a starting
      // value the new step supplied.
      key={screen.step}
      title={screen.prompt.title}
      placeholder={screen.prompt.placeholder}
      initialQuery={screen.prompt.initialQuery}
      items={screen.prompt.items}
      pinned={screen.prompt.pinned}
      busy={screen.prompt.busy}
      emptyNoMatch={screen.prompt.emptyNoMatch}
      emptyNoItems={screen.prompt.emptyNoItems}
      note={
        screen.failure ? (
          <span className="picker-note-failure">{screen.failure}</span>
        ) : (
          screen.prompt.note
        )
      }
      onChoose={screen.answer}
      // Escape is one step back, wherever it is pressed. On the first question
      // there is nothing behind it, so the flow ends — which is what Escape
      // does in every other sheet DevHub has.
      onCancel={screen.back}
    />
  );
}
