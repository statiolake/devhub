/**
 * One model, downloaded and checked (`voiceModels.ts` for what is pinned).
 *
 * The download goes to `<file>.part` beside where the model will be, and
 * resumes: a `.part` left by a download that failed — the network went, the
 * Mac slept — is continued with a `Range` request, and a server that answers
 * the whole file instead (200) starts it again from nothing. When it is all
 * there it is hashed, and only a file that hashes to every hash the pin
 * states is renamed into place, with the record that says it was checked. A
 * file that does not is deleted: what arrived was not the model, and a retry
 * starts clean.
 *
 * The fetcher is injected: main gives it Electron's `net.fetch`, which goes
 * through the Mac's own proxy settings and certificates, and the tests a
 * fake. Nothing else here touches the network.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
	partialPath,
	verifiedRecord,
	verifiedRecordPath,
	type VoiceModelPin,
} from "./voiceModels.js";

/** The part of `fetch` a download uses. */
export type ModelFetcher = (
	url: string,
	init: {
		readonly headers: Record<string, string>;
		readonly signal: AbortSignal;
	},
) => Promise<Response>;

export interface DownloadProgress {
	/** Bytes of the model on disk so far, a resumed part included. */
	readonly received: number;
	readonly total: number | undefined;
}

export interface DownloadOptions {
	readonly pin: VoiceModelPin;
	readonly directory: string;
	readonly fetch: ModelFetcher;
	readonly signal: AbortSignal;
	readonly onProgress?: (progress: DownloadProgress) => void;
	/** Everything has arrived; the hash is being checked. */
	readonly onVerifying?: () => void;
}

/** A download that failed, with the sentence the person is shown. */
export class ModelDownloadError extends Error {
	constructor(
		message: string,
		/** Whether what arrived was thrown away (a bad hash), not kept to resume. */
		readonly discarded = false,
	) {
		super(message);
		this.name = "ModelDownloadError";
	}
}

/** `bytes 100-199/200` → 200, when the server said. */
export function contentRangeTotal(header: string | null): number | undefined {
	const match = header === null ? null : /\/(\d+)\s*$/.exec(header);
	return match ? Number(match[1]) : undefined;
}

/** `bytes 100-199/200` → 100. */
function contentRangeStart(header: string | null): number | undefined {
	const match = header === null ? null : /^bytes\s+(\d+)-/.exec(header);
	return match ? Number(match[1]) : undefined;
}

function contentLength(response: Response): number | undefined {
	const header = response.headers.get("content-length");
	return header === null || !/^\d+$/.test(header) ? undefined : Number(header);
}

async function sizeOf(path: string): Promise<number> {
	try {
		return (await stat(path)).size;
	} catch {
		return 0;
	}
}

/** Every hash `pin` states, of the file at `path`. */
async function hashes(
	path: string,
	pin: VoiceModelPin,
): Promise<{ sha1?: string; sha256?: string }> {
	const sha1 = pin.sha1 === undefined ? undefined : createHash("sha1");
	const sha256 = pin.sha256 === undefined ? undefined : createHash("sha256");
	for await (const chunk of createReadStream(path, {
		highWaterMark: 1 << 20,
	})) {
		sha1?.update(chunk as Buffer);
		sha256?.update(chunk as Buffer);
	}
	return {
		...(sha1 === undefined ? {} : { sha1: sha1.digest("hex") }),
		...(sha256 === undefined ? {} : { sha256: sha256.digest("hex") }),
	};
}

/** Whether `error` is the download being cancelled. */
export function isAbort(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === "AbortError" || error.name === "TimeoutError")
	);
}

/**
 * Download `pin` into `directory`, resuming a `.part` there, and check it.
 * Resolves with the model's path once it is in place and checked; rejects
 * with a `ModelDownloadError` (or the abort, when `signal` fired).
 */
