import { describe, expect, it } from "vitest";
import type { SlashCommand } from "../../model/conversation";
import { completed, completionQuery, completions } from "./commandCompletion";

function command(
  name: string,
  route: SlashCommand["route"] = "message",
  trigger: "/" | "$" = "/",
): SlashCommand {
  return { trigger, name, description: "", argumentHint: undefined, route };
}

describe("completionQuery", () => {
  it("keeps the start-of-message rule", () => {
    expect(completionQuery("/re")).toMatchObject({
      trigger: "/",
      name: "re",
      start: 0,
      leading: true,
    });
    expect(completionQuery("/")).toMatchObject({ name: "" });
  });

  it("finds a / after whitespace at the caret", () => {
    expect(completionQuery("please /re")).toMatchObject({
      name: "re",
      start: 7,
      leading: false,
    });
    expect(completionQuery("a\n/re")).toMatchObject({ start: 2 });
    expect(completionQuery("go /re and more", 6)).toMatchObject({
      name: "re",
      start: 3,
      end: 6,
    });
  });

  it("finds a / after Japanese text or a bracket", () => {
    expect(completionQuery("これを/re")).toMatchObject({
      name: "re",
      start: 3,
    });
    expect(completionQuery("これは　/re")).toMatchObject({ name: "re" });
    expect(completionQuery("(/re")).toMatchObject({ name: "re" });
  });

  it("ignores paths and URLs", () => {
    for (const text of [
      "src/foo",
      "a/b",
      "~/x",
      "./x",
      "../x",
      "see https://x.dev/re",
      "foo //re",
      "/usr/bin",
      "word1/re",
    ])
      expect(completionQuery(text)).toBeUndefined();
  });

  it("finds a $ after whitespace only", () => {
    expect(completionQuery("use $re")).toMatchObject({
      trigger: "$",
      start: 4,
    });
    expect(completionQuery("a$re")).toBeUndefined();
  });

  it("ignores a caret that is not at a name", () => {
    expect(completionQuery("/re x", 5)).toBeUndefined();
  });
});

describe("completed", () => {
  it("replaces only the token at the caret", () => {
    const text = "please /re and more";
    const query = completionQuery(text, 10)!;
    expect(completed(text, query, command("review"))).toEqual({
      text: "please /review and more",
      caret: 15,
    });
  });

  it("adds a space at the end of the text", () => {
    const query = completionQuery("do /re")!;
    expect(completed("do /re", query, command("review"))).toEqual({
      text: "do /review ",
      caret: 11,
    });
  });
});

describe("completions", () => {
  const all = [
    command("review"),
    command("clear"),
    command("model", "model"),
    command("compact"),
    command("release", "message", "$"),
  ];

  it("offers every / command as the first word", () => {
    expect(
      completions(all, completionQuery("/")!).map((each) => each.name),
    ).toEqual(["review", "clear", "model", "compact"]);
  });

  it("offers only skills and prompt commands mid-sentence", () => {
    expect(
      completions(all, completionQuery("so /")!).map((each) => each.name),
    ).toEqual(["review"]);
  });
});
