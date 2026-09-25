/**
 * The one fold of a conversation.
 *
 * main and the page both build a Transcript by folding events with
 * `applyEvent`, so what these tests pin is what both of them see: a stream
 * that grows and finalizes, a tool call that runs and ends, subagent entries
 * hanging off the call that started them, requests that open and close — and
 * the events that cannot be true, refused where they land instead of drawn.
 */

import { describe, expect, it } from "vitest";
import {
  EMPTY_TRANSCRIPT,
  TranscriptInvariantError,
  applyEvent,
  applyEvents,
  childrenOf,
  conversationActivity,
  conversationStatus,
  pendingId,
  rewindTargets,
  entryId,
  lastTurnFailed,
  mostUsedRateLimit,
  rateLimitWindowName,
  withRateLimits,
  requestId,
  type AssistantEntry,
  type ConversationEvent,
  type PendingRequest,
  type SessionFacts,
  type ToolEntry,
  type Transcript,
  type TranscriptEntry,
  type Usage,
} from "./conversation.js";

const READY: ConversationEvent = {
  type: "state",
  state: { phase: "ready", turn: "none" },
};
const RUNNING: ConversationEvent = {
  type: "state",
  state: { phase: "ready", turn: "running" },
};

function user(
  id: string,
  text: string,
  parent: string | null = null,
): ConversationEvent {
  return {
    type: "entry",
    entry: {
      kind: "user",
      id: entryId(id),
      parent: parent === null ? null : entryId(parent),
      text,
      images: [],
      origin: "person",
      rewindable: true,
    },
  };
}

function assistant(
  id: string,
  blocks: AssistantEntry["blocks"],
  streaming: boolean,
  parent: string | null = null,
): ConversationEvent {
  return {
    type: "entry",
    entry: {
      kind: "assistant",
      id: entryId(id),
      parent: parent === null ? null : entryId(parent),
      blocks,
      streaming,
    },
  };
}

function tool(
  id: string,
  fields: Partial<Omit<ToolEntry, "kind" | "id" | "parent">> = {},
  parent: string | null = null,
): ConversationEvent {
  return {
    type: "entry",
    entry: {
      kind: "tool",
      id: entryId(id),
      parent: parent === null ? null : entryId(parent),
      tool: "Bash",
      title: "Bash: pwd",
      input: { command: "pwd" },
      status: "running",
      output: undefined,
      spawns: undefined,
      ...fields,
    },
  };
}

function delta(id: string, block: number, text: string): ConversationEvent {
  return { type: "text-delta", entry: entryId(id), block, text };
}

function turnEnd(
  id: string,
  outcome: "completed" | "interrupted" | "failed",
): ConversationEvent {
  return {
    type: "entry",
    entry: {
      kind: "turn-end",
      id: entryId(id),
      outcome,
      detail: undefined,
      usage: undefined,
      durationMs: 1200,
    },
  };
}

function permission(id: string, about: string | undefined): PendingRequest {
  return {
    id: requestId(id),
    entry: about === undefined ? undefined : entryId(about),
    subject: {
      kind: "tool",
      tool: "Bash",
      title: "Bash: pwd",
      input: { command: "pwd" },
      reason: undefined,
    },
    choices: [
      { id: "allow", label: "Allow once", tone: "allow", takesText: false },
      { id: "deny", label: "Deny", tone: "deny", takesText: true },
    ],
  };
}

function fold(...events: ConversationEvent[]): Transcript {
  return applyEvents(EMPTY_TRANSCRIPT, events);
}

function entry(transcript: Transcript, id: string): TranscriptEntry {
  const found = transcript.entries.find((candidate) => candidate.id === id);
  if (found === undefined)
    throw new Error(`no entry ${id} in the test transcript`);
  return found;
}

function refused(
  transcript: Transcript,
  event: ConversationEvent,
  pattern: RegExp,
): void {
  expect(() => applyEvent(transcript, event)).toThrow(TranscriptInvariantError);
  expect(() => applyEvent(transcript, event)).toThrow(pattern);
}

describe("an empty conversation", () => {
  it("is connecting, says nothing and knows nothing about its session", () => {
    expect(EMPTY_TRANSCRIPT.state).toEqual({ phase: "connecting" });
    expect(EMPTY_TRANSCRIPT.entries).toEqual([]);
    expect(EMPTY_TRANSCRIPT.requests).toEqual([]);
    expect(EMPTY_TRANSCRIPT.usage).toBeUndefined();
    expect(EMPTY_TRANSCRIPT.session.sessionId).toBeUndefined();
    expect(EMPTY_TRANSCRIPT.session.commands).toEqual([]);
    expect(conversationStatus(EMPTY_TRANSCRIPT)).toBe("unknown");
  });
});

