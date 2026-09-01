/**
 * The four things the runner exists to guarantee, none of which a single step
 * can be trusted with:
 *
 * 1. answers chain — a step's answer names the next step, and it is asked;
 * 2. Escape re-asks the step before, from its own code, so the question comes
 *    back with the list it had rather than a remembered snapshot of it;
 * 3. a failure that arrived with words for the person re-asks the step that
 *    caused it, carrying those words;
 * 4. a failure with no such words is not the person's to answer and leaves the
 *    wizard entirely.
 */

import { describe, expect, it, vi } from "vitest";
import { UserFacingFailure } from "../../failure";
import {
  runWizard,
  WIZARD_BACK,
  type WizardAnswer,
  type WizardPresenter,
  type WizardPrompt,
  type WizardStep,
} from "./wizardFlow";

const EMPTY: Omit<WizardPrompt, "title"> = {
  placeholder: "",
  items: [],
  emptyNoMatch: "",
  emptyNoItems: "",
};

function answer(id: string): WizardAnswer {
  return { id, split: false, query: "" };
}

/**
 * A presenter that answers each question from a script, and records what it
 * was asked. `back` in the script is the person pressing Escape.
 */
function scripted(script: readonly (string | typeof WIZARD_BACK)[]) {
  const asked: { title: string; failure: string | undefined }[] = [];
  let next = 0;
  const presenter: WizardPresenter = {
    prompt: (prompt, failure) => {
      asked.push({ title: prompt.title, failure });
      const reply = script[next++];
      if (reply === undefined) throw new Error("the flow asked one too many");
      return reply === WIZARD_BACK
        ? Promise.reject(WIZARD_BACK)
        : Promise.resolve(answer(reply));
    },
    working: (_message, task) => task(),
  };
  return { presenter, asked };
}

describe("the wizard runner", () => {
  it("walks the chain each answer names", async () => {
    const { presenter, asked } = scripted(["a", "b"]);
    const second: WizardStep = async (input) => {
      await input.ask({ ...EMPTY, title: "second" });
      return undefined;
    };
    const first: WizardStep = async (input) => {
      await input.ask({ ...EMPTY, title: "first" });
      return second;
    };

    await runWizard(first, presenter);

    expect(asked.map((entry) => entry.title)).toEqual(["first", "second"]);
  });

  it("re-asks the step before when the person escapes", async () => {
    const { presenter, asked } = scripted(["a", WIZARD_BACK, "a2", "b"]);
    const second: WizardStep = async (input) => {
      await input.ask({ ...EMPTY, title: "second" });
      return undefined;
    };
    const first: WizardStep = async (input) => {
      await input.ask({ ...EMPTY, title: "first" });
      return second;
    };

    await runWizard(first, presenter);

    expect(asked.map((entry) => entry.title)).toEqual([
      "first",
      "second",
      "first",
      "second",
    ]);
  });

  it("ends when the person escapes out of the first question", async () => {
    const { presenter, asked } = scripted([WIZARD_BACK]);
    const first: WizardStep = async (input) => {
      await input.ask({ ...EMPTY, title: "first" });
      return undefined;
    };

    await runWizard(first, presenter);

    expect(asked).toHaveLength(1);
  });

  it("re-asks the failing step with the words the failure came with", async () => {
    const { presenter, asked } = scripted(["bad", "good"]);
    const clone = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new UserFacingFailure("Repository not found."))
      .mockResolvedValueOnce(undefined);
    const first: WizardStep = async (input) => {
      await input.ask({ ...EMPTY, title: "url" });
      await input.working("Cloning…", clone);
      return undefined;
    };

    await runWizard(first, presenter);

    expect(asked).toEqual([
      { title: "url", failure: undefined },
      { title: "url", failure: "Repository not found." },
    ]);
    expect(clone).toHaveBeenCalledTimes(2);
  });

  it("forgets the reason once the re-asked question is answered", async () => {
    const { presenter, asked } = scripted(["bad", "good", "next"]);
    const clone = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new UserFacingFailure("Repository not found."))
      .mockResolvedValueOnce(undefined);
    const second: WizardStep = async (input) => {
      await input.ask({ ...EMPTY, title: "branch" });
      return undefined;
    };
    const first: WizardStep = async (input) => {
      await input.ask({ ...EMPTY, title: "url" });
      await input.working("Cloning…", clone);
      return second;
    };

    await runWizard(first, presenter);

    expect(asked.at(-1)).toEqual({ title: "branch", failure: undefined });
  });

  it("lets a failure with no words for the person out of the wizard", async () => {
    const { presenter, asked } = scripted(["a"]);
    const first: WizardStep = async (input) => {
      await input.ask({ ...EMPTY, title: "url" });
      throw new TypeError("cannot read properties of undefined");
    };

    await expect(runWizard(first, presenter)).rejects.toThrow(TypeError);
    expect(asked).toHaveLength(1);
  });
});
