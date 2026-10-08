/**
 * Main's half of dictation (`ipc/voice.ts`): the microphone permission and the
 * recogniser, answered to the Agents page and to no other.
 *
 * A dictation is a session: `begin` opens one, the page streams its audio
 * into it (`audio`, one way), main sends back what it has heard so far
 * (`update`, one way, to the page that began it), and `end` answers the whole
 * of it (`dictationStream.ts`). `cancel`, or the page going away, drops it.
 * The recogniser is `devhub-whisper-server` kept loaded (`whisperServer.ts`),
 * warmed when the page says the microphone is about to be used; a directory
 * with only the CLI is transcribed once, at `end`.
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

import type {
	IpcMain,
	IpcMainEvent,
	IpcMainInvokeEvent,
	WebContents,
} from "electron";

import {
	VOICE_CHANNELS,
	VOICE_LANGUAGES,
	VOICE_MAX_SECONDS,
	VOICE_SAMPLE_RATE,
	type VoiceLanguage,
	type VoiceResult,
	type VoiceStatus,
} from "../../ipc/voice.js";
import { DictationStream, type Transcriber } from "./dictationStream.js";
import { Whisper, type WhisperInstall } from "./whisper.js";
import { WhisperServer } from "./whisperServer.js";

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

type WarmTranscriber = Transcriber & { warm?(): Promise<void> };

/** The recogniser for an install: the server when it has one, else the CLI. */
export function transcriberFor(install: WhisperInstall): WarmTranscriber {
	return install.server === undefined
		? new Whisper(install)
		: new WhisperServer({ server: install.server, model: install.model });
}

/** Why a piece of streamed audio is not one main takes, or `undefined`. */
export function chunkRefusal(pcm: unknown): string | undefined {
	if (!(pcm instanceof Uint8Array))
		return "The recording did not arrive as audio.";
	if (pcm.byteLength % 2 !== 0) return "The recording is not 16-bit audio.";
	return undefined;
}

export function registerVoiceIpc(options: {
	readonly ipcMain: Pick<IpcMain, "handle" | "on">;
	readonly agentsPage: () => WebContents | undefined;
	readonly install: WhisperInstall | undefined;
	readonly microphone: MicrophoneAccess;
	/** For tests: the recogniser to use instead of the install's. */
	readonly transcriber?: WarmTranscriber;
}): void {
	const transcriber =
		options.transcriber ??
		(options.install === undefined
			? undefined
			: transcriberFor(options.install));
	const sessions = new Map<number, DictationStream>();
	let nextSession = 1;

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
	const listen = (channel: string, work: (...args: unknown[]) => void) =>
		options.ipcMain.on(channel, (event: IpcMainEvent, ...args: unknown[]) => {
			if (event.sender !== options.agentsPage()) return;
			work(...args);
		});

	handle(
		VOICE_CHANNELS.status,
		(): VoiceStatus =>
			transcriber === undefined
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

	handle(VOICE_CHANNELS.warm, () => {
		// A failure to start is reported to the dictation that waits for it.
		void transcriber?.warm?.().catch(() => undefined);
	});

	handle(VOICE_CHANNELS.begin, (language: unknown): VoiceResult<number> => {
		if (transcriber === undefined) return { ok: false, reason: NO_RECOGNISER };
		const page = options.agentsPage();
		if (page === undefined) return { ok: false, reason: "No Agents page." };
		const spoken: VoiceLanguage = VOICE_LANGUAGES.includes(
			language as VoiceLanguage,
		)
			? (language as VoiceLanguage)
			: "auto";
		const id = nextSession++;
		void transcriber.warm?.().catch(() => undefined);
		const stream = new DictationStream(transcriber, spoken, (update) => {
			if (sessions.has(id) && !page.isDestroyed())
				page.send(VOICE_CHANNELS.update, id, update);
		});
		sessions.set(id, stream);
		page.once("destroyed", () => {
			sessions.get(id)?.cancel();
			sessions.delete(id);
		});
		return { ok: true, value: id };
	});

	listen(VOICE_CHANNELS.audio, (id: unknown, pcm: unknown) => {
		const stream = sessions.get(id as number);
		if (stream === undefined || chunkRefusal(pcm) !== undefined) return;
		// Nothing past the limit is kept; the page stops itself there too.
		const seconds = (pcm as Uint8Array).byteLength / 2 / VOICE_SAMPLE_RATE;
		if (stream.seconds + seconds > VOICE_MAX_SECONDS) return;
		stream.push(pcm as Uint8Array);
	});

	listen(VOICE_CHANNELS.cancel, (id: unknown) => {
		sessions.get(id as number)?.cancel();
		sessions.delete(id as number);
	});

	handle(
		VOICE_CHANNELS.end,
		async (id: unknown): Promise<VoiceResult<string>> => {
			const stream = sessions.get(id as number);
			if (stream === undefined)
				return { ok: false, reason: "That dictation is not running." };
			try {
				return { ok: true, value: await stream.finish() };
			} catch (error: unknown) {
				return {
					ok: false,
					reason: error instanceof Error ? error.message : String(error),
				};
			} finally {
				sessions.delete(id as number);
			}
		},
	);
}