describe("entries", () => {
  it("are appended in the order they arrive", () => {
    const transcript = fold(
      user("u1", "fix the tests"),
      assistant("a1", [{ kind: "text", markdown: "On it." }], false),
      tool("t1"),
    );
    expect(transcript.entries.map((each) => each.id)).toEqual([
      "u1",
      "a1",
      "t1",
    ]);
  });

  it("are replaced whole, in place, by an entry with the same id", () => {
    const transcript = fold(
      user("u1", "hello"),
      tool("t1"),
      assistant("a1", [], false),
      tool("t1", {
        status: "succeeded",
        output: { kind: "text", text: "/", truncated: false },
      }),
    );
    expect(transcript.entries.map((each) => each.id)).toEqual([
      "u1",
      "t1",
      "a1",
    ]);
    expect(entry(transcript, "t1")).toMatchObject({
      status: "succeeded",
      output: { kind: "text", text: "/" },
    });
  });

  it("apply the same entry twice and it is the same transcript as once", () => {
    const once = fold(user("u1", "hello"), tool("t1"));
    const twice = applyEvent(once, tool("t1"));
    expect(twice).toEqual(once);
  });

  it("cannot change their kind", () => {
    const transcript = fold(user("x", "hello"));
    refused(
      transcript,
      assistant("x", [], false),
      /was a user and cannot become a assistant/,
    );
  });

  it("cannot move to another parent", () => {
    const transcript = fold(
      tool("task1", { tool: "Task" }),
      tool("task2", { tool: "Task" }),
      assistant("child", [], false, "task1"),
    );
    refused(
      transcript,
      assistant("child", [], false, "task2"),
      /cannot move from parent task1/,
    );
    refused(
      transcript,
      assistant("child", [], false, null),
      /cannot move from parent task1/,
    );
  });

  it("leave the transcript they were applied to untouched", () => {
    const before = fold(
      user("u1", "hello"),
      assistant("a1", [{ kind: "text", markdown: "" }], true),
    );
    const snapshot = structuredClone(before);
    applyEvent(before, delta("a1", 0, "Hi"));
    applyEvent(before, tool("t1"));
    applyEvent(before, user("u1", "changed"));
    expect(before).toEqual(snapshot);
  });
});

describe("a streaming assistant message", () => {
  const opened = fold(
    user("u1", "explain"),
    assistant(
      "a1",
      [
        { kind: "thinking", text: "" },
        { kind: "text", markdown: "" },
      ],
      true,
    ),
  );

  it("grows by its deltas, block by block", () => {
    const grown = applyEvents(opened, [
      delta("a1", 0, "Let me "),
      delta("a1", 0, "think."),
      delta("a1", 1, "The answer "),
      delta("a1", 1, "is **42**."),
    ]);
    expect(entry(grown, "a1")).toEqual({
      kind: "assistant",
      id: "a1",
      parent: null,
      blocks: [
        { kind: "thinking", text: "Let me think." },
        { kind: "text", markdown: "The answer is **42**." },
      ],
      streaming: true,
    });
  });

  it("is finalized by the complete message replacing it", () => {
    const final = applyEvents(opened, [
      delta("a1", 1, "The ans"),
      assistant(
        "a1",
        [
          { kind: "thinking", text: "Let me think." },
          { kind: "text", markdown: "The answer is 42." },
        ],
        false,
      ),
    ]);
    const finalized = entry(final, "a1") as AssistantEntry;
    expect(finalized.streaming).toBe(false);
    expect(finalized.blocks[1]).toEqual({
      kind: "text",
      markdown: "The answer is 42.",
    });
  });

  it("opens another block by being replaced with one more block", () => {
    const more = applyEvents(opened, [
      delta("a1", 1, "First."),
      assistant(
        "a1",
        [
          { kind: "thinking", text: "" },
          { kind: "text", markdown: "First." },
          { kind: "text", markdown: "" },
        ],
        true,
      ),
      delta("a1", 2, "Second."),
    ]);
    expect((entry(more, "a1") as AssistantEntry).blocks.slice(1)).toEqual([
      { kind: "text", markdown: "First." },
      { kind: "text", markdown: "Second." },
    ]);
  });

  it("takes no delta once finalized", () => {
    const final = applyEvent(
      opened,
      assistant("a1", [{ kind: "text", markdown: "done" }], false),
    );
    refused(final, delta("a1", 0, "late"), /a1, which is no longer streaming/);
  });

  it("refuses a delta for an entry that does not exist", () => {
    refused(
      opened,
      delta("nope", 0, "x"),
      /text delta for nope, which is not an entry/,
    );
  });

  it("refuses a delta for an entry that is not an assistant message", () => {
    const withTool = applyEvent(opened, tool("t1"));
    refused(
      withTool,
      delta("t1", 0, "x"),
      /text delta for t1, which is a tool entry/,
    );
    refused(
      withTool,
      delta("u1", 0, "x"),
      /text delta for u1, which is a user entry/,
    );
  });

  it("refuses a delta for a block the message does not have", () => {
    refused(opened, delta("a1", 2, "x"), /block 2 of a1, which has 2/);
    refused(opened, delta("a1", -1, "x"), /block -1 of a1/);
  });

  it("refuses a text delta into a plan", () => {
    const planned = applyEvent(
      opened,
      assistant(
        "a1",
        [{ kind: "plan", steps: [{ text: "read", status: "pending" }] }],
        true,
      ),
    );
    refused(planned, delta("a1", 0, "x"), /block 0 of a1, which is a plan/);
  });
});

