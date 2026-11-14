// The chaos driver's plans: a seed is its run, and only what a person can do
// at once overlaps.
import { describe, expect, it } from "vitest";
import { ACTIONS, BY_NAME, plan, rng } from "./chaosActions.mjs";

describe("a chaos plan", () => {
  it("is the same for the same seed, and another for another", () => {
    expect(plan(7, 80)).toEqual(plan(7, 80));
    expect(plan(7, 80)).not.toEqual(plan(8, 80));
  });

  it("draws every action, the pathological ones too, over enough seeds", () => {
    const seen = new Set();
    for (let seed = 1; seed <= 20; seed++)
      for (const step of plan(seed, 60)) seen.add(step.name);
    expect([...seen].sort()).toEqual(ACTIONS.map((a) => a.name).sort());
  });

  it("overlaps only actions that take different hands", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const steps = plan(seed, 60);
      steps.forEach((step, i) => {
        if (!step.overlap) return;
        const a = BY_NAME.get(steps[i - 1].name).hand;
        const b = BY_NAME.get(step.name).hand;
        const free =
          a === "none" ||
          b === "none" ||
          (a !== "both" && b !== "both" && a !== b);
        expect(free).toBe(true);
        expect(steps[i - 1].burst).toBe(step.burst);
      });
    }
  });

  it("keeps to the actions named", () => {
    const steps = plan(3, 40, ["wheel", "storm"]);
    expect(new Set(steps.map((s) => s.name))).toEqual(
      new Set(["wheel", "storm"]),
    );
  });

  it("draws from a seeded generator in [0, 1)", () => {
    const r = rng(1);
    for (let i = 0; i < 1000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
