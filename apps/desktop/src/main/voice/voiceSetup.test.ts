/**
 * Voice input's setup as a state machine: off until the person agrees,
 * the download it starts, its progress, failure and retry, and turning it
 * off again — with a fake download and a fake settings file.
 */

import { describe, expect, it, vi } from "vitest";

import type { VoiceConsentWire } from "../../ipc/voice.js";
import { ModelDownloadError, type DownloadOptions } from "./modelDownload.js";
import type { VoiceModelPin } from "./voiceModels.js";
import { VoiceSetup, type VoiceSettings } from "./voiceSetup.js";

const pin = (id: "small" | "large-v3-turbo", file: string): VoiceModelPin => ({
	id,
	label: id === "small" ? "Whisper small" : "Whisper large-v3-turbo (q5_0)",
	file,
	url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}`,
	sha1: "a".repeat(40),
	size: id === "small" ? "466 MiB" : "547 MiB",
	minBytes: 1,
});
const SMALL = pin("small", "ggml-small.bin");
const TURBO = pin("large-v3-turbo", "ggml-large-v3-turbo-q5_0.bin");

/** A download the test finishes, fails or watches being aborted. */
interface Pending {
	readonly options: DownloadOptions;
	resolve(): void;
	reject(error: Error): void;
}

function harness(
	options: {
		enabled?: boolean;
		model?: "small" | "large-v3-turbo";
		ready?: readonly string[];
		answer?: boolean;
		override?: string;
		recogniser?: boolean;
	} = {},
) {
	let voice: VoiceSettings = {
		enabled: options.enabled ?? false,
		model: options.model ?? "small",
	};
	const writes: VoiceSettings[] = [];
	const asked: VoiceConsentWire[] = [];
	const downloads: Pending[] = [];
	const removed: string[] = [];
	const setup = new VoiceSetup({
		pins: [SMALL, TURBO],
		directory: "/data/devhub/whisper",
		displayDirectory: "~/data/devhub/whisper",
		recogniser: options.recogniser ?? true,
		override: (each) =>
			options.override !== undefined && each.id === voice.model
				? options.override
				: undefined,
		settings: {
			read: () => voice,
			write: (next) => {
				voice = next;
				writes.push(next);
				return Promise.resolve();
			},
		},
		ask: (consent) => {
			asked.push(consent);
			return Promise.resolve(options.answer ?? true);
		},
		fetch: () => Promise.reject(new Error("unused")),
		isReady: (_directory, each) => (options.ready ?? []).includes(each.id),
		download: (download) =>
			new Promise<string>((resolve, reject) => {
				download.signal.addEventListener("abort", () => {
					reject(new DOMException("aborted", "AbortError"));
				});
				downloads.push({
					options: download,
					resolve: () => resolve(`/data/devhub/whisper/${download.pin.file}`),
					reject,
				});
			}),
		remove: (_directory, each) => {
			removed.push(each.file);
			return Promise.resolve();
		},
	});
	const changes = vi.fn();
	setup.subscribe(changes);
	return {
		setup,
		writes,
		asked,
		downloads,
		removed,
		changes,
		edit: (next: VoiceSettings) => {
			voice = next;
			setup.settingsChanged();
		},
	};
}

const state = (setup: VoiceSetup, id = "small") =>
	setup.wire().models.find((model) => model.id === id)?.state;

describe("voice input, off by default", () => {
	it("is off and offers to turn on; dictation has no model to read", () => {
		const { setup } = harness();
		expect(setup.status()).toMatchObject({
			available: false,
			step: { kind: "enable" },
		});
		expect(setup.modelPath()).toBeUndefined();
	});

	it("asks before downloading, stating the model, size, host and where it goes", async () => {
		const { setup, asked, writes, downloads } = harness();
		await expect(setup.setUp()).resolves.toEqual({ ok: true, value: true });
		expect(asked).toEqual([
			{
				model: "small",
				label: "Whisper small",
				file: "ggml-small.bin",
				size: "466 MiB",
				host: "huggingface.co",
				directory: "~/data/devhub/whisper",
			},
		]);
		expect(writes).toEqual([{ enabled: true, model: "small" }]);
		expect(downloads).toHaveLength(1);
		expect(state(setup)).toEqual({
			kind: "downloading",
			received: 0,
			total: undefined,
		});
	});

	it("stays off and downloads nothing on キャンセル", async () => {
		const { setup, writes, downloads } = harness({ answer: false });
		await expect(setup.setUp()).resolves.toEqual({ ok: true, value: false });
		expect(writes).toEqual([]);
		expect(downloads).toEqual([]);
		expect(setup.status()).toMatchObject({ step: { kind: "enable" } });
	});

	it("turns on without asking when the model is already here", async () => {
		const { setup, asked, downloads } = harness({ ready: ["small"] });
		await setup.setUp();
		expect(asked).toEqual([]);
		expect(downloads).toEqual([]);
		expect(setup.status()).toEqual({ available: true });
		expect(setup.modelPath()).toBe("/data/devhub/whisper/ggml-small.bin");
	});

	it("uses the development override and downloads nothing", async () => {
		const { setup, asked, downloads } = harness({
			override: "/repo/dist/whisper/ggml-small.bin",
		});
		await setup.setUp();
		expect(asked).toEqual([]);
		expect(downloads).toEqual([]);
		expect(setup.modelPath()).toBe("/repo/dist/whisper/ggml-small.bin");
	});

	it("refuses with the reason in a build with no recogniser", async () => {
		const { setup, asked } = harness({ recogniser: false });
		await expect(setup.setUp()).resolves.toMatchObject({ ok: false });
		expect(asked).toEqual([]);
		expect(setup.status()).not.toHaveProperty("step");
	});
});

describe("the download", () => {
	it("reports progress, verifying, then ready — and dictation can read it", async () => {
		const { setup, downloads, changes } = harness();
		await setup.enable("small");
		const download = downloads[0]!;
		download.options.onProgress?.({ received: 50, total: 100 });
		expect(state(setup)).toEqual({
			kind: "downloading",
			received: 50,
			total: 100,
		});
		expect(setup.status()).toMatchObject({
			step: { kind: "downloading", received: 50, total: 100 },
		});
		// Progress is said once a percent, not once a chunk.
		const said = changes.mock.calls.length;
		download.options.onProgress?.({ received: 50, total: 100 });
		expect(changes.mock.calls.length).toBe(said);
		download.options.onVerifying?.();
		expect(state(setup)).toEqual({ kind: "verifying" });
		expect(setup.modelPath()).toBeUndefined();
		download.resolve();
		await setup.settled();
		expect(state(setup)).toEqual({ kind: "ready" });
		expect(setup.status()).toEqual({ available: true });
		expect(setup.modelPath()).toBe("/data/devhub/whisper/ggml-small.bin");
	});

	it("fails with the reason, and the retry downloads again without asking", async () => {
		const { setup, downloads, asked } = harness();
		await setup.enable("small");
		downloads[0]!.reject(new ModelDownloadError("接続が切れました。"));
		await setup.settled();
		expect(state(setup)).toEqual({
			kind: "failed",
			reason: "接続が切れました。",
		});
		expect(setup.status()).toMatchObject({
			available: false,
			step: { kind: "retry" },
			reason: expect.stringContaining("接続が切れました。") as unknown,
		});
		// A press of the microphone is the retry.
		await expect(setup.setUp()).resolves.toEqual({ ok: true, value: true });
		expect(asked).toEqual([]);
		expect(downloads).toHaveLength(2);
		downloads[1]!.resolve();
		await setup.settled();
		expect(setup.status()).toEqual({ available: true });
	});

	it("is not started twice by a second press while it runs", async () => {
		const { setup, downloads } = harness();
		await setup.setUp();
		await setup.setUp();
		expect(downloads).toHaveLength(1);
	});

	it("stops, deletes what arrived and turns voice off when cancelled", async () => {
		const { setup, downloads, removed, writes } = harness();
		await setup.enable("small");
		await setup.cancelDownload();
		expect(downloads[0]!.options.signal.aborted).toBe(true);
		expect(removed).toContain("ggml-small.bin");
		expect(writes.at(-1)).toEqual({ enabled: false, model: "small" });
		expect(state(setup)).toEqual({ kind: "absent" });
	});

	it("stops when the file is edited to turn voice input off", async () => {
		const { setup, downloads, edit } = harness();
		await setup.enable("small");
		edit({ enabled: false, model: "small" });
		await setup.settled();
		expect(downloads[0]!.options.signal.aborted).toBe(true);
		expect(state(setup)).toEqual({ kind: "absent" });
	});
});

describe("turning it off, and the models", () => {
	it("keeps the model when told to, and voice input refuses again", async () => {
		const { setup, removed, writes } = harness({
			enabled: true,
			ready: ["small"],
		});
		await setup.disable(false);
		expect(writes).toEqual([{ enabled: false, model: "small" }]);
		expect(removed).toEqual([]);
		expect(state(setup)).toEqual({ kind: "ready" });
		expect(setup.modelPath()).toBeUndefined();
	});

	it("deletes every model when told to", async () => {
		const { setup, removed } = harness({
			enabled: true,
			ready: ["small", "large-v3-turbo"],
		});
		await setup.disable(true);
		expect(removed).toEqual(["ggml-small.bin", "ggml-large-v3-turbo-q5_0.bin"]);
		expect(state(setup)).toEqual({ kind: "absent" });
		expect(state(setup, "large-v3-turbo")).toEqual({ kind: "absent" });
	});

	it("switches model: the new one downloads, the old one's download stops", async () => {
		const { setup, downloads, writes } = harness();
		await setup.enable("small");
		await setup.enable("large-v3-turbo");
		expect(downloads[0]!.options.signal.aborted).toBe(true);
		expect(downloads[1]!.options.pin.id).toBe("large-v3-turbo");
		expect(writes.at(-1)).toEqual({ enabled: true, model: "large-v3-turbo" });
	});

	it("asks about the model the settings name when the microphone turns it on", async () => {
		const { setup, asked } = harness({ model: "large-v3-turbo" });
		await setup.setUp();
		expect(asked[0]).toMatchObject({
			model: "large-v3-turbo",
			size: "547 MiB",
		});
	});

	it("deletes one model", async () => {
		const { setup, removed } = harness({ ready: ["large-v3-turbo"] });
		await setup.deleteModel("large-v3-turbo");
		expect(removed).toEqual(["ggml-large-v3-turbo-q5_0.bin"]);
		expect(state(setup, "large-v3-turbo")).toEqual({ kind: "absent" });
	});
});
