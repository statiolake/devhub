/**
 * A model's download, against a fake server: resumed from what arrived,
 * restarted when the server sends it all again, checked against the pin
 * before it is used, and deleted when it does not match.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	contentRangeTotal,
	downloadModel,
	ModelDownloadError,
	removeModel,
	type ModelFetcher,
} from "./modelDownload.js";
import {
	modelIsReady,
	partialPath,
	voiceModelPins,
	type VoiceModelPin,
} from "./voiceModels.js";

const MODEL = new Uint8Array(Array.from({ length: 1000 }, (_, i) => i % 251));

function pinFor(bytes: Uint8Array, overrides: Partial<VoiceModelPin> = {}) {
	return {
		id: "small",
		label: "Whisper small",
		file: "ggml-small.bin",
		url: "https://models.example/ggml-small.bin",
		sha1: createHash("sha1").update(bytes).digest("hex"),
		sha256: createHash("sha256").update(bytes).digest("hex"),
		size: "1 KB",
		minBytes: 100,
		...overrides,
	} satisfies VoiceModelPin;
}

/** A server holding `bytes`, answering ranges unless told not to; what it was asked. */
function server(
	bytes: Uint8Array,
	options: { ranges?: boolean; status?: number; cutAfter?: number } = {},
) {
	const asked: Record<string, string>[] = [];
	const fetch: ModelFetcher = (_url, init) => {
		asked.push(init.headers);
		if (options.status !== undefined)
			return Promise.resolve(new Response("no", { status: options.status }));
		const range = /^bytes=(\d+)-$/.exec(init.headers.Range ?? "");
		const from = range && options.ranges !== false ? Number(range[1]) : 0;
		const body = bytes.subarray(from);
		const cut = options.cutAfter;
		let pulls = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1;
				if (cut !== undefined && cut < body.byteLength) {
					if (pulls === 1) controller.enqueue(body.subarray(0, cut));
					else controller.error(new Error("connection reset"));
					return;
				}
				controller.enqueue(body);
				controller.close();
			},
		});
		return Promise.resolve(
			new Response(stream, {
				status: from > 0 ? 206 : 200,
				headers: {
					"content-length": String(body.byteLength),
					...(from > 0
						? {
								"content-range": `bytes ${String(from)}-${String(bytes.byteLength - 1)}/${String(bytes.byteLength)}`,
							}
						: {}),
				},
			}),
		);
	};
	return { fetch, asked };
}

let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "devhub-voice-model-"));
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

const signal = () => new AbortController().signal;

