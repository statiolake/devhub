/**
 * The bundled speech recogniser: whisper.cpp's `whisper-cli`, as
 * `devhub-whisper`, with the model beside it (`scripts/build_whisper.py`).
 *
 * One program per recording. The recording is written to a WAV file in a
 * directory of its own, the program is told to write its transcript as text
 * beside it, and the directory is removed whatever happens. A program per
 * recording rather than one kept running: the model is mmapped, so after the
 * first recording loading it is the page cache and a fraction of a second,
 * and a recogniser that faults (a Metal driver, memory on a long recording)
 * fails that one recording instead of the next hundred. It is also what makes
 * "no network" a property of the build and not of a server's configuration:
 * the program has no socket to open (`-DWHISPER_CURL=OFF`) and nothing here
 * listens on one.
 *
 * Recordings are transcribed one at a time. The GPU is one GPU, two composers
 * dictating at once is two people at one Mac, and the second waiting a second
 * is better than both waiting for a GPU they share badly.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";

import {
	VOICE_MAX_SECONDS,
	VOICE_SAMPLE_RATE,
	type VoiceLanguage,
} from "../../ipc/voice.js";
import { needsSpace } from "../../model/spokenText.js";

export const WHISPER_BINARY = "devhub-whisper";
export const WHISPER_MODEL = "ggml-large-v3-turbo-q5_0.bin";

/**
 * Where a recogniser may be, most specific first: what the environment names
 * (`DEVHUB_WHISPER_DIR`, for trying another build), the packaged app's
 * `Contents/Resources/whisper` (the app root is `Resources/app`), and in a
 * source run the `dist/whisper` that `scripts/build_whisper.py` writes by
 * default (the app root is `apps/desktop`).
 */
export function whisperCandidates(
	appRoot: string,
	env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
	const named = env.DEVHUB_WHISPER_DIR;
	return [
		...(named ? [named] : []),
		join(appRoot, "..", "whisper"),
		join(appRoot, "..", "..", "dist", "whisper"),
	];
}

export interface WhisperInstall {
	readonly binary: string;
	readonly model: string;
}

/** The first candidate that holds both the program and the model. */
export function locateWhisper(
	candidates: readonly string[],
	exists: (path: string) => boolean = existsSync,
): WhisperInstall | undefined {
	for (const directory of candidates) {
		const binary = join(directory, WHISPER_BINARY);
		const model = join(directory, WHISPER_MODEL);
		if (exists(binary) && exists(model)) return { binary, model };
	}
	return undefined;
}

/**
 * A RIFF/WAVE file around 16-bit mono PCM: the one container `whisper-cli`
 * reads without ffmpeg. The 44-byte canonical header, little-endian.
 */
export function wavFile(
	pcm: Uint8Array,
	sampleRate: number = VOICE_SAMPLE_RATE,
): Uint8Array {
	const header = new ArrayBuffer(44);
	const view = new DataView(header);
	const ascii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++)
			view.setUint8(offset + i, text.charCodeAt(i));
	};
	ascii(0, "RIFF");
	view.setUint32(4, 36 + pcm.byteLength, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	view.setUint32(16, 16, true); // fmt chunk size
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true); // byte rate
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	ascii(36, "data");
	view.setUint32(40, pcm.byteLength, true);
	const file = new Uint8Array(44 + pcm.byteLength);
	file.set(new Uint8Array(header), 0);
	file.set(pcm, 44);
	return file;
}

/**
 * Why a recording is not one main transcribes, or `undefined` when it is.
 * The page is trusted to record; it is not trusted to have recorded sanely.
 */
export function recordingRefusal(pcm: unknown): string | undefined {
	if (!(pcm instanceof Uint8Array))
		return "The recording did not arrive as audio.";
	if (pcm.byteLength % 2 !== 0) return "The recording is not 16-bit audio.";
	if (pcm.byteLength === 0) return "Nothing was recorded.";
	if (pcm.byteLength > VOICE_MAX_SECONDS * VOICE_SAMPLE_RATE * 2)
		return `A recording is at most ${VOICE_MAX_SECONDS / 60} minutes long.`;
	return undefined;
}

