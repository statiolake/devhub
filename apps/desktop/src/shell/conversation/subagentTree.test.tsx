// @vitest-environment jsdom

/**
 * Subagents, drawn from what the adapters actually make of their CLIs.
 *
 * Each transcript here is one of the adapters' own fixtures fed through the
 * real Claude or Codex adapter, so the tree the page draws is the tree main
 * would hand it. For both: a subagent's entries hang inside its call and
 * nowhere else; it is open while it runs and folded once it has finished; its
 * text streams in place; its own tool calls, and the permission cards about
 * them, stand inside it where they happened.
 */

import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  claudeLines,
  claudeTranscript,
  codexLines,
  codexTranscript,
  type ClaudeLine,
} from "./adapterFixtures";
import { draw, entry, installResizeObserver } from "./surfaceTestKit";

beforeAll(() => {
  installResizeObserver();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

/** A fixture of the adapters', by its path under `main/agent/conversation/`. */
function text(path: string): string {
  // Relative to the package, which is where vitest runs: `import.meta.url` is
  // not a file URL in the jsdom environment.
  return readFileSync(`src/main/agent/conversation/${path}`, "utf8");
}

const CLAUDE = claudeLines(text("fixtures/claude-subagent-turn.ndjson"));
const HANDSHAKE = codexLines(
  text("codex/fixtures/handshake.handwritten.ndjson"),
);
const CODEX = codexLines(text("codex/fixtures/subagent.handwritten.ndjson"));
const MAIN = "00000000-0000-7000-8000-00000000000a";
const CHILD = "00000000-0000-7000-8000-00000000000b";

function received(value: unknown): ClaudeLine {
  return { side: "received", line: JSON.stringify(value) };
}

/** The Claude fixture up to and including the first line containing `marker`. */
function claudeUntil(marker: string): readonly ClaudeLine[] {
  const at = CLAUDE.findIndex((each) => each.line.includes(marker));
  if (at < 0) throw new Error(`the Claude fixture has no line with ${marker}`);
  return CLAUDE.slice(0, at + 1);
}

function subagentOf(id: string): HTMLDetailsElement {
  const found = entry(id).querySelector<HTMLDetailsElement>(
    ":scope details.conversation-subagent",
  );
  if (!found) throw new Error(`entry ${id} draws no subagent`);
  return found;
}

function topLevelIds(): (string | null)[] {
  return [...document.querySelector(".conversation-transcript")!.children].map(
    (child) => child.getAttribute("data-entry-id"),
  );
}

describe("a Claude subagent (Task)", () => {
  const TASK = "tool:toolu_task";

  it("hangs the subagent's text and tool calls inside its Task call, and nowhere else", () => {
    draw(claudeTranscript(CLAUDE));
    expect(topLevelIds()).toEqual([
      "user:00000000-0000-4000-8000-0000000000c1",
      TASK,
      "assistant:msg_11:0",
      "turn:1",
    ]);
    const subagent = subagentOf(TASK);
    const inside = [
      ...subagent.querySelectorAll(
        ":scope > .conversation-subagent-entries > .conversation-entry",
      ),
    ].map((child) => child.getAttribute("data-entry-id"));
    expect(inside).toEqual([
      "assistant:msg_s1:0",
      "tool:toolu_grep",
      "assistant:msg_s2:0",
    ]);
    expect(subagent).toHaveTextContent("Searching the model.");
    expect(entry("tool:toolu_grep")).toHaveTextContent("Grep: applyEvent");
    expect(entry("tool:toolu_grep")).toHaveTextContent(
      "src/model/conversation.ts",
    );
  });

  it("names the subagent, its model and its prompt, and folds it once it is done", () => {
    draw(claudeTranscript(CLAUDE));
    const subagent = subagentOf(TASK);
    expect(subagent.open).toBe(false);
    expect(subagent).toHaveAttribute("data-state", "completed");
    expect(subagent.querySelector("summary")).toHaveTextContent(
      /Explore.*haiku.*Done/,
    );
    expect(subagent).toHaveTextContent("Look for applyEvent");
    expect(entry(TASK).querySelector("summary")).toHaveTextContent(
      "Task: Find the reducer",
    );
  });

  it("is open while its task runs, and folds itself when it finishes", () => {
    const { redraw } = draw(claudeTranscript(claudeUntil("task_progress")));
    expect(subagentOf(TASK).open).toBe(true);
    expect(subagentOf(TASK).querySelector("summary")).toHaveTextContent(
      "Running",
    );
    redraw(claudeTranscript(CLAUDE));
    expect(subagentOf(TASK).open).toBe(false);
  });

  it("streams the subagent's own text in place", () => {
    const streaming = [
      ...claudeUntil("task_started"),
      received({
        type: "stream_event",
        event: {
          type: "message_start",
          message: {
            id: "msg_s1",
            type: "message",
            role: "assistant",
            content: [],
            model: "claude-haiku-4-5",
          },
        },
        parent_tool_use_id: "toolu_task",
      }),
      received({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        parent_tool_use_id: "toolu_task",
      }),
      received({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Searching the mo" },
        },
        parent_tool_use_id: "toolu_task",
      }),
    ];
    draw(claudeTranscript(streaming));
    const subagent = subagentOf(TASK);
    const answer = subagent.querySelector(".conversation-assistant")!;
    expect(answer).toHaveAttribute("data-streaming", "true");
    expect(answer).toHaveTextContent("Searching the mo");
    expect(topLevelIds()).not.toContain("assistant:msg_s1:0");
  });

  it("shows a permission card about the subagent's own tool call inside the subagent, and answers it", async () => {
    const asking = [
      ...claudeUntil('"toolu_grep","name":"Grep"'),
      received({
        type: "control_request",
        request_id: "perm-s1",
        request: {
          subtype: "can_use_tool",
          tool_name: "Grep",
          input: { pattern: "applyEvent" },
          tool_use_id: "toolu_grep",
          permission_suggestions: [],
        },
      }),
    ];
    const { actions } = draw(claudeTranscript(asking));
    const card = within(entry("tool:toolu_grep")).getByRole("group", {
      name: "The Agent is waiting for an answer",
    });
    expect(subagentOf(TASK)).toContainElement(card);
    expect(subagentOf(TASK).open).toBe(true);
    const allow = within(card).getAllByRole("button")[0]!;
    fireEvent.click(allow);
    await waitFor(() => expect(actions.answer).toHaveBeenCalledOnce());
  });

  it("opens a folded subagent to show its waiting card when asked from the waiting line", async () => {
    const asking = [
      ...claudeUntil('"toolu_grep","name":"Grep"'),
      received({
        type: "control_request",
        request_id: "perm-s1",
        request: {
          subtype: "can_use_tool",
          tool_name: "Grep",
          input: { pattern: "applyEvent" },
          tool_use_id: "toolu_grep",
          permission_suggestions: [],
        },
      }),
    ];
    draw(claudeTranscript(asking));
    // The person folds the running subagent.
    subagentOf(TASK).open = false;
    fireEvent(subagentOf(TASK), new Event("toggle"));
    expect(subagentOf(TASK).open).toBe(false);
    fireEvent.click(
      screen.getByRole("button", { name: /1 request is waiting/ }),
    );
    fireEvent(subagentOf(TASK), new Event("toggle"));
    await waitFor(() => expect(subagentOf(TASK).open).toBe(true));
    expect(
      within(entry("tool:toolu_grep")).getByRole("group", {
        name: "The Agent is waiting for an answer",
      }),
    ).toHaveFocus();
  });

  it("marks a subagent that failed", () => {
    draw(
      claudeTranscript([
        ...claudeUntil("task_started"),
        received({
          type: "system",
          subtype: "task_notification",
          task_id: "task_1",
          tool_use_id: "toolu_task",
          status: "failed",
          summary: "It gave up",
        }),
      ]),
    );
    expect(subagentOf(TASK)).toHaveAttribute("data-state", "failed");
    expect(subagentOf(TASK).querySelector("summary")).toHaveTextContent(
      "Failed",
    );
  });

  it("shows a background task finishing on the call that started it, not as a subagent", () => {
    draw(
      claudeTranscript([
        ...claudeUntil('"isReplay":true'),
        received({
          type: "assistant",
          message: {
            id: "msg_bg",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-5",
            content: [
              {
                type: "tool_use",
                id: "toolu_bg",
                name: "Bash",
                input: { command: "npm test", run_in_background: true },
              },
            ],
          },
          parent_tool_use_id: null,
        }),
        received({
          type: "system",
          subtype: "task_notification",
          tool_use_id: "toolu_bg",
          status: "completed",
          summary: "npm test finished",
        }),
      ]),
    );
    expect(
      entry("tool:toolu_bg").querySelector(".conversation-subagent"),
    ).toBeNull();
    expect(
      entry("tool:toolu_bg").querySelector(".conversation-tool-background"),
    ).toHaveTextContent("In the background: Done — npm test finished");
    expect(document.querySelector('[data-kind="notice"]')).toBeNull();
  });
});

describe("a Codex subagent (spawnAgent)", () => {
  const SPAWN = `${MAIN}/item-spawn`;

  it("hangs the subagent's thread inside the call that spawned it, and folds it once done", () => {
    draw(codexTranscript(HANDSHAKE, "delegate", CODEX));
    const subagent = subagentOf(SPAWN);
    expect(subagent.open).toBe(false);
    expect(subagent.querySelector("summary")).toHaveTextContent(
      /explorer.*gpt-5\.5-mini.*Done/,
    );
    expect(subagent).toHaveTextContent("List the files in src/");
    expect(subagent).toContainElement(entry(`${CHILD}/child-say`));
    expect(subagent).toContainElement(entry(`${CHILD}/child-ls`));
    expect(entry(`${CHILD}/child-ls`)).toHaveTextContent("ls src");
    expect(topLevelIds()).not.toContain(`${CHILD}/child-say`);
    expect(topLevelIds()).toContain(`${MAIN}/item-report`);
  });

  it("streams the subagent's text in place while its thread runs", () => {
    const upToDelta =
      CODEX.findIndex((line) => line.includes("item/agentMessage/delta")) + 1;
    draw(codexTranscript(HANDSHAKE, "delegate", CODEX.slice(0, upToDelta)));
    const subagent = subagentOf(SPAWN);
    expect(subagent.open).toBe(true);
    expect(subagent.querySelector("summary")).toHaveTextContent("Running");
    const answer = entry(`${CHILD}/child-say`).querySelector(
      ".conversation-assistant",
    )!;
    expect(answer).toHaveAttribute("data-streaming", "true");
    expect(answer).toHaveTextContent("Listing.");
  });

  it("shows an approval about the subagent's own command inside the subagent", () => {
    const upToCommand =
      CODEX.findIndex((line) => line.includes('"id":"child-ls"')) + 1;
    const turn = [
      ...CODEX.slice(0, upToCommand),
      JSON.stringify({
        id: 7,
        method: "item/commandExecution/requestApproval",
        params: {
          kind: "command",
          threadId: CHILD,
          turnId: "child-turn-1",
          itemId: "child-ls",
          startedAtMs: 1790000000000,
          approvalId: null,
          environmentId: null,
          reason: "Needs to list src/",
          networkApprovalContext: null,
          command: "ls src",
          cwd: "/home/testuser/project",
          commandActions: [{ type: "unknown", command: "ls src" }],
          proposedExecpolicyAmendment: null,
          proposedNetworkPolicyAmendments: null,
        },
      }),
    ];
    draw(codexTranscript(HANDSHAKE, "delegate", turn));
    const card = within(entry(`${CHILD}/child-ls`)).getByRole("group", {
      name: "The Agent is waiting for an answer",
    });
    expect(subagentOf(SPAWN)).toContainElement(card);
    expect(card).toHaveTextContent("Needs to list src/");
    expect(
      screen.getByRole("button", { name: /1 request is waiting/ }),
    ).toBeInTheDocument();
  });
});
