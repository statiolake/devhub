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
  it("defaults to ~/junk/YYYYMMDD", () => {
    expect(parseConfig("version = 2\n").scratch.daily).toBe("~/junk/YYYYMMDD");
    expect(defaultConfig().scratch.daily).toBe(DEFAULT_SCRATCH_DAILY);
  });

  it("reads a custom value and writes it back", () => {
    const config = parseConfig(scratchSetting("/data/[daily]/YYYY/MM-DD"));
    expect(config.scratch.daily).toBe("/data/[daily]/YYYY/MM-DD");
    expect(parseConfig(configToToml(config)).scratch.daily).toBe(
      "/data/[daily]/YYYY/MM-DD",
    );
  });

  it("refuses what is not one folder per day, naming the key", () => {
    for (const daily of [
      "~/junk", // no date: one folder forever
      "~/junk/YYYYMMDD-HH", // a new folder every hour
      "~/junk/YYYY/MM", // the same folder all month
      "~/[junk/YYYYMMDD", // an unclosed bracket
      "~/summaries/YYYYMMDD", // `mm` hiding in a word
      "junk/YYYYMMDD", // not a path
    ]) {
      expect(
        codeOf(() => parseConfig(scratchSetting(daily))),
        daily,
      ).toBe("invalid_scratch_daily");
    }
    expect(scratchDailyProblem("~/junk/YYYYMMDD-HH")).toEqual({
      kind: "not-one-day",
    });
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
    expect(scratchDailyPath("~/junk/YYYYMMDD", now)).toBe("~/junk/20260903");
    expect(scratchDailyPath("/d/YYYY/MMDD/[DD]", now)).toBe("/d/2026/0903/DD");
  });

  it("throws on a template the settings reader refuses", () => {
    expect(() => scratchDailyPath("~/junk/HH", new Date())).toThrow();
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
