/**
 * The colour theme a workbench is *started* in: handed to it before its first
 * frame, so that no frame of it is in another theme.
 *
 * DevHub names the theme every workbench wears (`shellTheme.ts`), and a
 * running workbench is told it in its memory configuration
 * (`workbenchManagedSettings.ts`). Being told at startup was not enough: a
 * workbench paints its window splash before any of its code runs, and its
 * theme service starts — from the theme it cached last time, if that is the
 * theme its settings name — long before an answer to a question could
 * arrive. So the settings that answer had been the person's own
 * `workbench.colorTheme` (or VS Code's default) when the theme service
 * started; the cached theme, which was DevHub's, did not match them and was
 * thrown away; and every reload, every wake from hibernation and every cold
 * start painted VS Code's default dark or light first and changed to the
 * right theme once the extensions were registered and the answer had come.
 *
 * Three things are now in place before the first frame, all made from the one
 * theme `ShellTheme` resolved:
 *
 * - **The settings themselves**, on the window configuration
 *   (`devhubManagedSettings`). The overlay's theme service writes them into
 *   the memory configuration before upstream's constructor reads the
 *   configured theme, so the theme it cached — DevHub's — is the one it
 *   starts in, token colours and all.
 * - **The theme's colours** (`devhubInitialColorTheme`, VS Code's own
 *   `IInitialColorTheme`), for a workbench that has no matching theme cached:
 *   one whose profile has never worn it, or one that slept through the change
 *   to it. It starts in those colours instead of the default's, and loads the
 *   theme's file as it always does.
 * - **The window splash** (`splashForWorkbench`), which the page paints
 *   before any of the workbench is loaded, and which colours the view behind
 *   the page. VS Code stores one splash for every window, saved by whichever
 *   workbench saved last; DevHub stamps each save with the theme it was saved
 *   in, and a splash saved in any other theme — or never stamped — is
 *   replaced by one made from the theme being worn.
 *
 * The configuration carries the values from wherever a window is loaded —
 * opened, reloaded (Developer: Reload Window, DevHub's own reload), woken,
 * restored at a cold start — because every one of those loads hands the
 * renderer a configuration through the same object URL
 * (`DevHubProtocolMainService`).
 */

import type { ManagedSettings } from "./workbenchManagedSettings.js";
import { managedSettingsOf } from "./workbenchManagedSettings.js";
import {
	shellThemeIfInstalled,
	type WorkbenchColorThemes,
} from "./shellTheme.js";
import {
	initialColorThemeOf,
	windowSplashOfTheme,
	type InitialColorTheme,
	type ResolvedColorTheme,
	type WindowSplashColors,
} from "../../model/colorTheme.js";

/** Everything a starting workbench is handed, from the one resolved theme. */
export interface WorkbenchStart {
	readonly settings: ManagedSettings;
	readonly initialColorTheme: InitialColorTheme;
	readonly splash: WindowSplashColors;
	/** Which theme a stored splash has to have been saved in to be shown. */
	readonly splashKey: string;
}

export function workbenchStartOf(
	theme: ResolvedColorTheme,
	themes: WorkbenchColorThemes,
): WorkbenchStart {
	const splash = windowSplashOfTheme(theme);
	return {
		settings: managedSettingsOf(themes),
		initialColorTheme: initialColorThemeOf(theme.definition),
		splash,
		splashKey: JSON.stringify([theme.definition.settingsId, splash]),
	};
}

/** What a workbench starting now is handed; none in a process with no theme. */
export function currentWorkbenchStart(): WorkbenchStart | undefined {
	const theme = shellThemeIfInstalled();
	return (
		theme &&
		workbenchStartOf(theme.workbenchColorTheme(), theme.workbenchThemes())
	);
}

/** The fields DevHub adds to a window configuration. */
export interface WorkbenchStartConfiguration {
	readonly devhubManagedSettings: ManagedSettings;
	readonly devhubInitialColorTheme: InitialColorTheme;
	/**
	 * Off: the splash a window is given is already the one for the theme it
	 * will wear (`splashForWorkbench`), and upstream's page would otherwise
	 * drop it whenever the theme's type is not the system appearance's — a
	 * light theme named for the dark appearance, say — for VS Code's default
	 * colours. Only the splash reads this field.
	 */
	readonly autoDetectColorScheme: false;
}

/**
 * A window configuration with the start theme in it. Only a window
 * configuration is touched — an object with a `windowId` — and a new object
 * is returned, so the configuration the window keeps is the one VS Code made.
 */
export function withWorkbenchStart<T>(
	configuration: T,
	start: WorkbenchStart,
): T {
	if (
		typeof configuration !== "object" ||
		configuration === null ||
		!("windowId" in configuration)
	) {
		return configuration;
	}
	const fields: WorkbenchStartConfiguration = {
		devhubManagedSettings: start.settings,
		devhubInitialColorTheme: start.initialColorTheme,
		autoDetectColorScheme: false,
	};
	return { ...configuration, ...fields };
}

/** As much of VS Code's `IPartsSplash` as this reads and writes. */
export interface StoredSplash {
	readonly baseTheme: string;
	readonly colorInfo: { readonly background: string };
	readonly layoutInfo?: unknown;
	readonly zoomLevel?: number;
	/** The `splashKey` it was saved under; absent before DevHub stamped it. */
	readonly devhubColorTheme?: string;
}

/** The splash about to be stored, stamped with the theme it was saved in. */
export function stampSplash<S extends object>(
	splash: S,
	start: WorkbenchStart | undefined,
): S {
	if (!start) return splash;
	return { ...splash, devhubColorTheme: start.splashKey };
}

/**
 * The splash a workbench about to load is given: the stored one when it was
 * saved in the theme being worn now, and otherwise one made from that theme —
 * colours with no layout, which the page paints as a plain ground in the right
 * colour rather than the last theme's parts. Without a theme (a test, or a
 * process with no shell) it is upstream's, untouched.
 */
export function splashForWorkbench<S extends StoredSplash>(
	stored: S | undefined,
	start: WorkbenchStart | undefined,
): S | WindowSplashColors | undefined {
	if (!start) return stored;
	if (stored?.devhubColorTheme === start.splashKey) return stored;
	return stored?.zoomLevel === undefined
		? start.splash
		: { ...start.splash, zoomLevel: stored.zoomLevel };
}
