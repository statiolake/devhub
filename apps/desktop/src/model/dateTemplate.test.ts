import { describe, expect, it } from "vitest";
import {
  dateTemplateBracketsBalance,
  expandDateTemplate,
} from "./dateTemplate.js";

// A Tuesday afternoon, chosen so every token has a distinguishable value and
// none of them is the same two digits as another.
const NOW = new Date(2026, 8, 1, 14, 25, 36);

describe("a date template", () => {
  it("expands the tokens a daily folder is named with", () => {
    expect(expandDateTemplate("~/workspace/daily/YYYY/MMDD", NOW)).toBe(
      "~/workspace/daily/2026/0901",
    );
  });

  it("reads MMDD as one token rather than MM followed by DD", () => {
    // They expand to the same string here; what is being pinned is that the
    // longer token is tried first, so a template can still say `MM-DD`.
    expect(expandDateTemplate("MMDD", NOW)).toBe("0901");
    expect(expandDateTemplate("MM-DD", NOW)).toBe("09-01");
  });

  it("knows the rest of moment's tokens", () => {
    expect(expandDateTemplate("YY HH:mm:ss", NOW)).toBe("26 14:25:36");
  });

  it("passes bracketed text through verbatim", () => {
    // Without the brackets this would be "~/2026/0901ta", because the folder
    // is called "data" and "DD" is inside it.
    expect(expandDateTemplate("~/YYYY/MMDD/[DDta]", NOW)).toBe(
      "~/2026/0901/DDta",
    );
  });

  it("leaves a path with no tokens alone", () => {
    expect(expandDateTemplate("~/workspace/scratch", NOW)).toBe(
      "~/workspace/scratch",
    );
  });

  it("says whether the brackets balance", () => {
    expect(dateTemplateBracketsBalance("~/YYYY/[DD]")).toBe(true);
    expect(dateTemplateBracketsBalance("~/YYYY/MMDD")).toBe(true);
    expect(dateTemplateBracketsBalance("~/YYYY/[DD")).toBe(false);
    expect(dateTemplateBracketsBalance("~/YYYY/DD]")).toBe(false);
  });
});