describe("a tool call", () => {
  it("runs, then ends with its output", () => {
    const running = fold(RUNNING, tool("t1"));
    expect(entry(running, "t1")).toMatchObject({
      status: "running",
      output: undefined,
    });

    const done = applyEvent(
      running,
      tool("t1", {
        status: "succeeded",
        output: { kind: "command", exitCode: 0, output: "/w\n" },
      }),
    );
    expect(entry(done, "t1")).toMatchObject({
      status: "succeeded",
      output: { kind: "command", exitCode: 0, output: "/w\n" },
    });
  });

  it("can end failed, denied or interrupted", () => {
    for (const status of ["failed", "denied", "interrupted"] as const) {
      const ended = fold(
        tool("t1"),
        tool("t1", {
          status,
          output: { kind: "text", text: "no", truncated: false },
        }),
      );
      expect((entry(ended, "t1") as ToolEntry).status).toBe(status);
    }
  });

  it("carries a diff as its output", () => {
    const edited = fold(
      tool("t1", {
        tool: "Edit",
        title: "Edit: src/x.ts",
        status: "succeeded",
        output: {
          kind: "diff",
          files: [{ path: "src/x.ts", unifiedDiff: "@@ -1 +1 @@\n-a\n+b\n" }],
        },
      }),
    );
    expect((entry(edited, "t1") as ToolEntry).output).toEqual({
      kind: "diff",
      files: [{ path: "src/x.ts", unifiedDiff: "@@ -1 +1 @@\n-a\n+b\n" }],
    });
  });
});

