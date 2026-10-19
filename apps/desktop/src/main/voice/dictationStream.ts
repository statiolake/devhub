/**
 * One dictation as it is spoken: the recording so far, the utterances found
 * in it, what of it is committed, and the tentative words of the utterance
 * being spoken.
 *
 * Whisper is not a streaming recogniser — it reads a stretch of audio and
 * writes its words — so streaming is done around it, as cheaply as it can be:
 *
 * - The recording is cut into *utterances* as it arrives (`Segmenter`): a
 *   hysteresis energy test per 20 ms frame, the segmentation the author's
 *   podcast-maker uses. An utterance starts after 200 ms loud enough to be
 *   speech and ends after 400 ms quiet enough to be silence; it keeps 300 ms
 *   of audio either side of the speech, so a soft first or last syllable is
 *   not clipped; one shorter than 0.8 s with that padding (a cough, a click)
 *   is dropped; and one that runs 10 s without a pause is cut at its
 *   quietest moment in its second half, so no transcription grows past what
 *   is quick. Cutting at pauses rather than every N seconds keeps words
 *   whole: a word cut in two is two wrong words.
 * - Each finished utterance is transcribed once, on its own, with the
 *   recogniser's full decoder (temperature fallback included), and that text
 *   is *committed*: it never changes, and it is never transcribed again.
 * - While an utterance is still being spoken it is transcribed from its start
 *   now and then, for the tentative text the page shows dimmed — greedily,
 *   with no fallback, and only when the recogniser is idle *and* at least a
 *   second more of it has come in since the last time. On a slow Mac that is
 *   fewer, not queued, tentative passes; and none run while a finished
 *   utterance waits for its own.
 *
 * The test for speech is energy against a threshold that follows the noise
 * floor of the last few seconds (three times its 20th percentile), between a
 * minimum and podcast-maker's fixed thresholds: a quiet room lets a quiet
 * voice count, a noisy one does not count its fan, and a loud voice always
 * counts. The browser has already suppressed noise; a model-based VAD would
 * be another model to ship.
 *
 * Committed text is passed back to Whisper as the prompt for what follows, so
 * the next utterance continues in the same language and style.
 *
 * A recogniser that is not `live` (the per-recording CLI, from a recogniser
 * directory built before the server existed) is only run once, at the end,
 * over everything from the first utterance to the last.
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
	/**
	 * A tentative pass over an utterance still being spoken: the cheapest
	 * decode will do, since the committed pass follows.
	 */
	readonly partial?: boolean;
}

/** Something that turns 16 kHz mono 16-bit PCM into words. */
export interface Transcriber {
	/** Whether it is cheap enough to run over and over while the person speaks. */
	readonly live: boolean;
	transcribe(pcm: Uint8Array, options: TranscribeOptions): Promise<string>;
}

export interface VadTuning {
	/** This many seconds above the start threshold start an utterance. */
	readonly startSeconds: number;
	/** This many seconds below the end threshold end one. */
	readonly endSeconds: number;
	/** Audio kept before the speech starts and after it ends. */
	readonly paddingSeconds: number;
	/** An utterance shorter than this, padding included, is dropped. */
	readonly minUtteranceSeconds: number;
	/** An utterance longer than this is cut at its quietest point. */
	readonly maxUtteranceSeconds: number;
	/** The start threshold at its highest (RMS of 1.0 full scale): always speech. */
	readonly startLevel: number;
	/** The end threshold at its highest: below it, always silence. */
	readonly endLevel: number;
	/** The start threshold at its lowest, however quiet the room. */
	readonly minLevel: number;
	/** How many seconds of recent audio the noise floor is taken over. */
	readonly floorSeconds: number;
}

export interface StreamTuning extends VadTuning {
	/** A tentative pass needs at least this much new audio since the last one. */
	readonly partialEverySeconds: number;
}

export const DEFAULT_TUNING: StreamTuning = {
	startSeconds: 0.2,
	endSeconds: 0.4,
	paddingSeconds: 0.3,
	minUtteranceSeconds: 0.8,
	maxUtteranceSeconds: 10,
	startLevel: 0.03,
	endLevel: 0.02,
	minLevel: 0.01,
	floorSeconds: 3,
	partialEverySeconds: 1,
};

