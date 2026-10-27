import { describe, expect, it } from "vitest";
import {
  codexDefaults,
  overrideValue,
  selectedProfile,
  withCodexUserDefault,
} from "./codexDefaults.js";
import { parseTomlValue } from "./tomlDocument.js";

describe("Codex's defaults for new threads", () => {
  it("is Codex's own when nothing names one", () => {
    expect(codexDefaults({ config: undefined, args: [] })).toEqual({
      model: { source: "built-in" },
      effort: { source: "built-in" },
    });
  });

  it("reads the top level of config.toml", () => {
    expect(
      codexDefaults({
        config: { model: "gpt-a", model_reasoning_effort: "high" },
        args: [],
      }),
    ).toEqual({
      model: { value: "gpt-a", source: "user" },
      effort: { value: "high", source: "user" },
    });
  });

  it("puts the selected profile's table before the top level", () => {
    const config = {
      model: "gpt-a",
      model_reasoning_effort: "high",
      profile: "fast",
      profiles: { fast: { model: "gpt-b" }, slow: { model: "gpt-c" } },
    };
    expect(codexDefaults({ config, args: [] })).toEqual({
      model: { value: "gpt-b", source: "user" },
      effort: { value: "high", source: "user" },
    });
    expect(
      codexDefaults({ config, args: ["-c", "profile=slow"] }).model,
    ).toEqual({ value: "gpt-c", source: "user" });
  });

  it("puts a -c override among the profile's arguments first", () => {
    expect(
      codexDefaults({
        config: { model: "gpt-a" },
        args: ["-c", 'model="gpt-z"', "--config", "model_reasoning_effort=low"],
      }),
    ).toEqual({
      model: { value: "gpt-z", source: "argument" },
      effort: { value: "low", source: "argument" },
    });
  });

  it("reads an override's value as TOML, else as its text, the last one winning", () => {
    expect(overrideValue(["-c", "model=gpt-a"], "model")).toBe("gpt-a");
    expect(overrideValue(["-c", 'model = "gpt-b"'], "model")).toBe("gpt-b");
    expect(
      overrideValue(["-c", "model=gpt-a", "--config=model=gpt-c"], "model"),
    ).toBe("gpt-c");
    expect(overrideValue(["-c", "model_provider=x"], "model")).toBeUndefined();
    expect(overrideValue(["-c"], "model")).toBeUndefined();
  });

  it("selects a profile by override before the file's own key", () => {
    expect(
      selectedProfile({ config: { profile: "a" }, args: ["-c", "profile=b"] }),
    ).toBe("b");
    expect(selectedProfile({ config: { profile: "a" }, args: [] })).toBe("a");
    expect(selectedProfile({ config: undefined, args: [] })).toBeUndefined();
  });
});

describe("making a Codex default", () => {
  const PERSONAL = [
    "# my settings",
    'model = "gpt-a" # the usual',
    'approval_policy = "on-request"',
    "",
    "[mcp_servers.docs]",
    'command = "docs-mcp"',
    "",
    '[projects."/work/app"]',
    'trust_level = "trusted"',
    "",
  ].join("\n");

  it("writes a file that is not there", () => {
    expect(withCodexUserDefault(undefined, "model", "gpt-b")).toBe(
      'model = "gpt-b"\n',
    );
    expect(
      parseTomlValue(withCodexUserDefault(undefined, "effort", "xhigh")),
    ).toEqual({ model_reasoning_effort: "xhigh" });
  });

  it("changes the one value, keeping comments, tables and the rest", () => {
    const written = withCodexUserDefault(PERSONAL, "model", "gpt-b");
    expect(written).toBe(
      PERSONAL.replace('model = "gpt-a"', 'model = "gpt-b"'),
    );
  });

  it("adds an effort at the top level, above every table", () => {
    const written = withCodexUserDefault(PERSONAL, "effort", "low");
    const parsed = parseTomlValue(written);
    expect(parsed["model_reasoning_effort"]).toBe("low");
    expect(parsed["mcp_servers"]).toEqual({ docs: { command: "docs-mcp" } });
    expect(written.indexOf("model_reasoning_effort")).toBeLessThan(
      written.indexOf("[mcp_servers.docs]"),
    );
    expect(written).toContain("# my settings");
    expect(written).toContain("# the usual");
  });

  it("writes into the selected profile's table, as Codex's own picker does", () => {
    const text = `${PERSONAL}\n[profiles.fast]\nmodel = "gpt-mini"\n`;
    const written = parseTomlValue(
      withCodexUserDefault(text, "effort", "minimal", "fast"),
    );
    expect(written["profiles"]).toEqual({
      fast: { model: "gpt-mini", model_reasoning_effort: "minimal" },
    });
    expect(written["model_reasoning_effort"]).toBeUndefined();
    expect(
      parseTomlValue(withCodexUserDefault(PERSONAL, "model", "gpt-c", "new"))[
        "profiles"
      ],
    ).toEqual({ new: { model: "gpt-c" } });
  });

  it("refuses a file it cannot read, and an empty value", () => {
    expect(() => withCodexUserDefault("model = ", "model", "gpt-b")).toThrow(
      /not valid TOML, so DevHub leaves it as it is/,
    );
    expect(() => withCodexUserDefault(undefined, "model", " ")).toThrow(
      /cannot be empty/,
    );
  });
});
