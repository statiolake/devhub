/**
 * Dictation into a GUI Agent's composer, as the Agents page reaches it.
 *
 * The page records; main transcribes. The page owns the microphone because
 * `getUserMedia` is a renderer API and the recording has to stop the moment
 * the person lets go of it, which only the page sees. Main owns the
 * recogniser because it is a native program in the bundle
 * (`scripts/build_whisper.py`) and only main may start one.
 *
 * What crosses is a stream: the page sends the microphone as it records —
 * 16 kHz mono signed 16-bit PCM, the format Whisper reads, as raw
 * little-endian bytes, a few times a second — and main sends back what it has
 * heard so far (`VoiceUpdate`). Main keeps the recogniser loaded
 * (`main/voice/whisperServer.ts`), cuts the recording into utterances at
 * pauses, and transcribes the utterance being spoken about once a second
 * (`main/voice/dictationStream.ts`): each utterance that has ended is
 * *committed* and never changes again, and the one still being spoken is
 * *tentative* and is rewritten as more is heard. When the recording ends,
 * the last utterance is transcribed one last time and committed.
 *
 * Every request answers with a result rather than rejecting, as the terminal
 * API does: a recogniser that is not in this build, or a microphone the
 * person refused, is an expected answer the composer words itself, not a
 * failure for the page's root.
 */

/** The sample rate Whisper is trained on, and the only one main accepts. */
export const VOICE_SAMPLE_RATE = 16_000;

/**
 * The longest recording main transcribes. Dictation is a message, not a
 * meeting; the composer stops a recording itself at this length, and main
 * refuses a longer one rather than tying the GPU up for minutes.
 */
export const VOICE_MAX_SECONDS = 300;

/**
 * Which language the recogniser listens for. Japanese is the default: the
 * composer is mostly dictated in Japanese, English words inside it come out
 * fine in katakana or Latin either way, and naming the language spares the
 * recogniser a detection pass and the wrong guesses on a short utterance.
 * `auto` lets Whisper decide from the first seconds, for a person who
 * dictates whole messages in either; `en` is for English throughout.
 */
export type VoiceLanguage = "auto" | "ja" | "en";

/** In the order the composer's label cycles through them, the default first. */
export const VOICE_LANGUAGES: readonly VoiceLanguage[] = ["ja", "en", "auto"];

export const DEFAULT_VOICE_LANGUAGE: VoiceLanguage = "ja";

/**
 * The speech models DevHub can download, by the id `[voice] model` names.
 * `small` is the default; `large-v3-turbo` is the heavier, more accurate one
 * (see `docs/agent-gui.md`, "Voice input"). What each is — its file, its
 * pinned URL and hash — is in `product.json` (`whisperModels`).
 */
export type VoiceModelId = "small" | "large-v3-turbo";

export const VOICE_MODEL_IDS: readonly VoiceModelId[] = [
	"small",
	"large-v3-turbo",
];

export const DEFAULT_VOICE_MODEL: VoiceModelId = "small";

/** Whether `value` is one of `VOICE_MODEL_IDS`. */
export function isVoiceModelId(value: unknown): value is VoiceModelId {
	return (VOICE_MODEL_IDS as readonly unknown[]).includes(value);
}

/**
 * Where one model is on this Mac.
 *
 * `absent` → (the person agrees) `downloading` → `verifying` → `ready`; a
 * download that fails is `failed`, with the sentence that says why, and is
 * retried from there (resuming what had arrived). Deleting a model is
 * `absent` again.
 */
export type VoiceModelState =
	| { readonly kind: "absent" }
	| {
			readonly kind: "downloading";
			readonly received: number;
			/** Bytes in all, when the server said. */
			readonly total: number | undefined;
	  }
	| { readonly kind: "verifying" }
	| { readonly kind: "ready" }
	| { readonly kind: "failed"; readonly reason: string };

/** One model, as the confirmation and Settings describe it. */
export interface VoiceModelWire {
	readonly id: VoiceModelId;
	/** `Whisper small`. */
	readonly label: string;
	/** `ggml-small.bin`. */
	readonly file: string;
	/** The download's size as upstream states it: `466 MiB`. */
	readonly size: string;
	/** The host it is downloaded from: `huggingface.co`. */
	readonly host: string;
	readonly state: VoiceModelState;
}

/**
 * Voice input on this Mac: whether it is on, which model it uses, and where
 * each model is. Settings draws it; the composer is told the short form
 * (`VoiceStatus`).
 */