describe("subagents", () => {
  const spawns = {
    label: "Explore",
    prompt: "find the reducer",
    model: "haiku",
    state: "running" as const,
    takesMessages: false,
  };

  const nested = fold(
    user("u1", "look around"),
    tool("task1", { tool: "Task", title: "Task: Explore", spawns }),
    assistant("c1", [{ kind: "text", markdown: "Searching." }], false, "task1"),
    tool("c1-tool", { title: "Bash: ls" }, "task1"),
    tool(
      "task2",
      {
        tool: "Task",
        title: "Task: deeper",
        spawns: { ...spawns, label: "deeper" },
      },
      "task1",
    ),
    assistant("g1", [{ kind: "text", markdown: "Deep." }], false, "task2"),
    assistant("a1", [{ kind: "text", markdown: "Found it." }], false),
  );

  it("hang off the call that started them, to any depth", () => {
    expect(childrenOf(nested, null).map((each) => each.id)).toEqual([
      "u1",
      "task1",
      "a1",
    ]);
    expect(childrenOf(nested, entryId("task1")).map((each) => each.id)).toEqual(
      ["c1", "c1-tool", "task2"],
    );
    expect(childrenOf(nested, entryId("task2")).map((each) => each.id)).toEqual(
      ["g1"],
    );
  });

  it("stay in display order in the flat list", () => {
    expect(nested.entries.map((each) => each.id)).toEqual([
      "u1",
      "task1",
      "c1",
      "c1-tool",
      "task2",
      "g1",
      "a1",
    ]);
  });

  it("stream under their parent like any other message", () => {
    const streaming = applyEvents(nested, [
      assistant("g2", [{ kind: "text", markdown: "" }], true, "task2"),
      delta("g2", 0, "more"),
    ]);
    expect(entry(streaming, "g2")).toMatchObject({
      parent: "task2",
      blocks: [{ kind: "text", markdown: "more" }],
    });
  });

  it("report their state on the call that started them", () => {
    const finished = applyEvent(
      nested,
      tool("task1", {
        tool: "Task",
        title: "Task: Explore",
        status: "succeeded",
        spawns: { ...spawns, state: "completed" },
      }),
    );
    expect((entry(finished, "task1") as ToolEntry).spawns?.state).toBe(
      "completed",
    );
    expect(childrenOf(finished, entryId("task1"))).toHaveLength(3);
  });

  it("cannot name a parent that has not arrived", () => {
    refused(
      nested,
      assistant("orphan", [], false, "task9"),
      /parent of orphan task9 is not an entry/,
    );
  });

  it("cannot name a parent that is not a tool call", () => {
    refused(
      nested,
      assistant("odd", [], false, "u1"),
      /parent of odd u1 is a user entry/,
    );
  });

  it("cannot be their own parent", () => {
    refused(
      nested,
      tool("self", {}, "self"),
      /parent of self self is not an entry/,
    );
  });
});

describe("requests", () => {
  const asked = fold(READY, RUNNING, tool("t1"), {
    type: "request-opened",
    request: permission("p1", "t1"),
  });

  it("are pending once opened, about the tool call they name", () => {
    expect(asked.requests).toEqual([permission("p1", "t1")]);
  });

  it("are gone once closed", () => {
    const answered = applyEvent(asked, {
      type: "request-closed",
      request: requestId("p1"),
    });
    expect(answered.requests).toEqual([]);
  });

  it("stay in the order they were opened, and close independently", () => {
    const two = applyEvents(asked, [
      tool("t2"),
      { type: "request-opened", request: permission("p2", "t2") },
      { type: "request-closed", request: requestId("p1") },
    ]);
    expect(two.requests.map((each) => each.id)).toEqual(["p2"]);
  });

  it("need not be about a tool call", () => {
    const question: PendingRequest = {
      id: requestId("q1"),
      entry: undefined,
      subject: {
        kind: "question",
        questions: [
          {
            id: "which",
            header: "Pick",
            text: "Which one?",
            options: [
              { label: "A", description: "the first" },
              { label: "B", description: "the second" },
            ],
            multiSelect: false,
            allowsOther: true,
          },
        ],
      },
      choices: [],
    };
    const opened = applyEvent(asked, {
      type: "request-opened",
      request: question,
    });
    expect(opened.requests.map((each) => each.id)).toEqual(["p1", "q1"]);
  });

  it("cannot be about a tool call that does not exist", () => {
    refused(
      asked,
      { type: "request-opened", request: permission("p2", "t9") },
      /subject of request p2 t9 is not an entry/,
    );
  });

  it("cannot be about an entry that is not a tool call", () => {
    const withUser = applyEvent(asked, user("u1", "hi"));
    refused(
      withUser,
      { type: "request-opened", request: permission("p2", "u1") },
      /subject of request p2 u1 is a user entry, not a tool call/,
    );
  });

  it("cannot be opened twice while pending", () => {
    refused(
      asked,
      { type: "request-opened", request: permission("p1", "t1") },
      /p1 is already open/,
    );
  });

  it("can open again under the same id once closed", () => {
    const again = applyEvents(asked, [
      { type: "request-closed", request: requestId("p1") },
      { type: "request-opened", request: permission("p1", "t1") },
    ]);
    expect(again.requests.map((each) => each.id)).toEqual(["p1"]);
  });

  it("cannot be closed if they are not open", () => {
    refused(
      asked,
      { type: "request-closed", request: requestId("p9") },
      /request p9 is not open/,
    );
    const closed = applyEvent(asked, {
      type: "request-closed",
      request: requestId("p1"),
    });
    refused(
      closed,
      { type: "request-closed", request: requestId("p1") },
      /request p1 is not open/,
    );
  });
});

