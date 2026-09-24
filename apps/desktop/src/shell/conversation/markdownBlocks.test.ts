import { describe, expect, it } from "vitest";
import { grammarFor } from "./highlight";
import { settledLength } from "./markdownBlocks";

describe("settledLength", () => {
  const settled = (markdown: string) =>
    markdown.slice(0, settledLength(markdown));

  it("settles nothing before the first block has ended", () => {
    expect(settled("A paragraph still being writ")).toBe("");
    expect(settled("A paragraph\nwith two lines\n")).toBe("");
  });

  it("settles every block a blank line has ended", () => {
    expect(settled("One.\n\nTwo.\n\nThr")).toBe("One.\n\nTwo.\n\n");
  });

  it("does not settle an open fence, blank lines inside it included", () => {
    const text = "Intro.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n";
    expect(settled(text)).toBe("Intro.\n\n");
  });

  it("settles a fence on its closing line", () => {
    const text = "Intro.\n\n```ts\nconst a = 1;\n```\nMore";
    expect(settled(text)).toBe("Intro.\n\n```ts\nconst a = 1;\n```\n");
  });

  it("does not take an unterminated last line as a closing fence", () => {
    // "```" may yet become "``` js", which closes nothing.
    expect(settled("```ts\nconst a = 1;\n```")).toBe("");
  });

  it("closes a fence only with a run of the same marker at least as long", () => {
    const text = "````md\n```\ninner\n```\n````\n";
    expect(settled(text)).toBe(text);
    expect(settled("~~~\ncode\n```\n")).toBe("");
  });

  it("does not take a line with text after the marker as a closing fence", () => {
    expect(settled("```\ncode\n``` not a close\n")).toBe("");
  });
});

describe("grammarFor", () => {
  it("reads the first word of the info string, case aside", () => {
    expect(grammarFor("TypeScript")).toBe("typescript");
    expect(grammarFor("rust ignore")).toBe("rust");
    expect(grammarFor("  py ")).toBe("python");
  });

  it("knows the names people write for the grammars it has", () => {
    expect(grammarFor("ts")).toBe("typescript");
    expect(grammarFor("sh")).toBe("shellscript");
    expect(grammarFor("zsh")).toBe("shellscript");
    expect(grammarFor("dockerfile")).toBe("docker");
  });

  it("has no grammar for a language outside its set, or for no language", () => {
    expect(grammarFor("cobol")).toBeUndefined();
    expect(grammarFor("")).toBeUndefined();
    expect(grammarFor(undefined)).toBeUndefined();
    expect(grammarFor("constructor")).toBeUndefined();
  });
});
