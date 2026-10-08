/**
 * Streaming dictation around a recogniser that is not a streaming one
 * (`dictationStream.ts`): where phrases are cut, what is committed and when,
 * and that committed text only ever grows. The recogniser is a fake that
 * names what it was given, so no whisper.cpp is needed.
 */

import { describe, expect, it } from "vitest";

import type { VoiceUpdate } from "../../ipc/voice.js";
import {
	DictationStream,
	findPause,
	joinSpoken,
	quietestCut,
	speechFrames,
	frameLevels,
	type TranscribeOptions,
	type Transcriber,
} from "./dictationStream.js";

const RATE = 16_000;
const FRAME = 480;

function tone(seconds: number, amplitude = 0.3): Uint8Array {
	const samples = new Int16Array(Math.round(seconds * RATE));
	for (let i = 0; i < samples.length; i++)
		samples[i] = Math.round(
			Math.sin((i / RATE) * 2 * Math.PI * 220) * amplitude * 32767,
		);
	return new Uint8Array(samples.buffer);
}

function silence(seconds: number): Uint8Array {
	return new Uint8Array(Math.round(seconds * RATE) * 2);
}

/** A recogniser that answers how many tenths of a second it heard: `t10` for one second. */
class FakeTranscriber implements Transcriber {
	readonly calls: { seconds: number; options: TranscribeOptions }[] = [];
	failWith: Error | undefined;
	constructor(readonly live = true) {}
	transcribe(pcm: Uint8Array, options: TranscribeOptions): Promise<string> {
		const seconds = pcm.byteLength / 2 / RATE;
		this.calls.push({ seconds, options });
		if (this.failWith) return Promise.reject(this.failWith);
		return Promise.resolve(`t${Math.round(seconds * 10)}`);
	}
}