describe("session facts and usage", () => {
  const session: SessionFacts = {
    agentVersion: "2.1.0",
    sessionId: "00000000-0000-4000-8000-000000000001",
    cwd: "/home/testuser/project",
    model: { current: "opus", choices: [{ id: "opus", label: "Opus" }] },
    effort: { current: undefined, choices: [] },
    mode: {
      current: "default",
      choices: [{ id: "default", label: "Default" }],
    },
    commands: [
      {
        name: "review",
        description: "Review a PR",
        argumentHint: "<pr>",
        route: "message",
      },
      {
        name: "model",
        description: "Switch model",
        argumentHint: undefined,
        route: "model",
      },
    ],
    canRewind: false,
  };

  it("are replaced whole by each session event", () => {
    const first = fold({ type: "session", session });
    expect(first.session).toEqual(session);
    const next: SessionFacts = {
      ...session,
      model: { ...session.model, current: "sonnet" },
    };
    expect(
      applyEvent(first, { type: "session", session: next }).session,
    ).toEqual(next);
  });

  it("apply the same session twice and it is the same as once", () => {
    const once = fold({ type: "session", session });
    expect(applyEvent(once, { type: "session", session })).toEqual(once);
  });

  it("carry usage and cost, replaced whole", () => {
    const usage: Usage = {
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 800,
      contextTokens: 1200,
      contextWindow: 200_000,
      costUsd: 0.01,
      rateLimits: [
        { window: "5-hour", usedPercent: 12, resetsAt: 1_800_000_000_000 },
      ],
    };
    const counted = fold({ type: "usage", usage });
    expect(counted.usage).toEqual(usage);
    const later: Usage = { ...usage, costUsd: 0.02, rateLimits: undefined };
    expect(applyEvent(counted, { type: "usage", usage: later }).usage).toEqual(
      later,
    );
  });
});

describe("rate-limit windows", () => {
  it("replace a window of the same name and keep one a report leaves out", () => {
    const five = { window: "5-hour", usedPercent: 10, resetsAt: 1 };
    const seven = { window: "7-day", usedPercent: 50, resetsAt: 2 };
    const later = { window: "5-hour", usedPercent: 60, resetsAt: 1 };
    expect(
      withRateLimits(withRateLimits(undefined, [five, seven]), [later]),
    ).toEqual([later, seven]);
    expect(mostUsedRateLimit([five, seven, later])).toBe(later);
  });

  it("are named by their length", () => {
    expect(rateLimitWindowName(300)).toBe("5-hour");
    expect(rateLimitWindowName(10080)).toBe("7-day");
    expect(rateLimitWindowName(90)).toBe("90-minute");
  });
});

describe("the turn lifecycle, read as a status", () => {
  it("is unknown while connecting, idle when ready, working in a turn", () => {
    expect(conversationStatus(fold())).toBe("unknown");
    expect(conversationStatus(fold(READY))).toBe("idle");
    expect(conversationStatus(fold(READY, user("u1", "go"), RUNNING))).toBe(
      "working",
    );
  });

  it("is waiting while a request is pending, even mid-turn", () => {
    const waiting = fold(READY, RUNNING, tool("t1"), {
      type: "request-opened",
      request: permission("p1", "t1"),
    });
    expect(conversationStatus(waiting)).toBe("waiting");
    const resumed = applyEvent(waiting, {
      type: "request-closed",
      request: requestId("p1"),
    });
    expect(conversationStatus(resumed)).toBe("working");
  });

  it("is idle after a completed turn and an interrupted one", () => {
    expect(
      conversationStatus(
        fold(READY, RUNNING, turnEnd("e1", "completed"), READY),
      ),
    ).toBe("idle");
    expect(
      conversationStatus(
        fold(READY, RUNNING, turnEnd("e1", "interrupted"), READY),
      ),
    ).toBe("idle");
  });

  it("stays error after a failed turn until the next turn starts", () => {
    const failed = fold(READY, RUNNING, turnEnd("e1", "failed"), READY);
    expect(lastTurnFailed(failed)).toBe(true);
    expect(conversationStatus(failed)).toBe("error");

    const next = applyEvent(failed, RUNNING);
    expect(conversationStatus(next)).toBe("working");

    const recovered = applyEvents(next, [turnEnd("e2", "completed"), READY]);
    expect(lastTurnFailed(recovered)).toBe(false);
    expect(conversationStatus(recovered)).toBe("idle");
  });

  it("is not ended by a turn-end entry alone: the state says when the turn ends", () => {
    const ended = fold(READY, RUNNING, turnEnd("e1", "completed"));
    expect(ended.state).toEqual({ phase: "ready", turn: "running" });
    expect(conversationStatus(ended)).toBe("working");
  });

  it("is error once broken, and the transcript up to there stays readable", () => {
    const broken = fold(READY, user("u1", "go"), RUNNING, {
      type: "state",
      state: {
        phase: "broken",
        failure: {
          code: "protocol_mismatch",
          detail: "assistant.message.content: expected an array",
        },
      },
    });
    expect(conversationStatus(broken)).toBe("error");
    expect(broken.state).toMatchObject({
      phase: "broken",
      failure: { code: "protocol_mismatch" },
    });
    expect(broken.entries.map((each) => each.id)).toEqual(["u1"]);
  });
});

