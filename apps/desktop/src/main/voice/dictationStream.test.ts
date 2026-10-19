/**
 * Streaming dictation around a recogniser that is not a streaming one
 * (`dictationStream.ts`): where utterances start and end, what is committed
 * and when, how often the tentative pass runs, and that committed text only
 * ever grows. The recogniser is a fake that names what it was given, so no
 * whisper.cpp is needed.
 */

import { describe, expect, it } from "vitest";

import type { VoiceUpdate } from "../../ipc/voice.js";
import {
	DEFAULT_TUNING,
	DictationStream,
	FRAME,
	joinSpoken,
	Segmenter,
	thresholds,
	type TranscribeOptions,
	type Transcriber,
	type Utterance,
	type VadTuning,
} from "./dictationStream.js";

const RATE = 16_000;

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

function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.byteLength;
	}
	return out;
}

/** A recogniser that answers how many tenths of a second it heard: `t10` for one second. */
class FakeTranscriber implements Transcriber {
	readonly calls: { seconds: number; options: TranscribeOptions }[] = [];
	failWith: Error | undefined;
	/** While set, answers wait until `release` is called. */
	hold = false;
	running = 0;
	maxRunning = 0;
	private waiting: (() => void)[] = [];
	constructor(readonly live = true) {}
	transcribe(pcm: Uint8Array, options: TranscribeOptions): Promise<string> {
		const seconds = pcm.byteLength / 2 / RATE;
		this.calls.push({ seconds, options });
		if (this.failWith) return Promise.reject(this.failWith);
		this.running++;
		this.maxRunning = Math.max(this.maxRunning, this.running);
		const answer = `t${Math.round(seconds * 10)}`;
		const done = () => {
			this.running--;
			return answer;
		};
		if (!this.hold) return Promise.resolve().then(done);
		return new Promise((resolve) => this.waiting.push(() => resolve(done())));
	}
	release(): void {
		const waiting = this.waiting;
		this.waiting = [];
		for (const go of waiting) go();
	}
}

