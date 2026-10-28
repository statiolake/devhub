import { defaultUrlTransform } from "react-markdown";
import { describe, expect, it } from "vitest";
import { pathOfHref } from "./textLinks";
import {
  FILE_LINK_INSTRUCTIONS,
  GUI_AGENT_INSTRUCTIONS,
  RICH_OUTPUT_INSTRUCTIONS,
} from "../../main/agent/conversation/linkInstructions";
import { previewKindOfFence, previewKindsOfPath } from "./previewKinds";

/** The `[text](target)` links the instructions give as examples, as Markdown reads their targets. */
function exampleTargets(text: string): readonly string[] {
  return [...text.matchAll(/\]\((?:<([^>]*)>|([^)\s]*))\)/gu)].map((match) =>
    match[1] !== undefined ? encodeURI(match[1]) : (match[2] ?? ""),
  );
}

describe("what GUI Agents are told about file links", () => {
  it("gives examples that the conversation opens as files, at their line", () => {
    const targets = exampleTargets(FILE_LINK_INSTRUCTIONS);
    expect(targets).toEqual([
      "src/app.ts#L42",
      "README.md",
      "docs/my%20file.ts#L3",
    ]);
    for (const target of targets) {
      // Kept by the transcript's Markdown, not dropped as a scheme.
      expect(defaultUrlTransform(target)).toBe(target);
      expect(pathOfHref(target)).toBeDefined();
    }
    expect(pathOfHref("src/app.ts#L42")).toEqual({
      path: "src/app.ts",
      range: { kind: "line", line: 42, column: 1 },
    });
    expect(pathOfHref("docs/my%20file.ts#L3")?.path).toBe("docs/my file.ts");
  });

  it("asks for #L positions, which survive a file at the top of the folder", () => {
    expect(defaultUrlTransform("a.ts#L42-L50")).toBe("a.ts#L42-L50");
    // The form it does not ask for: Markdown would read `a.ts:` as a scheme.
    expect(defaultUrlTransform("a.ts:42")).toBe("");
  });

  it("rules out remote links for local files", () => {
    expect(FILE_LINK_INSTRUCTIONS).toContain("Never link a GitHub");
    expect(FILE_LINK_INSTRUCTIONS).toContain(
      "relative to your working directory",
    );
  });
});

describe("what GUI Agents are told about rich output", () => {
  const FENCES = [
    "```svg",
    "```mermaid",
    "```markdown",
    "```marp",
    "```diff",
    "```html",
    "```vega-lite",
  ];

  it("names every fence the transcript draws, and each is drawn", () => {
    for (const fence of FENCES) {
      expect(RICH_OUTPUT_INSTRUCTIONS).toMatch(
        new RegExp(`${fence}(?![\\w-])`, "u"),
      );
    }
    const samples: Record<string, string> = {
      svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      mermaid: "graph TD",
      markdown: "# A",
      marp: "# A",
      diff: "@@ -1 +1 @@\n-a\n+b",
      html: "<p>a</p>",
      "vega-lite": '{"mark": "bar"}',
    };
    for (const fence of FENCES) {
      const word = fence.slice(3);
      expect(previewKindOfFence(word, samples[word]!)?.id).toBe(word);
    }
    expect(RICH_OUTPUT_INSTRUCTIONS).toContain("`marp: true`");
  });

  it("names the files it embeds by ![alt](path), and that they redraw", () => {
    expect(RICH_OUTPUT_INSTRUCTIONS).toContain("![alt](path)");
    for (const name of [
      "a.png",
      "a.svg",
      "a.md",
      "a.mmd",
      "a.diff",
      "a.html",
      "a.vl.json",
    ]) {
      const extension = name.slice(1);
      expect(RICH_OUTPUT_INSTRUCTIONS).toContain(
        extension === ".png" ? "PNG" : extension,
      );
      expect(previewKindsOfPath(name).length).toBeGreaterThan(0);
    }
    expect(RICH_OUTPUT_INSTRUCTIONS).toMatch(/redrawn when the file changes/);
  });

  it("says which to use when, as the person asked", () => {
    // A figure: inline SVG first, a file embedded once it is revised.
    expect(RICH_OUTPUT_INSTRUCTIONS).toMatch(
      /diagram or figure: an inline ```svg first; once it is being revised, write the SVG to a file and embed it/,
    );
    // A chart: inline Vega-Lite, or a script's output embedded.
    expect(RICH_OUTPUT_INSTRUCTIONS).toMatch(
      /chart or graph: inline ```vega-lite, or embed a script's output/,
    );
    expect(RICH_OUTPUT_INSTRUCTIONS).toMatch(
      /Slides: Marp, best as a \.md file embedded/,
    );
    expect(RICH_OUTPUT_INSTRUCTIONS).toMatch(
      /write-up or document: HTML, best as a file embedded/,
    );
    expect(RICH_OUTPUT_INSTRUCTIONS).toMatch(/proposed change: ```diff/);
    expect(RICH_OUTPUT_INSTRUCTIONS).toMatch(
      /Never ASCII art: anything picture-like is SVG/,
    );
    expect(RICH_OUTPUT_INSTRUCTIONS).toMatch(
      /no scripts or external resources/,
    );
    expect(RICH_OUTPUT_INSTRUCTIONS).toMatch(/keep it small/);
    // Concise: it is sent with every start and every resume.
    expect(RICH_OUTPUT_INSTRUCTIONS.length).toBeLessThan(1000);
  });

  it("is sent after the file links, on one line", () => {
    expect(GUI_AGENT_INSTRUCTIONS).toBe(
      `${FILE_LINK_INSTRUCTIONS} ${RICH_OUTPUT_INSTRUCTIONS}`,
    );
    expect(GUI_AGENT_INSTRUCTIONS).not.toContain("\n");
  });
});
