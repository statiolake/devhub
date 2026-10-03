/**
 * Dictation into a GUI Agent's composer, as the Agents page reaches it.
 *
 * The page records; main transcribes. The page owns the microphone because
 * `getUserMedia` is a renderer API and the recording has to stop the moment
 * the person lets go of it, which only the page sees. Main owns the
 * recogniser because it is a native program in the bundle
 * (`scripts/build_whisper.py`) and only main may start one.
 *
 * What crosses is one finished recording: 16 kHz mono signed 16-bit PCM, the
 * format Whisper reads, as raw little-endian bytes. Not a stream: Whisper
 * transcribes a whole utterance better than it transcribes pieces of one, and
 * a recording of a minute is under two megabytes.
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
 * Which language the recogniser listens for. `auto` lets Whisper decide from
 * the first seconds, which is right for Japanese and English alike; naming
 * one is for a speaker whose accent makes it guess wrong, and for a short
 * utterance where there is too little to guess from.
 */
export type VoiceLanguage = "auto" | "ja" | "en";

export const VOICE_LANGUAGES: readonly VoiceLanguage[] = ["auto", "ja", "en"];

/** Whether dictation can work in this DevHub, and why not when it cannot. */
export type VoiceStatus =
	| { readonly available: true }
	| { readonly available: false; readonly reason: string };

/** What a request answers: its value, or the sentence that says why not. */
export type VoiceResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly reason: string };

export const VOICE_CHANNELS = {
	status: "devhub:voice:status",
	microphone: "devhub:voice:microphone",
	transcribe: "devhub:voice:transcribe",
} as const;

export interface VoiceApi {
	/** Whether the recogniser is in this build. Asked once, when a composer mounts. */
	status(): Promise<VoiceStatus>;
	/**
	 * Ask macOS for the microphone, which shows its prompt the first time and
	 * answers from the person's earlier choice after that. `true` when DevHub
	 * may record.
	 */
	requestMicrophone(): Promise<VoiceResult<boolean>>;
	/** The words in one recording (see the module comment for its format). */
	transcribe(
		pcm: Uint8Array,
		language: VoiceLanguage,
	): Promise<VoiceResult<string>>;
}
