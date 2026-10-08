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
 * (`main/voice/whisperServer.ts`) and transcribes the utterance again every
 * fraction of a second (`main/voice/dictationStream.ts`): what lies before a
 * pause is *committed* and never changes again, and what follows the last
 * pause is *tentative* and is rewritten as more is heard. When the recording
 * ends, the tentative tail is transcribed one last time and committed.
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
	/** Start loading the recogniser, if it is not loaded: the microphone is about to be used. */
	warm(): void;
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
