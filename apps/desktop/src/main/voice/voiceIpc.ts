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
 * Voice input is off until the person turns it on, and the model is not in
 * the app (`voiceSetup.ts`): until it is on and its model is here, `status`
 * says why not and what a press does (`VoiceStatus.step`), `setUp` is that
 * press, and `warm` and `begin` refuse with the same sentence — nothing is
 * started. The status is pushed to the pages as it changes (a download's
 * progress), and Settings is answered on `VOICE_SETUP_CHANNELS`.
 *
 * The recogniser's programs are looked for once, at registration. A build
 * without them — `--without-whisper`, or a source run that never ran
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
	DEFAULT_VOICE_LANGUAGE,
	isVoiceModelId,
	VOICE_CHANNELS,
	VOICE_SETUP_CHANNELS,
	VOICE_LANGUAGES,
	VOICE_MAX_SECONDS,
	VOICE_SAMPLE_RATE,
	type VoiceLanguage,
	type VoiceResult,
	type VoiceStatus,
	type VoiceSetupWire,
} from "../../ipc/voice.js";
import { DictationStream, type Transcriber } from "./dictationStream.js";
import type { VoiceSetup } from "./voiceSetup.js";
import {
	Whisper,
	type WhisperInstall,
	type WhisperPrograms,
} from "./whisper.js";
import { WhisperServer } from "./whisperServer.js";

export interface MicrophoneAccess {
	status(): string;
	ask(): Promise<boolean>;
}

export const MICROPHONE_REFUSED =
	"DevHub may not use the microphone. Allow it in System Settings → Privacy & Security → Microphone.";

export const MICROPHONE_SETTINGS_URL =
	"x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

export { NO_RECOGNISER } from "../../ipc/voice.js";

type WarmTranscriber = Transcriber & { warm?(): Promise<void>; stop?(): void };

/** What the IPC asks of voice input's setup (`VoiceSetup`). */
export type VoiceGate = Pick<
	VoiceSetup,
	| "status"
	| "wire"
	| "modelPath"
	| "subscribe"
	| "setUp"
	| "enable"
	| "disable"
	| "deleteModel"
	| "retry"
	| "cancelDownload"