const settle = async () => {
	for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

function stream(transcriber: Transcriber, maxWindowSeconds = 20) {
	const updates: VoiceUpdate[] = [];
	const s = new DictationStream(
		transcriber,
		"en",
		(update) => updates.push(update),
		{
			partialEverySeconds: 0.5,
			pauseSeconds: 0.6,
			minSpeechSeconds: 0.25,
			maxWindowSeconds,
			minSpeechLevel: 0.01,
		},
	);
	return { s, updates };
}

describe("finding where a phrase ends", () => {
	const tuning = { pauseSeconds: 0.6, minSpeechSeconds: 0.25 };
	const frames = (pattern: string) => [...pattern].map((c) => c === "#");

	it("cuts in the middle of a long enough pause after speech", () => {
		// 30 ms frames: 0.6 s is 20 frames.
		const speech = frames("#".repeat(20) + ".".repeat(30) + "#".repeat(10));
		expect(findPause(speech, tuning)).toBe(35 * FRAME);
	});

	it("does not cut at a short breath, or at the quiet before any speech", () => {
		expect(
			findPause(
				frames("#".repeat(20) + ".".repeat(10) + "#".repeat(5)),
				tuning,
			),
		).toBeUndefined();
		expect(
			findPause(frames(".".repeat(40) + "#".repeat(20)), tuning),
		).toBeUndefined();
	});

	it("counts a pause still running at the end, and takes the last pause", () => {
		const speech = frames(
			"#".repeat(20) + ".".repeat(25) + "#".repeat(20) + ".".repeat(22),
		);
		expect(findPause(speech, tuning)).toBe(76 * FRAME);
	});

	it("tells speech from a noise floor", () => {
		const samples = new Int16Array(RATE);
		for (let i = 0; i < samples.length; i++)
			samples[i] = i < RATE / 2 ? (i % 2 ? 300 : -300) : i % 2 ? 8000 : -8000;
		const speech = speechFrames(frameLevels(samples), 0.01);
		expect(speech.slice(0, 10).some(Boolean)).toBe(false);
		expect(speech.slice(-10).every(Boolean)).toBe(true);
	});

	it("cuts a phrase with no pause at its quietest moment, in its second half", () => {
		const levels = new Float32Array([0.1, 0.0, 0.5, 0.5, 0.2, 0.5]);
		expect(quietestCut(levels)).toBe(4 * FRAME + FRAME / 2);
	});
});

describe("joining phrases", () => {
	it("spaces Latin text and runs Japanese together", () => {
		expect(joinSpoken("Fix the", "bug.")).toBe("Fix the bug.");
		expect(joinSpoken("これを", "直して")).toBe("これを直して");
		expect(joinSpoken("", "a")).toBe("a");
		expect(joinSpoken("a", "")).toBe("a");
	});
});

describe("a dictation as it is spoken", () => {
	it("shows the words being spoken as tentative, again as more is heard", async () => {
		const fake = new FakeTranscriber();
		const { s, updates } = stream(fake);
		s.push(tone(0.6));
		await settle();
		expect(updates.at(-1)).toEqual({ committed: "", tentative: "t6" });
		s.push(tone(0.3));
		await settle();
		// Not half a second more yet: nothing new transcribed.
		expect(fake.calls).toHaveLength(1);
		s.push(tone(0.3));
		await settle();
		expect(updates.at(-1)).toEqual({ committed: "", tentative: "t12" });
	});

	it("commits a phrase at a pause, never changes it, and starts the next after it", async () => {
		const fake = new FakeTranscriber();
		const { s, updates } = stream(fake);
		s.push(tone(1));
		await settle();
		s.push(silence(0.8));
		await settle();
		// The phrase up to the middle of the pause (1 s + 0.4 s) is committed.
		expect(updates.at(-1)).toEqual({ committed: "t14", tentative: "" });
		s.push(tone(1));
		await settle();
		const last = updates.at(-1)!;
		expect(last.committed).toBe("t14");
		expect(last.tentative).not.toBe("");
		// The committed text is the prompt for what follows.
		expect(fake.calls.at(-1)!.options.prompt).toBe("t14");

		const all = await s.finish();
		expect(all.startsWith("t14 ")).toBe(true);
		expect(updates.at(-1)).toEqual({ committed: all, tentative: "" });
		for (let i = 1; i < updates.length; i++)
			expect(updates[i]!.committed.startsWith(updates[i - 1]!.committed)).toBe(
				true,
			);
	});

	it("transcribes nothing of silence, and drops the silence before speech", async () => {
		const fake = new FakeTranscriber();
		const { s, updates } = stream(fake);
		s.push(silence(5));
		await settle();
		expect(fake.calls).toHaveLength(0);
		s.push(tone(0.6));
		await settle();
		// The window kept at most a second of the silence before the speech.
		expect(fake.calls[0]!.seconds).toBeLessThanOrEqual(1.6 + 1e-9);
		await s.finish();
		expect(updates.length).toBeGreaterThan(0);
		const quiet = new FakeTranscriber();
		await expect(stream(quiet).s.finish()).resolves.toBe("");
		expect(quiet.calls).toHaveLength(0);
	});

	it("cuts a phrase that runs past the longest window without a pause", async () => {
		const fake = new FakeTranscriber();
		const { s, updates } = stream(fake, 3);
		for (let i = 0; i < 8; i++) {
			s.push(tone(0.5));
			await settle();
		}
		expect(updates.some((u) => u.committed !== "")).toBe(true);
		expect(Math.max(...fake.calls.map((c) => c.seconds))).toBeLessThanOrEqual(
			4,
		);
	});

	it("with a recogniser too slow to run live, transcribes once at the end", async () => {
		const fake = new FakeTranscriber(false);
		const { s, updates } = stream(fake);
		s.push(tone(1));
		s.push(silence(1));
		s.push(tone(1));
		await settle();
		expect(fake.calls).toHaveLength(0);
		await expect(s.finish()).resolves.toBe("t30");
		expect(updates).toEqual([{ committed: "t30", tentative: "" }]);
	});

	it("fails the dictation once when the recogniser fails", async () => {
		const fake = new FakeTranscriber();
		fake.failWith = new Error("The recogniser stopped.");
		const { s } = stream(fake);
		s.push(tone(1));
		await settle();
		s.push(tone(1));
		await settle();
		expect(fake.calls).toHaveLength(1);
		await expect(s.finish()).rejects.toThrow("The recogniser stopped.");
	});

	it("reports nothing after it is cancelled", async () => {
		const fake = new FakeTranscriber();
		const { s, updates } = stream(fake);
		s.push(tone(1));
		s.cancel();
		await settle();
		s.push(tone(1));
		await settle();
		expect(updates).toEqual([]);
	});
});
