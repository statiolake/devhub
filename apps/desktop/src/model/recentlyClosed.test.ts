import { describe, expect, it } from "vitest";
import {
  agentEntriesOf,
  closedEntryDetail,
  closedEntryLabel,
  decodeRecentlyClosed,
  placeKey,
  RECENTLY_CLOSED_LIMIT,
  rememberClosed,
  restoreEntry,
  resumableSession,
  withoutEntry,
  type ClosedAgentRecord,
  type ClosedEntryRecord,
} from "./recentlyClosed.js";

const reviewer: ClosedAgentRecord = {
  profile_id: "claude",
  profile_kind: "claude",
  display_name: "Reviewer",
  named: true,
  presentation: "gui",
  session: "0b6f4c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e",
};

function agentEntry(path: string, at = 0): ClosedEntryRecord {
  return {
    kind: "agent",
    closed_at: at,
    place: { kind: "local", path },
    agent: reviewer,
  };
}

function workspaceEntry(
  path: string,
  at = 0,
  agents: ClosedAgentRecord[] = [],
): Extract<ClosedEntryRecord, { kind: "workspace" }> {
  return {
    kind: "workspace",
    closed_at: at,
    place: { kind: "local", path },
    agents,
  };
}

describe("the stack of what was closed", () => {
  it("puts the newest on top, so each reopen goes further back", () => {
    let stack: ClosedEntryRecord[] = [];
    stack = rememberClosed(stack, agentEntry("/a", 1));
    stack = rememberClosed(stack, workspaceEntry("/b", 2));
    expect(stack.map((entry) => entry.closed_at)).toEqual([2, 1]);
    expect(withoutEntry(stack, 0).map((entry) => entry.closed_at)).toEqual([1]);
  });

  it("forgets the oldest past its bound", () => {
    let stack: ClosedEntryRecord[] = [];
    for (let at = 0; at < RECENTLY_CLOSED_LIMIT + 5; at += 1) {
      stack = rememberClosed(stack, agentEntry(`/f${at}`, at));
    }
    expect(stack).toHaveLength(RECENTLY_CLOSED_LIMIT);
    expect(stack[0]?.closed_at).toBe(RECENTLY_CLOSED_LIMIT + 4);
    expect(stack.at(-1)?.closed_at).toBe(5);
  });

  it("keeps one entry per closed folder, but every closed Agent", () => {
    let stack: ClosedEntryRecord[] = [];
    stack = rememberClosed(stack, workspaceEntry("/a", 1));
    stack = rememberClosed(stack, agentEntry("/a", 2));
    stack = rememberClosed(stack, agentEntry("/a", 3));
    stack = rememberClosed(stack, workspaceEntry("/a", 4));
    expect(stack.map((entry) => [entry.kind, entry.closed_at])).toEqual([
      ["workspace", 4],
      ["agent", 3],
      ["agent", 2],
    ]);
  });

  it("puts an entry back where it was when a reopen may be tried again", () => {
    const stack = [agentEntry("/a", 3), agentEntry("/c", 1)];
    const entry = agentEntry("/b", 2);
    expect(restoreEntry(stack, 1, entry).map((each) => each.closed_at)).toEqual(
      [3, 2, 1],
    );
    expect(restoreEntry([], 4, entry)).toEqual([entry]);
  });

  it("turns a Workspace's Agents into entries of their own, first on top", () => {
    const codex: ClosedAgentRecord = { ...reviewer, display_name: "Codex" };
    const entry = workspaceEntry("/a", 7, [reviewer, codex]);
    let stack: ClosedEntryRecord[] = [];
    for (const agent of agentEntriesOf(entry).reverse()) {
      stack = rememberClosed(stack, agent);
    }
    expect(
      stack.map((each) =>
        each.kind === "agent" ? each.agent.display_name : "",
      ),
    ).toEqual(["Reviewer", "Codex"]);
  });

  it("files an ssh folder under its host", () => {
    expect(placeKey({ kind: "ssh", host: "build", path: "/srv" })).toBe(
      "ssh://build/srv",
    );
    expect(placeKey({ kind: "local", path: "/srv" })).toBe("/srv");
  });
});

describe("what can come back", () => {
  it("is a Claude or Codex Agent with a session", () => {
    expect(resumableSession(reviewer)).toEqual({
      kind: "session",
      session: reviewer.session,
    });
  });

  it("is not an Agent whose CLI had not named a session", () => {
    const { session: _session, ...unnamed } = reviewer;
    const answer = resumableSession(unnamed);
    expect(answer.kind).toBe("none");
    if (answer.kind === "none") expect(answer.why).toContain("Reviewer");
  });

  it("is not an Agent of a CLI with no sessions to resume", () => {
    expect(resumableSession({ ...reviewer, profile_kind: "cursor" }).kind).toBe(
      "none",
    );
  });
});

describe("how an entry is said", () => {
  it("names what it was and where", () => {
    expect(closedEntryLabel(agentEntry("/src/app"))).toBe(
      "Agent “Reviewer” in /src/app",
    );
    expect(
      closedEntryLabel({
        ...workspaceEntry("/srv/api"),
        place: { kind: "ssh", host: "build", path: "/srv/api" },
      }),
    ).toBe("Workspace build:/srv/api");
  });

  it("says what came with it and when", () => {
    expect(
      closedEntryDetail(
        workspaceEntry("/a", 0, [reviewer, reviewer]),
        5 * 60_000,
      ),
    ).toBe("2 Agents · closed 5 min ago");
    expect(closedEntryDetail(agentEntry("/a", 0), 10_000)).toBe(
      "GUI · closed just now",
    );
  });
});

describe("reading it from the file", () => {
  it("is the empty stack when the file has none", () => {
    expect(decodeRecentlyClosed(undefined)).toEqual([]);
    expect(decodeRecentlyClosed({})).toEqual([]);
  });

  it("keeps what reads and leaves out what does not", () => {
    const good = agentEntry("/a", 1);
    expect(
      decodeRecentlyClosed([
        good,
        { ...good, place: { kind: "local", path: "relative" } },
        { ...good, agent: { ...reviewer, presentation: "web" } },
        workspaceEntry("/b", 2, [reviewer]),
        { ...workspaceEntry("/c"), agents: [{}] },
        null,
      ]),
    ).toEqual([good, workspaceEntry("/b", 2, [reviewer])]);
  });
});