export interface VoiceSetupWire {
	/** Whether this build has the recogniser's programs at all. */
	readonly recogniser: boolean;
	/** `[voice] enabled`. */
	readonly enabled: boolean;
	/** `[voice] model`. */
	readonly model: VoiceModelId;
	readonly models: readonly VoiceModelWire[];
	/** Where models are kept, as it is shown: `~/Library/…/devhub/whisper`. */
	readonly directory: string;
	/**
	 * A model DevHub was pointed at for development (`DEVHUB_WHISPER_DIR`,
	 * or `dist/whisper` in a source run, with a model in it), used instead of
	 * a download. Its path, when there is one.
	 */
	readonly override?: string;
}

/**
 * What a press of the microphone does while dictation cannot run yet:
 * `enable` and `download` ask first (the confirmation), `retry` downloads
 * again what failed, and `downloading` and `verifying` wait.
 */
export type VoiceSetupStep =
	| { readonly kind: "enable" }
	| { readonly kind: "download" }
	| {
			readonly kind: "downloading";
			readonly received: number;
			readonly total: number | undefined;
	  }
	| { readonly kind: "verifying" }
	| { readonly kind: "retry" };

/** Whether dictation can work in this DevHub, and why not when it cannot. */
export type VoiceStatus =
	| { readonly available: true }
	| {
			readonly available: false;
			readonly reason: string;
			/** What a press does about it; nothing for a build with no recogniser. */
			readonly step?: VoiceSetupStep;
	  };

/** The one model `setup` is about: the one `[voice] model` names. */
export function chosenModel(setup: VoiceSetupWire): VoiceModelWire | undefined {
	return setup.models.find((model) => model.id === setup.model);
}

/** `received` bytes of `total`, as a percent the person reads. */
export function downloadPercent(
	received: number,
	total: number | undefined,
): number | undefined {
	if (total === undefined || total <= 0) return undefined;
	return Math.min(100, Math.floor((received / total) * 100));
}

/** Bytes as the person reads them: `210 MB`. */
export function megabytes(bytes: number): string {
	return `${String(Math.round(bytes / 1_000_000))} MB`;
}

export const NO_RECOGNISER =
	"この DevHub には音声認識のプログラム（devhub-whisper）が入っていません。python3 scripts/build_whisper.py でビルドするか DEVHUB_WHISPER_DIR を設定して、DevHub を再起動してください。";

/**
 * The short form of `setup` the composer draws: available, or why not and
 * what a press does about it. One function, here, so main's answer to
 * `status` and what Settings shows cannot disagree.
 */
export function voiceStatusOf(setup: VoiceSetupWire): VoiceStatus {
	if (!setup.recogniser) return { available: false, reason: NO_RECOGNISER };
	const model = chosenModel(setup);
	const state: VoiceModelState =
		setup.override !== undefined
			? { kind: "ready" }
			: (model?.state ?? { kind: "absent" });
	if (!setup.enabled) {
		return {
			available: false,
			reason:
				"音声入力はオフです。押すとオンにします（初回は音声認識モデルのダウンロードを確認します）。",
			step: { kind: "enable" },
		};
	}
	switch (state.kind) {
		case "ready":
			return { available: true };
		case "absent":
			return {
				available: false,
				reason: `音声認識モデル（${model?.label ?? setup.model}）がまだありません。押すとダウンロードを確認します。`,
				step: { kind: "download" },
			};
		case "downloading": {
			const percent = downloadPercent(state.received, state.total);
			return {
				available: false,
				reason: `音声認識モデルをダウンロードしています…${percent === undefined ? "" : ` ${String(percent)}%`}`,
				step: {
					kind: "downloading",
					received: state.received,
					total: state.total,
				},
			};
		}
		case "verifying":
			return {
				available: false,
				reason: "ダウンロードした音声認識モデルを確認しています…",
				step: { kind: "verifying" },
			};
		case "failed":
			return {
				available: false,
				reason: `音声認識モデルをダウンロードできませんでした: ${state.reason} 押すと再試行します。`,
				step: { kind: "retry" },
			};
	}
}

/**
 * What the confirmation states before anything is downloaded: which model,
 * how big, from where, and where it goes.
 */
export interface VoiceConsentWire {
	readonly model: VoiceModelId;
	readonly label: string;
	readonly file: string;
	readonly size: string;
	readonly host: string;
	readonly directory: string;
}

export function consentFor(
	setup: VoiceSetupWire,
	id: VoiceModelId = setup.model,
): VoiceConsentWire | undefined {
	const model = setup.models.find((each) => each.id === id);
	return model === undefined
		? undefined
		: {
				model: model.id,
				label: model.label,
				file: model.file,
				size: model.size,
				host: model.host,
				directory: setup.directory,
			};
}

