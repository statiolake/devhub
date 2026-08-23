import validFixtures from "../../../../contracts/settings/valid.json";
import {
  parseSettingsSnapshot,
  type SettingsSnapshot,
} from "../generated/settings";

export const SETTINGS_FIXTURE_NAMES = [
  "settings-ready",
  "settings-dirty",
  "settings-conflict",
  "settings-invalid-diagnostic",
  "settings-socket-confirmation",
] as const;

export type SettingsFixtureName = (typeof SETTINGS_FIXTURE_NAMES)[number];

const baseSnapshot = parseSettingsSnapshot(
  validFixtures[0],
) as SettingsSnapshot;

function snapshotWith(changes: Partial<SettingsSnapshot>): SettingsSnapshot {
  return { ...baseSnapshot, ...changes };
}

const invalidDiagnosticSnapshot = snapshotWith({
  diagnostic: {
    code: "invalid_appearance",
    path: "appearance.terminalFontSize",
    line: 12,
    column: 7,
  },
});

const socketConfirmationSnapshot = snapshotWith({
  runtime: {
    ...baseSnapshot.runtime,
    health: {
      ...baseSnapshot.runtime.health,
      inspectionAvailable: true,
      shell: "healthy",
      git: "healthy",
      tmux: "healthy",
      herdr: "healthy",
    },
    socketChange: {
      ...baseSnapshot.runtime.socketChange,
      state: "pending",
      requestedSocketName: "devhub-fixture",
      targetPreflight: "target_devhub_empty",
      scratchSessionCount: 2,
      workspaceSessionCount: 3,
      completedSessionCount: 0,
      failedSessionCount: 0,
      confirmationRequired: true,
      adapterAvailable: true,
    },
  },
});

export const settingsFixtureSnapshots: Readonly<
  Record<SettingsFixtureName, SettingsSnapshot>
> = {
  "settings-ready": baseSnapshot,
  "settings-dirty": baseSnapshot,
  "settings-conflict": baseSnapshot,
  "settings-invalid-diagnostic": invalidDiagnosticSnapshot,
  "settings-socket-confirmation": socketConfirmationSnapshot,
};

/**
 * Resolves development-only Settings visual routes. Unknown, duplicate, and
 * malformed values fall through to the real native application.
 */
export function parseSettingsFixtureQuery(
  search: string,
): SettingsFixtureName | undefined {
  const values = new URLSearchParams(search).getAll("fixture");
  if (values.length !== 1) return undefined;
  return (SETTINGS_FIXTURE_NAMES as readonly string[]).includes(values[0])
    ? (values[0] as SettingsFixtureName)
    : undefined;
}

export function settingsConflictSnapshot(): SettingsSnapshot {
  return snapshotWith({
    sequence: baseSnapshot.sequence + 1,
    revision: "f".repeat(64),
    config: {
      ...baseSnapshot.config,
      general: { importLoginEnvironment: true },
    },
  });
}
