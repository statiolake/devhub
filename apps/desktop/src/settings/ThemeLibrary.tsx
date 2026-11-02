/**
 * Appearance's colour themes: preview them, search Open VSX for more, and
 * keep DevHub's own library (`main/shell/themeLibrary.ts`).
 *
 * Nothing here reaches the network until the person searches or presses
 * Install, and whatever fails is said in the group as a notice — the theme
 * names above are still what the settings say, and still what is worn.
 */

import { useCallback, useEffect, useState } from "react";
import type {
  SettingsOpenVsxThemeWire,
  SettingsThemeOutcomeWire,
  SettingsThemesWire,
} from "../ipc/settings";
import { Group, Row, WideRow } from "./controls";

export interface ThemesClient {
  themes(): Promise<SettingsThemesWire>;
  search(query: string): Promise<
    | {
        readonly kind: "found";
        readonly themes: readonly SettingsOpenVsxThemeWire[];
      }
    | { readonly kind: "failed"; readonly problem: string }
  >;
  install(theme: SettingsOpenVsxThemeWire): Promise<SettingsThemeOutcomeWire>;
  uninstall(id: string): Promise<SettingsThemeOutcomeWire>;
  preview(): Promise<void>;
}

export function ThemeLibrary({
  client,
  nameTheme,
}: {
  readonly client: ThemesClient;
  /** Name this theme in `theme_dark` or `theme_light`. */
  readonly nameTheme: (half: "dark" | "light", name: string) => void;
}) {
  const [themes, setThemes] = useState<SettingsThemesWire>();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly SettingsOpenVsxThemeWire[]>();
  const [busy, setBusy] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [done, setDone] = useState<string>();

  useEffect(() => {
    let live = true;
    void client.themes().then(
      (next) => {
        if (live) setThemes(next);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client]);

  const settle = useCallback((outcome: SettingsThemeOutcomeWire) => {
    setThemes(outcome.themes);
    setProblem(outcome.problem);
    setDone(outcome.problem === undefined ? outcome.done : undefined);
  }, []);

  const search = () => {
    setBusy("search");
    setProblem(undefined);
    setDone(undefined);
    void client
      .search(query)
      .then((answer) => {
        if (answer.kind === "found") {
          setResults(answer.themes);
        } else {
          setResults(undefined);
          setProblem(answer.problem);
        }
      })
      .finally(() => {
        setBusy(undefined);
      });
  };

  const installedIds = new Set(
    (themes?.library ?? []).map((theme) => theme.id.toLowerCase()),
  );

  return (
    <Group
      heading="Colour themes"
      note="Preview wears a theme for this session only — the window, every editor, the terminals and the managed Neovim — and changes no setting; DevHub goes back to the themes above when the settings are next applied or it restarts. Themes from Open VSX are installed for DevHub (and its editors) only, not into your own VS Code. Open VSX is reached only when you search or install."
    >
      <Row
        label="Preview"
        help={
          themes?.temporary
            ? `Worn for this session: ${themes.temporary}.`
            : `${String(themes?.available.length ?? 0)} themes can be worn.`
        }
      >
        <button
          type="button"
          className="mac-button"
          onClick={() => {
            void client.preview();
          }}
        >
          Preview Themes…
        </button>
      </Row>
      <Row
        label="Open VSX"
        help="Search the Open VSX registry's colour themes."
      >
        <form
          className="sf-value"
          onSubmit={(event) => {
            event.preventDefault();
            search();
          }}
        >
          <input
            className="mac-field sf-grow"
            aria-label="Search Open VSX themes"
            placeholder="nord, solarized, …"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
          <button
            type="submit"
            className="mac-button"
            disabled={busy !== undefined}
          >
            {busy === "search" ? "Searching…" : "Search"}
          </button>
        </form>
      </Row>
      {problem !== undefined ? (
        <WideRow>
          <p className="settings-theme-notice" role="alert">
            {problem}
          </p>
        </WideRow>
      ) : null}
      {done !== undefined ? (
        <WideRow>
          <p className="settings-theme-done mac-caption" role="status">
            {done}
          </p>
        </WideRow>
      ) : null}
      {results !== undefined ? (
        <WideRow>
          {results.length === 0 ? (
            <p className="mac-caption">
              No colour theme on Open VSX matches that.
            </p>
          ) : (
            <ul className="settings-theme-list" aria-label="Open VSX themes">
              {results.map((theme) => {
                const id = `${theme.namespace}.${theme.name}`;
                const installed = installedIds.has(id.toLowerCase());
                return (
                  <li key={id} className="settings-theme-item">
                    <div className="settings-theme-text">
                      <span className="settings-theme-name">
                        {theme.displayName}
                      </span>
                      <span className="mac-caption">
                        {id} {theme.version}
                        {theme.description ? ` — ${theme.description}` : ""}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="mac-button"
                      disabled={busy !== undefined || installed}
                      aria-label={`Install ${theme.displayName}`}
                      onClick={() => {
                        setBusy(id);
                        void client
                          .install(theme)
                          .then(settle)
                          .finally(() => {
                            setBusy(undefined);
                          });
                      }}
                    >
                      {installed
                        ? "Installed"
                        : busy === id
                          ? "Installing…"
                          : "Install"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </WideRow>
      ) : null}
      <Row
        label="Installed"
        help="Themes installed from Open VSX, in DevHub's own library."
      >
        {(themes?.library.length ?? 0) === 0 ? (
          <span className="mac-caption">None yet.</span>
        ) : null}
      </Row>
      {(themes?.library ?? []).length > 0 ? (
        <WideRow>
          <ul className="settings-theme-list" aria-label="Installed themes">
            {(themes?.library ?? []).map((theme) => (
              <li key={theme.id} className="settings-theme-item">
                <div className="settings-theme-text">
                  <span className="settings-theme-name">
                    {theme.displayName} {theme.version}
                  </span>
                  <span className="mac-caption">
                    {theme.id}
                    {theme.inWorkbench ? "" : " · not in the editors"}
                  </span>
                  <span className="settings-theme-uses">
                    {theme.themes.map((name) => (
                      <span key={name} className="settings-theme-use">
                        {name}
                        <button
                          type="button"
                          className="mac-button"
                          aria-label={`Use ${name} as the dark theme`}
                          onClick={() => {
                            nameTheme("dark", name);
                          }}
                        >
                          Dark
                        </button>
                        <button
                          type="button"
                          className="mac-button"
                          aria-label={`Use ${name} as the light theme`}
                          onClick={() => {
                            nameTheme("light", name);
                          }}
                        >
                          Light
                        </button>
                      </span>
                    ))}
                  </span>
                </div>
                <button
                  type="button"
                  className="mac-button"
                  disabled={busy !== undefined}
                  aria-label={`Uninstall ${theme.displayName}`}
                  onClick={() => {
                    setBusy(theme.id);
                    void client
                      .uninstall(theme.id)
                      .then(settle)
                      .finally(() => {
                        setBusy(undefined);
                      });
                  }}
                >
                  Uninstall
                </button>
              </li>
            ))}
          </ul>
        </WideRow>
      ) : null}
    </Group>
  );
}
