/**
 * The speech models DevHub may download, and where they are kept.
 *
 * Voice input is off until the person turns it on (`[voice] enabled`), and
 * the model it reads is not in the app: the first time it is turned on,
 * DevHub says what it is about to download and downloads it only on yes
 * (`voiceSetup.ts`). This is the one thing DevHub downloads while it runs
 * (`docs/bundled-binaries.md`), so it is held to what the build holds its
 * own downloads to: the URL and the hash are pinned in `product.json`
 * (`whisperModels`), and a file that does not hash to the pin is deleted,
 * not used.
 *
 * The hash is the SHA-1 whisper.cpp's `models/README.md` publishes for each
 * model, the one upstream states; a pin may say `sha256` as well (or
 * instead), and every hash a pin states is checked.
 *
 * Models live in `<userData>/devhub/whisper/`, one file each, beside a
 * record of the check (`<file>.verified.json`: the hash it matched, its size
 * and modification time). A model is ready when its file is the one that was
 * checked — the record is read at launch instead of hashing half a gigabyte
 * again — and a file that changed since is not.
 */

import { readFileSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";

import {
	isVoiceModelId,
	VOICE_MODEL_IDS,
	type VoiceModelId,
} from "../../ipc/voice.js";

/** One model as `product.json` pins it. */
export interface VoiceModelPin {
	readonly id: VoiceModelId;
	readonly label: string;
	/** A plain file name: `ggml-small.bin`. */
	readonly file: string;
	readonly url: string;
	readonly sha1?: string;
	readonly sha256?: string;
	/** As upstream states it, for the confirmation: `466 MiB`. */
	readonly size: string;
	/** Anything smaller is not this model, whatever it hashes to. */
	readonly minBytes: number;
}

/** The host a pin downloads from, as the confirmation names it. */
export function hostOf(pin: VoiceModelPin): string {
	return new URL(pin.url).host;
}

const HEX = (length: number) => new RegExp(`^[0-9a-f]{${String(length)}}$`);

/**
 * The models `product.json` pins, in `VOICE_MODEL_IDS` order; a pin that is
 * not well formed — no https URL, no hash, a file name with a path in it —
 * is left out rather than downloaded.
 */
export function voiceModelPins(whisperModels: unknown): VoiceModelPin[] {
	if (typeof whisperModels !== "object" || whisperModels === null) return [];
	const table = whisperModels as Record<string, unknown>;
	const pins: VoiceModelPin[] = [];
	for (const id of VOICE_MODEL_IDS) {
		const pin = pinOf(id, table[id]);
		if (pin !== undefined) pins.push(pin);
	}
	return pins;
}

function pinOf(id: string, value: unknown): VoiceModelPin | undefined {
	if (!isVoiceModelId(id) || typeof value !== "object" || value === null)
		return undefined;
	const raw = value as Record<string, unknown>;
	const text = (key: string) =>
		typeof raw[key] === "string" ? (raw[key] as string) : undefined;
	const label = text("label");
	const file = text("file");
	const url = text("url");
	const size = text("size");
	const sha1 = text("sha1");
	const sha256 = text("sha256");
	const minBytes = raw["minBytes"];
	if (
		label === undefined ||
		file === undefined ||
		url === undefined ||
		size === undefined ||
		typeof minBytes !== "number" ||
		!/^[A-Za-z0-9._-]+\.bin$/.test(file) ||
		!url.startsWith("https://") ||
		(sha1 === undefined && sha256 === undefined) ||
		(sha1 !== undefined && !HEX(40).test(sha1)) ||
		(sha256 !== undefined && !HEX(64).test(sha256))
	)
		return undefined;
	return {
		id,
		label,
		file,
		url,
		size,
		minBytes,
		...(sha1 === undefined ? {} : { sha1 }),
		...(sha256 === undefined ? {} : { sha256 }),
	};
}

/** `<userData>/devhub/whisper`: where downloaded models are kept. */
export function voiceModelDirectory(userDataPath: string): string {
	return join(userDataPath, "devhub", "whisper");
}

/** What `<file>.verified.json` says. */
export interface VerifiedRecord {
	readonly sha1?: string;
	readonly sha256?: string;
	readonly size: number;
	readonly mtimeMs: number;
}

export function verifiedRecordPath(directory: string, file: string): string {
	return join(directory, `${file}.verified.json`);
}

export function partialPath(directory: string, file: string): string {
	return join(directory, `${file}.part`);
}

/** The record for `stats`, as it is written once the hash has matched. */
export function verifiedRecord(
	pin: VoiceModelPin,
	stats: Pick<Stats, "size" | "mtimeMs">,
): VerifiedRecord {
	return {
		...(pin.sha1 === undefined ? {} : { sha1: pin.sha1 }),
		...(pin.sha256 === undefined ? {} : { sha256: pin.sha256 }),
		size: stats.size,
		mtimeMs: stats.mtimeMs,
	};
}

/**
 * Whether `pin`'s model is in `directory` as it was when it was checked:
 * the file's size and time are the record's, and the record names the
 * hashes this pin states. A pin that changes (a new hash in a new DevHub)
 * makes the old file not ready, and it is downloaded again on yes.
 */
export function modelIsReady(directory: string, pin: VoiceModelPin): boolean {
	try {
		const stats = statSync(join(directory, pin.file));
		const record = JSON.parse(
			readFileSync(verifiedRecordPath(directory, pin.file), "utf8"),
		) as Partial<VerifiedRecord>;
		return (
			stats.isFile() &&
			record.size === stats.size &&
			record.mtimeMs === stats.mtimeMs &&
			record.sha1 === pin.sha1 &&
			record.sha256 === pin.sha256
		);
	} catch {
		return false;
	}
}

/** Whether anything of `pin`'s is in `directory`: the model, or part of one. */
export function modelHasFiles(directory: string, pin: VoiceModelPin): boolean {
	for (const path of [
		join(directory, pin.file),
		partialPath(directory, pin.file),
	]) {
		try {
			statSync(path);
			return true;
		} catch {
			// Not there.
		}
	}
	return false;
}
