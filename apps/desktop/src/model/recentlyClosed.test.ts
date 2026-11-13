import { describe, expect, it } from "vitest";
import {
  agentEntriesOf,
  aliasedAgent,
  closedAgentLink,
  closedAgentNamed,
  decodeAgentAliases,
  rememberAlias,
  closedEntryDetail,
  closedEntryLabel,
  closeRemembers,
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

describe("which closes are remembered", () => {
  // Every way of closing a Workspace — the Sidebar row's button and menu, the
  // File menu, Cmd+Q W, Vim's :qa, the terminal view's shell exiting, the
  // confirmation sheet's Close — is one close with one of these dispositions.
  const worktreeOnBranch = { mainWorktree: "/src/app", branch: "feat" };

  it("remembers a folder its close leaves where it was, as itself", () => {
    expect(closeRemembers("keep", undefined)).toEqual({ remember: true });
    expect(closeRemembers("keep", worktreeOnBranch)).toEqual({
      remember: true,
    });
  });

  it("remembers a clean worktree its close deleted without asking, as its branch", () => {
    expect(closeRemembers("remove", worktreeOnBranch)).toEqual({
      remember: true,
      worktree: { repository: "/src/app", branch: "feat" },
    });
  });

  it("remembers a worktree deleted with its changes, as its branch", () => {
    expect(closeRemembers("remove-anyway", worktreeOnBranch)).toEqual({
      remember: true,
      worktree: { repository: "/src/app", branch: "feat" },
    });
  });

  it("forgets a deleted worktree that was on no branch: nothing could make it again", () => {
    expect(closeRemembers("remove", { mainWorktree: "/src/app" })).toEqual({
      remember: false,
    });
    expect(closeRemembers("remove-anyway", undefined)).toEqual({
      remember: false,
    });
  });

  it("says the branch a deleted worktree comes back on", () => {
    expect(
      closedEntryDetail(
        {
          ...workspaceEntry("/src/app-feat", 0),
          worktree: { repository: "/src/app", branch: "feat" },
        },
        0,
      ),
    ).toBe("no Agents · worktree of feat · closed just now");
  });
});

describe("a deleted worktree in the file", () => {
  const entry: ClosedEntryRecord = {
    ...workspaceEntry("/src/app-feat", 7, [reviewer]),
    worktree: { repository: "/src/app", branch: "feat/x" },
  };

  it("reads back as it was written", () => {
    expect(decodeRecentlyClosed(JSON.parse(JSON.stringify([entry])))).toEqual([
      entry,
    ]);
  });

  it("leaves out a worktree that does not read rather than reopening a folder", () => {
    for (const worktree of [
      { repository: "src/app", branch: "feat" },
      { repository: "/src/app", branch: "" },
      { repository: "/src/app" },
      "feat",
    ]) {
      expect(decodeRecentlyClosed([{ ...entry, worktree }])).toEqual([]);
    }
  });
});

describe("a link to a closed Agent", () => {
  const ID = "3f2a9c1e-7b4d-4e2a-9c1e-7b4d4e2a9c1e";
  const linked: ClosedAgentRecord = { ...reviewer, agent_id: ID };
  const own: ClosedEntryRecord = {
    kind: "agent",
    closed_at: 2,
    place: { kind: "local", path: "/a" },
    agent: linked,
  };
  const none = () => false;

  it("remembers the id it had, and reads it back", () => {
    expect(decodeRecentlyClosed(JSON.parse(JSON.stringify([own])))).toEqual([
      own,
    ]);
    const bad = { ...own, agent: { ...linked, agent_id: "x/../y" } };
    expect(decodeRecentlyClosed([bad])).toEqual([{ ...own, agent: reviewer }]);
  });

  it("finds it by id or a unique prefix, in its own entry or its Workspace's", () => {
    const withWorkspace = workspaceEntry("/b", 1, [linked]);
    expect(closedAgentNamed([own], ID.slice(0, 4))?.entry).toBe(own);
    expect(closedAgentNamed([withWorkspace], ID)?.entry).toBe(withWorkspace);
    expect(closedAgentNamed([own], "3f2")).toBeUndefined();
    expect(closedAgentNamed([agentEntry("/c")], ID)).toBeUndefined();
  });

  it("reopens one that can be resumed, directly", () => {
    expect(
      closedAgentLink(ID, { aliases: [], stack: [own], isOpen: none }),
    ).toEqual({
      kind: "reopen",
      entry: own,
      agent: linked,
      session: reviewer.session,
    });
  });

  it("says one is gone that cannot be resumed, or is not remembered", () => {
    const sessionless: ClosedEntryRecord = {
      ...own,
      agent: {
        profile_id: "c",
        profile_kind: "custom",
        display_name: "Shell",
        presentation: "tui",
        agent_id: ID,
      },
    };
    expect(
      closedAgentLink(ID, { aliases: [], stack: [sessionless], isOpen: none }),
    ).toMatchObject({ kind: "gone", why: expect.stringContaining("Shell") });
    expect(
      closedAgentLink(ID, { aliases: [], stack: [], isOpen: none }),
    ).toMatchObject({ kind: "gone" });
  });

  it("follows an Agent reopened under a new id, through every id it had", () => {
    let aliases = rememberAlias([], "aaaa1111", "bbbb2222");
    aliases = rememberAlias(aliases, "bbbb2222", "cccc3333");
    expect(aliasedAgent(aliases, "aaaa1111")).toBe("cccc3333");
    expect(aliasedAgent(aliases, "bbbb")).toBe("cccc3333");
    expect(
      closedAgentLink("aaaa1111", {
        aliases,
        stack: [],
        isOpen: (id) => id === "cccc3333",
      }),
    ).toEqual({ kind: "successor", agentId: "cccc3333" });
    expect(decodeAgentAliases([...aliases, { from: "x", to: 1 }])).toEqual(
      aliases,
    );
  });

  it("reopens the successor when it was closed again", () => {
    const aliases = rememberAlias([], "aaaa1111", ID);
    expect(
      closedAgentLink("aaaa1111", { aliases, stack: [own], isOpen: none }),
    ).toMatchObject({ kind: "reopen", entry: own });
  });
});
