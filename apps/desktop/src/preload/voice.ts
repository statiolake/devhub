/**
 * `window.devhub.voice`: dictation for the GUI Agent composer.
 *
 * Each member forwards one request and returns what main answered. See
 * `ipc/voice.ts`.
 */

import { ipcRenderer } from "electron";
import {
	VOICE_CHANNELS,
	type VoiceApi,
	type VoiceLanguage,
	type VoiceResult,
	type VoiceModelId,
	type VoiceSetupApi,
	type VoiceSetupWire,
	type VoiceStatus,
	type VoiceUpdate,
	VOICE_SETUP_CHANNELS,
} from "../ipc/voice.js";

export const voiceApi: VoiceApi = {
	status: () =>
		ipcRenderer.invoke(VOICE_CHANNELS.status) as Promise<VoiceStatus>,
	onStatus: (listener) => {
		const handler = (_event: Electron.IpcRendererEvent, status: VoiceStatus) =>
			listener(status);
		ipcRenderer.on(VOICE_CHANNELS.statusChanged, handler);
		return () => {
			ipcRenderer.removeListener(VOICE_CHANNELS.statusChanged, handler);
		};
	},
	setUp: () =>
		ipcRenderer.invoke(VOICE_CHANNELS.setUp) as Promise<VoiceResult<boolean>>,
	requestMicrophone: () =>
		ipcRenderer.invoke(VOICE_CHANNELS.microphone) as Promise<
			VoiceResult<boolean>
		>,
	warm: () =>
		ipcRenderer.invoke(VOICE_CHANNELS.warm) as Promise<VoiceResult<true>>,
	begin: (language: VoiceLanguage) =>
		ipcRenderer.invoke(VOICE_CHANNELS.begin, language) as Promise<
			VoiceResult<number>
		>,
	audio: (session: number, pcm: Uint8Array) => {
		ipcRenderer.send(VOICE_CHANNELS.audio, session, pcm);
	},
	end: (session: number) =>
		ipcRenderer.invoke(VOICE_CHANNELS.end, session) as Promise<
			VoiceResult<string>
		>,
	cancel: (session: number) => {
		ipcRenderer.send(VOICE_CHANNELS.cancel, session);
	},
	onUpdate: (listener) => {
		const handler = (
			_event: Electron.IpcRendererEvent,
			session: number,
			update: VoiceUpdate,
		) => listener(session, update);
		ipcRenderer.on(VOICE_CHANNELS.update, handler);
		return () => {
			ipcRenderer.removeListener(VOICE_CHANNELS.update, handler);
		};
	},
};

type SetupResult = Promise<VoiceResult<VoiceSetupWire>>;

/** `window.devhubSettings.voice`: Settings' half (`VOICE_SETUP_CHANNELS`). */
export const voiceSetupApi: VoiceSetupApi = {
	get: () =>
		ipcRenderer.invoke(VOICE_SETUP_CHANNELS.get) as Promise<VoiceSetupWire>,
	onChanged: (listener) => {
		const handler = (
			_event: Electron.IpcRendererEvent,
			setup: VoiceSetupWire,
		) => listener(setup);
		ipcRenderer.on(VOICE_SETUP_CHANNELS.changed, handler);
		return () => {
			ipcRenderer.removeListener(VOICE_SETUP_CHANNELS.changed, handler);
		};
	},
	enable: (model: VoiceModelId) =>
		ipcRenderer.invoke(VOICE_SETUP_CHANNELS.enable, model) as SetupResult,
	disable: (deleteModels: boolean) =>
		ipcRenderer.invoke(
			VOICE_SETUP_CHANNELS.disable,
			deleteModels,
		) as SetupResult,
	deleteModel: (model: VoiceModelId) =>
		ipcRenderer.invoke(VOICE_SETUP_CHANNELS.deleteModel, model) as SetupResult,
	retry: () => ipcRenderer.invoke(VOICE_SETUP_CHANNELS.retry) as SetupResult,
	cancelDownload: () =>
		ipcRenderer.invoke(VOICE_SETUP_CHANNELS.cancelDownload) as SetupResult,
};
