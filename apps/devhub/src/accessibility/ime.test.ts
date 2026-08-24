import { describe, expect, it } from "vitest";
import { isImeComposing } from "./ime";

describe("IME keyboard guard", () => {
  it.each([
    [{ isComposing: true, keyCode: 13 }, true],
    [{ isComposing: false, keyCode: 229 }, true],
    [{ isComposing: false, keyCode: 13 }, false],
  ] as const)("recognizes native composition state", (event, expected) => {
    expect(isImeComposing(event)).toBe(expected);
  });

  it("keeps the fallback composition flag authoritative", () => {
    expect(isImeComposing({ isComposing: false, keyCode: 13 }, true)).toBe(
      true,
    );
  });
});