/** 20 ms, in samples. */
export const FRAME = Math.round(VOICE_SAMPLE_RATE * 0.02);

/** RMS of each whole 20 ms frame of `samples`, 0 to 1. */
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
 * The start and end thresholds over a noise floor: three times the floor,
 * held between `minLevel` and `startLevel`, and the end threshold in the
 * same proportion to it as podcast-maker's (0.02 to 0.03).
 */
export function thresholds(
	floor: number,
	tuning: Pick<VadTuning, "startLevel" | "endLevel" | "minLevel">,
): { readonly start: number; readonly end: number } {
	const start = Math.max(
		tuning.minLevel,
		Math.min(floor * 3, tuning.startLevel),
	);
	return { start, end: (start * tuning.endLevel) / tuning.startLevel };
}

/** A stretch of the recording, in frames: `[start, end)`. */
export interface Utterance {
	readonly start: number;
	readonly end: number;
	/** Cut because it ran too long, not at a pause. */
	readonly forced: boolean;
}

function frames(seconds: number): number {
	return Math.max(1, Math.round((seconds * VOICE_SAMPLE_RATE) / FRAME));
}

/**
 * The utterances in a recording, frame by frame as it arrives (see the
 * module comment). `feed` takes the next frame's level and answers the
 * utterance it finished, if it finished one; `open` is where the one being
 * spoken started.
 */
export class Segmenter {
	private readonly levels: number[] = [];
	private readonly startFrames: number;
	private readonly endFrames: number;
	private readonly paddingFrames: number;
	private readonly minFrames: number;
	private readonly maxFrames: number;
	private readonly floorFrames: number;
	/** Consecutive frames above the start threshold, while not in speech. */
	private loud = 0;
	/** Consecutive frames below the end threshold, while in speech. */
	private quiet = 0;
	private speechFrom: number | undefined;
	private lastVoice = 0;
	/** Where the last utterance ended: the next one's padding stops there. */
	private lastEnd = 0;

	constructor(private readonly tuning: VadTuning = DEFAULT_TUNING) {
		this.startFrames = frames(tuning.startSeconds);
		this.endFrames = frames(tuning.endSeconds);
		this.paddingFrames = Math.round(
			(tuning.paddingSeconds * VOICE_SAMPLE_RATE) / FRAME,
		);
		this.minFrames = frames(tuning.minUtteranceSeconds);
		this.maxFrames = Math.max(
			this.minFrames,
			frames(tuning.maxUtteranceSeconds),
		);
		this.floorFrames = frames(tuning.floorSeconds);
	}

	/** Frames fed so far. */
	get length(): number {
		return this.levels.length;
	}

	/** Where the utterance being spoken starts, padding included, or `undefined` between utterances. */
	get open(): number | undefined {
		return this.speechFrom;
	}

	/** The noise floor: the 20th-percentile level of the last `floorSeconds`. */
	floor(): number {
		const recent = this.levels.slice(-this.floorFrames).sort((a, b) => a - b);
		return recent.length === 0 ? 0 : recent[Math.floor(recent.length * 0.2)]!;
	}

	feed(level: number): Utterance | undefined {
		const { start, end } = thresholds(this.floor(), this.tuning);
		const f = this.levels.length;
		this.levels.push(level);
		if (this.speechFrom === undefined) {
			this.loud = level >= start ? this.loud + 1 : 0;
			if (this.loud >= this.startFrames) {
				this.speechFrom = Math.max(
					this.lastEnd,
					f + 1 - this.loud - this.paddingFrames,
				);
				this.lastVoice = f;
				this.quiet = 0;
			}
			return undefined;
		}
		if (level >= end) {
			this.lastVoice = f;
			this.quiet = 0;
		} else this.quiet++;
		if (this.quiet >= this.endFrames)
			return this.close(
				Math.min(this.lastVoice + 1 + this.paddingFrames, f + 1),
			);
		if (f + 1 - this.speechFrom >= this.maxFrames) return this.split(f + 1);
		return undefined;
	}

