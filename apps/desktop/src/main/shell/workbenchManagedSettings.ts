/**
 * The workbench settings DevHub decides, held in each workbench's memory.
 *
 * Some settings are not the workbench's to choose because DevHub chooses
 * them for the whole application — today the colour theme: DevHub paints its
 * own chrome and its Agent panes in the theme `[appearance] theme_dark` /
 * `theme_light` name (`shellTheme.ts`), and an editor in another theme
 * would be a window in two themes. So every workbench is told the values,
 * and holds them in VS Code's *memory* configuration
 * (`ConfigurationTarget.MEMORY`): the layer above the person's
 * `settings.json` and a folder's `.vscode/settings.json`, which nothing writes
 * to disk. The person's files are left exactly as they are — their dotfiles
 * tool owns them (see `workbenchDefaults.ts` for why DevHub writes only what
 * nobody has said) — and still cannot make the editor disagree with DevHub.
 *
 * They are also the workbench's *defaults* (`registerDefaultConfigurations`,
 * source "DevHub"). The Settings editor never shows the memory layer — only a
 * setting's user, workspace and default values — so "Preferred Dark Color
 * Theme" read VS Code's default while DevHub's theme was worn; as the default
 * it reads what applies. And the workbench puts the memory values back after
 * every reload of its configuration, which upstream answers by starting the
 * memory layer again from nothing: Start Debugging (F5) and Run Task reload it
 * before every run, and with the values gone the person's own
 * `window.autoDetectColorScheme` picked the preferred theme at VS Code's
 * default.
 *
 * The workbench half is the overlay's `devhubManagedSettings.contribution.ts`
 * and `common/devhubManagedSettings.ts`.
 * A workbench starts with the values already on its window configuration
 * (`workbenchStartTheme.ts`): its theme service decides which theme to paint
 * its first frame in as it is constructed, before any question could be
 * answered. It then asks once (`vscode:devhubManagedSettingsRequest`), which
 * is what puts it among the workbenches told again whenever the values change
 * (`vscode:devhubManagedSettings`).
 */

import type { WorkbenchColorThemes } from "./shellTheme.js";

export const MANAGED_SETTINGS_CHANNEL = "vscode:devhubManagedSettings";
export const MANAGED_SETTINGS_REQUEST = "vscode:devhubManagedSettingsRequest";

/** The settings, by key, as `workbench.colorTheme` and friends spell them. */
export type ManagedSettings = Readonly<Record<string, unknown>>;

/**
 * The theme, as the four settings VS Code picks a theme from. Auto-detect is
 * on so a workbench follows the appearance the process is in by itself, from
 * the same `nativeTheme` DevHub reads; `workbench.colorTheme` is the theme for
 * the appearance now, for the moment before it has detected anything.
 */
export function managedSettingsOf(
	themes: WorkbenchColorThemes,
): ManagedSettings {
	return {
		"window.autoDetectColorScheme": true,
		"workbench.preferredDarkColorTheme": themes.dark,
		"workbench.preferredLightColorTheme": themes.light,
		"workbench.colorTheme": themes.current,
	};
}

/** As much of a `WebContents` as being told needs. */
export interface ManagedSettingsReceiver {
	send(channel: string, ...args: unknown[]): void;
	isDestroyed(): boolean;
	once(event: "destroyed", listener: () => void): unknown;
}

/** As much of `ipcMain` as hearing the request needs. */
export interface ManagedSettingsIpc {
	on(
		channel: string,
		listener: (event: { readonly sender: ManagedSettingsReceiver }) => void,
	): unknown;
}

export class WorkbenchManagedSettings {
	private readonly receivers = new Set<ManagedSettingsReceiver>();
	private last: string;

	constructor(private readonly settings: () => ManagedSettings) {
		this.last = JSON.stringify(settings());
	}

	/** Answer every workbench that asks, and remember it to tell it again. */
	listen(ipc: ManagedSettingsIpc): void {
		ipc.on(MANAGED_SETTINGS_REQUEST, (event) => {
			const receiver = event.sender;
			if (receiver.isDestroyed()) return;
			if (!this.receivers.has(receiver)) {
				this.receivers.add(receiver);
				receiver.once("destroyed", () => {
					this.receivers.delete(receiver);
				});
			}
			receiver.send(MANAGED_SETTINGS_CHANNEL, this.settings());
		});
	}

	/** The values may have changed: every workbench that asked hears them. */
	changed(): void {
		const settings = this.settings();
		const next = JSON.stringify(settings);
		if (next === this.last) return;
		this.last = next;
		for (const receiver of this.receivers) {
			if (receiver.isDestroyed()) {
				this.receivers.delete(receiver);
				continue;
			}
			receiver.send(MANAGED_SETTINGS_CHANNEL, settings);
		}
	}
}
