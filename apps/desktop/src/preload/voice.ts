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
	type VoiceStatus,
	type VoiceUpdate,
} from "../ipc/voice.js";

export const voiceApi: VoiceApi = {
	status: () =>
		ipcRenderer.invoke(VOICE_CHANNELS.status) as Promise<VoiceStatus>,
	requestMicrophone: () =>
		ipcRenderer.invoke(VOICE_CHANNELS.microphone) as Promise<
			VoiceResult<boolean>
		>,
	warm: () => {
		void ipcRenderer.invoke(VOICE_CHANNELS.warm).catch(() => undefined);
	},
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
