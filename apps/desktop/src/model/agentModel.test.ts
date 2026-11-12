import { describe, expect, it } from "vitest";
import {
  modelKindProblem,
  modelOf,
  modelOverride,
  modelProblem,
  withModel,
} from "./agentModel.js";

describe("an Agent's model", () => {
  it("takes Claude's aliases and full ids, passed through, and nothing else", () => {
    for (const name of [
      "haiku",
      "sonnet",
      "opus",
      "claude-sonnet-4-5",
      "claude-opus-4-1[1m]",
      "us.anthropic.claude-sonnet-4-5-v1:0",
    ])
      expect(modelProblem(name)).toBeUndefined();
    for (const name of ["", "-p", "two words", "a\u0000b", "x".repeat(129)])
      expect(modelProblem(name)).toMatch(/--model takes a model name/u);
  });

  it("replaces the profile's --model, in either spelling, and never adds a second", () => {
    expect(
      withModel(["--model", "opus", "--verbose", "--model=opus[1m]"], "haiku"),
    ).toEqual(["--verbose", "--model", "haiku"]);
    expect(withModel(["--permission-mode", "plan"], "sonnet")).toEqual([
      "--permission-mode",
      "plan",
      "--model",
      "sonnet",
    ]);
    const twice = withModel(withModel(["--model", "opus"], "haiku"), "sonnet");
    expect(twice.filter((arg) => arg === "--model")).toHaveLength(1);
    expect(modelOf(twice)).toBe("sonnet");
  });

  it("says a model only where it differs from the profile's own", () => {
    expect(modelOverride(["--model", "haiku"], ["--model", "opus"])).toBe(
      "haiku",
    );
    expect(modelOverride(["--model", "opus"], ["--model", "opus"])).toBe(
      undefined,
    );
    expect(modelOverride(["--model", "haiku"], [])).toBe("haiku");
    expect(modelOverride([], ["--model", "opus"])).toBeUndefined();
  });

  it("refuses every kind but Claude's", () => {
    expect(modelKindProblem("claude", "claude")).toBeUndefined();
    expect(modelKindProblem("codex", "codex")).toMatch(
      /--model is for Claude profiles: 'codex' runs codex/u,
    );
    expect(modelKindProblem("custom", "shell")).toMatch(/'shell' runs custom/u);
  });
});
