/**
 * A question that takes more than one answer.
 *
 * Assigning an Issue asks four things — the URL, which clone, which branch
 * (the root checkout or a worktree), which agent — and each answer decides what the next
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
/**
 * Escape while something slow was running: stop waiting, ask this step again.
 *
 * Not `WIZARD_BACK`, and the difference is the whole reason it exists. Back
 * means "I have answered this and want the question before it"; this means "I
 * am still inside this step and it is not coming back". The step is where the
 * person was, so the step is what is re-run — they see the question they last
 * answered, with what they typed still the thing to change, which is the only
 * screen from which the slow thing can be asked for differently.
 *
 * Popping the step instead, which is what back does, ended the flow outright
 * for a first step: the person who escaped a wedged lookup lost the wizard
 * rather than getting their question back.
 */
export const WIZARD_ABANDONED = Symbol("wizard:abandoned");

/** One question, in the terms the picker draws it. */
export interface WizardPrompt {
  readonly title: string;
  /**
   * What this step is asking, and why it is being asked now.
   *
   * A wizard is the one place a person can arrive at a question they never
   * went looking for — the clone folder they are shown because no clone of the
   * repository was found — so this is where saying so matters most. It is
   * required for the same reason it is required of the picker: a step that
   * cannot say what it wants has not decided what it wants.
   */
  readonly question: string;
  /** An example of the shape of an answer, where one is worth showing. */
  readonly placeholder?: string;
  readonly initialQuery?: string;
  readonly items: readonly PickerItem[];
  readonly pinned?: readonly PickerItem[];
  readonly busy?: boolean;
  readonly note?: ReactNode;
  readonly emptyNoMatch?: string;
  readonly emptyNoItems?: string;
}

/** A row taken, and the field it was taken from. */
export interface WizardAnswer {
  readonly id: string;
  readonly split: boolean;
  /** Command was held: the row's other reading, as its accessory showed it. */
  readonly alternate: boolean;
  readonly query: string;
}

/**
 * What the runner hands a sheet a step draws itself: which question it is,
 * why its last attempt failed, and the two ways out of it.
 */
export interface WizardSheetControls<T> {
  readonly step: number;
  readonly failure: string | undefined;
  readonly answer: (value: T) => void;
  /** Escape: the question before this one. */
  readonly back: () => void;
}

/** A question whose sheet is more than a list of rows known when it is asked. */
export type WizardSheet<T> = (controls: WizardSheetControls<T>) => ReactNode;

export interface WizardInput {
  /**
   * Ask, and answer with the row taken. Rejects with `WIZARD_BACK` when the
   * person escapes, which the runner reads and nothing else has to.
   */
  ask(prompt: WizardPrompt): Promise<WizardAnswer>;
  /**
   * Ask with a sheet of the step's own — one whose rows arrive while it is up,
   * or that previews the row the person is on — and answer with what it
   * answers. The same question to the runner as `ask`: on the stack, counted,
   * re-asked with the reason when what follows it fails, and left by Escape.
   */
  sheet<T>(draw: WizardSheet<T>): Promise<T>;
  /**
   * Do something slow with the person watching — a clone, a worktree, a
   * search. The message is what is being done, in the present tense.
   *
   * The task is handed the signal that fires when the person stops waiting, so
   * that abandoning the wait and abandoning the *work* are the same event
   * rather than two that have to be kept in step. A task with nothing to stop
   * ignores it and reads exactly as it did.
   */
  working<T>(
    message: string,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
}

/**
 * One question and what it leads to. Answering with nothing ends the flow,
 * which is how a step says "that was the last thing I needed".
 */
export type WizardStep = (
  input: WizardInput,
) => Promise<WizardStep | undefined>;

/** Everything about a question that is the runner's to know, not the step's. */
export interface WizardAsking {
  /** Why the last attempt at this step failed, if there was one. */
  readonly failure: string | undefined;
  /**
   * Which question this is, counting from one.
   *
   * The depth of the stack, so going back counts *down*: the person who
   * escapes off the third question is on the second, and a header that said
   * "Step 4" because four questions had been drawn would be describing the
   * drawing rather than the flow. Steps that decided for themselves are not on
   * the stack and so are not counted — they are not questions, and Escape
   * cannot come back to them.
   */
  readonly step: number;
}

/** What the runner needs from whoever is drawing. */
export interface WizardPresenter {
  prompt(prompt: WizardPrompt, asking: WizardAsking): Promise<WizardAnswer>;
  sheet<T>(draw: WizardSheet<T>, asking: WizardAsking): Promise<T>;
  working<T>(
    message: string,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
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
    const question = async <T>(
      present: (asking: WizardAsking) => Promise<T>,
    ): Promise<T> => {
      asked = true;
      // The step is already on the stack, so its depth is the stack's — and
      // a step that asks twice over (a URL that did not parse) is still the
      // same question, at the same depth, which is what the person sees.
      const answer = await present({ failure, step: walked.length });
      // The reason belongs to the attempt that failed. Once the person has
      // answered the re-asked question it is history, and carrying it into
      // the next step would report a failure that step never had.
      failure = undefined;
      return answer;
    };
    const input: WizardInput = {
      ask: (prompt) => question((asking) => presenter.prompt(prompt, asking)),
      sheet: (draw) => question((asking) => presenter.sheet(draw, asking)),
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
      if (error === WIZARD_ABANDONED) {
        // Escape goes back to the last question that was really asked — the
        // rule this runner already keeps for steps that decide for themselves,
        // applied to the step that was interrupted.
        //
        // Which step that is depends on whether this one had asked anything
        // before it started waiting. A step that asked and *then* did something
        // slow is re-run, so the person lands on the question they just
        // answered and can answer it differently. A step that begins with the
        // slow thing has no question of its own to come back to, and re-running
        // it would start the very work they escaped: a second lookup, a third,
        // and a spinner that never reports anything however long they wait.
        // That one unwinds to the step before it instead.
        failure = undefined;
        if (!asked) walked.pop();
        step = walked.pop();
        continue;
      }
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
      // A step that failed before asking anything has no question to show the
      // reason under, and re-running it would fail the same way again. The
      // reason goes under the question before it instead.
      if (!asked) walked.pop();
      step = walked.pop();
    }
  }
}
