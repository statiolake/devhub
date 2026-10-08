/**
 * The bundled recogniser, as main runs it (`whisper.ts`) and answers the
 * Agents page about it (`voiceIpc.ts`).
 *
 * whisper.cpp itself is not run here — it is a macOS binary built by
 * `scripts/build_whisper.py` — so what is pinned is everything around it:
 * where it is looked for, the WAV it is handed, the command line, how its
 * transcript is turned into one paragraph, which recordings are refused, and
 * that only the Agents page is answered.
 */

import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";

import { VOICE_CHANNELS } from "../../ipc/voice.js";
import type { TranscribeOptions, Transcriber } from "./dictationStream.js";
import {
	chunkRefusal,
	MICROPHONE_REFUSED,
	NO_RECOGNISER,
	registerVoiceIpc,
} from "./voiceIpc.js";
import {
	cleanTranscript,
	locateWhisper,
	recordingRefusal,
	wavFile,
	whisperArgs,
	whisperCandidates,
	WHISPER_BINARY,
	WHISPER_MODEL,
	WHISPER_SERVER_BINARY,
} from "./whisper.js";

describe("where the recogniser is", () => {
	it("looks where the environment says, then the bundle, then the source run's dist", () => {
		expect(
			whisperCandidates("/A/DevHub.app/Contents/Resources/app", {
				DEVHUB_WHISPER_DIR: "/elsewhere",
			}),
		).toEqual([
			"/elsewhere",
			"/A/DevHub.app/Contents/Resources/whisper",
			"/A/DevHub.app/Contents/dist/whisper",
		]);
		expect(whisperCandidates("/repo/apps/desktop", {})).toEqual([
			"/repo/apps/whisper",
			"/repo/dist/whisper",
		]);
	});

	it("takes the first directory with both the program and the model", () => {
		const present = new Set([
			join("/a", WHISPER_BINARY),
			join("/b", WHISPER_BINARY),
			join("/b", WHISPER_MODEL),
		]);
		expect(locateWhisper(["/a", "/b"], (p) => present.has(p))).toEqual({
			binary: join("/b", WHISPER_BINARY),
			model: join("/b", WHISPER_MODEL),
		});
		expect(locateWhisper(["/a"], (p) => present.has(p))).toBeUndefined();
		present.add(join("/b", WHISPER_SERVER_BINARY));
		expect(locateWhisper(["/a", "/b"], (p) => present.has(p))).toEqual({
			binary: join("/b", WHISPER_BINARY),
			model: join("/b", WHISPER_MODEL),
			server: join("/b", WHISPER_SERVER_BINARY),
		});
	});
});

describe("the recording it is handed", () => {
	it("is a canonical 16 kHz mono 16-bit WAV", () => {
		const file = wavFile(new Uint8Array([1, 2, 3, 4]));
		const view = new DataView(file.buffer);
		const text = (at: number) =>
			String.fromCharCode(...file.subarray(at, at + 4));
		expect(file.byteLength).toBe(48);
		expect(text(0)).toBe("RIFF");
		expect(view.getUint32(4, true)).toBe(40);
		expect(text(8)).toBe("WAVE");
		expect(view.getUint16(20, true)).toBe(1);
		expect(view.getUint16(22, true)).toBe(1);
		expect(view.getUint32(24, true)).toBe(16_000);
		expect(view.getUint32(28, true)).toBe(32_000);
		expect(view.getUint16(34, true)).toBe(16);
		expect(text(36)).toBe("data");
		expect(view.getUint32(40, true)).toBe(4);
		expect([...file.subarray(44)]).toEqual([1, 2, 3, 4]);
	});

	it("refuses what is not a sane recording", () => {
		expect(recordingRefusal("audio")).toMatch(/did not arrive/);
		expect(recordingRefusal(new Uint8Array(3))).toMatch(/16-bit/);
		expect(recordingRefusal(new Uint8Array(0))).toMatch(/Nothing/);
		expect(recordingRefusal(new Uint8Array(301 * 16_000 * 2))).toMatch(
			/at most 5 minutes/,
		);
		expect(recordingRefusal(new Uint8Array(32_000))).toBeUndefined();
	});
});

