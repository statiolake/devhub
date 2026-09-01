/**
 * A Settings window with a transport that answers, for the tests.
 *
 * The saves are the whole point: what leaves the window is what DevHub is being
 * asked to write, so a keystroke that never becomes a save can never be
 * refused, and a control that saves something the person did not choose is a
 * bug no screenshot would show.
 *
 * The transport keeps the config it was last asked to save, so the window sees
 * what a real one would — a snapshot that reflects the write, with a sequence
 * that moves forward.
 */

import type {
  SettingsConfig,
  SettingsSnapshot,
  SettingsTerminalPaletteWire,
} from "../ipc/settings";
import { SETTINGS_SCHEMA_VERSION } from "../ipc/settings";
import { AGENT_ACTIONS } from "../model/agentActions";
import type { SettingsClient } from "./client";

const PALETTE: SettingsTerminalPaletteWire = {
  background: "#FFFFFF",
  foreground: "#202020",
  cursor: "#202020",
  cursorText: "#FFFFFF",
  selectionBackground: "#BFD9F2",
  selectionForeground: "#202020",
  ansi: Array.from({ length: 16 }, () => "#202020"),
};

export function testConfig(
  patch: Partial<SettingsConfig> = {},
): SettingsConfig {
  return {
    version: 1,
    general: { importLoginEnvironment: true },
    runtimes: {
      shell: "/bin/zsh",
      git: "git",
      tmux: "tmux",
      tmuxSocketName: "devhub",
      tmuxArgs: [],
    },
    appearance: {
      mode: "auto",
      sidebarDensity: "compact",
      terminalFontFamily: "SF Mono",
      terminalFontSize: 13,
      terminalLineHeight: 1.2,
      terminalMargin: 4,
      terminalTheme: { light: PALETTE, dark: PALETTE },
    },
    workspaceSources: [],
    agentProfiles: [],
    // Every action DevHub has, exactly as a real config always carries them.
    agentActions: AGENT_ACTIONS.map((action) => ({
      id: action.id,
      template: action.defaultTemplate,
    })),
    ...patch,
  };
}

const RESOLVED = { kind: "command_name" as const, value: "x" };

export function testSnapshot(
  config: SettingsConfig,
  sequence: number,
): SettingsSnapshot {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    sequence,
    revision: "rev-1",
    config,
    runtime: {
      configured: config.runtimes,
      resolved: {
        shell: RESOLVED,
        git: RESOLVED,
        tmux: RESOLVED,
      },
      effective: config.runtimes,
      health: {
        shell: "healthy",
        git: "healthy",
        tmux: "healthy",
        inspectionAvailable: true,
      },
      restartRequired: false,
      loginEnvironment: "Imported from /bin/zsh.",
    },
    diagnostics: {
      sessionId: "session",
      logDirectory: "logs",
      logLevel: "info",
      previousExit: "clean",
      health: "healthy",
      recentCodes: [],
    },
  };
}

export function testClient(initial: SettingsConfig): {
  readonly saves: SettingsConfig[];
  readonly client: SettingsClient;
} {
  const saves: SettingsConfig[] = [];
  let current = initial;
  const snapshot = () => testSnapshot(current, saves.length + 1);
  const client: SettingsClient = {
    getSnapshot: () => Promise.resolve(snapshot()),
    save: (request) => {
      saves.push(request.config);
      current = request.config;
      return Promise.resolve(snapshot());
    },
    reload: () => Promise.resolve(snapshot()),
    recheck: () => Promise.resolve(snapshot()),
    openLogFolder: () => Promise.resolve(),
    copyDiagnostics: () => Promise.resolve(),
    socketPreflight: () =>
      Promise.resolve({
        requestedSocketName: "devhub-other",
        state: "target_absent" as const,
        ownedSessionCount: 0,
        unknownSessionCount: 0,
      }),
    socketApply: () => Promise.resolve(snapshot()),
    close: () => Promise.resolve(),
    subscribe: () => () => undefined,
  };
  return { saves, client };
}
