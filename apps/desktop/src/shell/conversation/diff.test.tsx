// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationActionsProvider } from "./ConversationContext";
import { Markdown } from "./Markdown";
import { isPatch, parsePatch, patchSides, splitRows } from "./patch";
import { previewKindOfFence, previewKindOfFile } from "./previewKinds";
import { fakeActions } from "./surfaceTestKit";

afterEach(cleanup);

const GIT = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1e2d3c4..5f6a7b8 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,4 +1,5 @@",
  " import { start } from './server';",
  "-const port = 3000;",
  "+const port = 8080;",
  "+const host = 'localhost';",
  " ",
  " start(port);",
  "diff --git a/old.md b/new.md",
  "similarity index 90%",
  "rename from old.md",
  "rename to new.md",
  "diff --git a/README.md b/README.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/README.md",
  "@@ -0,0 +1 @@",
  "+# App",
].join("\n");

describe("a patch, read", () => {
  it("is known by its fence and its file", () => {
    expect(previewKindOfFence("diff", GIT)?.id).toBe("diff");
    expect(previewKindOfFence("patch", "@@ -1 +1 @@\n-a\n+b")?.id).toBe("diff");
    expect(previewKindOfFence("diff", "just words")).toBeUndefined();
    expect(previewKindOfFile("fix.patch", GIT)?.id).toBe("diff");
    expect(isPatch("--- a\n+++ b\n")).toBe(true);
  });

  it("names each file and what happened to it", () => {
    const files = parsePatch(GIT);
    expect(
      files.map(({ path, from, status }) => ({ path, from, status })),
    ).toEqual([
      { path: "src/app.ts", from: undefined, status: "modified" },
      { path: "new.md", from: "old.md", status: "renamed" },
      { path: "README.md", from: undefined, status: "added" },
    ]);
    expect(files[0]!.hunks.split("\n")).toHaveLength(7);
  });

  it("reads diff -u's files, and bare hunks", () => {
    const plain = parsePatch(
      "--- a.txt\t2026-01-01\n+++ b.txt\t2026-01-02\n@@ -1 +1 @@\n-x\n+y\n--- c.txt\n+++ c.txt\n@@ -1 +1 @@\n--- not a header\n+++ still a line\n",
    );
    expect(plain.map((file) => file.path)).toEqual(["b.txt", "c.txt"]);
    expect(plain[1]!.hunks).toBe(
      "@@ -1 +1 @@\n--- not a header\n+++ still a line",
    );
    expect(parsePatch("@@ -3,1 +3,1 @@\n-a\n+b\n")).toEqual([
      expect.objectContaining({ path: "", hunks: "@@ -3,1 +3,1 @@\n-a\n+b" }),
    ]);
  });

  it("knows each line's place in the text before and after", () => {
    const { rows, oldText, newText } = patchSides(parsePatch(GIT)[0]!.hunks);
    expect(oldText.split("\n")).toEqual([
      "import { start } from './server';",
      "const port = 3000;",
      "",
      "start(port);",
    ]);
    expect(newText.split("\n")).toHaveLength(5);
    const added = rows.filter((row) => row.kind === "add");
    expect(added.map((row) => [row.new, row.newAt])).toEqual([
      [2, 1],
      [3, 2],
    ]);
  });

  it("pairs removed and added lines side by side", () => {
    const { rows } = patchSides(parsePatch(GIT)[0]!.hunks);
    const split = splitRows(rows);
    expect(split[0]).toEqual({ hunk: "@@ -1,4 +1,5 @@" });
    expect(split[2]!.left?.text).toBe("-const port = 3000;");
    expect(split[2]!.right?.text).toBe("+const port = 8080;");
    expect(split[3]!.left).toBeUndefined();
    expect(split[3]!.right?.text).toBe("+const host = 'localhost';");
  });
});

describe("a diff block in an answer", () => {
  it("is drawn as files of changed lines, inline or side by side", () => {
    const { container } = render(
      <ConversationActionsProvider value={fakeActions()}>
        <Markdown source={"```diff\n" + GIT + "\n```\n"} streaming={false} />
      </ConversationActionsProvider>,
    );
    const figure = container.querySelector('figure[data-kind="diff"]')!;
    expect(figure).not.toBeNull();
    expect(screen.getByText("renamed")).toBeInTheDocument();
    expect(screen.getByText("added")).toBeInTheDocument();
    expect(
      figure.querySelectorAll('.conversation-diff-line[data-line="add"]'),
    ).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Show side by side" }));
    expect(figure.querySelectorAll(".conversation-diff-pair").length).toBe(6);
    fireEvent.click(screen.getByRole("button", { name: "Show inline" }));
    expect(figure.querySelector(".conversation-diff-pair")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show source" }));
    expect(
      screen.getByRole("button", { name: "Show changes" }),
    ).toBeInTheDocument();
  });

  it("copies the patch", async () => {
    const actions = fakeActions({
      showContextMenu: vi.fn().mockResolvedValue("copy-source"),
    });
    const { container } = render(
      <ConversationActionsProvider value={actions}>
        <Markdown
          source={"```patch\n@@ -1 +1 @@\n-a\n+b\n```\n"}
          streaming={false}
        />
      </ConversationActionsProvider>,
    );
    fireEvent.contextMenu(container.querySelector(".conversation-diff")!);
    await waitFor(() =>
      expect(actions.writeClipboard).toHaveBeenCalledWith(
        "@@ -1 +1 @@\n-a\n+b",
      ),
    );
  });
});