export async function downloadModel(options: DownloadOptions): Promise<string> {
	const { pin, directory, signal } = options;
	await mkdir(directory, { recursive: true });
	const partial = partialPath(directory, pin.file);
	const target = join(directory, pin.file);
	// A model that was there is replaced only by a checked one.
	await rm(verifiedRecordPath(directory, pin.file), { force: true });

	let have = await sizeOf(partial);
	let response: Response;
	try {
		response = await options.fetch(pin.url, {
			headers: have > 0 ? { Range: `bytes=${String(have)}-` } : {},
			signal,
		});
	} catch (error: unknown) {
		if (isAbort(error)) throw error;
		throw new ModelDownloadError(
			`${new URL(pin.url).host} に接続できませんでした（${error instanceof Error ? error.message : String(error)}）。`,
		);
	}

	let total: number | undefined;
	let append: boolean;
	if (response.status === 206 && have > 0) {
		if (contentRangeStart(response.headers.get("content-range")) !== have) {
			await response.body?.cancel().catch(() => undefined);
			await rm(partial, { force: true });
			throw new ModelDownloadError(
				"サーバーが途中からの続きを正しく返しませんでした。もう一度試すと最初からダウンロードします。",
			);
		}
		append = true;
		total =
			contentRangeTotal(response.headers.get("content-range")) ??
			(contentLength(response) === undefined
				? undefined
				: have + contentLength(response)!);
	} else if (response.status === 416 && have > 0) {
		// Nothing left to send: the part may be the whole file. The check says.
		await response.body?.cancel().catch(() => undefined);
		append = true;
		total = have;
	} else if (response.status === 200) {
		append = false;
		have = 0;
		total = contentLength(response);
	} else {
		await response.body?.cancel().catch(() => undefined);
		throw new ModelDownloadError(
			`${new URL(pin.url).host} が HTTP ${String(response.status)} を返しました。`,
		);
	}

	let received = have;
	options.onProgress?.({ received, total });
	if (response.status !== 416) {
		if (response.body === null)
			throw new ModelDownloadError("サーバーの応答が空でした。");
		const file = await open(partial, append ? "a" : "w");
		try {
			const reader = response.body.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				await file.write(value);
				received += value.byteLength;
				options.onProgress?.({ received, total });
			}
		} catch (error: unknown) {
			if (isAbort(error) || signal.aborted) throw error;
			// What arrived is kept: the retry resumes it.
			throw new ModelDownloadError(
				`ダウンロードが途中で切れました（${error instanceof Error ? error.message : String(error)}）。再試行すると続きから再開します。`,
			);
		} finally {
			await file.close();
		}
	}

	const size = await sizeOf(partial);
	if (total !== undefined && size < total) {
		throw new ModelDownloadError(
			"ダウンロードが途中で終わりました。再試行すると続きから再開します。",
		);
	}
	if (size < pin.minBytes) {
		await rm(partial, { force: true });
		throw new ModelDownloadError(
			`届いたファイル（${String(size)} バイト）は ${pin.file} にしては小さすぎます。`,
			true,
		);
	}
	options.onVerifying?.();
	const got = await hashes(partial, pin);
	if (signal.aborted) throw signal.reason ?? new DOMException("", "AbortError");
	if (got.sha1 !== pin.sha1 || got.sha256 !== pin.sha256) {
		await rm(partial, { force: true });
		throw new ModelDownloadError(
			`届いたファイルのハッシュが ${pin.file} の固定値と一致しません。使わずに削除しました。`,
			true,
		);
	}
	await rename(partial, target);
	await writeFile(
		verifiedRecordPath(directory, pin.file),
		`${JSON.stringify(verifiedRecord(pin, await stat(target)))}\n`,
	);
	return target;
}

/** Delete `pin`'s model and anything of a download of it. */
export async function removeModel(
	directory: string,
	pin: VoiceModelPin,
): Promise<void> {
	await Promise.all(
		[
			verifiedRecordPath(directory, pin.file),
			join(directory, pin.file),
			partialPath(directory, pin.file),
		].map((path) => rm(path, { force: true })),
	);
}
