/**
 * One dictation as it is spoken: the recording so far, what of it is
 * committed, and the tentative words after the last pause.
 *
 * Whisper is not a streaming recogniser — it reads a window of audio and
 * writes its words — so streaming is done around it. The audio since the last
 * commit is the *window*. Whenever enough new audio has come in (and the
 * recogniser is free) the whole window is transcribed again and the result is
 * the tentative text: it gets better as the window grows, and may change
 * completely. When the window holds a pause — a stretch of silence after
 * speech — the audio up to the middle of the pause is transcribed once more,
 * on its own, and that text is committed: it is never transcribed again, the
 * window starts after it, and the page puts it in the composer. So a phrase
 * lands in the composer a moment after the speaker pauses, and the words of
 * the phrase being spoken show as they are recognised.
 *
 * Cutting at pauses rather than every N seconds keeps words whole: a word cut
 * in two is two wrong words. A window that grows past `maxWindowSeconds`
 * without a pause (a person who does not breathe) is cut at its quietest
 * moment instead, so no one transcription grows past what is quick.
 *
 * The silence test is energy, per 30 ms frame, against a threshold that
 * follows the noise floor of the recording. It only has to find pauses
 * between phrases in a dictation at a desk, and the browser has already
 * suppressed noise; a model-based VAD would be another model to ship.
 *
 * Committed text is passed back to Whisper as the prompt for what follows, so
 * the next phrase continues in the same language and style.
 *
 * A recogniser that is not `live` (the per-recording CLI, from a recogniser
 * directory built before the server existed) is only run once, at the end.
 */

import {
	VOICE_SAMPLE_RATE,
	type VoiceLanguage,
	type VoiceUpdate,
} from "../../ipc/voice.js";
import { needsSpace } from "../../model/spokenText.js";

export interface TranscribeOptions {
	readonly language: VoiceLanguage;
	/** Text the audio continues, for context. */
	readonly prompt?: string;
}

/** Something that turns 16 kHz mono 16-bit PCM into words. */
export interface Transcriber {
	/** Whether it is cheap enough to run over and over while the person speaks. */
	readonly live: boolean;
	transcribe(pcm: Uint8Array, options: TranscribeOptions): Promise<string>;
}

export interface StreamTuning {
	/** Transcribe the window again once this much new audio has come in. */
	readonly partialEverySeconds: number;
	/** A pause at least this long ends a phrase. */
	readonly pauseSeconds: number;
	/** Speech shorter than this in a window is not worth transcribing. */
	readonly minSpeechSeconds: number;
	/** A window longer than this is cut at its quietest point. */
	readonly maxWindowSeconds: number;
	/** The quietest RMS (of 1.0 full scale) ever counted as speech. */
	readonly minSpeechLevel: number;
}

export const DEFAULT_TUNING: StreamTuning = {
	partialEverySeconds: 0.5,
	pauseSeconds: 0.6,
	minSpeechSeconds: 0.25,
	maxWindowSeconds: 20,
	minSpeechLevel: 0.01,
};

/** A frame this loud (RMS of full scale) is speech whatever the noise floor. */
const SPEECH_CEILING = 0.03;

const FRAME = Math.round(VOICE_SAMPLE_RATE * 0.03);

/** RMS of each 30 ms frame of `samples`, 0 to 1. */
export function frameLevels(samples: Int16Array): Float32Array {
	const frames = Math.floor(samples.length / FRAME);
	const out = new Float32Array(frames);
	for (let f = 0; f < frames; f++) {
		let sum = 0;
		for (let i = f * FRAME; i < (f + 1) * FRAME; i++) {
			const v = samples[i]! / 32768;
			sum += v * v;
		}
		out[f] = Math.sqrt(sum / FRAME);
	}
	return out;
}

/**
 * Which frames are speech: louder than the minimum and than three times the
 * window's noise floor (its 20th-percentile frame) — but never a threshold
 * above `SPEECH_CEILING`, so a window that is all speech (whose 20th
 * percentile is speech too) still counts as speech.
 */
