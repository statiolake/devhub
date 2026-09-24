// @vitest-environment jsdom

/**
 * A real Claude session, drawn.
 *
 * `claude-session.capture.ndjson` is a scrubbed capture of claude 2.1.281
 * run through DevHub's host (design §8 stage 0). Played through the real
 * `ClaudeAdapter`, it is the transcript the page is handed for such a
 * session, and these are the things the live pass checked on screen: the
 * person's messages, a table, highlighted TypeScript, a tool call and what it
 * printed, a subagent's work inside the call that started it, the permission
 * card its Bash call raised (after the turn had ended, the subagent running
 * in the background), and no fold for thinking that came without text.
 * The capture is the protocol as the CLI really spoke it; the hand-written
 * fixtures are the protocol as it is documented.
 */

import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { cleanup, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ToolEntry, TranscriptEntry } from "../../model/conversation";
import { claudeLines, claudeTranscript } from "./adapterFixtures";
import { draw, entry, installResizeObserver } from "./surfaceTestKit";

beforeAll(installResizeObserver);
afterEach(cleanup);

// Relative to the package, where vitest runs: `import.meta.url` is not a
// file URL in the jsdom environment.
const CAPTURE = claudeLines(
  readFileSync(
    "src/main/agent/conversation/fixtures/claude-session.capture.ndjson",
    "utf8",
  ),
);
const SESSION = claudeTranscript(CAPTURE);

function toolWhere(
  test: (tool: ToolEntry) => boolean,
  entries: readonly TranscriptEntry[] = SESSION.entries,
): ToolEntry {
  const found = entries.find(
    (candidate): candidate is ToolEntry =>
      candidate.kind === "tool" && test(candidate),
  );
  if (!found) throw new Error("the capture has no such tool call");
  return found;
}

const SENT_MESSAGES = CAPTURE.filter(
  (each) => each.side === "sent" && each.line.includes('"type":"user"'),
).map((each) => {
  const message = JSON.parse(each.line) as {
    message: { content: string };
  };
  return message.message.content;
});

