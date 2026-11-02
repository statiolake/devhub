// @vitest-environment jsdom

/**
 * Appearance's colour themes: Open VSX searched only when asked, a result
 * installed, an installed theme named in a setting, and failures said.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsApp } from "./SettingsApp";
import { testClient, testConfig } from "./testHarness";
import type { ThemesClient } from "./ThemeLibrary";
import type {
  SettingsOpenVsxThemeWire,
  SettingsThemesWire,
} from "../ipc/settings";

afterEach(() => {
  cleanup();
});

const NORD: SettingsOpenVsxThemeWire = {
  namespace: "arcticicestudio",
  name: "nord-visual-studio-code",
  version: "0.19.0",
  displayName: "Nord",
  description: "An arctic theme.",
  downloadCount: 1,
  download: "https://open-vsx.org/x.vsix",
};

function themes(installed: boolean): SettingsThemesWire {
  return {
    available: [],
    library: installed
      ? [
          {
            id: "arcticicestudio.nord-visual-studio-code",
            version: "0.19.0",
            displayName: "Nord",
            themes: ["Nord"],
            inWorkbench: true,
          },
        ]
      : [],
  };
}

async function open(overrides: Partial<ThemesClient> = {}) {
  const { saves, client } = testClient(testConfig());
  const calls: string[] = [];
  const themesClient: ThemesClient = {
    themes: () => Promise.resolve(themes(false)),
    search: (query) => {
      calls.push(`search ${query}`);
      return Promise.resolve({ kind: "found", themes: [NORD] });
    },
    install: (theme) => {
      calls.push(`install ${theme.name}`);
      return Promise.resolve({
        themes: themes(true),
        done: "Installed Nord: Nord.",
      });
    },
    uninstall: (id) => {
      calls.push(`uninstall ${id}`);
      return Promise.resolve({ themes: themes(false) });
    },
    preview: () => {
      calls.push("preview");
      return Promise.resolve();
    },
    ...overrides,
  };
  render(<SettingsApp client={{ ...client, themes: themesClient }} />);
  fireEvent.click(await screen.findByRole("tab", { name: "General" }));
  return { saves, calls };
}

describe("the colour themes group", () => {
  it("asks Open VSX nothing until a search, then installs and uses a result", async () => {
    const { saves, calls } = await open();
    expect(calls).toEqual([]);
    fireEvent.change(screen.getByLabelText("Search Open VSX themes"), {
      target: { value: "nord" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Install Nord" }),
    );
    expect(
      await screen.findByText("Installed Nord: Nord."),
    ).toBeInTheDocument();
    expect(calls).toEqual(["search nord", "install nord-visual-studio-code"]);
    fireEvent.click(
      screen.getByRole("button", { name: "Use Nord as the dark theme" }),
    );
    await vi.waitFor(() => {
      expect(saves.map((save) => save.appearance.themeDark)).toEqual(["Nord"]);
    });
    fireEvent.click(screen.getByRole("button", { name: "Uninstall Nord" }));
    await vi.waitFor(() => {
      expect(calls.at(-1)).toBe(
        "uninstall arcticicestudio.nord-visual-studio-code",
      );
    });
  });

  it("says a network failure as a notice", async () => {
    await open({
      search: () =>
        Promise.resolve({
          kind: "failed",
          problem: "DevHub could not reach Open VSX: fetch failed",
        }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(
      await screen.findByText("DevHub could not reach Open VSX: fetch failed"),
    ).toBeInTheDocument();
  });

  it("opens the preview", async () => {
    const { calls } = await open();
    fireEvent.click(screen.getByRole("button", { name: "Preview Themes…" }));
    expect(calls).toEqual(["preview"]);
  });
});
