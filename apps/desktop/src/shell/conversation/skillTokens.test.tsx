// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { SlashCommand } from "../../model/conversation";
import { skillWords, tokenizeSkills } from "./skillTokens";

function command(trigger: "/" | "$", name: string): SlashCommand {
  return {
    trigger,
    name,
    description: "",
    argumentHint: undefined,
    route: "message",
  };
}

const WORDS = skillWords([
  command("/", "review"),
  command("/", "plugin:skill"),
  command("$", "release-notes"),
]);

const skills = (text: string) =>
  tokenizeSkills(text, WORDS)
    .filter((segment) => segment.skill)
    .map((segment) => segment.text);

describe("tokenizeSkills", () => {
  it("marks a known command as the message's first word", () => {
    expect(skills("/review src/a.ts")).toEqual(["/review"]);
    expect(skills("/plugin:skill go")).toEqual(["/plugin:skill"]);
  });

  it("leaves an unknown name plain", () => {
    expect(skills("/foo bar")).toEqual([]);
  });

  it("takes a / only at the start of the message", () => {
    expect(skills("please /review")).toEqual([]);
  });

  it("takes a $ skill after any whitespace but not inside a word", () => {
    expect(skills("use $release-notes\nthen $release-notes")).toEqual([
      "$release-notes",
      "$release-notes",
    ]);
    expect(skills("a$release-notes")).toEqual([]);
  });

  it("does not take a / name for a $ one", () => {
    expect(skills("$review")).toEqual([]);
  });

  it("leaves trailing punctuation out of the name", () => {
    expect(tokenizeSkills("/review.", WORDS)).toEqual([
      { text: "/review", skill: true },
      { text: ".", skill: false },
    ]);
  });

  it("reads back as the same text", () => {
    const text = "/review a $release-notes, \n$nope é";
    expect(
      tokenizeSkills(text, WORDS)
        .map((segment) => segment.text)
        .join(""),
    ).toBe(text);
  });

  it("is one plain run with no known names", () => {
    expect(tokenizeSkills("/review", new Set())).toEqual([
      { text: "/review", skill: false },
    ]);
  });
});