describe("the activity of a turn", () => {
  it("is the latest running tool call's title", () => {
    const busy = fold(
      READY,
      RUNNING,
      tool("t1", { title: "Bash: npm test" }),
      tool("t1", { title: "Bash: npm test", status: "succeeded" }),
      tool("t2", { tool: "Edit", title: "Edit: src/x.ts" }),
    );
    expect(conversationActivity(busy)).toBe("Edit: src/x.ts");
  });

  it("is the in-progress step of the latest plan when no tool is running", () => {
    const planning = fold(
      READY,
      RUNNING,
      assistant(
        "a1",
        [
          {
            kind: "plan",
            steps: [
              { text: "read the code", status: "completed" },
              { text: "fix the fold", status: "in_progress" },
              { text: "run the tests", status: "pending" },
            ],
          },
        ],
        false,
      ),
    );
    expect(conversationActivity(planning)).toBe("fix the fold");
  });

  it("is nothing outside a turn", () => {
    expect(conversationActivity(fold(READY, tool("t1")))).toBeUndefined();
    expect(conversationActivity(fold(tool("t1")))).toBeUndefined();
  });
});

describe("what the CLI says that DevHub does not know", () => {
  it("is a warning notice in the transcript, and the conversation carries on", () => {
    const raw = { type: "future_event", payload: { x: 1 } };
    const noticed = fold(READY, RUNNING, user("u1", "go"), {
      type: "entry",
      entry: {
        kind: "notice",
        id: entryId("n1"),
        parent: null,
        level: "warning",
        text: "DevHub does not know the event future_event",
        raw,
      },
    });
    expect(entry(noticed, "n1")).toMatchObject({
      kind: "notice",
      level: "warning",
      raw,
    });
    expect(conversationStatus(noticed)).toBe("working");
    const continued = applyEvent(
      noticed,
      assistant("a1", [{ kind: "text", markdown: "ok" }], false),
    );
    expect(continued.entries.map((each) => each.id)).toEqual([
      "u1",
      "n1",
      "a1",
    ]);
  });

  it("can come from inside a subagent", () => {
    const noticed = fold(tool("task1", { tool: "Task" }), {
      type: "entry",
      entry: {
        kind: "notice",
        id: entryId("n1"),
        parent: entryId("task1"),
        level: "warning",
        text: "unknown",
        raw: null,
      },
    });
    expect(
      childrenOf(noticed, entryId("task1")).map((each) => each.id),
    ).toEqual(["n1"]);
  });
});