describe("a real claude session, as the page draws it", () => {
  it("draws every message the person sent, in order, at the top level", () => {
    draw(SESSION);
    const said = [
      ...document.querySelectorAll(
        ".conversation-transcript > .conversation-entry[data-kind=user]",
      ),
    ].map((user) => user.textContent);
    expect(SENT_MESSAGES.length).toBeGreaterThanOrEqual(3);
    expect(said).toEqual(SENT_MESSAGES);
  });

  it("draws the answer's table and colours its TypeScript", async () => {
    draw(SESSION);
    const table = document.querySelector(".conversation-table table");
    expect(table).not.toBeNull();
    expect(
      within(table as HTMLElement).getAllByRole("columnheader"),
    ).toHaveLength(2);
    const typescript = document.querySelector<HTMLElement>(
      ".conversation-code[data-language=typescript] pre, .conversation-code[data-language=ts] pre",
    );
    expect(typescript).not.toBeNull();
    await waitFor(() =>
      expect(typescript).toHaveAttribute("data-highlighted", "true"),
    );
  });

  it("draws no fold for the thinking the CLI withheld, and one for each it sent", () => {
    draw(SESSION);
    const thinking = SESSION.entries.flatMap((each) =>
      each.kind === "assistant"
        ? each.blocks.filter((block) => block.kind === "thinking")
        : [],
    );
    // The CLI withheld its thinking in this session: the capture carries
    // thinking blocks with no text. Whether the adapter keeps them or not,
    // none of them may be drawn as a fold with nothing in it.
    expect(
      CAPTURE.some((each) =>
        each.line.includes('"type":"thinking","thinking":""'),
      ),
    ).toBe(true);
    const withText = thinking.filter(
      (block) => block.kind === "thinking" && block.text !== "",
    );
    const folds = document.querySelectorAll(".conversation-thinking");
    expect(folds).toHaveLength(withText.length);
    for (const fold of folds) {
      expect(
        fold.querySelector(".conversation-thinking-text")?.textContent,
      ).not.toBe("");
    }
  });

  it("draws the Bash call and what it printed", () => {
    draw(SESSION);
    const pwd = toolWhere(
      (tool) =>
        tool.tool === "Bash" && JSON.stringify(tool.input).includes("pwd"),
    );
    const drawn = entry(pwd.id);
    expect(drawn.querySelector("summary")).toHaveTextContent("Bash");
    expect(drawn).toHaveTextContent("/home/testuser");
  });

  it("wraps what a tool was given and printed, as the live pass read it", () => {
    // jsdom applies no stylesheet, so the rule is read where it is written.
    const css = readFileSync("src/shell/conversation/conversation.css", "utf8");
    const rule =
      /\.conversation-json,\s*\.conversation-output,\s*\.conversation-request-command\s*\{([^}]*)\}/.exec(
        css,
      );
    expect(rule?.[1]).toMatch(/white-space:\s*pre-wrap/);
    expect(rule?.[1]).toMatch(/overflow-wrap:\s*anywhere/);
    draw(SESSION);
    const agent = toolWhere((tool) => tool.spawns !== undefined);
    expect(
      entry(agent.id).querySelector(".conversation-json, .conversation-output"),
    ).not.toBeNull();
  });

  it("draws the subagent's own work inside the call that started it", () => {
    draw(SESSION);
    const agent = toolWhere((tool) => tool.spawns !== undefined);
    const subagent = entry(agent.id).querySelector(
      "details.conversation-subagent",
    );
    expect(subagent).not.toBeNull();
    expect(subagent?.querySelector("summary")).toHaveTextContent(
      agent.spawns!.label,
    );
    const touch = toolWhere(
      (tool) =>
        tool.parent === agent.id &&
        JSON.stringify(tool.input).includes("touch note.txt"),
    );
    expect(subagent).toContainElement(entry(touch.id));
    const topLevel = [
      ...document.querySelectorAll(
        ".conversation-transcript > .conversation-entry",
      ),
    ].map((each) => each.getAttribute("data-entry-id"));
    expect(topLevel).not.toContain(touch.id);
  });

  it("draws the permission card the subagent's Bash raised, inside the subagent, until it is answered", () => {
    const asked = CAPTURE.findIndex((each) =>
      each.line.includes('"subtype":"can_use_tool"'),
    );
    expect(asked).toBeGreaterThan(0);
    const waiting = claudeTranscript(CAPTURE.slice(0, asked + 1));
    expect(waiting.requests).toHaveLength(1);
    const request = waiting.requests[0]!;
    draw(waiting);
    const card = document.querySelector<HTMLElement>(
      `[data-request-id="${request.id}"]`,
    );
    expect(card).not.toBeNull();
    const buttons = within(card!)
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(buttons).toEqual(
      request.choices.map(
        (choice, index) =>
          `${index + 1}${choice.label}${choice.takesText ? "…" : ""}`,
      ),
    );
    // The request is about the subagent's own Bash call, so its card stands
    // under that call, inside the subagent.
    const about = toolWhere(
      (tool) => tool.id === request.entry,
      waiting.entries,
    );
    expect(about.parent).not.toBeNull();
    expect(entry(about.id)).toContainElement(card);
    expect(
      entry(about.parent!).querySelector("details.conversation-subagent"),
    ).toContainElement(card);
    // The subagent ran in the background: its request arrives after the
    // turn that started it ended. The card and the waiting line show all
    // the same, and the composer stays usable, because no turn is running.
    expect(waiting.state).toEqual({ phase: "ready", turn: "none" });
    expect(document.querySelector(".conversation-waiting")).toHaveTextContent(
      "1 request is waiting for an answer",
    );
    expect(
      document.querySelector("textarea.conversation-composer-input"),
    ).toBeEnabled();
    // Once answered, the session holds no open request and draws no card.
    cleanup();
    draw(SESSION);
    expect(SESSION.requests).toHaveLength(0);
    expect(document.querySelector(".conversation-request")).toBeNull();
  });
});
