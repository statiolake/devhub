// @vitest-environment jsdom

/**
 * Changing the terminal font family.
 *
 * The bug this pins: the field used to apply every keystroke, so clearing
 * "SF Mono" to type "Menlo" asked DevHub to accept an empty font family, and
 * the refusal that came back was about a value nobody had chosen — while the
 * word being typed was still on screen. What is asserted here is that the
 * half-typed states never leave the window at all, and that the ones a person
 * really does type are carried through unchanged.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsConfig, SettingsSnapshot } from "../ipc/settings";
import { SETTINGS_SCHEMA_VERSION } from "../ipc/settings";
import { FONT_FAMILY_RULE } from "../model/fontFamily";
import { SettingsApp } from "./SettingsApp";
import type { SettingsClient } from "./client";

afterEach(cleanup);

const PALETTE = {
  background: "#FFFFFF",
  foreground: "#202020",
  cursor: "#202020",
  cursorText: "#FFFFFF",
  selectionBackground: "#BFD9F2",
  selectionForeground: "#202020",
  ansi: Array.from({ length: 16 }, () => "#202020"),
};

function config(terminalFontFamily: string): SettingsConfig {
  return {
    version: 1,
    general: { importLoginEnvironment: true },
    runtimes: {
      shell: "/bin/zsh",
      git: "git",
      tmux: "tmux",
      herdr: "herdr",
      tmuxSocketName: "devhub",
      tmuxArgs: [],
    },
    appearance: {
      colorScheme: "light",
      sidebarDensity: "compact",
      terminalFontFamily,
      terminalFontSize: 13,
      terminalLineHeight: 1.2,
      terminalMargin: 4,
      terminalTheme: { light: PALETTE, dark: PALETTE },
    },
    workspaceSources: [],
    agentProfiles: [],
  };
}

const RUNTIME = {
  kind: "command_name" as const,
  value: "x",
};

function snapshot(terminalFontFamily: string): SettingsSnapshot {
  const wire = config(terminalFontFamily);
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    sequence: 1,
    revision: "rev-1",
    config: wire,
    runtime: {
      configured: wire.runtimes,
      resolved: {
        shell: RUNTIME,
        git: RUNTIME,
        tmux: RUNTIME,
        herdr: RUNTIME,
      },
      effective: wire.runtimes,
      health: {
        shell: "healthy",
        git: "healthy",
        tmux: "healthy",
        herdr: "healthy",
        inspectionAvailable: true,
      },
      restartRequired: false,
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

/**
 * A transport that records every save it is asked to make.
 *
 * The saves are the whole point: a keystroke that never becomes one is a
 * keystroke that can never be refused.
 */
function harness(initial = "SF Mono") {
  const saves: string[] = [];
  const client: SettingsClient = {
    getSnapshot: () => Promise.resolve(snapshot(initial)),
    save: (request) => {
      saves.push(request.config.appearance.terminalFontFamily);
      return Promise.resolve({
        ...snapshot(request.config.appearance.terminalFontFamily),
        sequence: saves.length + 1,
      });
    },
    reload: () => Promise.resolve(snapshot(initial)),
    recheck: () => Promise.resolve(snapshot(initial)),
    openLogFolder: () => Promise.resolve(),
    copyDiagnostics: () => Promise.resolve(),
    socketPreflight: () =>
      Promise.resolve({
        requestedSocketName: "devhub",
        state: "target_absent" as const,
        ownedSessionCount: 0,
        unknownSessionCount: 0,
      }),
    socketApply: () => Promise.resolve(snapshot(initial)),
    close: () => Promise.resolve(),
    subscribe: () => () => undefined,
  };
  return { saves, client };
}

async function openAppearance(client: SettingsClient) {
  render(<SettingsApp client={client} />);
  fireEvent.click(await screen.findByRole("button", { name: "Appearance" }));
  return screen.getByLabelText("Terminal font family");
}

const type = (field: HTMLElement, value: string) => {
  fireEvent.change(field, { target: { value } });
};

describe("the terminal font family field", () => {
  it("carries every spelling a person types through to the save", async () => {
    for (const family of [
      "Menlo",
      "JetBrains Mono, Menlo, monospace",
      '"Fira Code"',
      "SF Mono",
    ]) {
      // Started from something else each time, so every spelling below is a
      // real change rather than the value already in effect.
      const { saves, client } = harness("ui-monospace");
      const field = await openAppearance(client);

      type(field, family);
      fireEvent.blur(field);

      await vi.waitFor(() => {
        expect(saves).toEqual([family]);
      });
      cleanup();
    }
  });

  it("saves nothing while the field is being typed into", async () => {
    const { saves, client } = harness();
    const field = await openAppearance(client);

    // The states a person passes through on the way from SF Mono to Menlo.
    // The empty one is the one that used to be sent and refused.
    for (const step of ["", "M", "Me", "Men", "Menl", "Menlo"]) {
      type(field, step);
    }

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(saves).toEqual([]);
    expect(screen.getByText(/Not applied yet/)).toBeInTheDocument();
  });

  it("states the rule for an empty family rather than sending it", async () => {
    const { saves, client } = harness();
    const field = await openAppearance(client);

    type(field, "");
    fireEvent.blur(field);

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(saves).toEqual([]);
    expect(screen.getByRole("alert")).toHaveTextContent(FONT_FAMILY_RULE);
    // The refusal is visible and the typing is kept — nothing is silently
    // reverted behind the person's back.
    expect(screen.getByLabelText("Terminal font family")).toHaveValue("");
  });

  it("commits on Return without leaving the field", async () => {
    const { saves, client } = harness();
    const field = await openAppearance(client);

    type(field, "Menlo");
    fireEvent.keyDown(field, { key: "Enter" });

    await vi.waitFor(() => {
      expect(saves).toEqual(["Menlo"]);
    });
  });

  it("puts back what is in effect on Escape", async () => {
    const { saves, client } = harness();
    const field = await openAppearance(client);

    type(field, "Menl");
    fireEvent.keyDown(field, { key: "Escape" });

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(saves).toEqual([]);
    expect(screen.getByLabelText("Terminal font family")).toHaveValue(
      "SF Mono",
    );
  });
});
