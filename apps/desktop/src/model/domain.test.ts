import { describe, expect, it } from "vitest";
import {
  Agent,
  AgentProfile,
  agentProfileId,
  agentId,
  consolidateCloseInspection,
  closeInspectionProjection,
  busy,
  CLEAN,
  CLEAN_INSPECTION,
  DomainError,
  DomainErrorCode,
  displayPath,
  remoteIdentity,
  Repository,
  repositoryId,
  rootBasename,
  unknownResource,
  Workspace,
  workspaceId,
  workspaceRoot,
} from "./domain.js";

const UUID_A = "550e8400-e29b-41d4-a716-446655440000";
const UUID_B = "550e8400-e29b-41d4-a716-446655440001";
const UUID_C = "550e8400-e29b-41d4-a716-446655440002";

function codeOf(run: () => unknown): DomainErrorCode | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof DomainError ? error.code : undefined;
  }
  return undefined;
}

describe("identities", () => {
  it("accepts only canonical lowercase UUIDs", () => {
    expect(workspaceId(UUID_A)).toBe(UUID_A);
    expect(codeOf(() => workspaceId("workspace-a"))).toBe(
      DomainErrorCode.InvalidId,
    );
    expect(codeOf(() => workspaceId(UUID_A.toUpperCase()))).toBe(
      DomainErrorCode.InvalidId,
    );
    expect(codeOf(() => workspaceId(UUID_A.replaceAll("-", "")))).toBe(
      DomainErrorCode.InvalidId,
    );
  });

  it("accepts only lowercase slugs for profile identities", () => {
    expect(agentProfileId("codex")).toBe("codex");
    expect(codeOf(() => agentProfileId("Codex"))).toBe(
      DomainErrorCode.InvalidId,
    );
  });
});

describe("paths", () => {
  it("normalises lexically and rejects escapes above the root", () => {
    expect(workspaceRoot("/dev/./worktree/../repo")).toBe(
      workspaceRoot("/dev/repo"),
    );
    expect(displayPath("/dev/./repo")).toBe("/dev/repo");
    expect(codeOf(() => workspaceRoot("relative/repo"))).toBe(
      DomainErrorCode.InvalidPath,
    );
    expect(codeOf(() => workspaceRoot("/../repo"))).toBe(
      DomainErrorCode.InvalidPath,
    );
    expect(codeOf(() => workspaceRoot("/.."))).toBe(DomainErrorCode.InvalidPath);
  });

  it("names the root by its last component", () => {
    expect(rootBasename(workspaceRoot("/dev/repo"))).toBe("repo");
    expect(rootBasename(workspaceRoot("/"))).toBe("/");
  });
});

describe("remote identity", () => {
  it("normalises https and ssh aliases without credentials", () => {
    const https = remoteIdentity(
      "https://USER:secret@GitHub.com/Owner/Repo.git",
    );
    const ssh = remoteIdentity("git@github.com:owner/repo.git");
    const scp = remoteIdentity("alice@github.com:OWNER/Repo.git");
    expect(https).toBe("github.com/owner/repo");
    expect(ssh).toBe(https);
    expect(scp).toBe(ssh);
  });

  it("drops only the scheme's own default port", () => {
    expect(remoteIdentity("https://github.com:443/OWNER/Repo.git")).toBe(
      "github.com/owner/repo",
    );
    expect(remoteIdentity("https://github.com:8443/OWNER/Repo.git")).toBe(
      "github.com:8443/owner/repo",
    );
    expect(remoteIdentity("http://code.example:80/Owner/Repo")).toBe(
      remoteIdentity("http://code.example/Owner/Repo"),
    );
    expect(remoteIdentity("ssh://git@code.example:22/Owner/Repo")).toBe(
      remoteIdentity("ssh://git@code.example/Owner/Repo"),
    );
    expect(remoteIdentity("ssh://git@code.example:2222/Owner/Repo")).toBe(
      "code.example:2222/Owner/Repo",
    );
  });

  it("keeps non-GitHub paths case sensitive and rejects traversal", () => {
    expect(remoteIdentity("https://code.example/Owner/Repo.git")).toBe(
      "code.example/Owner/Repo",
    );
    expect(codeOf(() => remoteIdentity("https://code.example/owner/../repo"))).toBe(
      DomainErrorCode.InvalidRemote,
    );
  });

  it("collapses duplicate aliases and matches any of them", () => {
    const https = remoteIdentity("https://github.com/owner/repo");
    const repository = new Repository(repositoryId(UUID_A), https, [
      remoteIdentity("ssh://git@github.com/owner/repo"),
    ]);
    expect(repository.aliases).toHaveLength(1);
    expect(repository.matchesRemote(remoteIdentity("git@github.com:owner/repo"))).toBe(
      true,
    );
  });
});

