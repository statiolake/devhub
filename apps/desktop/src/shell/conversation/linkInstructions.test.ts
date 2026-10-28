import { defaultUrlTransform } from "react-markdown";
import { describe, expect, it } from "vitest";
import { pathOfHref } from "./textLinks";
import {
  DIAGRAM_INSTRUCTIONS,
  FILE_LINK_INSTRUCTIONS,
  GUI_AGENT_INSTRUCTIONS,
} from "../../main/agent/conversation/linkInstructions";
import { diagramKindOf } from "./diagram";

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

describe("what GUI Agents are told about diagrams", () => {
  it("names the two fences the transcript draws, and they are drawn", () => {
    expect(DIAGRAM_INSTRUCTIONS).toContain("```mermaid");
    expect(DIAGRAM_INSTRUCTIONS).toContain("```svg");
    expect(diagramKindOf("mermaid", "graph TD")).toBe("mermaid");
    expect(
      diagramKindOf("svg", '<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    ).toBe("svg");
  });

  it("asks for small, self-contained pictures, and only where they help", () => {
    expect(DIAGRAM_INSTRUCTIONS).toMatch(/no scripts or external resources/);
    expect(DIAGRAM_INSTRUCTIONS).toMatch(/keep it small/);
    expect(DIAGRAM_INSTRUCTIONS).toMatch(/architecture/);
    // Concise: it is sent with every start and every resume.
    expect(DIAGRAM_INSTRUCTIONS.length).toBeLessThan(500);
  });

  it("is sent after the file links, on one line", () => {
    expect(GUI_AGENT_INSTRUCTIONS).toBe(
      `${FILE_LINK_INSTRUCTIONS} ${DIAGRAM_INSTRUCTIONS}`,
    );
    expect(GUI_AGENT_INSTRUCTIONS).not.toContain("\n");
  });
});