	/**
	 * The recording has ended: the utterance being spoken, if any, ends with
	 * it. It is kept however short — it was speech long enough to start one,
	 * and the person may have stopped right after a short word.
	 */
	flush(): Utterance | undefined {
		if (this.speechFrom === undefined) return undefined;
		const utterance = {
			start: this.speechFrom,
			end: this.levels.length,
			forced: false,
		};
		this.speechFrom = undefined;
		this.lastEnd = utterance.end;
		return utterance;
	}

	private close(endFrame: number): Utterance | undefined {
		const start = this.speechFrom!;
		this.speechFrom = undefined;
		this.loud = 0;
		this.lastEnd = endFrame;
		return endFrame - start >= this.minFrames
			? { start, end: endFrame, forced: false }
			: undefined;
	}

	/** Cut at the quietest frame of the second half; the rest is the next utterance, still in speech. */
	private split(endFrame: number): Utterance {
		const start = this.speechFrom!;
		let cut = start + Math.floor((endFrame - start) / 2);
		for (let f = cut; f < endFrame; f++)
			if (this.levels[f]! < this.levels[cut]!) cut = f;
		this.speechFrom = cut;
		this.lastEnd = cut;
		return { start, end: cut, forced: true };
	}
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

/** An utterance in samples. */
interface Span {
	readonly start: number;
	readonly end: number;
}

export class DictationStream {
	private samples = new Int16Array(VOICE_SAMPLE_RATE * 10);
	private length = 0;
	private readonly segmenter: Segmenter;
	/** Finished utterances not transcribed yet, oldest first. */
	private readonly pending: Span[] = [];
	/** Every utterance found, for a recogniser that runs only at the end. */
	private first: number | undefined;
	private last = 0;
	/** How far the recording had got at the last tentative pass. */
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
	) {
		this.segmenter = new Segmenter(tuning);
	}

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
		const done = this.segmenter.length;
		const levels = frameLevels(
			this.samples.subarray(done * FRAME, this.length),
		);
		for (const level of levels) {
			const utterance = this.segmenter.feed(level);
			if (utterance !== undefined) this.found(utterance);
		}
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
		const rest = this.segmenter.flush();
		if (rest !== undefined) this.found(rest, this.length);
		if (this.transcriber.live) {
			for (let span = this.pending.shift(); span; span = this.pending.shift())
				await this.final(span);
		} else if (this.first !== undefined) {
			await this.final({ start: this.first, end: this.last });
		}
		this.tentative = "";
		this.onUpdate({ committed: this.committed, tentative: "" });
		return this.committed;
	}

	/** Throw it away: nothing more is transcribed or reported. */
	cancel(): void {
		this.closed = true;
	}

	private found(utterance: Utterance, end = utterance.end * FRAME): void {
		const span = { start: utterance.start * FRAME, end };
		this.first ??= span.start;
		this.last = span.end;
		if (this.transcriber.live) this.pending.push(span);
	}

	private options(partial: boolean): TranscribeOptions {
		return {
			language: this.language,
			prompt: this.committed === "" ? undefined : this.committed.slice(-200),
			partial,
		};
	}

	private final(span: Span): Promise<void> {
		const audio = this.samples.slice(span.start, span.end);
		return this.transcriber
			.transcribe(bytes(audio), this.options(false))
			.then((words) => {
				// Applied even after the recording ended: `finish` transcribes
				// only what comes after it.
				this.committed = joinSpoken(this.committed, words);
				this.tentative = "";
				if (!this.closed) this.report();
			});
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
		const span = this.pending.shift();
		if (span !== undefined) return this.final(span);
		const open = this.segmenter.open;
		if (open === undefined) return undefined;
		const from = Math.max(open * FRAME, this.lastPartialAt);
		if (
			this.length - from <
			this.tuning.partialEverySeconds * VOICE_SAMPLE_RATE
		)
			return undefined;
		const at = this.length;
		this.lastPartialAt = at;
		const audio = this.samples.slice(open * FRAME, at);
		return this.transcriber
			.transcribe(bytes(audio), this.options(true))
			.then((words) => {
				if (this.closed) return;
				this.tentative = words;
				this.report();
			});
	}

	private report(): void {
		this.onUpdate({ committed: this.committed, tentative: this.tentative });
	}
}
