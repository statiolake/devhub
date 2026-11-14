import { describe, expect, it } from "vitest";
import { KIND_GROUPS, familyOf, kindOf, markPath } from "./kinds";
import { THEME_GROUPS } from "../../ipc/neovimPaintTheme";
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

  it("takes the colour its words wear in the buffer, and nothing of a plugin", () => {
    const theme = themeOf({
      groups: {
        BlinkCmpKindMethod: { fg: 0x111111 },
        CmpItemKindField: { fg: 0x222222 },
        "@function.method": { fg: 0x333333 },
      },
      kind_icons: { Method: "\u{f0295}" },
    });
    expect(theme.kinds?.colours.get("Method")).toBe(0x333333);
    expect(theme.kinds?.colours.has("Field")).toBe(false);
    expect(theme.kinds).toEqual({ colours: new Map([["Method", 0x333333]]) });
  });
});

describe("the paint theme's groups", () => {
  it("ask every group a completion kind is coloured by", () => {
    // `THEME_GROUPS` is Lua's list too (`src/ipc`), spelled out there.
    for (const group of KIND_GROUPS) expect(THEME_GROUPS).toContain(group);
  });
});