export function speechFrames(
	levels: Float32Array,
	minSpeechLevel: number,
): boolean[] {
	if (levels.length === 0) return [];
	const sorted = Array.from(levels).sort((a, b) => a - b);
	const floor = sorted[Math.floor(sorted.length * 0.2)]!;
	const threshold = Math.max(
		minSpeechLevel,
		Math.min(floor * 3, SPEECH_CEILING),
	);
	return Array.from(levels, (level) => level >= threshold);
}

/**
 * Where to cut `samples` so that what comes before is a finished phrase, in
 * samples, or `undefined` when it holds no pause after speech yet. The cut is
 * the middle of the *last* pause that has speech before it and is at least
 * `pauseSeconds` long — a pause still running at the end of the window counts
 * once it is that long, since a speaker who has stopped has finished the
 * phrase.
 */
export function findPause(
	speech: readonly boolean[],
	tuning: Pick<StreamTuning, "pauseSeconds" | "minSpeechSeconds">,
): number | undefined {
	const pauseFrames = Math.ceil(
		(tuning.pauseSeconds * VOICE_SAMPLE_RATE) / FRAME,
	);
	const minSpeech = Math.ceil(
		(tuning.minSpeechSeconds * VOICE_SAMPLE_RATE) / FRAME,
	);
	let cut: number | undefined;
	let spoken = 0;
	let silentFrom = -1;
	const close = (end: number) => {
		if (
			silentFrom >= 0 &&
			spoken >= minSpeech &&
			end - silentFrom >= pauseFrames
		)
			cut = Math.floor((silentFrom + end) / 2);
	};
	for (let f = 0; f < speech.length; f++) {
		if (speech[f]) {
			close(f);
			silentFrom = -1;
			spoken++;
		} else if (silentFrom < 0) silentFrom = f;
	}
	close(speech.length);
	return cut === undefined ? undefined : cut * FRAME;
}

/** The quietest frame in the second half of a window, in samples: where to cut a phrase with no pause. */
export function quietestCut(levels: Float32Array): number {
	const from = Math.floor(levels.length / 2);
	let best = from;
	for (let f = from; f < levels.length; f++)
		if (levels[f]! < levels[best]!) best = f;
	return best * FRAME + Math.floor(FRAME / 2);
}

/** `text` and `more` as one, with a space only where `needsSpace` says so. */
export function joinSpoken(text: string, more: string): string {
	if (more === "") return text;
	if (text === "") return more;
	return needsSpace(text.at(-1)!, more[0]!)
		? `${text} ${more}`
		: `${text}${more}`;
}

