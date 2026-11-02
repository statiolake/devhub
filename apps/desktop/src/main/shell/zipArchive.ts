/**
 * Reading and writing the small zip archives a `.vsix` is.
 *
 * Only what a theme extension needs, and nothing trusted: an archive from the
 * network is read through its central directory with every size checked
 * before anything is inflated — an entry claiming more than the cap, an
 * archive with more entries than the cap, a name that leaves the directory
 * it is extracted into (`../`, an absolute path, a drive letter, a
 * backslash), and an entry whose inflated size is not the size it declared
 * are all refusals, never truncations. Stored (0) and deflated (8) entries
 * only; encryption, ZIP64 and multi-disk archives are refused.
 *
 * Writing is stored entries only — the archive DevHub hands VS Code's own
 * installer is a few small JSON files it has already validated.
 */

import { crc32, inflateRawSync } from "node:zlib";

export class ZipRefused extends Error {}

export interface ZipLimits {
	/** Entries in the central directory. */
	readonly maxEntries: number;
	/** One entry, inflated. */
	readonly maxEntryBytes: number;
	/** Every entry read, inflated, together. */
	readonly maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
	maxEntries: 5_000,
	maxEntryBytes: 8 * 1024 * 1024,
	maxTotalBytes: 32 * 1024 * 1024,
};

export interface ZipEntry {
	/** As the archive spells it, `/`-separated. */
	readonly name: string;
	readonly method: number;
	readonly compressedSize: number;
	readonly size: number;
	readonly crc: number;
	readonly localHeaderOffset: number;
	readonly flags: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/**
 * Whether a name stays inside the directory it is extracted into. Refused:
 * empty segments other than a trailing one, `.` and `..`, a leading `/`, a
 * backslash, a drive letter, a NUL.
 */
export function isSafeEntryName(name: string): boolean {
	if (name.length === 0 || name.length > 512) return false;
	if (name.includes("\\") || name.includes("\0")) return false;
	if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return false;
	const segments = name.replace(/\/$/, "").split("/");
	return segments.every(
		(segment) => segment.length > 0 && segment !== "." && segment !== "..",
	);
}

export class ZipArchive {
	readonly entries: readonly ZipEntry[];
	#read = 0;

	private constructor(
		private readonly data: Buffer,
		entries: readonly ZipEntry[],
		private readonly limits: ZipLimits,
	) {
		this.entries = entries;
	}

	/** Read the central directory. Throws `ZipRefused` for anything off. */
	static open(
		data: Buffer,
		limits: ZipLimits = DEFAULT_ZIP_LIMITS,
	): ZipArchive {
		if (data.length < 22) throw new ZipRefused("it is not a zip archive");
		// The end record is in the last 64 KiB + 22 bytes (the comment's room).
		const floor = Math.max(0, data.length - 0xffff - 22);
		let end = -1;
		for (let offset = data.length - 22; offset >= floor; offset -= 1) {
			if (data.readUInt32LE(offset) === EOCD_SIGNATURE) {
				end = offset;
				break;
			}
		}
		if (end < 0) throw new ZipRefused("it is not a zip archive");
		const disk = data.readUInt16LE(end + 4);
		const count = data.readUInt16LE(end + 10);
		const directorySize = data.readUInt32LE(end + 12);
		const directoryOffset = data.readUInt32LE(end + 16);
		if (disk !== 0 || count === 0xffff || directoryOffset === 0xffffffff) {
			throw new ZipRefused("it is a multi-part or ZIP64 archive");
		}
		if (count > limits.maxEntries) {
			throw new ZipRefused(
				`it has ${String(count)} entries, more than ${String(limits.maxEntries)}`,
			);
		}
		if (directoryOffset + directorySize > end) {
			throw new ZipRefused("its directory is outside the archive");
		}
		const entries: ZipEntry[] = [];
		let offset = directoryOffset;
		for (let index = 0; index < count; index += 1) {
			if (
				offset + 46 > end ||
				data.readUInt32LE(offset) !== CENTRAL_SIGNATURE
			) {
				throw new ZipRefused("its directory is damaged");
			}
			const flags = data.readUInt16LE(offset + 8);
			const method = data.readUInt16LE(offset + 10);
			const crc = data.readUInt32LE(offset + 16);
			const compressedSize = data.readUInt32LE(offset + 20);
			const size = data.readUInt32LE(offset + 24);
			const nameLength = data.readUInt16LE(offset + 28);
			const extraLength = data.readUInt16LE(offset + 30);
			const commentLength = data.readUInt16LE(offset + 32);
			const localHeaderOffset = data.readUInt32LE(offset + 42);
			const nameEnd = offset + 46 + nameLength;
			if (nameEnd > end) throw new ZipRefused("its directory is damaged");
			const name = data.toString("utf8", offset + 46, nameEnd);
			entries.push({
				name,
				method,
				compressedSize,
				size,
				crc,
				localHeaderOffset,
				flags,
			});
			offset = nameEnd + extraLength + commentLength;
		}
		return new ZipArchive(data, entries, limits);
	}