describe("a rewind", () => {
  const REWINDABLE: ConversationEvent = {
    type: "session",
    session: { ...EMPTY_TRANSCRIPT.session, canRewind: true },
  };
  const REWINDING: ConversationEvent = {
    type: "state",
    state: { phase: "ready", turn: "rewinding" },
  };
  const twoTurns = fold(
    REWINDABLE,
    READY,
    user("u1", "first"),
    RUNNING,
    assistant("a1", [{ kind: "text", markdown: "one" }], false),
    turnEnd("e1", "completed"),
    READY,
    user("u2", "second"),
    RUNNING,
    tool("t1", { status: "succeeded" }),
    assistant("a2", [{ kind: "text", markdown: "two" }], false),
    turnEnd("e2", "completed"),
    READY,
  );

  it("drops the message it names and everything after it, and keeps what came before", () => {
    const rewound = applyEvents(twoTurns, [
      REWINDING,
      { type: "rewound", from: entryId("u2") },
      READY,
    ]);
    expect(rewound.entries.map((each) => each.id)).toEqual(["u1", "a1", "e1"]);
  });

  it("is refused for an entry that is not a top-level user message", () => {
    refused(
      twoTurns,
      { type: "rewound", from: entryId("a2") },
      /a2 is a assistant entry, not a message the person sent/,
    );
    refused(
      twoTurns,
      { type: "rewound", from: entryId("nope") },
      /nope, which is not an entry/,
    );
  });

  it("is refused while a request is open: nothing may answer about what it drops", () => {
    const asking = fold(READY, user("u1", "go"), RUNNING, tool("t1"), {
      type: "request-opened",
      request: permission("p1", "t1"),
    });
    refused(
      asking,
      { type: "rewound", from: entryId("u1") },
      /while request p1 is open/,
    );
  });

  it("reads as working while it is under way", () => {
    expect(conversationStatus(applyEvent(twoTurns, REWINDING))).toBe("working");
  });

  it("can go back to before any of the person's messages, only when the session can rewind and nothing runs, waits or is held", () => {
    expect([...rewindTargets(twoTurns)]).toEqual(["u1", "u2"]);
    expect(
      rewindTargets(
        applyEvent(twoTurns, {
          type: "session",
          session: { ...twoTurns.session, canRewind: false },
        }),
      ).size,
    ).toBe(0);
    expect(rewindTargets(applyEvent(twoTurns, RUNNING)).size).toBe(0);
    expect(rewindTargets(applyEvent(twoTurns, REWINDING)).size).toBe(0);
    expect(
      rewindTargets(
        applyEvent(twoTurns, {
          type: "pending",
          pending: [
            { id: pendingId("held:1"), text: "later", failure: undefined },
          ],
        }),
      ).size,
    ).toBe(0);
  });

  it("does not go back to before an injection, nor a message the CLI cannot cut before", () => {
    const more = applyEvents(twoTurns, [
      {
        type: "entry",
        entry: {
          kind: "user",
          id: entryId("u3"),
          parent: null,
          text: "from a template",
          images: [],
          origin: "injection",
          rewindable: true,
        },
      },
      {
        type: "entry",
        entry: {
          kind: "user",
          id: entryId("u4"),
          parent: null,
          text: "steered into a turn",
          images: [],
          origin: "person",
          rewindable: false,
        },
      },
    ]);
    expect([...rewindTargets(more)]).toEqual(["u1", "u2"]);
  });
});

describe("the messages DevHub holds", () => {
  it("are replaced whole by each pending event, and start empty", () => {
    expect(EMPTY_TRANSCRIPT.pending).toEqual([]);
    const held = [
      { id: pendingId("held:1"), text: "one", failure: undefined },
      { id: pendingId("held:2"), text: "two", failure: "the host is gone" },
    ];
    const folded = applyEvent(EMPTY_TRANSCRIPT, {
      type: "pending",
      pending: held,
    });
    expect(folded.pending).toEqual(held);
    expect(
      applyEvent(folded, { type: "pending", pending: held.slice(1) }).pending,
    ).toEqual(held.slice(1));
  });
});

describe("an event the fold does not know", () => {
  it("is refused rather than ignored", () => {
    const bogus = {
      type: "entry-deleted",
      entry: "u1",
    } as unknown as ConversationEvent;
    refused(fold(), bogus, /unknown conversation event "entry-deleted"/);
  });
});

describe("a replayed journal", () => {
  it("folds to the same transcript as the live events did", () => {
    const events: ConversationEvent[] = [
      {
        type: "session",
        session: { ...EMPTY_TRANSCRIPT.session, sessionId: "s1" },
      },
      READY,
      user("u1", "run pwd"),
      RUNNING,
      assistant("a1", [{ kind: "text", markdown: "" }], true),
      delta("a1", 0, "Running "),
      delta("a1", 0, "it."),
      assistant("a1", [{ kind: "text", markdown: "Running it." }], false),
      tool("t1"),
      { type: "request-opened", request: permission("p1", "t1") },
      { type: "request-closed", request: requestId("p1") },
      tool("t1", {
        status: "succeeded",
        output: { kind: "text", text: "/w", truncated: false },
      }),
      turnEnd("e1", "completed"),
      READY,
    ];
    let live = EMPTY_TRANSCRIPT;
    for (const event of events) live = applyEvent(live, event);
    expect(applyEvents(EMPTY_TRANSCRIPT, events)).toEqual(live);
    expect(conversationStatus(live)).toBe("idle");
    expect(live.requests).toEqual([]);
  });
});
