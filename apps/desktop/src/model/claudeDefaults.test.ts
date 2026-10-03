import { describe, expect, it } from "vitest";
import {
  argumentValue,
  builtInEffort,
  claudeEffortDefault,
  claudeModelDefault,
  withUserDefault,
  type ClaudeDefaultInputs,
} from "./claudeDefaults.js";

const NOTHING: ClaudeDefaultInputs = { settings: {}, env: {}, args: [] };

describe("the model a new Claude session starts on", () => {
  it("is the account's default when nothing sets one", () => {
    expect(claudeModelDefault(NOTHING)).toEqual({ source: "built-in" });
  });

  it("is the user settings' model", () => {
    expect(
      claudeModelDefault({ ...NOTHING, settings: { user: { model: "opus" } } }),
    ).toEqual({ value: "opus", source: "user" });
  });

  it("takes managed, then local, then project settings over the user's", () => {
    const settings = {
      user: { model: "haiku" },
      project: { model: "sonnet" },
      local: { model: "opus" },
    };
    expect(claudeModelDefault({ ...NOTHING, settings })).toEqual({
      value: "opus",
      source: "local",
    });
    expect(
      claudeModelDefault({
        ...NOTHING,
        settings: { ...settings, managed: { model: "claude-x" } },
      }),
    ).toEqual({ value: "claude-x", source: "managed" });
  });

  it("takes ANTHROPIC_MODEL over the settings, and --model over both", () => {
    const inputs = {
      settings: { managed: { model: "haiku" } },
      env: { ANTHROPIC_MODEL: "sonnet" },
      args: [],
    };
    expect(claudeModelDefault(inputs)).toEqual({
      value: "sonnet",
      source: "environment",
    });
    expect(claudeModelDefault({ ...inputs, args: ["--model=opus"] })).toEqual({
      value: "opus",
      source: "argument",
    });
  });
});

describe("the effort a new Claude session starts at", () => {
  const OPUS = "claude-opus-5-5";

  it("is the model's own default when nothing sets one", () => {
    expect(claudeEffortDefault(NOTHING, OPUS)).toEqual({
      value: "medium",
      source: "built-in",
    });
    expect(claudeEffortDefault(NOTHING, "claude-opus-4-7")?.value).toBe(
      "xhigh",
    );
    expect(claudeEffortDefault(NOTHING, "claude-sonnet-4-6")?.value).toBe(
      "high",
    );
    expect(claudeEffortDefault(NOTHING, undefined)).toEqual({
      source: "built-in",
    });
  });

  it("is the level saved for the model before the top-level one", () => {
    const settings = {
      user: {
        effortLevel: "low",
        modelSettings: { [OPUS]: { effortLevel: "xhigh" } },
      },
    };
    expect(claudeEffortDefault({ ...NOTHING, settings }, OPUS)).toEqual({
      value: "xhigh",
      source: "user",
    });
    // Its 1M context window is the same model.
    expect(
      claudeEffortDefault({ ...NOTHING, settings }, `${OPUS}[1m]`)?.value,
    ).toBe("xhigh");
    expect(
      claudeEffortDefault({ ...NOTHING, settings }, "claude-haiku-4-5"),
    ).toEqual({ value: "low", source: "user" });
  });

  it("takes --effort over the settings, and CLAUDE_CODE_EFFORT_LEVEL over both", () => {
    const inputs = {
      settings: { user: { effortLevel: "low" } },
      env: {},
      args: ["--effort", "high"],
    };
    expect(claudeEffortDefault(inputs, OPUS)).toEqual({
      value: "high",
      source: "argument",
    });
    expect(
      claudeEffortDefault(
        { ...inputs, env: { CLAUDE_CODE_EFFORT_LEVEL: "max" } },
        OPUS,
      ),
    ).toEqual({ value: "max", source: "environment" });
    expect(
      claudeEffortDefault(
        { ...inputs, env: { CLAUDE_CODE_EFFORT_LEVEL: "auto" } },
        OPUS,
      ),
    ).toEqual({ value: "medium", source: "environment" });
  });
});

describe("a flag's value", () => {
  it("is the last one given, spelled either way", () => {
    expect(argumentValue(["--model", "a", "--model=b"], "--model")).toBe("b");
    expect(argumentValue(["--model"], "--model")).toBeUndefined();
    expect(argumentValue(["--models", "x"], "--model")).toBeUndefined();
  });
});

describe("changing a default in the user settings", () => {
  it("sets the model and keeps every other key", () => {
    const text = JSON.stringify({ theme: "dark", model: "haiku" });
    expect(JSON.parse(withUserDefault(text, "model", "opus"))).toEqual({
      theme: "dark",
      model: "opus",
    });
  });

  it("makes a file that is not there", () => {
    expect(withUserDefault(undefined, "model", "opus")).toBe(
      '{\n  "model": "opus"\n}\n',
    );
  });

  it("saves an effort for its model, keeping what is saved for it and others", () => {
    const text = JSON.stringify({
      modelSettings: {
        "claude-opus-5-5": { autoCompactWindow: "auto" },
        "claude-haiku-4-5": { effortLevel: "low" },
      },
    });
    expect(
      JSON.parse(
        withUserDefault(text, "effort", "high", "claude-opus-5-5[1m]"),
      ),
    ).toEqual({
      modelSettings: {
        "claude-opus-5-5": { autoCompactWindow: "auto", effortLevel: "high" },
        "claude-haiku-4-5": { effortLevel: "low" },
      },
    });
  });

  it("saves an effort for no model as the top-level level", () => {
    expect(JSON.parse(withUserDefault("{}", "effort", "low"))).toEqual({
      effortLevel: "low",
    });
  });

  it("refuses max, which is a session's only, and a file it cannot read", () => {
    expect(() => withUserDefault("{}", "effort", "max")).toThrow(/max/u);
    expect(() => withUserDefault("{ nope", "model", "opus")).toThrow(
      /not valid JSON/u,
    );
    expect(() => withUserDefault("[]", "model", "opus")).toThrow(
      /not a JSON object/u,
    );
  });
});

describe("a model's built-in effort", () => {
  it("is none without a model", () => {
    expect(builtInEffort(undefined)).toBeUndefined();
  });
});