/** What a request answers: its value, or the sentence that says why not. */
export type VoiceResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly reason: string };

/**
 * What main has heard so far in one dictation. `committed` only ever grows —
 * each update's starts with the last one's — so the page can put in just what
 * is new; `tentative` is the words since the last pause, which the next update
 * may rewrite.
 */
export interface VoiceUpdate {
	readonly committed: string;
	readonly tentative: string;
}

export const VOICE_CHANNELS = {
	status: "devhub:voice:status",
	microphone: "devhub:voice:microphone",
	/** Load the recogniser now, ahead of a dictation that may follow. */
	warm: "devhub:voice:warm",
	begin: "devhub:voice:begin",
	/** One way, page to main: (session, pcm). */
	audio: "devhub:voice:audio",
	end: "devhub:voice:end",
	/** One way, page to main: (session). */
	cancel: "devhub:voice:cancel",
	/** One way, main to page: (session, VoiceUpdate). */
	update: "devhub:voice:update",
	/** One way, main to page: (VoiceStatus), whenever it changes. */
	statusChanged: "devhub:voice:status-changed",
	/**
	 * A press while dictation cannot run yet: turn it on, asking first where
	 * that downloads a model, or retry a download that failed.
	 */
	setUp: "devhub:voice:set-up",
} as const;

/**
 * Settings' half: voice input turned on and off, and its models managed.
 * Answered to the Settings window only. The confirmation is the window's own
 * sheet, so `enable` is called once the person has agreed.
 */
export const VOICE_SETUP_CHANNELS = {
	get: "devhub:voice-setup:get",
	/** One way, main to Settings: (VoiceSetupWire). */
	changed: "devhub:voice-setup:changed",
	/** (model): turn voice input on with it, downloading it if it is not here. */
	enable: "devhub:voice-setup:enable",
	/** (deleteModels): turn it off, and delete every downloaded model when asked. */
	disable: "devhub:voice-setup:disable",
	/** (model): delete one downloaded model. */
	deleteModel: "devhub:voice-setup:delete-model",
	retry: "devhub:voice-setup:retry",
	cancelDownload: "devhub:voice-setup:cancel-download",
} as const;

/** What Settings reaches of voice input: `window.devhubSettings.voice`. */
export interface VoiceSetupApi {
	get(): Promise<VoiceSetupWire>;
	onChanged(listener: (setup: VoiceSetupWire) => void): () => void;
	enable(model: VoiceModelId): Promise<VoiceResult<VoiceSetupWire>>;
	disable(deleteModels: boolean): Promise<VoiceResult<VoiceSetupWire>>;
	deleteModel(model: VoiceModelId): Promise<VoiceResult<VoiceSetupWire>>;
	retry(): Promise<VoiceResult<VoiceSetupWire>>;
	cancelDownload(): Promise<VoiceResult<VoiceSetupWire>>;
}

export interface VoiceApi {
	/** Whether dictation can run now. Asked when a composer mounts; `onStatus` after that. */
	status(): Promise<VoiceStatus>;
	/** The status, each time it changes (turned on, a download's progress). */
	onStatus(listener: (status: VoiceStatus) => void): () => void;
	/**
	 * What a press does while dictation cannot run yet (`VoiceStatus.step`):
	 * main asks first where a model would be downloaded, then turns voice
	 * input on and starts the download. `ok` with `false` when the person
	 * said Cancel.
	 */
	setUp(): Promise<VoiceResult<boolean>>;
	/**
	 * Ask macOS for the microphone, which shows its prompt the first time and
	 * answers from the person's earlier choice after that. `true` when DevHub
	 * may record.
	 */
	requestMicrophone(): Promise<VoiceResult<boolean>>;
	/**
	 * Start loading the recogniser, if it is not loaded: the microphone is
	 * about to be used. Answers once the recogniser can take audio (at once
	 * when it already can, or when there is only the CLI, which is run at
	 * `end`), or why it cannot.
	 */
	warm(): Promise<VoiceResult<true>>;
	/** Start a dictation in `language`; its session number. */
	begin(language: VoiceLanguage): Promise<VoiceResult<number>>;
	/** More of the recording (see the module comment for its format). */
	audio(session: number, pcm: Uint8Array): void;
	/** End the recording: everything it said, committed (the last update's `committed` and more). */
	end(session: number): Promise<VoiceResult<string>>;
	/** Throw the dictation away. */
	cancel(session: number): void;
	/** What main has heard so far, as it hears it. Returns the way to stop listening. */
	onUpdate(
		listener: (session: number, update: VoiceUpdate) => void,
	): () => void;
}
