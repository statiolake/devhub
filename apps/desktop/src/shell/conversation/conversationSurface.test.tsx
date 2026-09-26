// @vitest-environment jsdom

/**
 * A GUI Agent's transcript, drawn from fixtures.
 *
 * Every entry kind is drawn from what it carries; a request is drawn from its
 * `choices` and answered with the one pressed; "Copy" copies an answer's
 * Markdown or a block's code through the page's clipboard, says so only once
 * the write lands, and hands a failed write to the page's root; a streaming
 * answer's code is coloured only once its fence has closed; and the
 * transcript follows new output only while it is scrolled to the end.
 */

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { COPIED_MS } from "./CopyButton";
import {
  draw,
  entry,
  fakeActions,
  installResizeObserver,
} from "./surfaceTestKit";
import {
  assistant,
  delta,
  notice,
  opened,
  put,
  tool,
  toolRequest,
  transcriptOf,
  turnEnd,
  user,
} from "./transcriptFixtures";

beforeAll(installResizeObserver);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("every entry kind", () => {
  it("draws a person's message and a template's, and says which is which", () => {
    draw(
      transcriptOf([
        put(user("u1", "fix the\nbuild")),
        put(user("u2", "review the diff", "injection")),
      ]),
    );
    expect(entry("u1")).toHaveTextContent("fix the build");
    expect(entry("u1")).not.toHaveTextContent("Sent by a template");
    expect(entry("u2")).toHaveTextContent("Sent by a template");
  });

  it("draws an answer's Markdown: headings, lists, tables, links, inline code, no raw HTML", () => {
    draw(
      transcriptOf([
        put(
          assistant(
            "a1",
            [
              "## Result",
              "- one\n- two",
              "| a | b |\n|---|--:|\n| 1 | 2 |",
              "See [the docs](https://example.com/docs) and `npm test`.",
              "<script>alert(1)</script><b>bold?</b>",
              "- [x] done\n- [ ] not yet",
              "~~gone~~",
            ].join("\n\n"),
          ),
        ),
      ]),
    );
    const answer = entry("a1");
    expect(
      within(answer).getByRole("heading", { level: 2, name: "Result" }),
    ).toBeInTheDocument();
    expect(within(answer).getAllByRole("listitem")).toHaveLength(4);
    const table = within(answer).getByRole("table");
    expect(within(table).getAllByRole("columnheader")).toHaveLength(2);
    expect(within(table).getByRole("cell", { name: "2" })).toHaveStyle({
      textAlign: "right",
    });
    expect(
      within(answer).getByRole("link", { name: "the docs" }),
    ).toHaveAttribute("href", "https://example.com/docs");
    expect(answer.querySelector(":not(pre) > code")).toHaveTextContent(
      "npm test",
    );
    expect(answer.querySelector("script, b")).toBeNull();
    expect(within(answer).getAllByRole("checkbox")).toHaveLength(2);
    expect(answer.querySelector("del")).toHaveTextContent("gone");
  });

  it("opens a link through the page, not in the view", () => {
    const { actions } = draw(
      transcriptOf([put(assistant("a1", "[docs](https://example.com/x)"))]),
    );
    const link = screen.getByRole("link", { name: "docs" });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(actions.openExternalUrl).toHaveBeenCalledWith(
      "https://example.com/x",
    );
  });

  it("draws no fold for thinking that came with no text", () => {
    draw(
      transcriptOf([
        put(
          assistant("a1", [
            { kind: "thinking", text: "" },
            { kind: "text", markdown: "The answer." },
          ]),
        ),
      ]),
    );
    expect(entry("a1").querySelector(".conversation-thinking")).toBeNull();
    expect(entry("a1")).toHaveTextContent("The answer.");
  });

  it("folds thinking and draws a plan with each step's state", () => {
    draw(
      transcriptOf([
        put(
          assistant("a1", [
            { kind: "thinking", text: "weighing it up" },
            {
              kind: "plan",
              steps: [
                { text: "read", status: "completed" },
                { text: "write", status: "in_progress" },
                { text: "test", status: "pending" },
              ],
            },
          ]),
        ),
      ]),
    );
    const thinking = entry("a1").querySelector("details.conversation-thinking");
    expect(thinking).not.toHaveAttribute("open");
    expect(thinking).toHaveTextContent("weighing it up");
    const steps = entry("a1").querySelectorAll(".conversation-plan > li");
    expect([...steps].map((step) => step.getAttribute("data-status"))).toEqual([
      "completed",
      "in_progress",
      "pending",
    ]);
  });

  it("says a thought is still being had while its answer streams, and was had once it has not", () => {
    const thinking = (streaming: boolean) =>
      transcriptOf([
        put(
          assistant("a1", [{ kind: "thinking", text: "weighing it up" }], {
            streaming,
          }),
        ),
      ]);
    const { redraw } = draw(thinking(true));
    const summary = () =>
      entry("a1").querySelector(".conversation-thinking > summary");
    expect(summary()).toHaveTextContent("Thinking…");
    redraw(thinking(false));
    expect(summary()).toHaveTextContent("Thought");
  });

  it("says what the pane is for until the first entry, and nothing of it after", () => {
    const { redraw } = draw(transcriptOf([]));
    expect(screen.getByText("What should the Agent do?")).toBeInTheDocument();
    redraw(transcriptOf([put(user("u1", "fix the build"))]));
    expect(screen.queryByText("What should the Agent do?")).toBeNull();
  });

  it("draws a tool call folded, with its input and each kind of output inside", () => {
    draw(
      transcriptOf([
        put(
          tool("t1", "Bash: npm test", {
            input: { command: "npm test" },
            output: { kind: "command", exitCode: 1, output: "1 failed" },
            status: "failed",
          }),
        ),
        put(
          tool("t2", "Read: README.md", {
            output: { kind: "text", text: "# Title", truncated: true },
          }),
        ),
        put(
          tool("t3", "Edit: src/x.ts", {
            output: {
              kind: "diff",
              files: [
                {
                  path: "src/x.ts",
                  unifiedDiff: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;",
                },
              ],
            },
          }),
        ),
        put(tool("t4", "Bash: sleep 100", { status: "running" })),
      ]),
    );
    const bash = entry("t1").querySelector("details.conversation-tool")!;
    expect(bash).not.toHaveAttribute("open");
    expect(bash.querySelector("summary")).toHaveTextContent("Bash: npm test");
    expect(bash.querySelector("summary")).toHaveTextContent("Failed");
    expect(bash).toHaveTextContent('"command": "npm test"');
    expect(bash).toHaveTextContent("1 failed");
    expect(bash).toHaveTextContent("Exit code 1");
    expect(entry("t2")).toHaveTextContent("# Title");
    expect(entry("t2")).toHaveTextContent("The Agent shortened this output.");
    const lines = entry("t3").querySelectorAll(".conversation-diff-line");
    expect([...lines].map((line) => line.getAttribute("data-line"))).toEqual([
      "hunk",
      "remove",
      "add",
    ]);
    expect(entry("t3")).toHaveTextContent("src/x.ts");
    expect(entry("t4").querySelector("summary")).toHaveTextContent("Running");
  });

  it("draws a background task's end as one quiet line on the call that started it", () => {
    draw(
      transcriptOf([
        put(
          tool("t1", "Bash: npm test", {
            background: { state: "completed", summary: "npm test finished" },
          }),
        ),
        put(tool("t2", "Bash: ls")),
      ]),
    );
    const line = entry("t1").querySelector(".conversation-tool-background")!;
    expect(line).toHaveAttribute("data-state", "completed");
    expect(line).toHaveTextContent("In the background: Done");
    expect(line).toHaveTextContent("npm test finished");
    // Outside the call's fold, so it shows without opening the call.
    expect(line.closest("details")).toBeNull();
    expect(
      entry("t2").querySelector(".conversation-tool-background"),
    ).toBeNull();
    expect(document.querySelector(".conversation-notice")).toBeNull();
  });

  it("nests a subagent's entries under its call: open while it runs, closed once it is done", () => {
    const running = transcriptOf([
      put(
        tool("task", "Task: explore", {
          name: "Task",
          status: "running",
          spawns: {
            label: "Explore",
            prompt: "list src/",
            model: "example-model",
            state: "running",
            takesMessages: false,
          },
        }),
      ),
      put(tool("inner", "Bash: ls", { parent: "task" })),
      put(assistant("inner-answer", "three modules", { parent: "task" })),
      put(
        tool("deep", "Task: deeper", {
          parent: "task",
          spawns: {
            label: "Deeper",
            prompt: "",
            model: undefined,
            state: "running",
            takesMessages: false,
          },
        }),
      ),
      put(assistant("deepest", "found it", { parent: "deep" })),
    ]);
    const { redraw } = draw(running);
    const subagent = entry("task").querySelector<HTMLDetailsElement>(
      "details.conversation-subagent",
    )!;
    expect(subagent.open).toBe(true);
    expect(subagent.querySelector("summary")).toHaveTextContent(
      /Explore.*example-model.*Running/,
    );
    // The children are inside the subagent, not beside it at the top level.
    expect(subagent).toContainElement(entry("inner"));
    expect(subagent).toContainElement(entry("inner-answer"));
    expect(entry("deep")).toContainElement(entry("deepest"));
    const topLevel = document.querySelector(".conversation-transcript")!;
    expect(
      [...topLevel.children].map((child) =>
        child.getAttribute("data-entry-id"),
      ),
    ).toEqual(["task"]);

    redraw(
      transcriptOf([
        put(
          tool("task", "Task: explore", {
            name: "Task",
            spawns: {
              label: "Explore",
              prompt: "list src/",
              model: "example-model",
              state: "completed",
              takesMessages: false,
            },
          }),
        ),
        put(tool("inner", "Bash: ls", { parent: "task" })),
      ]),
    );
    expect(
      entry("task").querySelector<HTMLDetailsElement>(
        "details.conversation-subagent",
      )!.open,
    ).toBe(false);
  });

  it("keeps a subagent the way the person left it once they have toggled it", () => {
    const spawns = {
      label: "Explore",
      prompt: "",
      model: undefined,
      state: "running" as const,
      takesMessages: false,
    };
    const { redraw } = draw(
      transcriptOf([put(tool("task", "Task", { status: "running", spawns }))]),
    );
    const subagent = () =>
      entry("task").querySelector<HTMLDetailsElement>(
        "details.conversation-subagent",
      )!;
    // The person closes it while it is still running.
    subagent().open = false;
    fireEvent(subagent(), new Event("toggle"));
    redraw(
      transcriptOf([
        put(
          tool("task", "Task", { spawns: { ...spawns, state: "completed" } }),
        ),
      ]),
    );
    expect(subagent().open).toBe(false);
    subagent().open = true;
    fireEvent(subagent(), new Event("toggle"));
    redraw(
      transcriptOf([
        put(
          tool("task", "Task", { spawns: { ...spawns, state: "completed" } }),
        ),
        put(assistant("late", "more", { parent: "task" })),
      ]),
    );
    expect(subagent().open).toBe(true);
  });

  it("draws a notice at its level, with the event it is about folded", () => {
    draw(
      transcriptOf([
        put(notice("n1", "Retrying the API (attempt 2)")),
        put(
          notice("n2", "DevHub does not know the event `foo`", "warning", {
            type: "foo",
          }),
        ),
        put(notice("n3", "The CLI said no", "error")),
      ]),
    );
    expect(entry("n1").firstElementChild).toHaveAttribute("data-level", "info");
    const raw = entry("n2").querySelector("details")!;
    expect(raw).not.toHaveAttribute("open");
    expect(raw).toHaveTextContent('"type": "foo"');
    expect(within(entry("n3")).getByRole("alert")).toHaveTextContent(
      "The CLI said no",
    );
  });

  it("draws nothing for a completed turn, and how and why a turn that did not complete ended", () => {
    draw(
      transcriptOf([
        put(turnEnd("e1")),
        put(
          turnEnd("e2", "failed", {
            detail: "The API refused the request.",
            durationMs: 65_000,
          }),
        ),
      ]),
    );
    expect(document.querySelector('[data-entry-id="e1"]')).toBeNull();
    expect(within(entry("e2")).getByRole("separator")).toHaveAttribute(
      "data-outcome",
      "failed",
    );
    expect(entry("e2")).toHaveTextContent(
      /^Turn failedThe API refused the request\.$/u,
    );
  });
});