function bytes(samples: Int16Array): Uint8Array {
	return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

export class DictationStream {
	private samples = new Int16Array(VOICE_SAMPLE_RATE * 10);
	private length = 0;
	/** Where the window starts: everything before is committed or thrown away as silence. */
	private windowStart = 0;
	/** How far the window had got when it was last transcribed. */
	private lastPartialAt = 0;
	private committed = "";
	private tentative = "";
	private busy: Promise<void> | undefined;
	private closed = false;
	private failure: unknown;

	constructor(
		private readonly transcriber: Transcriber,
		private readonly language: VoiceLanguage,
		private readonly onUpdate: (update: VoiceUpdate) => void,
		private readonly tuning: StreamTuning = DEFAULT_TUNING,
	) {}

	/** Seconds recorded so far. */
	get seconds(): number {
		return this.length / VOICE_SAMPLE_RATE;
	}

	/** More of the recording, as 16-bit little-endian bytes. */
	push(pcm: Uint8Array): void {
		if (this.closed) return;
		const count = pcm.byteLength >> 1;
		if (this.length + count > this.samples.length) {
			const grown = new Int16Array(
				Math.max(this.samples.length * 2, this.length + count),
			);
			grown.set(this.samples.subarray(0, this.length));
			this.samples = grown;
		}
		const view = new DataView(pcm.buffer, pcm.byteOffset, count * 2);
		for (let i = 0; i < count; i++)
			this.samples[this.length + i] = view.getInt16(i * 2, true);
		this.length += count;
		this.pump();
	}

	/**
	 * The recording has ended: wait for what is running, transcribe what is
	 * left, and answer everything committed.
	 */
	async finish(): Promise<string> {
		this.closed = true;
		while (this.busy !== undefined) await this.busy;
		if (this.failure !== undefined) throw this.failure;
		const rest = this.samples.subarray(this.windowStart, this.length);
		if (this.hasSpeech(rest)) {
			const words = await this.transcriber.transcribe(
				bytes(rest),
				this.options(),
			);
			this.committed = joinSpoken(this.committed, words);
		}
		this.windowStart = this.length;
		this.tentative = "";
		this.onUpdate({ committed: this.committed, tentative: "" });
		return this.committed;
	}

	/** Throw it away: nothing more is transcribed or reported. */
	cancel(): void {
		this.closed = true;
	}

	private options() {
		return {
			language: this.language,
			prompt: this.committed === "" ? undefined : this.committed.slice(-200),
		};
	}

	private hasSpeech(window: Int16Array): boolean {
		const speech = speechFrames(
			frameLevels(window),
			this.tuning.minSpeechLevel,
		);
		const frames = speech.filter(Boolean).length;
		return frames * FRAME >= this.tuning.minSpeechSeconds * VOICE_SAMPLE_RATE;
	}

	/** Start the next transcription, if one is due and none is running. */
	private pump(): void {
		if (this.busy !== undefined || this.closed || !this.transcriber.live)
			return;
		const job = this.next();
		if (job === undefined) return;
		this.busy = job
			.catch((error: unknown) => {
				// A partial that failed fails the dictation: the final pass would
				// fail the same way, and the person should hear about it once.
				this.failure ??= error;
			})
			.finally(() => {
				this.busy = undefined;
				this.pump();
			});
	}

	private next(): Promise<void> | undefined {
		if (this.failure !== undefined) return undefined;
		const window = this.samples.subarray(this.windowStart, this.length);
		const levels = frameLevels(window);
		const speech = speechFrames(levels, this.tuning.minSpeechLevel);
		const spoken = speech.filter(Boolean).length * FRAME;
		const max = this.tuning.maxWindowSeconds * VOICE_SAMPLE_RATE;

		if (spoken < this.tuning.minSpeechSeconds * VOICE_SAMPLE_RATE) {
			// Nothing said yet: drop all but the last second of silence, so a
			// window is never mostly the quiet before the person spoke.
			const keep = VOICE_SAMPLE_RATE;
			if (window.length > keep * 2) {
				this.windowStart = this.length - keep;
				this.lastPartialAt = this.windowStart;
			}
			return undefined;
		}

		let cut = findPause(speech, this.tuning);
		if (cut === undefined && window.length > max) cut = quietestCut(levels);
		if (cut !== undefined) {
			const phrase = window.slice(0, cut);
			const end = this.windowStart + cut;
			return this.transcriber
				.transcribe(bytes(phrase), this.options())
				.then((words) => {
					// Applied even after the recording ended: `finish` transcribes
					// only what comes after it.
					this.committed = joinSpoken(this.committed, words);
					this.windowStart = end;
					this.lastPartialAt = end;
					this.tentative = "";
					if (!this.closed) this.report();
				});
		}

		const due =
			this.length - this.lastPartialAt >=
			this.tuning.partialEverySeconds * VOICE_SAMPLE_RATE;
		if (!due) return undefined;
		const at = this.length;
		return this.transcriber
			.transcribe(bytes(window.slice()), this.options())
			.then((words) => {
				this.lastPartialAt = at;
				if (this.closed) return;
				this.tentative = words;
				this.report();
			});
	}

	private report(): void {
		this.onUpdate({ committed: this.committed, tentative: this.tentative });
	}
}