const settle = async () => {
	for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

function stream(transcriber: Transcriber, tuning = DEFAULT_TUNING) {
	const updates: VoiceUpdate[] = [];
	const s = new DictationStream(
		transcriber,
		"ja",
		(update) => updates.push(update),
		tuning,
	);
	return { s, updates };
}

// --- the segmenter -------------------------------------------------------------

/** Fixed thresholds — start 0.03, end 0.02 — so the noise floor does not move them. */
const FIXED: VadTuning = { ...DEFAULT_TUNING, minLevel: 0.03 };

/** Feed `levels`, run-length encoded as [level, frames] pairs; the utterances finished. */
function feed(
	segmenter: Segmenter,
	...runs: (readonly [number, number])[]
): Utterance[] {
	const out: Utterance[] = [];
	for (const [level, count] of runs)
		for (let i = 0; i < count; i++) {
			const u = segmenter.feed(level);
			if (u) out.push(u);
		}
	return out;
}

// 20 ms frames: 200 ms is 10, 400 ms 20, the 300 ms padding 15, 0.8 s 40.
describe("cutting a recording into utterances", () => {
	it("starts only after 200 ms above the start threshold", () => {
		const s = new Segmenter(FIXED);
		feed(s, [0, 20], [0.05, 9], [0, 1], [0.05, 9]);
		expect(s.open).toBeUndefined();
		feed(s, [0.05, 1]);
		// The loud run began at frame 30; 300 ms of padding before it.
		expect(s.open).toBe(30 - 15);
	});

	it("keeps going while the level stays above the end threshold, below the start one", () => {
		const s = new Segmenter(FIXED);
		expect(feed(s, [0, 20], [0.05, 20], [0.025, 100])).toEqual([]);
		expect(s.open).toBe(5);
		// Under the end threshold for 400 ms ends it.
		const [u] = feed(s, [0.01, 20]);
		// Last voice at frame 139; 300 ms of padding after it.
		expect(u).toEqual({ start: 5, end: 140 + 15, forced: false });
		expect(s.open).toBeUndefined();
	});

	it("does not end at a breath shorter than 400 ms", () => {
		const s = new Segmenter(FIXED);
		expect(feed(s, [0.05, 20], [0, 19], [0.05, 20], [0, 19])).toEqual([]);
		expect(s.open).toBe(0);
	});

	it("drops an utterance shorter than 0.8 s with its padding", () => {
		const s = new Segmenter(FIXED);
		// At the very start there is nothing to pad before: 10 + 15 frames.
		expect(feed(s, [0.05, 10], [0, 30])).toEqual([]);
		// 15 + 10 + 15 = 40 frames is long enough.
		expect(feed(s, [0, 20], [0.05, 10], [0, 30])).toEqual([
			{ start: 45, end: 85, forced: false },
		]);
	});

	it("never pads back into the utterance before", () => {
		const s = new Segmenter(FIXED);
		const [a] = feed(s, [0.05, 50], [0, 20]);
		const [b] = feed(s, [0.05, 50], [0, 20]);
		expect(a!.end).toBe(65);
		// The second began loud at frame 70; its padding would reach 55.
		expect(b!.start).toBe(65);
	});

	it("cuts one that runs too long at its quietest frame in its second half, and goes on", () => {
		const s = new Segmenter({ ...FIXED, maxUtteranceSeconds: 2 });
		const done = feed(s, [0.05, 70], [0.021, 1], [0.05, 29]);
		expect(done).toEqual([{ start: 0, end: 70, forced: true }]);
		// The rest is the next utterance, already in speech.
		expect(s.open).toBe(70);
		const [next] = feed(s, [0.05, 10], [0, 20]);
		expect(next).toEqual({ start: 70, end: 110 + 15, forced: false });
	});

	it("at the end of the recording, ends the one being spoken there", () => {
		const s = new Segmenter(FIXED);
		feed(s, [0, 5], [0.05, 12]);
		expect(s.flush()).toEqual({ start: 0, end: 17, forced: false });
		expect(s.flush()).toBeUndefined();
	});

	it("follows the noise floor between its limits", () => {
		expect(thresholds(0, DEFAULT_TUNING).start).toBe(0.01);
		expect(thresholds(0, DEFAULT_TUNING).end).toBeCloseTo(0.02 / 3, 6);
		expect(thresholds(0.005, DEFAULT_TUNING).start).toBeCloseTo(0.015, 6);
		expect(thresholds(1, DEFAULT_TUNING).start).toBe(0.03);
		expect(thresholds(1, DEFAULT_TUNING).end).toBeCloseTo(0.02, 6);
		// A quiet voice counts in a quiet room, not over a fan.
		const quiet = new Segmenter();
		feed(quiet, [0.001, 100], [0.012, 10]);
		expect(quiet.open).toBeDefined();
		const fan = new Segmenter();
		feed(fan, [0.005, 100], [0.012, 10]);
		expect(fan.open).toBeUndefined();
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

// --- the stream ----------------------------------------------------------------

describe("a dictation as it is spoken", () => {
	it("shows the utterance being spoken as tentative, again only once a second more is heard", async () => {
		const fake = new FakeTranscriber();
		const { s, updates } = stream(fake);
		s.push(tone(0.75));
		await settle();
		expect(fake.calls).toHaveLength(0);
		s.push(tone(0.25));
		await settle();
		expect(updates.at(-1)).toEqual({ committed: "", tentative: "t10" });
		s.push(tone(0.75));
		await settle();
		// Not a second more yet: nothing new transcribed.
		expect(fake.calls).toHaveLength(1);
		s.push(tone(0.25));
		await settle();
		expect(updates.at(-1)).toEqual({ committed: "", tentative: "t20" });
		expect(fake.calls.map((c) => c.options.partial)).toEqual([true, true]);
	});

	it("never runs two at once, and does not queue tentative passes behind a slow one", async () => {
		const fake = new FakeTranscriber();
		fake.hold = true;
		const { s } = stream(fake);
		for (let i = 0; i < 16; i++) {
			s.push(tone(0.25));
			await settle();
		}
		// Four seconds heard, one pass still running.
		expect(fake.calls).toHaveLength(1);
		fake.release();
		await settle();
		// One more, over everything heard so far, not one per second missed.
		expect(fake.calls).toHaveLength(2);
		expect(fake.calls[1]!.seconds).toBeCloseTo(4);
		fake.release();
		await settle();
		expect(fake.maxRunning).toBe(1);
	});

	it("commits an utterance at a pause, once, and starts the next after it", async () => {
		const fake = new FakeTranscriber();
		const { s, updates } = stream(fake);
		s.push(tone(1));
		await settle();
		s.push(silence(0.8));
		await settle();
		// The utterance and 300 ms after it is committed, with the full decoder.
		expect(updates.at(-1)).toEqual({ committed: "t13", tentative: "" });
		expect(fake.calls.at(-1)!.options.partial).toBe(false);
		s.push(tone(1.5));
		await settle();
		const last = updates.at(-1)!;
		expect(last.committed).toBe("t13");
		// The next starts 300 ms before its speech, after what was committed.
		expect(last.tentative).toBe("t18");
		// The committed text is the prompt for what follows.
		expect(fake.calls.at(-1)!.options.prompt).toBe("t13");

		const all = await s.finish();
		expect(all).toBe("t13 t18");
		expect(updates.at(-1)).toEqual({ committed: all, tentative: "" });
		expect(fake.calls.map((c) => [c.seconds, c.options.partial])).toEqual([
			[1, true],
			[1.3, false],
			[1.8, true],
			[1.8, false],
		]);
		for (let i = 1; i < updates.length; i++)
			expect(updates[i]!.committed.startsWith(updates[i - 1]!.committed)).toBe(
				true,
			);
	});

	it("commits utterances that ended while the recogniser was busy, in order, before any tentative pass", async () => {
		const fake = new FakeTranscriber();
		fake.hold = true;
		const { s } = stream(fake);
		// All at once, as after a stall: two utterances ended, a third begun.
		s.push(concat(tone(1), silence(0.5), tone(1), silence(0.5), tone(1.2)));
		await settle();
		expect(fake.calls).toHaveLength(1);
		const finishing = s.finish();
		for (let i = 0; i < 5; i++) {
			fake.release();
			await settle();
		}
		// [0, 1.3), [1.3, 2.8) — its padding stops where the first ended — and [2.8, 4.2).
		await expect(finishing).resolves.toBe("t13 t15 t14");
		expect(fake.calls.every((c) => c.options.partial === false)).toBe(true);
		expect(fake.maxRunning).toBe(1);
	});

	it("transcribes nothing of silence or a click", async () => {
		const fake = new FakeTranscriber();
		const { s } = stream(fake);
		s.push(silence(5));
		s.push(tone(0.1));
		s.push(silence(1));
		await settle();
		await expect(s.finish()).resolves.toBe("");
		expect(fake.calls).toHaveLength(0);
	});

	it("cuts an utterance that runs past the longest without a pause", async () => {
		const fake = new FakeTranscriber();
		const { s, updates } = stream(fake, {
			...DEFAULT_TUNING,
			maxUtteranceSeconds: 3,
		});
		for (let i = 0; i < 16; i++) {
			s.push(tone(0.5));
			await settle();
		}
		expect(updates.some((u) => u.committed !== "")).toBe(true);
		expect(Math.max(...fake.calls.map((c) => c.seconds))).toBeLessThanOrEqual(
			3,
		);
		await s.finish();
		// Every sample is committed once: the pieces add up to the recording.
		const committed = fake.calls
			.filter((c) => c.options.partial === false)
			.reduce((sum, c) => sum + c.seconds, 0);
		expect(committed).toBeCloseTo(8);
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

it("frames are 20 ms", () => {
	expect(FRAME).toBe(320);
});
