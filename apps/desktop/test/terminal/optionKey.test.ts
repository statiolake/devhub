/**
 * Which Option presses are Meta, by `[terminal] mac_option_is_meta`.
 *
 * The bytes are xterm's: with its `macOptionIsMeta` on, Option+X is `ESC x`,
 * and off, Option composes. What is DevHub's is the per-key answer to "on or
 * off", and that is what is pinned here — including the two things a Mac
 * keyboard does not tell a letter's keydown: which Option is held, and that a
 * Japanese keyboard's Option+¥ is a backslash rather than a chord.
 */

import { describe, expect, it } from "vitest";
import {
  OptionKeys,
  type OptionKeyEvent,
} from "../../src/shell/surfaces/optionKey";

const down = (code: string, altKey = true): OptionKeyEvent => ({
  type: "keydown",
  code,
  altKey,
});
const up = (code: string, altKey = false): OptionKeyEvent => ({
  type: "keyup",
  code,
  altKey,
});

describe("Option as Meta in DevHub's terminals", () => {
  it("is never Meta by default, so Option types what the layout puts on it", () => {
    const keys = new OptionKeys();
    keys.isMeta(false, down("AltLeft"));
    expect(keys.isMeta(false, down("KeyX"))).toBe(false);
    keys.isMeta(false, down("AltRight"));
    expect(keys.isMeta(false, down("KeyE"))).toBe(false);
  });

  it("is Meta for either Option with true", () => {
    const keys = new OptionKeys();
    keys.isMeta(true, down("AltLeft"));
    expect(keys.isMeta(true, down("KeyX"))).toBe(true);
    keys.isMeta(true, up("AltLeft"));
    keys.isMeta(true, down("AltRight"));
    expect(keys.isMeta(true, down("KeyX"))).toBe(true);
  });

  it("is Meta for the left Option only with left; the right one composes", () => {
    const keys = new OptionKeys();
    keys.isMeta("left", down("AltLeft"));
    expect(keys.isMeta("left", down("KeyX"))).toBe(true);
    expect(keys.isMeta("left", down("KeyE"))).toBe(true);
    keys.isMeta("left", up("AltLeft"));

    keys.isMeta("left", down("AltRight"));
    expect(keys.isMeta("left", down("KeyX"))).toBe(false);
    expect(keys.isMeta("left", down("Digit2"))).toBe(false);
    keys.isMeta("left", up("AltRight"));
  });

  it("follows each side up and down when both are held", () => {
    const keys = new OptionKeys();
    keys.isMeta("left", down("AltRight"));
    keys.isMeta("left", down("AltLeft"));
    expect(keys.isMeta("left", down("KeyN"))).toBe(true);
    // Left comes up while right is still held: altKey stays true.
    keys.isMeta("left", up("AltLeft", true));
    expect(keys.isMeta("left", down("KeyN"))).toBe(false);
  });

  it("counts an Option it never saw go down as composing", () => {
    // Held before the terminal had focus: the letter says Option, not which.
    const keys = new OptionKeys();
    expect(keys.isMeta("left", down("KeyX"))).toBe(false);
  });

  it("forgets a side whose keyup went to another window", () => {
    const keys = new OptionKeys();
    keys.isMeta("left", down("AltLeft"));
    // No keyup: focus left while it was held. The next key without Option
    // says it is up.
    keys.isMeta("left", down("KeyA", false));
    expect(keys.isMeta("left", down("KeyX"))).toBe(false);
  });

  it("keeps Option+¥ the JIS backslash whatever the setting", () => {
    for (const setting of [true, "left", false] as const) {
      const keys = new OptionKeys();
      keys.isMeta(setting, down("AltLeft"));
      expect(keys.isMeta(setting, down("IntlYen"))).toBe(false);
      // …and only that key: the next letter is Meta again.
      expect(keys.isMeta(setting, down("KeyX"))).toBe(setting !== false);
    }
  });

  it("answers the keypress and keyup of a chord as its keydown", () => {
    const keys = new OptionKeys();
    keys.isMeta("left", down("AltLeft"));
    expect(
      keys.isMeta("left", { type: "keypress", code: "KeyX", altKey: true }),
    ).toBe(true);
    expect(
      keys.isMeta("left", { type: "keyup", code: "KeyX", altKey: true }),
    ).toBe(true);
  });

  it("leaves typing without Option alone", () => {
    const keys = new OptionKeys();
    // No Option: xterm reads the switch only with altKey, so the answer is
    // the resting one and changes nothing.
    expect(keys.isMeta("left", down("KeyX", false))).toBe(false);
    expect(keys.isMeta(false, down("KeyX", false))).toBe(false);
  });
});