>;

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
	/**
	 * The pages that dictate: the Conversations page (a GUI Agent's composer)
	 * and the Agents page (the Orchestrator's). A dictation's words go back
	 * to the page that began it.
	 */
	readonly pages: () => readonly (WebContents | undefined)[];
	/** The Settings window's page, when it is open: it manages voice input. */
	readonly settingsPage?: () => WebContents | undefined;
	readonly programs: WhisperPrograms | undefined;
	readonly setup: VoiceGate;
	readonly microphone: MicrophoneAccess;
	/** For tests: the recogniser to use instead of the programs', once a model is here. */
	readonly transcriber?: WarmTranscriber;
}): void {
	const { setup } = options;
	/** The recogniser for the model in use, made when it is first wanted. */
	let current:
		| { readonly model: string; readonly transcriber: WarmTranscriber }
		| undefined;
	const transcriber = (): WarmTranscriber | undefined => {
		const model = setup.modelPath();
		if (model === undefined || options.programs === undefined) {
			if (model !== undefined && options.transcriber !== undefined)
				return options.transcriber;
			return undefined;
		}
		if (current?.model !== model) {
			current?.transcriber.stop?.();
			current = {
				model,
				transcriber:
					options.transcriber ??
					transcriberFor({
						binary: options.programs.binary,
						model,
						...(options.programs.server === undefined
							? {}
							: { server: options.programs.server }),
					}),
			};
		}
		return current.transcriber;
	};
	const refusal = (): string => {
		const status = setup.status();
		return status.available ? "" : status.reason;
	};
	const sessions = new Map<number, DictationStream>();
	let nextSession = 1;

	// Told as it changes: the pages' microphones, and Settings' section.
	let lastStatus = "";
	setup.subscribe(() => {
		// A model turned off or switched gives its GPU memory back now.
		if (current !== undefined && current.model !== setup.modelPath()) {
			current.transcriber.stop?.();
			current = undefined;
		}
		const status = setup.status();
		const said = JSON.stringify(status);
		if (said !== lastStatus) {
			lastStatus = said;
			for (const page of options.pages())
				if (page !== undefined && !page.isDestroyed())
					page.send(VOICE_CHANNELS.statusChanged, status);
		}
		const settings = options.settingsPage?.();
		if (settings !== undefined && !settings.isDestroyed())
			settings.send(VOICE_SETUP_CHANNELS.changed, setup.wire());
	});

	const dictates = (sender: WebContents) => options.pages().includes(sender);
	const handle = <T>(
		channel: string,
		work: (sender: WebContents, ...args: unknown[]) => Promise<T> | T,
	) =>
		options.ipcMain.handle(
			channel,
			async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
				if (!dictates(event.sender))
					throw new Error("only the Conversations and Agents pages dictate");
				return work(event.sender, ...args);
			},
		);
	const listen = (channel: string, work: (...args: unknown[]) => void) =>
		options.ipcMain.on(channel, (event: IpcMainEvent, ...args: unknown[]) => {
			if (!dictates(event.sender)) return;
			work(...args);
		});
	const manage = <T>(
		channel: string,
		work: (...args: unknown[]) => Promise<T> | T,
	) =>
		options.ipcMain.handle(
			channel,
			async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
				const settings = options.settingsPage?.();
				if (settings === undefined || event.sender !== settings)
					throw new Error("only the Settings window manages voice input");
				return work(...args);
			},
		);

	handle(VOICE_CHANNELS.status, (): VoiceStatus => setup.status());

	handle(VOICE_CHANNELS.setUp, () => setup.setUp());

	manage(VOICE_SETUP_CHANNELS.get, (): VoiceSetupWire => setup.wire());
	manage(VOICE_SETUP_CHANNELS.enable, (model: unknown) =>
		isVoiceModelId(model)
			? setup.enable(model)
			: { ok: false as const, reason: "その音声認識モデルはありません。" },
	);
	manage(VOICE_SETUP_CHANNELS.disable, (deleteModels: unknown) =>
		setup.disable(deleteModels === true),
	);
	manage(VOICE_SETUP_CHANNELS.deleteModel, (model: unknown) =>
		isVoiceModelId(model)
			? setup.deleteModel(model)
			: { ok: false as const, reason: "その音声認識モデルはありません。" },
	);
	manage(VOICE_SETUP_CHANNELS.retry, () => setup.retry());
	manage(VOICE_SETUP_CHANNELS.cancelDownload, () => setup.cancelDownload());

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

	// Answered when the recogniser can take audio, so the page can say it is
	// still starting; a failure to start is the answer too.
	handle(VOICE_CHANNELS.warm, async (): Promise<VoiceResult<true>> => {
		const recogniser = transcriber();
		if (recogniser === undefined) return { ok: false, reason: refusal() };
		try {
			await recogniser.warm?.();
			return { ok: true, value: true };
		} catch (error: unknown) {
			return {
				ok: false,
				reason: error instanceof Error ? error.message : String(error),
			};
		}
	});

	handle(
		VOICE_CHANNELS.begin,
		(page: WebContents, language: unknown): VoiceResult<number> => {
			const recogniser = transcriber();
			if (recogniser === undefined) return { ok: false, reason: refusal() };
			const spoken: VoiceLanguage = VOICE_LANGUAGES.includes(
				language as VoiceLanguage,
			)
				? (language as VoiceLanguage)
				: DEFAULT_VOICE_LANGUAGE;
			const id = nextSession++;
			void recogniser.warm?.().catch(() => undefined);
			const stream = new DictationStream(recogniser, spoken, (update) => {
				if (sessions.has(id) && !page.isDestroyed())
					page.send(VOICE_CHANNELS.update, id, update);
			});
			sessions.set(id, stream);
			page.once("destroyed", () => {
				sessions.get(id)?.cancel();
				sessions.delete(id);
			});
			return { ok: true, value: id };
		},
	);

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
		async (_page, id: unknown): Promise<VoiceResult<string>> => {
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