/**
 * The command line for one recording.
 *
 * `-nt` because a message has no use for timestamps; `-np` so that stdout and
 * stderr carry nothing but what went wrong; `-otxt -of` for the transcript as
 * a file, which unlike stdout cannot be mixed with a log line. The threads are
 * for the parts Metal does not take — capped, because past the performance
 * cores more threads are slower, not faster.
 */
export function whisperArgs(options: {
	readonly model: string;
	readonly wav: string;
	readonly outputBase: string;
	readonly language: VoiceLanguage;
	readonly threads: number;
}): readonly string[] {
	return [
		"-m",
		options.model,
		"-f",
		options.wav,
		"-l",
		options.language,
		"-t",
		String(Math.max(1, Math.min(8, options.threads))),
		"-nt",
		"-np",
		"-otxt",
		"-of",
		options.outputBase,
	];
}

/**
 * Whisper's markers for what is not speech — `[BLANK_AUDIO]`, `[音楽]`,
 * `(keyboard clicking)`, `*sigh*` — written on a segment of their own. A
 * marker is a whole segment: brackets inside a sentence are words.
 */
const NON_SPEECH = /^\s*(\[[^\]]*\]|\([^)]*\)|（[^）]*）|\*[^*]*\*|♪+)\s*$/u;

/**
 * The words a transcript file holds, as one paragraph.
 *
 * Whisper writes a segment per line, cut wherever it paused, which is not
 * where the speaker's sentences end; the composer wants the words, so the
 * lines are joined — with a space between Latin text, and with nothing where
 * either side is Japanese, which has no spaces to put back.
 */
export function cleanTranscript(raw: string): string {
	const segments = raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "" && !NON_SPEECH.test(line));
	let text = "";
	for (const segment of segments) {
		if (text === "") text = segment;
		else
			text += needsSpace(text.at(-1)!, segment[0]!) ? ` ${segment}` : segment;
	}
	return text;
}

/** The program's last words, for a failure: its stderr's tail, shortened. */
function tail(text: string): string {
	const trimmed = text.trim();
	return trimmed.length > 400 ? `…${trimmed.slice(-400)}` : trimmed;
}

/**
 * A recording of `seconds` seconds is given this long before it is given up
 * on: a minute for loading the model the first time, and then far more than
 * the fraction of real time large-v3-turbo takes on Apple Silicon.
 */
export function transcriptionDeadlineMs(seconds: number): number {
	return 60_000 + seconds * 2_000;
}

export class Whisper {
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly install: WhisperInstall) {}

	/** The words in `pcm` (see `ipc/voice.ts`), after any recording before it. */
	transcribe(pcm: Uint8Array, language: VoiceLanguage): Promise<string> {
		const run = this.queue.then(() => this.run(pcm, language));
		this.queue = run.catch(() => undefined);
		return run;
	}

	private async run(pcm: Uint8Array, language: VoiceLanguage): Promise<string> {
		const directory = await mkdtemp(join(tmpdir(), "devhub-voice-"));
		try {
			const wav = join(directory, "recording.wav");
			const outputBase = join(directory, "transcript");
			await writeFile(wav, wavFile(pcm));
			await this.spawn(
				whisperArgs({
					model: this.install.model,
					wav,
					outputBase,
					language,
					threads: availableParallelism(),
				}),
				transcriptionDeadlineMs(pcm.byteLength / 2 / VOICE_SAMPLE_RATE),
			);
			return cleanTranscript(await readFile(`${outputBase}.txt`, "utf8"));
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}

	private spawn(args: readonly string[], deadlineMs: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const child = spawn(this.install.binary, args, {
				stdio: ["ignore", "ignore", "pipe"],
			});
			let stderr = "";
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				stderr = (stderr + chunk).slice(-4000);
			});
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				reject(
					new Error(
						`The recogniser took longer than ${Math.round(deadlineMs / 1000)} seconds and was stopped.`,
					),
				);
			}, deadlineMs);
			child.on("error", (error) => {
				clearTimeout(timer);
				reject(
					new Error(`The recogniser could not be started: ${error.message}`),
				);
			});
			child.on("exit", (code, signal) => {
				clearTimeout(timer);
				if (code === 0) resolve();
				else
					reject(
						new Error(
							`The recogniser stopped (${signal ?? `exit code ${String(code)}`})${stderr.trim() ? `: ${tail(stderr)}` : "."}`,
						),
					);
			});
		});
	}
}
