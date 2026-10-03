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
} from "../ipc/voice.js";

export const voiceApi: VoiceApi = {
	status: () =>
		ipcRenderer.invoke(VOICE_CHANNELS.status) as Promise<VoiceStatus>,
	requestMicrophone: () =>
		ipcRenderer.invoke(VOICE_CHANNELS.microphone) as Promise<
			VoiceResult<boolean>
		>,
	transcribe: (pcm: Uint8Array, language: VoiceLanguage) =>
		ipcRenderer.invoke(VOICE_CHANNELS.transcribe, pcm, language) as Promise<
			VoiceResult<string>
		>,
};
