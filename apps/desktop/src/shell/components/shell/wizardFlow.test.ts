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
  question: "",
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
  const asked: {
    title: string;
    failure: string | undefined;
    step: number;
  }[] = [];
  let next = 0;
  const presenter: WizardPresenter = {
    prompt: (prompt, asking) => {
      asked.push({ title: prompt.title, ...asking });
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
      { title: "url", failure: undefined, step: 1 },
      { title: "url", failure: "Repository not found.", step: 1 },
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

    expect(asked.at(-1)).toEqual({
      title: "branch",
      failure: undefined,
      step: 2,
    });
  });

  it("goes back past a step that decided instead of asking", async () => {
    // The repository step skips itself when there is exactly one clone. Escape
    // from the question after it must reach the question *before* it — coming
    // back to a step that asks nothing would re-run it, it would decide the
    // same way again, and the person would land where they started.
    const { presenter, asked } = scripted(["a", WIZARD_BACK, "a", "b"]);
    let decisions = 0;
    const third: WizardStep = async (input) => {
      await input.ask({ ...EMPTY, title: "worktree" });
      return undefined;
    };
    const decided: WizardStep = () => {
      decisions += 1;
      return Promise.resolve(third);
    };
    const first: WizardStep = async (input) => {
      await input.ask({ ...EMPTY, title: "agent" });
      return decided;
    };

    await runWizard(first, presenter);

    expect(asked.map((entry) => entry.title)).toEqual([
      "agent",
      "worktree",
      "agent",
      "worktree",
    ]);
    // Walked forward twice, so decided twice — and never became a destination.
    expect(decisions).toBe(2);
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
