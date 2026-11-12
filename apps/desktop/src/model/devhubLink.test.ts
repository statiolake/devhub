/**
 * `devhub:` links: the syntax read and written, and resolved against what is
 * open.
 */

import { describe, expect, it } from "vitest";
import {
  formatDevhubLink,
  isDevhubLink,
  owningWorkspace,
  parseDevhubLink,
  resolveDevhubLink,
  type DevhubLink,
  type LinkPlaces,
} from "./devhubLink.js";

const AGENT = "3f2a9c1e-7b4d-4e2a-9c1e-7b4d4e2a9c1e";

function parsed(text: string): DevhubLink {
  const result = parseDevhubLink(text);
  if (!result.ok) throw new Error(result.problem);
  return result.link;
}

function problem(text: string): string {
  const result = parseDevhubLink(text);
  if (result.ok) throw new Error(`${text} parsed`);
  return result.problem;
}

describe("parsing a devhub: link", () => {
  it("reads every kind", () => {
    expect(parsed(`devhub:agent/${AGENT}`)).toEqual({
      kind: "agent",
      agent: AGENT,
    });
    expect(parsed("devhub:agent/3F2A9C1E")).toEqual({
      kind: "agent",
      agent: "3f2a9c1e",
    });
    expect(parsed("devhub:workspace/login-fix")).toEqual({
      kind: "workspace",
      workspace: "login-fix",
    });
    expect(parsed("devhub:escalation/12")).toEqual({
      kind: "escalation",
      id: 12,
    });
    expect(parsed("devhub:escalation/%2312")).toEqual({
      kind: "escalation",
      id: 12,
    });
    expect(parsed("devhub:orchestrator")).toEqual({ kind: "orchestrator" });
    expect(parsed("devhub:session/0b6c-77aa.x_y")).toEqual({
      kind: "session",
      session: "0b6c-77aa.x_y",
    });
    expect(isDevhubLink("DevHub:orchestrator")).toBe(true);
    expect(isDevhubLink("https://devhub.example")).toBe(false);
  });

  it("reads a file's path, percent-decoded, and its line and column", () => {
    expect(parsed("devhub:file/Users/me/app/src/a%20b.ts")).toEqual({
      kind: "file",
      path: "/Users/me/app/src/a b.ts",
    });
    expect(parsed("devhub:file/Users/me/app.ts:12")).toEqual({
      kind: "file",
      path: "/Users/me/app.ts",
      line: 12,
    });
    expect(parsed("devhub:file/Users/me/app.ts:12:3")).toEqual({
      kind: "file",
      path: "/Users/me/app.ts",
      line: 12,
      column: 3,
    });
    // An encoded colon is the path's own; only a trailing :N is a position.
    expect(parsed("devhub:file/tmp/a%3A12.txt")).toEqual({
      kind: "file",
      path: "/tmp/a:12.txt",
    });
    expect(parsed("devhub:file/tmp/%E6%97%A5%E6%9C%AC.md:2")).toEqual({
      kind: "file",
      path: "/tmp/日本.md",
      line: 2,
    });
  });

  it("refuses what is not a link, saying why", () => {
    expect(problem("https://x.test")).toMatch(/not a devhub: link/u);
    expect(problem("devhub://agent/abcd")).toMatch(/no \/\//u);
    expect(problem("devhub:robot/abcd")).toMatch(/not a kind/u);
    expect(problem("devhub:agent/")).toMatch(/needs what it names/u);
    expect(problem("devhub:agent/abc")).toMatch(/4\+ characters/u);
    expect(problem("devhub:agent/a%2Fbcd")).toMatch(/agent id/u);
    expect(problem("devhub:escalation/0")).toMatch(/escalation id/u);
    expect(problem("devhub:escalation/x")).toMatch(/escalation id/u);
    expect(problem("devhub:orchestrator/1")).toMatch(/nothing after/u);
    expect(problem("devhub:file//etc/passwd")).toMatch(/leading \//u);
    expect(problem("devhub:file/a/../etc")).toMatch(/\.\. segment/u);
    expect(problem("devhub:file/a%2F..%2Fb")).toMatch(/cannot have/u);
    expect(problem("devhub:file/a.ts:0")).toMatch(/starts at 1/u);
    expect(problem("devhub:file/a%ZZ.ts")).toMatch(/percent-encoded/u);
    expect(problem("devhub:file/a b.ts")).toMatch(/percent-encode/u);
    expect(problem("devhub:file/a.ts?x=1")).toMatch(/query/u);
    expect(problem("devhub:workspace/%0A")).toMatch(/workspace id or name/u);
  });

  it("writes each canonically, and reads it back", () => {
    const links: DevhubLink[] = [
      { kind: "agent", agent: AGENT },
      { kind: "workspace", workspace: "my app" },
      { kind: "file", path: "/Users/me/a b/c:d.ts", line: 4, column: 2 },
      { kind: "file", path: "/tmp/#x?.md" },
      { kind: "escalation", id: 7 },
      { kind: "orchestrator" },
      { kind: "session", session: "abc-123" },
    ];
    expect(links.map(formatDevhubLink)).toEqual([
      `devhub:agent/${AGENT}`,
      "devhub:workspace/my%20app",
      "devhub:file/Users/me/a%20b/c%3Ad.ts:4:2",
      "devhub:file/tmp/%23x%3F.md",
      "devhub:escalation/7",
      "devhub:orchestrator",
      "devhub:session/abc-123",
    ]);
    for (const link of links)
      expect(parsed(formatDevhubLink(link))).toEqual(link);
  });
});

const PLACES: LinkPlaces = {
  workspaces: [
    {
      id: "w1",
      label: "app",
      root: "/Users/me/app",
      local: true,
      agents: [{ id: AGENT, displayName: "API fix", status: "working" }],
    },
    {
      id: "w2",
      label: "app-login",
      root: "/Users/me/app/worktrees/login",
      local: true,
      agents: [{ id: "3f2a0000-0000", displayName: "Login", status: "idle" }],
    },
    {
      id: "w3",
      label: "app",
      root: "/srv/app",
      local: false,
      agents: [],
    },
  ],
  tasks: [{ id: 3, title: "列追加の作業", status: "answer" }],
  escalations: [{ id: 12, taskId: 3, title: "列追加", state: "open" }],
  orchestrator: true,
};

describe("resolving a link against what is open", () => {
  it("finds an agent by id or unique prefix, with its workspace", () => {
    const found = resolveDevhubLink(parsed(`devhub:agent/${AGENT}`), PLACES);
    expect(found).toMatchObject({
      found: true,
      target: { kind: "agent", agent: { displayName: "API fix" } },
    });
    expect(resolveDevhubLink(parsed("devhub:agent/3f2a9c"), PLACES).found).toBe(
      true,
    );
    // Two agents start so, in two workspaces: it names neither.
    expect(resolveDevhubLink(parsed("devhub:agent/3f2a"), PLACES)).toEqual({
      found: false,
      why: "no such agent is open",
    });
  });

  it("finds a workspace by id or unique name", () => {
    expect(
      resolveDevhubLink(parsed("devhub:workspace/w2"), PLACES),
    ).toMatchObject({ found: true, target: { workspace: { id: "w2" } } });
    expect(
      resolveDevhubLink(parsed("devhub:workspace/app-login"), PLACES),
    ).toMatchObject({ found: true, target: { workspace: { id: "w2" } } });
    // Two are called app.
    expect(
      resolveDevhubLink(parsed("devhub:workspace/app"), PLACES).found,
    ).toBe(false);
  });

  it("puts a file in the workspace whose root is its nearest ancestor", () => {
    expect(
      owningWorkspace("/Users/me/app/worktrees/login/a.ts", PLACES.workspaces)
        ?.id,
    ).toBe("w2");
    expect(owningWorkspace("/Users/me/app/a.ts", PLACES.workspaces)?.id).toBe(
      "w1",
    );
    expect(owningWorkspace("/Users/me/apple", PLACES.workspaces)).toBe(
      undefined,
    );
    expect(resolveDevhubLink(parsed("devhub:file/etc/hosts"), PLACES)).toEqual({
      found: false,
      why: "no open workspace holds this file",
    });
  });

  it("finds an escalation, and the Orchestrator row", () => {
    expect(
      resolveDevhubLink(parsed("devhub:escalation/12"), PLACES),
    ).toMatchObject({
      found: true,
      target: { escalation: { title: "列追加" } },
    });
    expect(
      resolveDevhubLink(parsed("devhub:escalation/13"), PLACES).found,
    ).toBe(false);
    expect(resolveDevhubLink(parsed("devhub:orchestrator"), PLACES).found).toBe(
      true,
    );
  });
});