describe("the command line", () => {
	it("asks for plain text in a file, in the language chosen, with capped threads", () => {
		expect(
			whisperArgs({
				model: "/m.bin",
				wav: "/t/r.wav",
				outputBase: "/t/out",
				language: "ja",
				threads: 24,
			}),
		).toEqual([
			"-m",
			"/m.bin",
			"-f",
			"/t/r.wav",
			"-l",
			"ja",
			"-t",
			"8",
			"-nt",
			"-np",
			"-otxt",
			"-of",
			"/t/out",
		]);
	});
});

describe("the transcript", () => {
	it("joins English segments with spaces", () => {
		expect(cleanTranscript(" Fix the login bug\n and add a test.\n")).toBe(
			"Fix the login bug and add a test.",
		);
	});

	it("joins Japanese segments with nothing between", () => {
		expect(cleanTranscript("ログインのバグを\n直してください。\n")).toBe(
			"ログインのバグを直してください。",
		);
	});

	it("drops Whisper's markers for what is not speech, but not brackets in a sentence", () => {
		expect(
			cleanTranscript(
				"[BLANK_AUDIO]\n(keyboard clicking)\n[音楽]\n♪\nCall foo(bar) [twice]\n*sigh*\n",
			),
		).toBe("Call foo(bar) [twice]");
		expect(cleanTranscript("[BLANK_AUDIO]\n")).toBe("");
	});
});

/** `seconds` of a 220 Hz tone at `amplitude`, as 16-bit PCM bytes: "speech" to the stream's level test. */
function tone(seconds: number, amplitude = 0.3): Uint8Array {
	const samples = new Int16Array(Math.round(seconds * 16_000));
	for (let i = 0; i < samples.length; i++)
		samples[i] = Math.round(
			Math.sin((i / 16_000) * 2 * Math.PI * 220) * amplitude * 32767,
		);
	return new Uint8Array(samples.buffer);
}

