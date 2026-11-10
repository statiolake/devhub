// @vitest-environment jsdom

/**
 * A permission request on the card: a known tool says what the call is for
 * and exactly what it acts on, an unknown one shows its input, and one
 * answer — the first — is the filled primary.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { requestId, type JsonValue } from "../../model/conversation";
import { draw, installResizeObserver } from "./surfaceTestKit";
import { ALLOW_DENY, opened, transcriptOf } from "./transcriptFixtures";
import { knownToolRequest } from "./toolRequest";

beforeAll(installResizeObserver);

afterEach(cleanup);

function asking(tool: string, input: JsonValue, title = `${tool}: x`) {
  return transcriptOf([
    opened({
      id: requestId("p1"),
      entry: undefined,
      subject: { kind: "tool", tool, title, input, reason: undefined },
      choices: ALLOW_DENY,
    }),
  ]);
}

function card(): HTMLElement {
  return screen.getByRole("group", {
    name: "The Agent is waiting for an answer",
  });
}

describe("a known tool's request", () => {
  it("is headed by the call's description, the command once in a block, and no JSON", () => {
    draw(
      asking("Bash", {
        command: "rm -rf build && pnpm run migrate --env staging",
        description: "Clean the build and run the staging migration",
      }),
    );
    expect(
      card().querySelector(".conversation-request-heading"),
    ).toHaveTextContent("Clean the build and run the staging migration");
    const blocks = card().querySelectorAll(".conversation-request-command");
    expect([...blocks].map((block) => block.textContent)).toEqual([
      "rm -rf build && pnpm run migrate --env staging",
    ]);
    expect(card().querySelector(".conversation-json")).toBeNull();
    expect(card().querySelector(".conversation-request-title")).toBeNull();
  });

  it.each([
    ["Bash", { command: "ls" }, "Run a command", "ls"],
    ["Read", { file_path: "/w/a.ts" }, "Read a file", "/w/a.ts"],
    [
      "Edit",
      { file_path: "/w/a.ts", old_string: "a", new_string: "b" },
      "Edit a file",
      "/w/a.ts",
    ],
    [
      "Write",
      { file_path: "/w/b.ts", content: "x" },
      "Write a file",
      "/w/b.ts",
    ],
    [
      "WebFetch",
      { url: "https://example.com", prompt: "the title" },
      "Fetch a web page",
      "https://example.com",
    ],
    ["WebSearch", { query: "devhub" }, "Search the web", "devhub"],
    ["Glob", { pattern: "**/*.ts" }, "Find files", "**/*.ts"],
    ["Grep", { pattern: "TODO", path: "src" }, "Search file contents", "TODO"],
  ] as const)(
    "reads %s as what it does and its target",
    (tool, input, heading, target) => {
      expect(knownToolRequest(tool, input)).toMatchObject({ heading, target });
    },
  );

  it("says what else changes the call, a line each", () => {
    expect(
      knownToolRequest("Read", { file_path: "/a", offset: 10, limit: 5 })
        ?.notes,
    ).toEqual([{ text: "Lines 10–14" }]);
    expect(
      knownToolRequest("Bash", {
        command: "make",
        dangerouslyDisableSandbox: true,
      })?.notes,
    ).toEqual([{ text: "Outside the sandbox", warning: true }]);
    expect(
      knownToolRequest("Grep", { pattern: "x", path: "src" })?.notes,
    ).toEqual([{ text: "In src" }]);
  });

  it("is drawn as its input when the shape is not the known one", () => {
    // A key the tool is not known to take: nothing the call carries is hidden.
    expect(
      knownToolRequest("Bash", { command: "ls", surprise: true }),
    ).toBeUndefined();
    // The target missing, or not text.
    expect(knownToolRequest("Read", { path: "/a" })).toBeUndefined();
    expect(knownToolRequest("Bash", { command: ["ls"] })).toBeUndefined();
    // A tool DevHub does not know, and a name that only looks like a key.
    expect(knownToolRequest("mcp__x__y", { command: "ls" })).toBeUndefined();
    expect(knownToolRequest("toString", { command: "ls" })).toBeUndefined();
  });
});

describe("an unknown tool's request", () => {
  it("shows its title and its input as JSON", () => {
    draw(asking("mcp__db__query", { sql: "select 1" }, "db · query: select 1"));
    expect(
      card().querySelector(".conversation-request-title"),
    ).toHaveTextContent("db · query: select 1");
    expect(card().querySelector(".conversation-json")).toHaveTextContent(
      "select 1",
    );
  });
});

describe("the answers", () => {
  it("fill only the first, the one Return presses", async () => {
    const { actions } = draw(asking("Bash", { command: "ls" }));
    const buttons = [
      ...card().querySelectorAll<HTMLButtonElement>(
        ".conversation-request-choice",
      ),
    ];
    expect(
      buttons.map((button) => button.hasAttribute("data-primary")),
    ).toEqual([true, false, false]);
    fireEvent.keyDown(card(), { key: "Enter" });
    await waitFor(() =>
      expect(actions.answer).toHaveBeenCalledWith("p1", {
        kind: "choice",
        choiceId: "allow-once",
        text: undefined,
      }),
    );
  });

  it("still answer by number", async () => {
    const { actions } = draw(asking("Bash", { command: "ls" }));
    fireEvent.keyDown(card(), { key: "2" });
    await waitFor(() =>
      expect(actions.answer).toHaveBeenCalledWith("p1", {
        kind: "choice",
        choiceId: "always",
        text: undefined,
      }),
    );
  });
});
