/**
 * A question that takes more than one answer.
 *
 * Assigning an Issue asks five things — the URL, the agent, which clone, one
 * workspace or a worktree, which branch — and each answer decides what the next
 * question is. Written as five sheets that open each other, the going-back is
 * what falls apart: Escape on the third would have to know that the second was
 * a picker of clones and not the agent list, and every new step would have to
 * be taught the shape of the one before it.
 *
 * So a flow here is a chain of steps, each a function that asks something and
 * answers with the step that comes next. The runner keeps the chain it has
 * walked, and that stack — not any individual step — is what Escape unwinds:
 * one step back, re-asked from the top of its own code, so the person sees the
 * same question with the same list and can answer it differently. Nothing in a
 * step knows where it sits, which is why a step can be moved, reused, or
 * dropped in between two others without touching either.
 *
 * **A failure is answered where it happened.** A clone that git refused, a
 * worktree whose directory is in the way — these arrive as words written for
 * the person, and the runner re-asks the step that caused them with those words
 * under the field. Anything that arrives *without* words is a broken assumption
 * in DevHub rather than something to retype, and it is thrown clear of the
 * wizard to the one place the shell shows failures it cannot explain.
 */

import type { ReactNode } from "react";
import { spokenFailure } from "../../failure";
import type { PickerItem } from "./Picker";

/** Escape: this step is done with, and the one before it is asked again. */
export const WIZARD_BACK = Symbol("wizard:back");
/** The flow is over and nothing is going to be asked. */
export const WIZARD_CANCELLED = Symbol("wizard:cancelled");

/** One question, in the terms the picker draws it. */
export interface WizardPrompt {
  readonly title: string;
  readonly placeholder: string;
  readonly initialQuery?: string;
  readonly items: readonly PickerItem[];
  readonly pinned?: readonly PickerItem[];
  readonly busy?: boolean;
  readonly note?: ReactNode;
  readonly emptyNoMatch: string;
  readonly emptyNoItems: string;
}

/** A row taken, and the field it was taken from. */
export interface WizardAnswer {
  readonly id: string;
  readonly split: boolean;
  readonly query: string;
}

export interface WizardInput {
  /**
   * Ask, and answer with the row taken. Rejects with `WIZARD_BACK` when the
   * person escapes, which the runner reads and nothing else has to.
   */
  ask(prompt: WizardPrompt): Promise<WizardAnswer>;
  /**
   * Do something slow with the person watching — a clone, a worktree, a
   * search. The message is what is being done, in the present tense.
   */
  working<T>(message: string, task: () => Promise<T>): Promise<T>;
}

/**
 * One question and what it leads to. Answering with nothing ends the flow,
 * which is how a step says "that was the last thing I needed".
 */
export type WizardStep = (
  input: WizardInput,
) => Promise<WizardStep | undefined>;

/** What the runner needs from whoever is drawing. */
export interface WizardPresenter {
  /** Draw the prompt, with the reason the last attempt failed, if there was one. */
  prompt(
    prompt: WizardPrompt,
    failure: string | undefined,
  ): Promise<WizardAnswer>;
  working<T>(message: string, task: () => Promise<T>): Promise<T>;
}

/**
 * Walk the chain until it ends, the person escapes out of the first step, or
 * something fails in a way this cannot put into words.
 */
export async function runWizard(
  start: WizardStep,
  presenter: WizardPresenter,
): Promise<void> {
  const walked: WizardStep[] = [];
  let step: WizardStep | undefined = start;
  let failure: string | undefined;

  while (step) {
    // Whether this step actually put a question on screen. A step that decides
    // for itself — "there is exactly one clone, so use it" — is not somewhere
    // Escape can come back *to*: coming back would re-run it, it would decide
    // the same way again, and the person would land on the question they were
    // trying to leave. So it is taken off the stack once it is done, and going
    // back reaches the last question that was really asked.
    let asked = false;
    const input: WizardInput = {
      ask: async (prompt) => {
        asked = true;
        const answer = await presenter.prompt(prompt, failure);
        // The reason belongs to the attempt that failed. Once the person has
        // answered the re-asked question it is history, and carrying it into
        // the next step would report a failure that step never had.
        failure = undefined;
        return answer;
      },
      working: (message, task) => presenter.working(message, task),
    };
    walked.push(step);
    try {
      const next = await step(input);
      // Only on the way forward. A step that failed stays on the stack because
      // the failure is answered by re-running it, with the reason attached.
      if (!asked) walked.pop();
      step = next;
    } catch (error: unknown) {
      if (error === WIZARD_CANCELLED) return;
      if (error === WIZARD_BACK) {
        failure = undefined;
        walked.pop();
        step = walked.pop();
        continue;
      }
      const spoken = spokenFailure(error);
      // No words means nothing to answer: it is not this person's mistake, and
      // pretending otherwise would leave them retyping a URL that was fine.
      if (!spoken) throw error;
      failure = spoken.summary;
      step = walked.pop();
    }
  }
}
