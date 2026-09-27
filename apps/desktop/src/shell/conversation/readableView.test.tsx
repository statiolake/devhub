// @vitest-environment jsdom

/**
 * A call's readable view: under its row and outside its fold, the change it
 * makes to files, the plan it set or the images it gave back — one slot for
 * every tool, cut to a height by one clip.
 */

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  EMPTY_SESSION,
  type ConversationEvent,
  type ToolEntry,
} from "../../model/conversation";
import { anchoredScrollTop } from "./Clip";
import { diffRows, shownPath } from "./EntryParts";
import { draw, entry, installResizeObserver } from "./surfaceTestKit";
import { put, tool, transcriptOf } from "./transcriptFixtures";

beforeAll(installResizeObserver);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const CWD = "/home/testuser/project";

const IN_CWD: ConversationEvent = {
  type: "session",
  session: { ...EMPTY_SESSION, cwd: CWD },
};

const PATCH = [
  "@@ -5,4 +5,5 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " const d = 5;",
].join("\n");

function edit(status: ToolEntry["status"]) {
  return put(
    tool("t1", "Edit: src/x.ts", {
      status,
      change: [{ path: `${CWD}/src/x.ts`, unifiedDiff: PATCH }],
    }),
  );
}

function readable(id: string): HTMLElement | null {
  return entry(id).querySelector<HTMLElement>(
    ":scope .conversation-tool-entry > .conversation-readable",
  );
}

describe("a diff", () => {
  it("is one row per line, numbered as its hunk says", () => {
    expect(
      diffRows(PATCH).map((row) => [row.kind, row.old ?? "", row.new ?? ""]),
    ).toEqual([
      ["hunk", "", ""],
      ["context", 5, 5],
      ["remove", 6, ""],
      ["add", "", 6],
      ["add", "", 7],
      ["context", 7, 8],
    ]);
    // A diff made from a call's input has no numbers to give.
    expect(diffRows("@@\n-a\n+b").map((row) => row.old ?? row.new)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("names a file inside the Agent's directory relative to it, and any other whole", () => {
    expect(shownPath(`${CWD}/src/x.ts`, CWD)).toBe("src/x.ts");
    expect(shownPath("/etc/hosts", CWD)).toBe("/etc/hosts");
    expect(shownPath(`${CWD}-other/x`, CWD)).toBe(`${CWD}-other/x`);
    expect(shownPath("src/x.ts", undefined)).toBe("src/x.ts");
  });
});

describe("a call's readable view", () => {
  it("is the file change, drawn row by row under the row and outside its fold, whatever the call's status", () => {
    for (const status of ["running", "succeeded", "failed"] as const) {
      cleanup();
      draw(transcriptOf([IN_CWD, edit(status)]));
      const view = readable("t1")!;
      expect(view).not.toBeNull();
      expect(view.closest("details")).toBeNull();
      expect(view.querySelector(".conversation-diff-path")).toHaveTextContent(
        /^src\/x\.ts$/,
      );
      const rows = view.querySelectorAll(".conversation-diff-line");
      expect(rows).toHaveLength(6);
      expect([...rows].map((row) => row.getAttribute("data-line"))).toEqual([
        "hunk",
        "context",
        "remove",
        "add",
        "add",
        "context",
      ]);
      expect(rows[3]).toHaveTextContent("6+const b = 3;");
      // Not again inside the fold.
      expect(
        entry("t1").querySelector(
          "details.conversation-tool .conversation-diff",
        ),
      ).toBeNull();
    }
  });

  it("is the one slot every kind of readable view is drawn in", () => {
    draw(
      transcriptOf([
        IN_CWD,
        edit("succeeded"),
        put(
          tool("t2", "TodoWrite: 0 of 1 done", {
            plan: [{ text: "Read", status: "pending" }],
          }),
        ),
        put(
          tool("t3", "Screenshot", {
            output: [
              {
                kind: "image",
                image: {
                  mediaType: "image/png",
                  source: { kind: "data", base64: "AAAA" },
                  label: "shot.png",
                },
              },
            ],
          }),
        ),
        put(tool("t4", "Bash: ls", { output: [{ kind: "text", text: "a" }] })),
      ]),
    );
    expect(readable("t1")!.querySelector(".conversation-diff")).not.toBeNull();
    expect(
      readable("t2")!.querySelector(".conversation-checklist"),
    ).not.toBeNull();
    expect(readable("t3")!.querySelector("img")).not.toBeNull();
    for (const id of ["t1", "t2", "t3"])
      expect(readable(id)!.querySelector(".conversation-clip")).not.toBeNull();
    // A call with nothing but its input and output has none.
    expect(readable("t4")).toBeNull();
  });
});

describe("a long readable view", () => {
  /** Every clipped box reports `height` of content, in a box 100 px tall. */
  function laidOut(height: number) {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      height,
    );
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(100);
  }

  it("is cut with its end fading, and opens whole and closes again", () => {
    laidOut(400);
    draw(transcriptOf([IN_CWD, edit("succeeded")]));
    const clip = readable("t1")!.querySelector(".conversation-clip")!;
    expect(clip).toHaveAttribute("data-long");
    expect(clip).not.toHaveAttribute("data-open");
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(clip).toHaveAttribute("data-open");
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(clip).not.toHaveAttribute("data-open");
  });

  it("is not cut when it fits", () => {
    laidOut(80);
    draw(transcriptOf([IN_CWD, edit("succeeded")]));
    expect(
      readable("t1")!.querySelector(".conversation-clip"),
    ).not.toHaveAttribute("data-long");
    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
  });

  it("keeps the button that closed it where it was on screen", () => {
    expect(anchoredScrollTop(5000, 600, -2400)).toBe(2000);
    laidOut(400);
    draw(transcriptOf([IN_CWD, edit("succeeded")]));
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    const scroller = document.querySelector<HTMLElement>(
      ".conversation-body .conversation-scroll",
    )!;
    scroller.scrollTop = 5000;
    // Open, the button is at 600 on screen; closed, the content above it
    // shrank by 3000.
    let top = 600;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ top }) as DOMRect,
    );
    act(() => {
      screen.getByRole("button", { name: "Show less" }).click();
      top = -2400;
    });
    expect(scroller.scrollTop).toBe(2000);
  });
});
