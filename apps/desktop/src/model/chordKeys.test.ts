import { describe, expect, it } from "vitest";
import {
  ChordKeyError,
  chordKeyId,
  describeChordKey,
  formatChordKey,
  isModifierKey,
  keyNameForCode,
  parseChordKey,
  sameChordKey,
} from "./chordKeys.js";

describe("the key-string grammar", () => {
  it("reads a bare key and every modifier, in any order and any case", () => {
    expect(parseChordKey("n")).toEqual({
      key: "n",
      command: false,
      control: false,
      option: false,
      shift: false,
    });
    expect(parseChordKey("shift+CMD+Alt+ctrl+comma")).toEqual({
      key: "comma",
      command: true,
      control: true,
      option: true,
      shift: true,
    });
  });

  it("normalises the case of a key written as a character", () => {
    // Somebody thinking in characters writes `Shift+N`. It is the same
    // physical key, so it is accepted rather than refused, and it lands on
    // the same binding the canonical `Shift+n` does.
    expect(parseChordKey("Shift+N")).toEqual(parseChordKey("Shift+n"));
  });

  it("round-trips every default spelling through format", () => {
    for (const text of [
      "q",
      "Cmd+q",
      "Shift+n",
      "Shift+bracketleft",
      "Cmd+j",
      "comma",
      "Shift+slash",
      "1",
      "f12",
      "escape",
    ]) {
      const parsed = parseChordKey(text);
      expect(parseChordKey(formatChordKey(parsed))).toEqual(parsed);
    }
  });

  it("writes the modifiers in one order however they were typed", () => {
    expect(formatChordKey(parseChordKey("shift+cmd+n"))).toBe("Cmd+Shift+n");
    expect(formatChordKey(parseChordKey("cmd+shift+n"))).toBe("Cmd+Shift+n");
  });

  it("refuses what could never be a key, with the reason", () => {
    const problems: readonly [string, string][] = [
      ["", "empty"],
      ["   ", "empty"],
      ["Shift+", "missing_key"],
      ["Hyper+n", "unknown_modifier"],
      ["Shift+Shift+n", "duplicate_modifier"],
      // A character is not a key name: nothing can say which physical key
      // produces `{` on the layout the person will be typing on.
      ["Shift+{", "invalid_key"],
      ["Cmd+,", "invalid_key"],
      ["a b", "invalid_key"],
    ];
    for (const [text, problem] of problems) {
      let caught: unknown;
      try {
        parseChordKey(text);
      } catch (error) {
        caught = error;
      }
      expect(caught, text).toBeInstanceOf(ChordKeyError);
      expect((caught as ChordKeyError).problem, text).toBe(problem);
    }
  });

  it("treats two spellings of one stroke as one key", () => {
    expect(chordKeyId(parseChordKey("shift+N"))).toBe(
      chordKeyId(parseChordKey("Shift+n")),
    );
    expect(
      sameChordKey(parseChordKey("Shift+n"), parseChordKey("shift+n")),
    ).toBe(true);
    // And an absent modifier means the modifier is up, not "don't care".
    expect(sameChordKey(parseChordKey("n"), parseChordKey("Shift+n"))).toBe(
      false,
    );
  });
});

describe("naming the physical key", () => {
  it("strips the two prefixes that are pure prefix, and nothing else", () => {
    expect(keyNameForCode("KeyF")).toBe("f");
    expect(keyNameForCode("Digit1")).toBe("1");
    expect(keyNameForCode("BracketLeft")).toBe("bracketleft");
    expect(keyNameForCode("Comma")).toBe("comma");
    expect(keyNameForCode("Slash")).toBe("slash");
    expect(keyNameForCode("Escape")).toBe("escape");
    // The JIS-only keys are ordinary codes and need no special case.
    expect(keyNameForCode("IntlYen")).toBe("intlyen");
    expect(keyNameForCode("IntlRo")).toBe("intlro");
  });

  it("has no name for an event with no physical key behind it", () => {
    // Chromium reports an empty code for a few synthesised events. The empty
    // string is not a key name, so no binding can ever match one.
    expect(keyNameForCode("")).toBe("");
    expect(() => parseChordKey("")).toThrow(ChordKeyError);
  });

  it("knows a bare modifier when it sees one", () => {
    for (const code of [
      "ShiftLeft",
      "ShiftRight",
      "ControlLeft",
      "AltRight",
      "MetaLeft",
      "CapsLock",
    ]) {
      expect(isModifierKey(code), code).toBe(true);
    }
    for (const code of ["KeyP", "Digit1", "BracketLeft", "Comma"]) {
      expect(isModifierKey(code), code).toBe(false);
    }
  });
});

describe("showing a chord", () => {
  it("prints the character where DevHub can be sure of one", () => {
    expect(describeChordKey(parseChordKey("Shift+comma"))).toBe("Shift+,");
    expect(describeChordKey(parseChordKey("Shift+slash"))).toBe("Shift+/");
    expect(describeChordKey(parseChordKey("Shift+bracketleft"))).toBe(
      "Shift+[",
    );
  });

  it("falls back to the key's own name where it cannot", () => {
    expect(describeChordKey(parseChordKey("Shift+n"))).toBe("Shift+n");
    expect(describeChordKey(parseChordKey("escape"))).toBe("escape");
  });
});
