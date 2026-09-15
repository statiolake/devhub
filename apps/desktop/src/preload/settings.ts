/**
 * The Settings window's bridge — `settings.html`.
 *
 * Two globals, because Settings does two unrelated things. Everything it is
 * *for* is `window.devhubSettings` and its own channel namespace
 * (`ipc/settings.ts`): read the config, save it against the revision it was
 * drafted from, reload, re-resolve the runtimes, reach the two diagnostics
 * affordances. `window.devhub` carries only the failure contract every DevHub
 * page has — the palette this window wears, what began here told to main, and
 * what main tells back drawn here. It reaches nothing else: this window has no
 * snapshot, no workspaces and no modal layer, and nothing about it can spell
 * them.
 */

import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS, type SettingsPageBridge } from "../ipc/contract.js";
import type { AppError } from "../ipc/appShell.js";
import {
	SETTINGS_CHANNELS,
	type SettingsApi,
	type SettingsResetRequestWire,
	type SettingsSaveRequestWire,
	type SettingsSnapshot,
	type SettingsSocketPreflightWire,
} from "../ipc/settings.js";
import { on, pageBridge } from "./bridge.js";

const devhub: SettingsPageBridge = {
	...pageBridge(),
	onNativeError: (listener) => on<AppError>(CHANNELS.nativeError, listener),
};

const devhubSettings: SettingsApi = {
	getSnapshot: () =>
		ipcRenderer.invoke(
			SETTINGS_CHANNELS.getSnapshot,
		) as Promise<SettingsSnapshot>,
	save: (request: SettingsSaveRequestWire) =>
		ipcRenderer.invoke(
			SETTINGS_CHANNELS.save,
			request,
		) as Promise<SettingsSnapshot>,
	resetScope: (request: SettingsResetRequestWire) =>
		ipcRenderer.invoke(
			SETTINGS_CHANNELS.resetScope,
			request,
		) as Promise<SettingsSnapshot>,
	reload: () =>
		ipcRenderer.invoke(SETTINGS_CHANNELS.reload) as Promise<SettingsSnapshot>,
	recheck: () =>
		ipcRenderer.invoke(SETTINGS_CHANNELS.recheck) as Promise<SettingsSnapshot>,
	openLogFolder: () =>
		ipcRenderer.invoke(SETTINGS_CHANNELS.openLogFolder) as Promise<void>,
	copyDiagnostics: () =>
		ipcRenderer.invoke(SETTINGS_CHANNELS.copyDiagnostics) as Promise<void>,
	socketPreflight: (socketName: string) =>
		ipcRenderer.invoke(
			SETTINGS_CHANNELS.socketPreflight,
			socketName,
		) as Promise<SettingsSocketPreflightWire>,
	socketApply: (socketName: string) =>
		ipcRenderer.invoke(
			SETTINGS_CHANNELS.socketApply,
			socketName,
		) as Promise<SettingsSnapshot>,
	close: () => ipcRenderer.invoke(SETTINGS_CHANNELS.close) as Promise<void>,
	onChanged: (listener) =>
		on<SettingsSnapshot>(SETTINGS_CHANNELS.changed, listener),
};

contextBridge.exposeInMainWorld("devhub", devhub);
contextBridge.exposeInMainWorld("devhubSettings", devhubSettings);
