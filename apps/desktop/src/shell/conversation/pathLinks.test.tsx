// @vitest-environment jsdom

/**
 * File paths in the conversation as links to the editor: drawn only when
 * main says the file is there, and opened with the range the text gave.
 */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  EMPTY_SESSION,
  type ConversationEvent,
} from "../../model/conversation";
import {
  draw,
  entry,
  fakeActions,
  installResizeObserver,
} from "./surfaceTestKit";
import {
  assistant,
  put,
  tool,
  transcriptOf,
  turnEnd,
} from "./transcriptFixtures";

beforeAll(installResizeObserver);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const CWD = "/work/app";

const IN_CWD: ConversationEvent = {
  type: "session",
  session: { ...EMPTY_SESSION, cwd: CWD },
};

/** Main, answering that exactly these files exist: relative ones under `CWD`. */
function machineWith(files: readonly string[]) {
  return vi.fn((cwd: string | undefined, paths: readonly string[]) =>
    Promise.resolve(
      paths.map((path) => {
        const absolute = path.startsWith("/") ? path : `${cwd}/${path}`;
        return files.includes(absolute) ? absolute : null;
      }),
    ),
  );
}

/** Let the batch be asked, and its answer drawn. */
async function answered(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function links(): readonly HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".conversation-path-link")];
}

describe("a path in the Agent's prose", () => {
  it("is a link once main says it is a file, and plain text when it is not", async () => {
    const resolvePaths = machineWith([`${CWD}/src/a.ts`]);
    draw(
      transcriptOf([
        IN_CWD,
        put(assistant("a1", "Changed src/a.ts:12 but not src/gone.ts.\n")),
      ]),
      fakeActions({ resolvePaths }),
    );
    await answered();
    expect(resolvePaths).toHaveBeenCalledTimes(1);
    expect(resolvePaths).toHaveBeenCalledWith(CWD, ["src/a.ts", "src/gone.ts"]);
    expect(links().map((link) => link.textContent)).toEqual(["src/a.ts:12"]);
    expect(entry("a1")).toHaveTextContent(
      "Changed src/a.ts:12 but not src/gone.ts.",
    );
  });

  it("opens the file at the range it names, and says a failure to", async () => {
    const failure = new Error("/work/app/src/a.ts is no longer there.");
    const openFile = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(failure);
    const actions = fakeActions({
      resolvePaths: machineWith([`${CWD}/src/a.ts`]),
      openFile,
    });
    draw(
      transcriptOf([
        IN_CWD,
        put(assistant("a1", "See `src/a.ts#L12-L20` for it.\n")),
      ]),
      actions,
    );
    await answered();
    const [link] = links();
    fireEvent.click(link!);
    expect(openFile).toHaveBeenCalledWith(`${CWD}/src/a.ts`, {
      kind: "lines",
      from: 12,
      to: 20,
    });
    fireEvent.click(link!);
    await answered();
    expect(actions.reportFailure).toHaveBeenCalledWith(failure);
  });

  it("is not looked for in a fenced code block, nor while it streams", async () => {
    const resolvePaths = machineWith([`${CWD}/src/a.ts`]);
    const view = draw(
      transcriptOf([
        IN_CWD,
        put(
          assistant("a1", "```ts\nimport a from 'src/a.ts';\n```\n\nsrc/a.ts", {
            streaming: true,
          }),
        ),
      ]),
      fakeActions({ resolvePaths }),
    );
    await answered();
    expect(resolvePaths).not.toHaveBeenCalled();
    view.redraw(
      transcriptOf([
        IN_CWD,
        put(
          assistant("a1", "```ts\nimport a from 'src/a.ts';\n```\n\nsrc/a.ts"),
        ),
      ]),
    );
    await answered();
    // Once: the prose's, not the code's.
    expect(links()).toHaveLength(1);
    expect(links()[0]!.closest("pre")).toBeNull();
  });

  it("asks again about a word that named nothing once a turn has ended", async () => {
    const files: string[] = [];
    const resolvePaths = vi.fn(
      (_cwd: string | undefined, paths: readonly string[]) =>
        Promise.resolve(
          paths.map((path) =>
            files.includes(`${CWD}/${path}`) ? `${CWD}/${path}` : null,
          ),
        ),
    );
    const said = put(assistant("a1", "I will write src/new.ts next.\n"));
    const view = draw(
      transcriptOf([IN_CWD, said]),
      fakeActions({ resolvePaths }),
    );
    await answered();
    expect(links()).toHaveLength(0);
    files.push(`${CWD}/src/new.ts`);
    view.redraw(transcriptOf([IN_CWD, said, put(turnEnd("e1"))]));
    await answered();
    await answered();
    expect(resolvePaths).toHaveBeenCalledTimes(2);
    expect(links().map((link) => link.textContent)).toEqual(["src/new.ts"]);
  });

  it("says once when main could not answer, and draws the words as text", async () => {
    const failure = new Error(
      "DevHub could not ask on box which paths are files",
    );
    const actions = fakeActions({
      resolvePaths: vi.fn(() => Promise.reject(failure)),
    });
    draw(
      transcriptOf([
        IN_CWD,
        put(assistant("a1", "See src/a.ts and src/b.ts.\n")),
      ]),
      actions,
    );
    await answered();
    expect(actions.reportFailure).toHaveBeenCalledTimes(1);
    expect(actions.reportFailure).toHaveBeenCalledWith(failure);
    expect(links()).toHaveLength(0);
  });
});

describe("a path in a tool call", () => {
  it("links its title's target, its output's grep lines and its diff's header", async () => {
    const openFile = vi.fn(() => Promise.resolve());
    const resolvePaths = machineWith([
      `${CWD}/src/a.ts`,
      `${CWD}/src/b.ts`,
      `${CWD}/src/x.ts`,
    ]);
    draw(
      transcriptOf([
        IN_CWD,
        put(
          tool("t1", "Grep: needle", {
            output: [
              { kind: "text", text: "src/a.ts:3:needle\nsrc/b.ts:9:needle" },
            ],
          }),
        ),
        put(tool("t2", "Read: src/a.ts")),
        put(
          tool("t3", "Edit: src/x.ts", {
            change: [
              {
                path: `${CWD}/src/x.ts`,
                unifiedDiff: "@@ -5,2 +7,2 @@\n-a\n+b",
              },
            ],
          }),
        ),
      ]),
      fakeActions({ resolvePaths, openFile }),
    );
    await answered();
    expect(
      [...entry("t1").querySelectorAll(".conversation-path-link")].map(
        (link) => link.textContent,
      ),
    ).toEqual(["src/a.ts:3", "src/b.ts:9"]);
    const title = entry("t2").querySelector<HTMLElement>(
      ".conversation-tool-target .conversation-path-link",
    );
    expect(title).toHaveTextContent("src/a.ts");
    fireEvent.click(title!);
    expect(openFile).toHaveBeenLastCalledWith(`${CWD}/src/a.ts`, undefined);
    // The link is followed; the row it is on does not open.
    expect(entry("t2").querySelector("details")).not.toHaveAttribute("open");

    const header = entry("t3").querySelector<HTMLElement>(
      ".conversation-diff-path .conversation-path-link",
    );
    fireEvent.click(header!);
    expect(openFile).toHaveBeenLastCalledWith(`${CWD}/src/x.ts`, {
      kind: "line",
      line: 7,
      column: 1,
    });
    expect(screen.getAllByTitle(/in the editor$/u).length).toBeGreaterThan(0);
  });
});
