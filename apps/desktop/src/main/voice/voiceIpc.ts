/**
 * Main's half of dictation (`ipc/voice.ts`): the microphone permission and the
 * recogniser, answered to the Agents page and to no other.
 *
 * The recogniser is looked for once, at registration. A build without one —
 * `--without-whisper`, or a source run that never ran
 * `scripts/build_whisper.py` — answers `status` with the sentence that says
 * so, and the composer shows its microphone as unavailable with that
 * sentence rather than offering a button that fails when pressed.
 *
 * The microphone is macOS's to grant. `askForMediaAccess` shows the system
 * prompt the first time (its words are `NSMicrophoneUsageDescription`, set by
 * `scripts/darwin_bundle.py`) and answers from the person's choice after
 * that; a refusal is theirs to undo in System Settings, so that is what the
 * answer says. Chromium must then let `getUserMedia` through as well, which
 * VS Code's session handlers would refuse: see `microphonePermission.ts`.
 */

import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";

import {
	VOICE_CHANNELS,
	VOICE_LANGUAGES,
	type VoiceLanguage,
	type VoiceResult,
	type VoiceStatus,
} from "../../ipc/voice.js";
import { recordingRefusal, Whisper, type WhisperInstall } from "./whisper.js";

export interface MicrophoneAccess {
	status(): string;
	ask(): Promise<boolean>;
}

export const MICROPHONE_REFUSED =
	"DevHub may not use the microphone. Allow it in System Settings → Privacy & Security → Microphone.";

export const MICROPHONE_SETTINGS_URL =
	"x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

export const NO_RECOGNISER =
	"This build of DevHub has no speech recogniser: devhub-whisper and its model were not found in dist/whisper. Run python3 scripts/build_whisper.py (or set DEVHUB_WHISPER_DIR), then restart DevHub.";

export function registerVoiceIpc(options: {
	readonly ipcMain: Pick<IpcMain, "handle">;
	readonly agentsPage: () => WebContents | undefined;
	readonly install: WhisperInstall | undefined;
	readonly microphone: MicrophoneAccess;
}): void {
	const whisper =
		options.install === undefined ? undefined : new Whisper(options.install);

	const handle = <T>(
		channel: string,
		work: (...args: unknown[]) => Promise<T> | T,
	) =>
		options.ipcMain.handle(
			channel,
			async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
				if (event.sender !== options.agentsPage())
					throw new Error("only the Agents page dictates");
				return work(...args);
			},
		);

	handle(
		VOICE_CHANNELS.status,
		(): VoiceStatus =>
			whisper === undefined
				? { available: false, reason: NO_RECOGNISER }
				: { available: true },
	);

	handle(VOICE_CHANNELS.microphone, async (): Promise<VoiceResult<boolean>> => {
		try {
			if (options.microphone.status() === "granted")
				return { ok: true, value: true };
			const granted = await options.microphone.ask();
			return granted
				? { ok: true, value: true }
				: { ok: false, reason: MICROPHONE_REFUSED };
		} catch (error: unknown) {
			return { ok: false, reason: String(error) };
		}
	});

	handle(
		VOICE_CHANNELS.transcribe,
		async (pcm: unknown, language: unknown): Promise<VoiceResult<string>> => {
			if (whisper === undefined) return { ok: false, reason: NO_RECOGNISER };
			const refusal = recordingRefusal(pcm);
			if (refusal !== undefined) return { ok: false, reason: refusal };
			const spoken: VoiceLanguage = VOICE_LANGUAGES.includes(
				language as VoiceLanguage,
			)
				? (language as VoiceLanguage)
				: "auto";
			try {
				return {
					ok: true,
					value: await whisper.transcribe(pcm as Uint8Array, spoken),
				};
			} catch (error: unknown) {
				return {
					ok: false,
					reason: error instanceof Error ? error.message : String(error),
				};
			}
		},
	);
}