describe("pending requests", () => {
  it("draws the card under its tool call, one button per choice, and answers with the one pressed", async () => {
    const { actions } = draw(
      transcriptOf([
        put(tool("t1", "Bash: npm test", { status: "running" })),
        put(tool("t2", "Bash: ls")),
        opened(toolRequest("r1", "t1")),
      ]),
    );
    const card = within(entry("t1")).getByRole("group", {
      name: "The Agent is waiting for an answer",
    });
    expect(entry("t2").querySelector(".conversation-request")).toBeNull();
    expect(
      within(card)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["1Allow once", "2Always allow Bash(npm test:*)", "3Deny…"]);
    fireEvent.click(within(card).getByRole("button", { name: "Allow once" }));
    await waitFor(() =>
      expect(actions.answer).toHaveBeenCalledWith("r1", {
        kind: "choice",
        choiceId: "allow-once",
        text: undefined,
      }),
    );
  });

  it("opens a field for a choice that takes text, and sends what was typed", async () => {
    const { actions } = draw(
      transcriptOf([
        put(tool("t1", "Bash: rm -rf build", { status: "running" })),
        opened(toolRequest("r1", "t1")),
      ]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Deny…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Deny" }), {
      target: { value: "use the clean script instead" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() =>
      expect(actions.answer).toHaveBeenCalledWith("r1", {
        kind: "choice",
        choiceId: "deny",
        text: "use the clean script instead",
      }),
    );
  });

  it("draws a request about no tool call after the last entry", () => {
    draw(
      transcriptOf([
        put(user("u1", "hi")),
        opened(toolRequest("r1", undefined)),
      ]),
    );
    const transcript = document.querySelector(".conversation-transcript")!;
    expect(transcript.lastElementChild).toHaveAttribute(
      "data-entry-id",
      "request:r1",
    );
    expect(transcript.lastElementChild).toHaveTextContent("Allow once");
  });

  it("answers a question with the options picked and the text typed", async () => {
    const { actions } = draw(
      transcriptOf([
        opened({
          id: "q1" as never,
          entry: undefined,
          subject: {
            kind: "question",
            questions: [
              {
                id: "lang",
                header: "Language",
                text: "Which language?",
                options: [
                  { label: "TypeScript", description: "" },
                  { label: "Rust", description: "fast" },
                ],
                multiSelect: false,
                allowsOther: false,
              },
              {
                id: "targets",
                header: "Targets",
                text: "Where should it run?",
                options: [
                  { label: "macOS", description: "" },
                  { label: "Linux", description: "" },
                ],
                multiSelect: true,
                allowsOther: true,
              },
            ],
          },
          choices: [],
        }),
      ]),
    );
    fireEvent.click(screen.getByRole("radio", { name: /Rust/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "macOS" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Linux" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Targets: other" }), {
      target: { value: "FreeBSD" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() =>
      expect(actions.answer).toHaveBeenCalledWith("q1", {
        kind: "answers",
        values: { lang: "Rust", targets: ["macOS", "Linux", "FreeBSD"] },
      }),
    );
  });

  it("hands an answer that did not reach the Agent to the page's root, and keeps the card", async () => {
    const refused = new Error("the host did not answer");
    const actions = fakeActions({
      answer: vi.fn(() => Promise.reject(refused)),
    });
    draw(
      transcriptOf([
        put(tool("t1", "Bash: npm test", { status: "running" })),
        opened(toolRequest("r1", "t1")),
      ]),
      actions,
    );
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    await waitFor(() =>
      expect(actions.reportFailure).toHaveBeenCalledWith(refused),
    );
    expect(screen.getByRole("button", { name: "Allow once" })).toBeEnabled();
  });
});

describe("copy", () => {
  const ANSWER =
    "Run this:\n\n```ts\nconst answer = 42;\n```\n\nThen **commit**.";

  it("copies an answer's Markdown source, and says Copied for a moment once it has", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { actions } = draw(transcriptOf([put(assistant("a1", ANSWER))]));
    const button = screen.getByRole("button", { name: "Copy answer" });
    fireEvent.click(button);
    expect(actions.writeClipboard).toHaveBeenCalledWith(ANSWER);
    await waitFor(() => expect(button).toHaveTextContent("Copied"));
    act(() => {
      vi.advanceTimersByTime(COPIED_MS);
    });
    expect(button).toHaveTextContent("Copy");
  });

  it("copies an answer of several text blocks as one document", () => {
    const { actions } = draw(
      transcriptOf([
        put(
          assistant("a1", [
            { kind: "text", markdown: "first" },
            { kind: "thinking", text: "not this" },
            { kind: "text", markdown: "second" },
          ]),
        ),
      ]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));
    expect(actions.writeClipboard).toHaveBeenCalledWith("first\n\nsecond");
  });

  it("copies a code block's contents and nothing else", () => {
    const { actions } = draw(transcriptOf([put(assistant("a1", ANSWER))]));
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(actions.writeClipboard).toHaveBeenCalledWith("const answer = 42;");
  });

  it("hands a copy that failed to the page's root, and never says Copied", async () => {
    const denied = new Error("the pasteboard refused the write");
    const actions = fakeActions({
      writeClipboard: vi.fn(() => Promise.reject(denied)),
    });
    draw(transcriptOf([put(assistant("a1", ANSWER))]), actions);
    const button = screen.getByRole("button", { name: "Copy code" });
    fireEvent.click(button);
    await waitFor(() =>
      expect(actions.reportFailure).toHaveBeenCalledWith(denied),
    );
    expect(button).toHaveTextContent("Copy");
  });
});

describe("streaming", () => {
  const code = (id: string) =>
    entry(id).querySelectorAll<HTMLPreElement>(".conversation-code pre");

  it("colours a code block once its fence has closed, and not before", async () => {
    let transcript = transcriptOf([
      put(
        assistant("a1", "Intro.\n\n```ts\nconst a = 1;\n", { streaming: true }),
      ),
    ]);
    const { redraw } = draw(transcript);
    // Open fence: drawn, plain.
    expect(code("a1")).toHaveLength(1);
    expect(code("a1")[0]).toHaveTextContent("const a = 1;");
    expect(code("a1")[0]).not.toHaveAttribute("data-highlighted");

    transcript = transcriptOf([
      put(
        assistant("a1", "Intro.\n\n```ts\nconst a = 1;\n", { streaming: true }),
      ),
      delta("a1", "```\n\nNext:\n\n```python\nx = 1\n"),
    ]);
    redraw(transcript);
    // The first fence closed; the second is still open.
    await waitFor(() =>
      expect(code("a1")[0]).toHaveAttribute("data-highlighted", "true"),
    );
    expect(code("a1")[0]!.querySelector("span[style]")).not.toBeNull();
    expect(code("a1")[1]).toHaveTextContent("x = 1");
    expect(code("a1")[1]).not.toHaveAttribute("data-highlighted");

    // Finished: every block is final, and every block is coloured.
    redraw(
      transcriptOf([
        put(
          assistant(
            "a1",
            "Intro.\n\n```ts\nconst a = 1;\n```\n\nNext:\n\n```python\nx = 1\n```",
          ),
        ),
      ]),
    );
    await waitFor(() =>
      expect(code("a1")[1]).toHaveAttribute("data-highlighted", "true"),
    );
    expect(code("a1")[0]).toHaveAttribute("data-highlighted", "true");
    expect(entry("a1").firstElementChild).not.toHaveAttribute("data-streaming");
  });

  it("leaves a block in a language this build does not colour as plain text", async () => {
    draw(transcriptOf([put(assistant("a1", "```cobol\nDISPLAY 'HI'.\n```"))]));
    expect(code("a1")[0]).toHaveTextContent("DISPLAY 'HI'.");
    // Nothing is loading for it; give a coloured block the same time to land.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(code("a1")[0]).not.toHaveAttribute("data-highlighted");
  });
});

describe("follow-scroll", () => {
  /** jsdom lays nothing out: the scroller's geometry is set by hand. */
  function geometry(scroller: HTMLElement) {
    let height = 1_000;
    let top = 0;
    Object.defineProperty(scroller, "clientHeight", { value: 200 });
    Object.defineProperty(scroller, "scrollHeight", { get: () => height });
    Object.defineProperty(scroller, "scrollTop", {
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(value, height - 200));
      },
    });
    return {
      grow(by: number) {
        height += by;
      },
      scrollTo(value: number) {
        top = value;
        fireEvent.scroll(scroller);
      },
      get top() {
        return top;
      },
      bottom: () => height - 200,
    };
  }

  function scroller(): HTMLElement {
    return document.querySelector<HTMLElement>(".conversation-scroll")!;
  }

  const first = [put(user("u1", "one")), put(assistant("a1", "reply"))];
  const second = [...first, put(user("u2", "two"))];
  const third = [...second, put(assistant("a2", "reply again"))];

  it("follows new output while at the bottom", () => {
    const { redraw } = draw(transcriptOf(first));
    const box = geometry(scroller());
    box.scrollTo(box.bottom());
    box.grow(300);
    redraw(transcriptOf(second));
    expect(box.top).toBe(box.bottom());
    expect(screen.queryByRole("button", { name: /New output/ })).toBeNull();
  });

  it("stays where the person scrolled to, and offers the way back", () => {
    const { redraw } = draw(transcriptOf(first));
    const box = geometry(scroller());
    box.scrollTo(120);
    box.grow(300);
    redraw(transcriptOf(second));
    expect(box.top).toBe(120);
    const pill = screen.getByRole("button", { name: /New output/ });
    fireEvent.click(pill);
    expect(box.top).toBe(box.bottom());
    expect(screen.queryByRole("button", { name: /New output/ })).toBeNull();
    // Following again: the next output is followed.
    box.grow(300);
    redraw(transcriptOf(third));
    expect(box.top).toBe(box.bottom());
  });

  it("resumes following when the person scrolls back to the end themselves", () => {
    const { redraw } = draw(transcriptOf(first));
    const box = geometry(scroller());
    box.scrollTo(0);
    box.grow(300);
    redraw(transcriptOf(second));
    expect(
      screen.getByRole("button", { name: /New output/ }),
    ).toBeInTheDocument();
    box.scrollTo(box.bottom());
    expect(screen.queryByRole("button", { name: /New output/ })).toBeNull();
    box.grow(300);
    redraw(transcriptOf(third));
    expect(box.top).toBe(box.bottom());
  });

  it("ignores a parked surface's scrolls, and does not follow while parked", () => {
    const { redraw } = draw(transcriptOf(first));
    const box = geometry(scroller());
    box.scrollTo(120);
    redraw(transcriptOf(first), true);
    box.grow(300);
    redraw(transcriptOf(second), true);
    expect(box.top).toBe(120);
    redraw(transcriptOf(second), false);
    expect(box.top).toBe(120);
    expect(
      screen.getByRole("button", { name: /New output/ }),
    ).toBeInTheDocument();
  });
});
