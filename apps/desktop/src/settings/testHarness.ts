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
import {
  DEFAULT_ACTION_ID,
  DEFAULT_ACTION_NAME,
  DEFAULT_ACTION_TEMPLATE,
} from "../model/agentActions";
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
    scratch: { daily: "~/junk/YYYYMMDD" },
    runtimes: {
      shell: "/bin/zsh",
      git: "git",
      tmux: "tmux",
      tmuxSocketName: "devhub",
      tmuxArgs: [],
    },
    appearance: {
      mode: "auto",
      titleBar: "shown",
      sidebarDensity: "compact",
      terminalFontFamily: "SF Mono",
      terminalFontSize: 13,
      terminalLineHeight: 1.2,
      terminalScrollSensitivity: 3,
      terminalMargin: 4,
      terminalTheme: { light: PALETTE, dark: PALETTE },
    },
    keybindings: { prefix: "Cmd+q", chords: {} },
    workspaceSources: [],
    agentProfiles: [],
    // The one action DevHub ships, as a fresh config carries it.
    agentActions: [
      {
        id: DEFAULT_ACTION_ID,
        displayName: DEFAULT_ACTION_NAME,
        template: DEFAULT_ACTION_TEMPLATE,
        confirmBeforeSend: true,
        trigger: "issue",
        enabled: true,
      },
    ],
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
    notices: [],
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

/**
 * The one thing the Settings window needs from the *shell* bridge.
 *
 * Settings talks to main over `SETTINGS_CHANNELS` and has its own client for
 * it. It reaches `window.devhub` for exactly one thing: an app-scoped failure
 * that began in this window comes back to this window to be drawn, and that
 * arrives on `nativeError` like it does on every other page. A test that
 * renders the window therefore needs the bridge to exist, and this is all of
 * it that is used.
 */
export function stubShellBridge(): { raise: (error: unknown) => void } {
  // One holder for the process, so calling this twice — the harness installs
  // it, and a test that wants to raise through it asks again — does not leave
  // one of the two handles wired to a bridge that has been replaced.
  const listeners = new Set<(error: unknown) => void>();
  const existing = (window as unknown as { devhub?: { listeners?: unknown } })
    .devhub;
  const holder =
    (existing?.listeners as Set<(error: unknown) => void> | undefined) ??
    listeners;
  (window as unknown as { devhub: unknown }).devhub = {
    listeners: holder,
    onNativeError: (listener: (error: unknown) => void) => {
      holder.add(listener);
      return () => holder.delete(listener);
    },
  };
  return {
    raise: (error) => {
      for (const listener of [...holder]) listener(error);
    },
  };
}

export function testClient(initial: SettingsConfig): {
  readonly saves: SettingsConfig[];
  /** Which keys each "reset this screen" asked main to drop. */
  readonly resets: (readonly string[])[];
  readonly client: SettingsClient;
} {
  const saves: SettingsConfig[] = [];
  const resets: (readonly string[])[] = [];
  // Every test that renders the window needs the shell bridge to exist, for
  // the one thing the window uses it for. Here rather than in each test,
  // because a harness that leaves one thing out is a harness the next test
  // forgets about.
  stubShellBridge();
  let current = initial;
  const snapshot = () => testSnapshot(current, saves.length + 1);
  const client: SettingsClient = {
    getSnapshot: () => Promise.resolve(snapshot()),
    save: (request) => {
      saves.push(request.config);
      current = request.config;
      return Promise.resolve(snapshot());
    },
    // The page hands over names, not values: the defaults live in the model,
    // which only main has.
    resetScope: (request) => {
      resets.push(request.keys);
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
  return { saves, resets, client };
}
