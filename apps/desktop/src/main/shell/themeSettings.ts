/**
 * Appearance's colour themes, behind the Settings window: every theme
 * `[appearance] theme` can name, and Theme: Preview… to try them on.
 */

import type { SettingsThemesWire } from "../../ipc/settings.js";
import type { SettingsThemesHost } from "./settingsWindow.js";
import type { ShellTheme } from "./shellTheme.js";

export interface ThemeSettingsOptions {
	readonly theme: () => ShellTheme;
	/** Open Theme: Preview… in the main window. */
	readonly preview: () => void;
}

export function themeSettings(
	options: ThemeSettingsOptions,
): SettingsThemesHost {
	return {
		themes(): Promise<SettingsThemesWire> {
			const shell = options.theme();
			const temporary = shell.temporaryTheme();
			return Promise.resolve({
				available: shell.available().map((theme) => ({ ...theme })),
				...(temporary ? { temporary: temporary.name } : {}),
			});
		},
		preview: options.preview,
		revertTemporary() {
			const shell = options.theme();
			if (shell.temporaryTheme()) shell.wearTemporarily(undefined, "session");
		},
	};
}
