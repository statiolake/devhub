import { describe, expect, it } from "vitest";
import { familyOf, iconKinds, kindOf, markPath } from "./kinds";
import { themeOf } from "./chrome";

describe("a completion kind", () => {
  it("is named by LSP's word, an icon before it, or Vim's letter", () => {
    expect(kindOf("Method")).toBe("Method");
    expect(kindOf("\u{f0295} function")).toBe("Function");
    expect(kindOf("v")).toBe("Variable");
    expect(kindOf("[snip]")).toBeUndefined();
  });

  it("is a mark by its family", () => {
    expect(familyOf("Method")).toBe("callable");
    expect(familyOf("Field")).toBe("member");
    expect(familyOf("EnumMember")).toBe("value");
    expect(markPath("value", 10).fill).toBe(true);
    expect(markPath("callable", 10)).toEqual({
      d: "M2 8.5L5 1.5L8 8.5",
      fill: false,
      stroke: 1,
    });
  });

  it("is known by the person's own kind icons, the first kind winning a shared glyph", () => {
    const icons = iconKinds({
      Method: "A",
      Function: "A ",
      Value: "B",
      Enum: "B",
    });
    expect(icons.get("A")).toBe("Method");
    expect(icons.get("B")).toBe("Value");
  });

  it("takes the kind's own colour, not a plugin's one colour for all", () => {
    const theme = themeOf({
      groups: {
        BlinkCmpKind: { fg: 0x111111 },
        BlinkCmpKindMethod: { fg: 0x111111 },
        BlinkCmpKindField: { fg: 0x222222 },
        "@function.method": { fg: 0x333333 },
      },
      kind_icons: { Method: "\u{f0295}" },
    });
    expect(theme.kinds?.colours.get("Method")).toBe(0x333333);
    expect(theme.kinds?.colours.get("Field")).toBe(0x222222);
    expect(theme.kinds?.icons.get("\u{f0295}")).toBe("Method");
  });
});
