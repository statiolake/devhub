/**
 * Appearance's colour themes, behind the Settings window: every theme DevHub
 * can wear, DevHub's own library (`themeLibrary.ts`), and Open VSX
 * (`openVsx.ts`) to add to it. Open VSX is reached only from here, and only
 * because the person searched or pressed Install; whatever goes wrong comes
 * back as a sentence the page shows as a notice, never as a thrown error.
 */

import type {
	SettingsOpenVsxThemeWire,
	SettingsThemeOutcomeWire,
	SettingsThemeSearchWire,
	SettingsThemesWire,
} from "../../ipc/settings.js";
import type { SettingsThemesHost } from "./settingsWindow.js";
import type { ShellTheme } from "./shellTheme.js";
import type { OpenVsxClient } from "./openVsx.js";
import type { ThemeLibrary, WorkbenchExtensions } from "./themeLibrary.js";
import { failureText } from "../../model/wire.js";

export interface ThemeSettingsOptions {
	readonly theme: () => ShellTheme;
	readonly library: ThemeLibrary;
	readonly openVsx: OpenVsxClient;
	/** The workbench's extensions, when VS Code's services are up. */
	readonly workbench: () => Promise<WorkbenchExtensions | undefined>;
	/** Open Theme: Preview… in the main window. */
	readonly preview: () => void;
}

/** A failure in its own words: a named one as its summary and detail. */
function sentence(error: unknown): string {
	return failureText(error);
}

export function themeSettings(
	options: ThemeSettingsOptions,
): SettingsThemesHost {
	const themes = async (): Promise<SettingsThemesWire> => {
		const shell = options.theme();
		const library = await options.library.list();
		const temporary = shell.temporaryTheme();
		return {
			available: shell.available().map((theme) => ({ ...theme })),
			library: library.map((theme) => ({
				id: theme.id,
				version: theme.version,
				displayName: theme.displayName,
				themes: theme.themes.map((item) => item.name),
				inWorkbench: theme.inWorkbench,
			})),
			...(temporary ? { temporary: temporary.name } : {}),
		};
	};
	return {
		themes,
		async search(query): Promise<SettingsThemeSearchWire> {
			try {
				const found = await options.openVsx.searchThemes(query);
				return { kind: "found", themes: found.themes };
			} catch (error) {
				return { kind: "failed", problem: sentence(error) };
			}
		},
		async install(
			wanted: SettingsOpenVsxThemeWire,
		): Promise<SettingsThemeOutcomeWire> {
			const label = `${wanted.namespace}.${wanted.name}`;
			try {
				const vsix = await options.openVsx.download(wanted);
				const installed = await options.library.install(
					vsix,
					`open-vsx:${label}@${wanted.version}`,
					await options.workbench().catch(() => undefined),
				);
				const names = installed.theme.themes.map((theme) => theme.name);
				return {
					themes: await themes(),
					done: `Installed ${installed.theme.displayName}: ${names.join(", ")}.`,
					...(installed.workbenchProblem === undefined
						? {}
						: {
								problem: `${installed.theme.displayName} is installed for DevHub, but not in the editors, which will wear VS Code's default instead: ${installed.workbenchProblem}`,
							}),
				};
			} catch (error) {
				return {
					themes: await themes(),
					problem: `${label} was not installed. ${sentence(error)}`,
				};
			}
		},
		async uninstall(id): Promise<SettingsThemeOutcomeWire> {
			try {
				const removed = await options.library.uninstall(
					id,
					await options.workbench().catch(() => undefined),
				);
				return {
					themes: await themes(),
					done: `Removed ${id}. A setting that names one of its themes falls back to VS Code's default the next time it is applied.`,
					...(removed.workbenchProblem === undefined
						? {}
						: {
								problem: `${id} is removed from DevHub but is still installed in the editors: ${removed.workbenchProblem}`,
							}),
				};
			} catch (error) {
				return {
					themes: await themes(),
					problem: `${id} was not removed. ${sentence(error)}`,
				};
			}
		},
		preview: options.preview,
		revertTemporary() {
			const shell = options.theme();
			if (shell.temporaryTheme()) shell.wearTemporarily(undefined, "session");
		},
	};
}
