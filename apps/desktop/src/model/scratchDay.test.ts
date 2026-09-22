import { describe, expect, it } from "vitest";
import {
  ConfigError,
  configToToml,
  defaultConfig,
  parseConfig,
} from "./config.js";
import {
  DEFAULT_SCRATCH_DAILY,
  expandHome,
  nextLocalMidnight,
  scratchDailyPath,
  scratchDailyProblem,
} from "./scratchDay.js";

function scratchSetting(daily: string): string {
  return `version = 2\n[scratch]\ndaily = ${JSON.stringify(daily)}\n`;
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof ConfigError ? error.code : "not-a-config-error";
  }
  return undefined;
}

describe("[scratch] daily", () => {
  it("defaults to ~/junk/%Y%m%d", () => {
    expect(parseConfig("version = 2\n").scratch.daily).toBe("~/junk/%Y%m%d");
    expect(defaultConfig().scratch.daily).toBe(DEFAULT_SCRATCH_DAILY);
  });

  it("reads a custom value and writes it back", () => {
    const config = parseConfig(scratchSetting("/data/daily/%Y/%m-%d"));
    expect(config.scratch.daily).toBe("/data/daily/%Y/%m-%d");
    expect(parseConfig(configToToml(config)).scratch.daily).toBe(
      "/data/daily/%Y/%m-%d",
    );
  });

  it("refuses a field it does not understand, naming the key", () => {
    for (const daily of ["~/junk/%Y%m%d-%H", "~/junk/%j", "~/junk/%Y%"]) {
      expect(codeOf(() => parseConfig(scratchSetting(daily)))).toBe(
        "invalid_scratch_daily",
      );
    }
    expect(scratchDailyProblem("~/junk/%Y%m%d-%H")).toEqual({
      kind: "unknown-field",
      field: "%H",
    });
  });

  it("refuses a relative path and a path with no date", () => {
    expect(codeOf(() => parseConfig(scratchSetting("junk/%Y")))).toBe(
      "invalid_scratch_daily",
    );
    expect(codeOf(() => parseConfig(scratchSetting("~/junk")))).toBe(
      "invalid_scratch_daily",
    );
  });

  it("refuses an unknown key in the table", () => {
    expect(
      codeOf(() => parseConfig('version = 2\n[scratch]\nfolder = "~/x"\n')),
    ).toBe("unknown_key");
  });
});

describe("scratchDailyPath", () => {
  it("names the local day", () => {
    const now = new Date(2026, 8, 3, 23, 59);
    expect(scratchDailyPath("~/junk/%Y%m%d", now)).toBe("~/junk/20260903");
    expect(scratchDailyPath("/d/%Y/%m/%d/%%", now)).toBe("/d/2026/09/03/%");
  });

  it("throws on a template the settings reader refuses", () => {
    expect(() => scratchDailyPath("~/junk/%H", new Date())).toThrow();
  });

  it("expands ~ against the given home", () => {
    expect(expandHome("~/junk/20260903", "/home/testuser")).toBe(
      "/home/testuser/junk/20260903",
    );
    expect(expandHome("/abs/x", "/home/testuser")).toBe("/abs/x");
  });
});

describe("nextLocalMidnight", () => {
  it("is the first instant of the next local day, month and year included", () => {
    expect(nextLocalMidnight(new Date(2026, 8, 22, 13, 5))).toEqual(
      new Date(2026, 8, 23),
    );
    expect(nextLocalMidnight(new Date(2026, 11, 31, 23, 59, 59))).toEqual(
      new Date(2027, 0, 1),
    );
    expect(nextLocalMidnight(new Date(2026, 8, 23))).toEqual(
      new Date(2026, 8, 24),
    );
  });
});
