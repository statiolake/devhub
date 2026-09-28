import { describe, expect, it } from "vitest";
import {
  ChordKeyError,
  chordKeyId,
  describeChordKey,
  formatChordKey,
  isModifierKey,
  parseChordKey,
  sameChordKey,
  strokeKey,
} from "./chordKeys.js";

describe("the key-string grammar", () => {
  it("reads a character and every modifier, in any order and any case", () => {
    expect(parseChordKey("{")).toEqual({
      key: "{",
      command: false,
      control: false,
      option: false,
      shift: false,
    });
    expect(parseChordKey("CMD+Alt+ctrl+,")).toEqual({
      key: ",",
      command: true,
      control: true,
      option: true,
      shift: false,
    });
  });

  it("folds Shift into the character, and accepts either spelling", () => {
    // The multiplexer's notation, and the character it means, are the same
    // stroke. What is stored — and written back to the file — is the
    // character.
    expect(parseChordKey("Shift+n")).toEqual(parseChordKey("N"));
    expect(parseChordKey("Shift+[")).toEqual(parseChordKey("{"));
    expect(parseChordKey("Shift+]")).toEqual(parseChordKey("}"));
    expect(parseChordKey("Shift+,")).toEqual(parseChordKey("<"));
    expect(parseChordKey("Shift+/")).toEqual(parseChordKey("?"));
    expect(parseChordKey("Shift+w")).toEqual(parseChordKey("W"));
    expect(formatChordKey(parseChordKey("Shift+["))).toBe("{");
    // Already shifted: a character with no shifted form of its own has been
    // written shifted already, so it is taken as it stands.
    expect(parseChordKey("Shift+{")).toEqual(parseChordKey("{"));
  });

  it("keeps Shift as a flag for a key with no character to put it in", () => {
    expect(parseChordKey("Shift+Escape")).toEqual({
      key: "escape",
      command: false,
      control: false,
      option: false,
      shift: true,
    });
    expect(formatChordKey(parseChordKey("shift+escape"))).toBe("Shift+escape");
    // And Shift is never written twice: on a character it is already there.
    expect(formatChordKey(parseChordKey("Shift+n"))).toBe("N");
  });

  it("round-trips every spelling through format", () => {
    for (const text of [
      "q",
      "Cmd+q",
      "N",
      "{",
      "}",
      "<",
      "?",
      ",",
      "Cmd+j",
      "1",
      "f12",
      "Shift+escape",
    ]) {
      const parsed = parseChordKey(text);
      expect(parseChordKey(formatChordKey(parsed)), text).toEqual(parsed);
    }
  });

  it("writes the modifiers in one order however they were typed", () => {
    expect(formatChordKey(parseChordKey("shift+cmd+n"))).toBe("Cmd+N");
    expect(formatChordKey(parseChordKey("cmd+shift+n"))).toBe("Cmd+N");
  });

  it("refuses what could never be a key, with the reason", () => {
    const problems: readonly [string, string][] = [
      ["", "empty"],
      ["   ", "empty"],
      ["Shift+", "missing_key"],
      ["Hyper+n", "unknown_modifier"],
      ["Shift+Shift+n", "duplicate_modifier"],
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

  it("keeps a letter's case, because the case is the Shift", () => {
    // Folding them would make `Shift+N` and `n` one binding.
    expect(chordKeyId(parseChordKey("N"))).not.toBe(
      chordKeyId(parseChordKey("n")),
    );
    expect(sameChordKey(parseChordKey("Shift+n"), parseChordKey("N"))).toBe(
      true,
    );
    // And an absent modifier still means the modifier is up.
    expect(sameChordKey(parseChordKey("N"), parseChordKey("Cmd+N"))).toBe(
      false,
    );
  });
});

/**
 * What a key event says it is.
 *
 * The character — which is what makes a binding right on a keyboard whose
 * punctuation sits somewhere else — and never the physical key.
 */
describe("reading a key event", () => {
  it("takes the character, whatever key produced it", () => {
    // US: `{` is Shift and the key at BracketLeft. JIS: the same character
    // from the key at BracketRight. One binding matches both, because both
    // events say `{`.
    expect(strokeKey("{")).toBe("{");
    expect(strokeKey("}")).toBe("}");
    // And the JIS key at BracketLeft is `@`, which is not a chord at all.
    expect(strokeKey("@")).toBe("@");
  });

  it("keeps a named key by its name, without regard to case", () => {
    expect(strokeKey("Escape")).toBe("escape");
    expect(strokeKey("ArrowLeft")).toBe("arrowleft");
  });

  it("makes no stroke of a key that produced no character", () => {
    // Not read from the physical key instead: that was a guess between two
    // layouts, for a composing key that on macOS never reaches DevHub.
    for (const absent of ["Process", "Dead", "Unidentified", ""]) {
      expect(strokeKey(absent), absent).toBeUndefined();
    }
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
  it("shows the character, which is what is printed on the key", () => {
    expect(describeChordKey(parseChordKey("Shift+,"))).toBe("<");
    expect(describeChordKey(parseChordKey("Shift+/"))).toBe("?");
    expect(describeChordKey(parseChordKey("Shift+["))).toBe("{");
    expect(describeChordKey(parseChordKey("Cmd+j"))).toBe("Cmd+j");
  });

  it("capitalises a key that has a name rather than a character", () => {
    expect(describeChordKey(parseChordKey("escape"))).toBe("Escape");
    expect(describeChordKey(parseChordKey("Shift+escape"))).toBe(
      "Shift+Escape",
    );
  });
});
