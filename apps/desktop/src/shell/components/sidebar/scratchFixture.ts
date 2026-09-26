import type { WorkspaceSnapshot } from "../../../ipc/appShell";

/**
 * Scratch, as tests draw it: today's daily folder, an ordinary Workspace that
 * the snapshot names in `scratchWorkspaceId`. Every snapshot has one, so every
 * fixture that renders the Sidebar starts its `workspaces` with it.
 */
export const SCRATCH_ID = "scratch";

export function scratchWorkspace(
  overrides: Partial<WorkspaceSnapshot> = {},
): WorkspaceSnapshot {
  return {
    id: SCRATCH_ID,
    label: "Scratch",
    location: { kind: "local" },
    editor: { kind: "host" },
    root: "/home/example/junk/20260923",
    displayRoot: "~/junk/20260923",
    key: "/home/example/junk/20260923",
    selectedPath: "/home/example/junk/20260923",
    state: { kind: "available" },
    close: { kind: "idle" },
    canCreateAgent: true,
    agents: [],
    ...overrides,
  } as unknown as WorkspaceSnapshot;
}

/** Scratch selected: what `{ kind: "global" }` used to spell. */
export const ON_SCRATCH = {
  kind: "workspace",
  workspaceId: SCRATCH_ID,
} as const;