describe("agent naming", () => {
  const profile = AgentProfile.create(
    agentProfileId("codex"),
    "Codex",
    "codex",
    ["--full-auto"],
  );

  it("derives a name from the profile and ordinal, and takes an override", () => {
    const agent = Agent.create(
      agentId(UUID_A),
      workspaceId(UUID_B),
      profile,
      2,
    );
    expect(agent.displayName).toBe("Codex 2");
    agent.rename("Investigator");
    expect(agent.displayName).toBe("Investigator");
    agent.resetName();
    expect(agent.displayName).toBe("Codex 2");
  });

  it("refuses a blank rename", () => {
    const agent = Agent.create(agentId(UUID_A), workspaceId(UUID_B), profile, 1);
    expect(codeOf(() => agent.rename("   "))).toBe(
      DomainErrorCode.InvalidDisplayName,
    );
  });
});

describe("workspace lifecycle", () => {
  const profile = AgentProfile.create(
    agentProfileId("codex"),
    "Codex",
    "codex",
  );

  it("keeps agents when unavailable but refuses new ones", () => {
    const owner = workspaceId(UUID_A);
    const workspace = new Workspace(
      owner,
      workspaceRoot("/dev/project"),
      displayPath("/dev/project"),
    );
    workspace.addAgent(Agent.create(agentId(UUID_B), owner, profile, 1));
    workspace.markUnavailable("root_missing");
    expect(workspace.agents).toHaveLength(1);
    expect(workspace.canCreateAgent).toBe(false);
    expect(
      codeOf(() =>
        workspace.addAgent(Agent.create(agentId(UUID_C), owner, profile, 2)),
      ),
    ).toBe(DomainErrorCode.WorkspaceUnavailable);
  });
});

describe("close inspection", () => {
  it("is clean when every resource is clean", () => {
    expect(consolidateCloseInspection(CLEAN_INSPECTION)).toEqual({
      kind: "clean",
    });
  });

  it("preserves every busy count", () => {
    const inspection = consolidateCloseInspection({
      agents: busy(2),
      terminalProcesses: busy(3),
      terminalPanes: CLEAN,
      terminalWindows: CLEAN,
      unsavedEditors: busy(1),
    });
    expect(inspection).toEqual({
      kind: "requires-confirmation",
      reasons: {
        agents: 2,
        terminalProcesses: 3,
        terminalPanes: 0,
        terminalWindows: 0,
        unsavedEditors: 1,
      },
      unknownDiagnostics: [],
    });
  });

  it("keeps each distinct unknown diagnostic once, in order", () => {
    const inspection = consolidateCloseInspection({
      agents: busy(1),
      terminalProcesses: unknownResource("close_terminal_unknown"),
      terminalPanes: unknownResource("close_terminal_unknown"),
      terminalWindows: unknownResource("close_editor_unknown"),
      unsavedEditors: CLEAN,
    });
    expect(inspection.kind).toBe("requires-confirmation");
    if (inspection.kind !== "requires-confirmation") return;
    expect(inspection.reasons.agents).toBe(1);
    expect(inspection.unknownDiagnostics).toEqual([
      "close_terminal_unknown",
      "close_editor_unknown",
    ]);
  });

  it("rejects a busy count of zero", () => {
    expect(codeOf(() => busy(0))).toBe(DomainErrorCode.InvalidBusyCount);
  });

  it("retains workspace identity and every resource state in the projection", () => {
    const projection = closeInspectionProjection(workspaceId(UUID_A), "DevHub", {
      agents: busy(2),
      terminalProcesses: unknownResource("close_terminal_unknown"),
      terminalPanes: CLEAN,
      terminalWindows: CLEAN,
      unsavedEditors: busy(1),
    });
    expect(projection.workspaceId).toBe(UUID_A);
    expect(projection.workspaceLabel).toBe("DevHub");
    expect(projection.agents).toEqual({ kind: "busy", count: 2 });
    expect(projection.terminalPanes).toEqual({ kind: "clean" });
  });
});