describe("the Agents page's requests", () => {
	type Handler = (event: { sender: unknown }, ...args: unknown[]) => unknown;

	function register(
		options: {
			installed?: boolean;
			status?: string;
			ask?: () => Promise<boolean>;
			transcriber?: Transcriber & { warm?(): Promise<void> };
		} = {},
	) {
		const handlers = new Map<string, Handler>();
		const listeners = new Map<string, Handler>();
		const sent: unknown[][] = [];
		const page = {
			send: (...args: unknown[]) => void sent.push(args),
			isDestroyed: () => false,
			once: () => undefined,
		};
		registerVoiceIpc({
			ipcMain: {
				handle: (channel: string, handler: Handler) =>
					void handlers.set(channel, handler),
				on: (channel: string, handler: Handler) =>
					void listeners.set(channel, handler),
			} as never,
			agentsPage: () => page as never,
			install:
				options.installed === false
					? undefined
					: { binary: "/nonexistent/devhub-whisper", model: "/m.bin" },
			microphone: {
				status: () => options.status ?? "not-determined",
				ask: options.ask ?? (() => Promise.resolve(true)),
			},
			transcriber: options.transcriber,
		});
		const call = (channel: string, ...args: unknown[]) =>
			handlers.get(channel)!({ sender: page }, ...args);
		const emit = (channel: string, ...args: unknown[]) =>
			listeners.get(channel)!({ sender: page }, ...args);
		return { handlers, listeners, call, emit, sent };
	}

	it("answers no other page", async () => {
		const { handlers, listeners } = register();
		await expect(
			handlers.get(VOICE_CHANNELS.status)!({ sender: {} }),
		).rejects.toThrow(/only the Agents page/);
		// One-way messages from another page are dropped, not thrown.
		expect(
			listeners.get(VOICE_CHANNELS.audio)!(
				{ sender: {} },
				1,
				new Uint8Array(2),
			),
		).toBeUndefined();
	});

	it("says a build with no recogniser has none, and begins nothing", async () => {
		const { call } = register({ installed: false });
		await expect(call(VOICE_CHANNELS.status)).resolves.toEqual({
			available: false,
			reason: NO_RECOGNISER,
		});
		await expect(call(VOICE_CHANNELS.begin, "auto")).resolves.toEqual({
			ok: false,
			reason: NO_RECOGNISER,
		});
	});

	it("asks macOS for the microphone only when it has not been granted", async () => {
		const ask = vi.fn(() => Promise.resolve(true));
		await expect(
			register({ status: "granted", ask }).call(VOICE_CHANNELS.microphone),
		).resolves.toEqual({ ok: true, value: true });
		expect(ask).not.toHaveBeenCalled();

		await expect(
			register({ ask: () => Promise.resolve(false) }).call(
				VOICE_CHANNELS.microphone,
			),
		).resolves.toEqual({ ok: false, reason: MICROPHONE_REFUSED });
	});

	it("refuses audio that is not 16-bit PCM", () => {
		expect(chunkRefusal(new Uint8Array(3))).toBe(
			"The recording is not 16-bit audio.",
		);
		expect(chunkRefusal("pcm")).toBe("The recording did not arrive as audio.");
		expect(chunkRefusal(new Uint8Array(4))).toBeUndefined();
	});

	it("streams a dictation: warms, reports updates to the page, and answers the whole at the end", async () => {
		const warm = vi.fn(() => Promise.resolve());
		const transcribe = vi.fn((_pcm: Uint8Array, options: TranscribeOptions) =>
			Promise.resolve(options.language === "ja" ? "直して" : "?"),
		);
		const { call, emit, sent } = register({
			transcriber: { live: false, transcribe, warm },
		});
		const begun = (await call(VOICE_CHANNELS.begin, "ja")) as {
			ok: true;
			value: number;
		};
		expect(begun.ok).toBe(true);
		expect(warm).toHaveBeenCalled();
		emit(VOICE_CHANNELS.audio, begun.value, tone(1));
		emit(VOICE_CHANNELS.audio, begun.value, new Uint8Array(3)); // dropped
		await expect(call(VOICE_CHANNELS.end, begun.value)).resolves.toEqual({
			ok: true,
			value: "直して",
		});
		expect(transcribe).toHaveBeenCalledTimes(1);
		expect(transcribe.mock.calls[0]![0].byteLength).toBe(32_000);
		expect(sent).toEqual([
			[
				VOICE_CHANNELS.update,
				begun.value,
				{ committed: "直して", tentative: "" },
			],
		]);
		await expect(call(VOICE_CHANNELS.end, begun.value)).resolves.toMatchObject({
			ok: false,
		});
	});

	it("transcribes nothing of a cancelled dictation", async () => {
		const transcribe = vi.fn(() => Promise.resolve("x"));
		const { call, emit } = register({
			transcriber: { live: true, transcribe },
		});
		const begun = (await call(VOICE_CHANNELS.begin, "auto")) as {
			value: number;
		};
		emit(VOICE_CHANNELS.cancel, begun.value);
		emit(VOICE_CHANNELS.audio, begun.value, tone(2));
		expect(transcribe).not.toHaveBeenCalled();
		await expect(call(VOICE_CHANNELS.end, begun.value)).resolves.toMatchObject({
			ok: false,
		});
	});

	it("answers a recogniser that cannot start with the reason, not a rejection", async () => {
		const { call, emit } = register();
		const begun = (await call(VOICE_CHANNELS.begin, "klingon")) as {
			value: number;
		};
		emit(VOICE_CHANNELS.audio, begun.value, tone(1));
		const result = (await call(VOICE_CHANNELS.end, begun.value)) as {
			ok: boolean;
			reason?: string;
		};
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/could not be started/);
	});
});