	/** The entry by its exact name, if the archive has one. */
	entry(name: string): ZipEntry | undefined {
		return this.entries.find((entry) => entry.name === name);
	}

	/** One entry's bytes, every limit and the CRC checked. */
	read(entry: ZipEntry): Buffer {
		if (!isSafeEntryName(entry.name)) {
			throw new ZipRefused(`it names a file outside itself: ${entry.name}`);
		}
		if ((entry.flags & 0x1) !== 0) {
			throw new ZipRefused(`${entry.name} is encrypted`);
		}
		if (entry.size > this.limits.maxEntryBytes) {
			throw new ZipRefused(
				`${entry.name} is ${String(entry.size)} bytes, more than ${String(this.limits.maxEntryBytes)}`,
			);
		}
		if (this.#read + entry.size > this.limits.maxTotalBytes) {
			throw new ZipRefused(
				`it holds more than ${String(this.limits.maxTotalBytes)} bytes`,
			);
		}
		const header = entry.localHeaderOffset;
		if (
			header + 30 > this.data.length ||
			this.data.readUInt32LE(header) !== LOCAL_SIGNATURE
		) {
			throw new ZipRefused(`${entry.name} is damaged`);
		}
		const start =
			header +
			30 +
			this.data.readUInt16LE(header + 26) +
			this.data.readUInt16LE(header + 28);
		const stop = start + entry.compressedSize;
		if (stop > this.data.length)
			throw new ZipRefused(`${entry.name} is damaged`);
		const raw = this.data.subarray(start, stop);
		let bytes: Buffer;
		if (entry.method === 0) {
			bytes = Buffer.from(raw);
		} else if (entry.method === 8) {
			try {
				// One byte past the declared size, so a lie about it is caught
				// without inflating a bomb to find out.
				bytes = inflateRawSync(raw, { maxOutputLength: entry.size + 1 });
			} catch {
				throw new ZipRefused(
					`${entry.name} does not inflate to the size it declares`,
				);
			}
		} else {
			throw new ZipRefused(
				`${entry.name} is compressed with method ${String(entry.method)}`,
			);
		}
		if (bytes.length !== entry.size) {
			throw new ZipRefused(`${entry.name} is not the size it declares`);
		}
		if (crc32(bytes) >>> 0 !== entry.crc >>> 0) {
			throw new ZipRefused(`${entry.name} fails its checksum`);
		}
		this.#read += bytes.length;
		return bytes;
	}
}

/** A zip of stored entries, in the order given. */
export function writeZip(
	files: readonly { readonly name: string; readonly data: Buffer }[],
): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const file of files) {
		const name = Buffer.from(file.name, "utf8");
		const crc = crc32(file.data) >>> 0;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(LOCAL_SIGNATURE, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6); // UTF-8 names
		local.writeUInt16LE(0, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(file.data.length, 18);
		local.writeUInt32LE(file.data.length, 22);
		local.writeUInt16LE(name.length, 26);
		locals.push(local, name, file.data);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(0, 10);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(file.data.length, 20);
		central.writeUInt32LE(file.data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, name);
		offset += 30 + name.length + file.data.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(EOCD_SIGNATURE, 0);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}
