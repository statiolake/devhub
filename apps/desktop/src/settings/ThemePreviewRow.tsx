/**
 * Appearance's Preview row: how many themes `[appearance] theme` can name,
 * which one is worn for the session only (if any), and Theme: Preview… to
 * try them on in the main window. Nothing here writes a setting.
 */

import { useEffect, useState } from "react";
import type { SettingsThemesWire } from "../ipc/settings";
import { Row } from "./controls";

export interface ThemesClient {
  themes(): Promise<SettingsThemesWire>;
  preview(): Promise<void>;
}

export function ThemePreviewRow({ client }: { readonly client: ThemesClient }) {
  const [themes, setThemes] = useState<SettingsThemesWire>();

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

  return (
    <Row
      label="Preview"
      help={
        themes?.temporary
          ? `Worn for this session: ${themes.temporary}. The setting above comes back when the settings are next applied.`
          : `${String(themes?.available.length ?? 0)} themes can be named. Preview wears one for this session only, while the cursor is on it, and changes no setting.`
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
  );
}