describe("a model's download", () => {
	it("downloads, checks every pinned hash, and is ready after", async () => {
		const pin = pinFor(MODEL);
		const progress: number[] = [];
		let verifying = false;
		const path = await downloadModel({
			pin,
			directory,
			fetch: server(MODEL).fetch,
			signal: signal(),
			onProgress: ({ received }) => progress.push(received),
			onVerifying: () => {
				verifying = true;
			},
		});
		expect(path).toBe(join(directory, "ggml-small.bin"));
		expect(new Uint8Array(readFileSync(path))).toEqual(MODEL);
		expect(progress.at(-1)).toBe(1000);
		expect(verifying).toBe(true);
		expect(existsSync(partialPath(directory, pin.file))).toBe(false);
		expect(modelIsReady(directory, pin)).toBe(true);
	});

	it("resumes what arrived before with a range request", async () => {
		const pin = pinFor(MODEL);
		writeFileSync(partialPath(directory, pin.file), MODEL.subarray(0, 400));
		const { fetch, asked } = server(MODEL);
		await downloadModel({ pin, directory, fetch, signal: signal() });
		expect(asked[0]).toEqual({ Range: "bytes=400-" });
		expect(modelIsReady(directory, pin)).toBe(true);
	});

	it("starts again when the server sends the whole file instead", async () => {
		const pin = pinFor(MODEL);
		writeFileSync(partialPath(directory, pin.file), new Uint8Array(400));
		await downloadModel({
			pin,
			directory,
			fetch: server(MODEL, { ranges: false }).fetch,
			signal: signal(),
		});
		expect(new Uint8Array(readFileSync(join(directory, pin.file)))).toEqual(
			MODEL,
		);
	});

	it("keeps what arrived when the connection drops, and the retry resumes it", async () => {
		const pin = pinFor(MODEL);
		await expect(
			downloadModel({
				pin,
				directory,
				fetch: server(MODEL, { cutAfter: 300 }).fetch,
				signal: signal(),
			}),
		).rejects.toThrow(/続きから再開/);
		expect(readFileSync(partialPath(directory, pin.file)).byteLength).toBe(300);
		expect(modelIsReady(directory, pin)).toBe(false);
		const { fetch, asked } = server(MODEL);
		await downloadModel({ pin, directory, fetch, signal: signal() });
		expect(asked[0]).toEqual({ Range: "bytes=300-" });
		expect(modelIsReady(directory, pin)).toBe(true);
	});

	it("deletes a file that does not hash to the pin, and never uses it", async () => {
		const pin = pinFor(MODEL);
		const wrong = MODEL.map((byte) => byte ^ 1);
		const failure = await downloadModel({
			pin,
			directory,
			fetch: server(wrong).fetch,
			signal: signal(),
		}).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(ModelDownloadError);
		expect((failure as ModelDownloadError).discarded).toBe(true);
		expect((failure as Error).message).toMatch(/ハッシュが/);
		expect(existsSync(join(directory, pin.file))).toBe(false);
		expect(existsSync(partialPath(directory, pin.file))).toBe(false);
		expect(modelIsReady(directory, pin)).toBe(false);
	});

	it("checks a pin that states only the SHA-1", async () => {
		const pin = { ...pinFor(MODEL) } as VoiceModelPin & { sha256?: string };
		delete pin.sha256;
		await downloadModel({
			pin,
			directory,
			fetch: server(MODEL).fetch,
			signal: signal(),
		});
		expect(modelIsReady(directory, pin)).toBe(true);
	});

	it("refuses a file too small to be the model", async () => {
		const small = MODEL.subarray(0, 50);
		await expect(
			downloadModel({
				pin: pinFor(small),
				directory,
				fetch: server(small).fetch,
				signal: signal(),
			}),
		).rejects.toThrow(/小さすぎます/);
	});

	it("says what the server answered when it refuses", async () => {
		await expect(
			downloadModel({
				pin: pinFor(MODEL),
				directory,
				fetch: server(MODEL, { status: 404 }).fetch,
				signal: signal(),
			}),
		).rejects.toThrow(/HTTP 404/);
	});

	it("says it could not connect when the fetch itself fails", async () => {
		await expect(
			downloadModel({
				pin: pinFor(MODEL),
				directory,
				fetch: () => Promise.reject(new TypeError("fetch failed")),
				signal: signal(),
			}),
		).rejects.toThrow(/models\.example に接続できませんでした/);
	});

	it("is not ready once the file changes after it was checked", async () => {
		const pin = pinFor(MODEL);
		await downloadModel({
			pin,
			directory,
			fetch: server(MODEL).fetch,
			signal: signal(),
		});
		writeFileSync(join(directory, pin.file), MODEL.subarray(0, 900));
		expect(modelIsReady(directory, pin)).toBe(false);
	});

	it("is not ready under a pin with another hash", async () => {
		const pin = pinFor(MODEL);
		await downloadModel({
			pin,
			directory,
			fetch: server(MODEL).fetch,
			signal: signal(),
		});
		expect(modelIsReady(directory, { ...pin, sha1: "0".repeat(40) })).toBe(
			false,
		);
	});

	it("deletes the model, its record and any part", async () => {
		const pin = pinFor(MODEL);
		await downloadModel({
			pin,
			directory,
			fetch: server(MODEL).fetch,
			signal: signal(),
		});
		writeFileSync(partialPath(directory, pin.file), "x");
		await removeModel(directory, pin);
		expect(existsSync(join(directory, pin.file))).toBe(false);
		expect(existsSync(partialPath(directory, pin.file))).toBe(false);
		expect(modelIsReady(directory, pin)).toBe(false);
	});

	it("reads the total out of a content range", () => {
		expect(contentRangeTotal("bytes 100-199/200")).toBe(200);
		expect(contentRangeTotal("bytes 100-199/*")).toBeUndefined();
		expect(contentRangeTotal(null)).toBeUndefined();
	});
});

describe("the pins product.json holds", () => {
	const product = JSON.parse(
		readFileSync(new URL("../../../product.json", import.meta.url), "utf8"),
	) as { whisperModels: unknown };

	it("pins small, the default, and large-v3-turbo, each by URL and hash", () => {
		const pins = voiceModelPins(product.whisperModels);
		expect(pins.map((pin) => pin.id)).toEqual(["small", "large-v3-turbo"]);
		expect(pins[0]).toMatchObject({
			file: "ggml-small.bin",
			// whisper.cpp's models/README.md at v1.9.4.
			sha1: "55356645c2b361a969dfd0ef2c5a50d530afd8d5",
		});
		for (const pin of pins) {
			expect(pin.url.startsWith("https://huggingface.co/")).toBe(true);
			expect(pin.url.endsWith(`/${pin.file}`)).toBe(true);
		}
	});

	it("leaves out a pin with no hash, no https, or a path for a file name", () => {
		const good = {
			label: "x",
			file: "ggml-small.bin",
			url: "https://h/x",
			sha1: "a".repeat(40),
			size: "1",
			minBytes: 1,
		};
		expect(voiceModelPins({ small: good })).toHaveLength(1);
		expect(voiceModelPins({ small: { ...good, sha1: undefined } })).toEqual([]);
		expect(voiceModelPins({ small: { ...good, url: "http://h/x" } })).toEqual(
			[],
		);
		expect(
			voiceModelPins({ small: { ...good, file: "../ggml-small.bin" } }),
		).toEqual([]);
		expect(voiceModelPins({ tiny: good })).toEqual([]);
	});
});
