/**
 * Just enough MessagePack for Neovim's RPC.
 *
 * Neovim speaks msgpack-rpc on its `--listen` socket (`:help rpc`), and the
 * managed Neovim server (`managedNeovim.ts`) is the one place DevHub talks to
 * it. A dependency for this would be a package to pin, audit and bundle for a
 * few dozen lines; the format is small and stable, so it is written here and
 * tested against the specification's own byte layouts.
 *
 * What it encodes: `null`/`undefined` (nil), booleans, integers (as the
 * smallest int/uint that holds them), other numbers (float64), strings
 * (UTF-8 str), `Uint8Array` (bin), arrays, and plain objects (maps with
 * string keys). What it decodes: all of that, float32, maps with any keys
 * (into a plain object, keys stringified), and ext — which is how Neovim
 * sends a Buffer, Window or Tabpage handle — as `MsgpackExt`.
 *
 * Integers beyond 2^53 are refused rather than rounded: nothing DevHub sends
 * or asks for is that large, and a silently different number is worse than
 * a failure.
 */

/** An ext value as it arrived: Neovim's handles are these (`:help api-types`). */
export class MsgpackExt {
	constructor(
		readonly type: number,
		readonly data: Uint8Array,
	) {}
}

/** The buffer ended part way through a value: wait for more bytes. */
export class MsgpackIncomplete extends Error {
	constructor() {
		super("msgpack: the value is not complete yet");
		this.name = "MsgpackIncomplete";
	}
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Encode one value. */
export function encode(value: unknown): Uint8Array {
	const parts: Uint8Array[] = [];
	write(value, parts);
	let length = 0;
	for (const part of parts) length += part.byteLength;
	const out = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

function bytes(...values: number[]): Uint8Array {
	return Uint8Array.from(values);
}

function header(prefix: number, size: number, length: number): Uint8Array {
	const view = new DataView(new ArrayBuffer(1 + size));
	view.setUint8(0, prefix);
	if (size === 1) view.setUint8(1, length);
	else if (size === 2) view.setUint16(1, length);
	else view.setUint32(1, length);
	return new Uint8Array(view.buffer);
}

function writeInteger(value: number, parts: Uint8Array[]): void {
	if (!Number.isSafeInteger(value)) {
		throw new RangeError(`msgpack: ${String(value)} is not a safe integer`);
	}
	if (value >= 0) {
		if (value < 0x80) parts.push(bytes(value));
		else if (value <= 0xff) parts.push(bytes(0xcc, value));
		else if (value <= 0xffff) parts.push(header(0xcd, 2, value));
		else if (value <= 0xffffffff) parts.push(header(0xce, 4, value));
		else {
			const view = new DataView(new ArrayBuffer(9));
			view.setUint8(0, 0xcf);
			view.setBigUint64(1, BigInt(value));
			parts.push(new Uint8Array(view.buffer));
		}
		return;
	}
	if (value >= -32) parts.push(bytes(value & 0xff));
	else if (value >= -0x80) parts.push(bytes(0xd0, value & 0xff));
	else if (value >= -0x8000) {
		const view = new DataView(new ArrayBuffer(3));
		view.setUint8(0, 0xd1);
		view.setInt16(1, value);
		parts.push(new Uint8Array(view.buffer));
	} else if (value >= -0x80000000) {
		const view = new DataView(new ArrayBuffer(5));
		view.setUint8(0, 0xd2);
		view.setInt32(1, value);
		parts.push(new Uint8Array(view.buffer));
	} else {
		const view = new DataView(new ArrayBuffer(9));
		view.setUint8(0, 0xd3);
		view.setBigInt64(1, BigInt(value));
		parts.push(new Uint8Array(view.buffer));
	}
}

function writeLength(
	length: number,
	fix: { readonly prefix: number; readonly max: number } | undefined,
	prefixes: readonly [number | undefined, number, number],
	parts: Uint8Array[],
): void {
	if (fix !== undefined && length <= fix.max) {
		parts.push(bytes(fix.prefix | length));
	} else if (prefixes[0] !== undefined && length <= 0xff) {
		parts.push(header(prefixes[0], 1, length));
	} else if (length <= 0xffff) {
		parts.push(header(prefixes[1], 2, length));
	} else {
		parts.push(header(prefixes[2], 4, length));
	}
}

function write(value: unknown, parts: Uint8Array[]): void {
	if (value === null || value === undefined) {
		parts.push(bytes(0xc0));
		return;
	}
	if (typeof value === "boolean") {
		parts.push(bytes(value ? 0xc3 : 0xc2));
		return;
	}
	if (typeof value === "number") {
		if (Number.isInteger(value)) {
			writeInteger(value, parts);
			return;
		}
		const view = new DataView(new ArrayBuffer(9));
		view.setUint8(0, 0xcb);
		view.setFloat64(1, value);
		parts.push(new Uint8Array(view.buffer));
		return;
	}
	if (typeof value === "string") {
		const utf8 = encoder.encode(value);
		writeLength(
			utf8.byteLength,
			{ prefix: 0xa0, max: 31 },
			[0xd9, 0xda, 0xdb],
			parts,
		);
		parts.push(utf8);
		return;
	}
	if (value instanceof Uint8Array) {
		writeLength(value.byteLength, undefined, [0xc4, 0xc5, 0xc6], parts);
		parts.push(value);
		return;
	}
	if (Array.isArray(value)) {
		writeLength(
			value.length,
			{ prefix: 0x90, max: 15 },
			[undefined, 0xdc, 0xdd],
			parts,
		);
		for (const item of value) write(item, parts);
		return;
	}
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).filter(
			([, item]) => item !== undefined,
		);
		writeLength(
			entries.length,
			{ prefix: 0x80, max: 15 },
			[undefined, 0xde, 0xdf],
			parts,
		);
		for (const [key, item] of entries) {
			write(key, parts);
			write(item, parts);
		}
		return;
	}
	throw new TypeError(`msgpack: cannot encode a ${typeof value}`);
}

/**
 * Decode one value from the front of `buffer`. Answers the value and how many
 * bytes it took; throws `MsgpackIncomplete` when the buffer ends inside it,
 * which a stream reader answers by waiting for more.
 */
export function decode(buffer: Uint8Array): {
	readonly value: unknown;
	readonly length: number;
} {
	const reader = new Reader(buffer);
	const value = reader.value();
	return { value, length: reader.offset };
}

class Reader {
	offset = 0;
	private readonly view: DataView;

	constructor(private readonly buffer: Uint8Array) {
		this.view = new DataView(
			buffer.buffer,
			buffer.byteOffset,
			buffer.byteLength,
		);
	}

	private need(count: number): void {
		if (this.offset + count > this.buffer.byteLength) {
			throw new MsgpackIncomplete();
		}
	}

	private u8(): number {
		this.need(1);
		const value = this.view.getUint8(this.offset);
		this.offset += 1;
		return value;
	}

	private u16(): number {
		this.need(2);
		const value = this.view.getUint16(this.offset);
		this.offset += 2;
		return value;
	}

	private u32(): number {
		this.need(4);
		const value = this.view.getUint32(this.offset);
		this.offset += 4;
		return value;
	}

	private take(count: number): Uint8Array {
		this.need(count);
		const slice = this.buffer.slice(this.offset, this.offset + count);
		this.offset += count;
		return slice;
	}

	private safe(value: bigint): number {
		const number = Number(value);
		if (!Number.isSafeInteger(number)) {
			throw new RangeError(
				`msgpack: ${value.toString()} is not a safe integer`,
			);
		}
		return number;
	}

	private str(length: number): string {
		return decoder.decode(this.take(length));
	}

	private array(length: number): unknown[] {
		const items: unknown[] = [];
		for (let index = 0; index < length; index += 1) items.push(this.value());
		return items;
	}

	private map(length: number): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		for (let index = 0; index < length; index += 1) {
			const key = this.value();
			out[typeof key === "string" ? key : String(key)] = this.value();
		}
		return out;
	}

	private ext(length: number): MsgpackExt {
		this.need(1);
		const type = this.view.getInt8(this.offset);
		this.offset += 1;
		return new MsgpackExt(type, this.take(length));
	}

	value(): unknown {
		const prefix = this.u8();
		if (prefix <= 0x7f) return prefix;
		if (prefix >= 0xe0) return prefix - 0x100;
		if ((prefix & 0xf0) === 0x80) return this.map(prefix & 0x0f);
		if ((prefix & 0xf0) === 0x90) return this.array(prefix & 0x0f);
		if ((prefix & 0xe0) === 0xa0) return this.str(prefix & 0x1f);
		switch (prefix) {
			case 0xc0:
				return null;
			case 0xc2:
				return false;
			case 0xc3:
				return true;
			case 0xc4:
				return this.take(this.u8());
			case 0xc5:
				return this.take(this.u16());
			case 0xc6:
				return this.take(this.u32());
			case 0xc7:
				return this.ext(this.u8());
			case 0xc8:
				return this.ext(this.u16());
			case 0xc9:
				return this.ext(this.u32());
			case 0xca: {
				this.need(4);
				const value = this.view.getFloat32(this.offset);
				this.offset += 4;
				return value;
			}
			case 0xcb: {
				this.need(8);
				const value = this.view.getFloat64(this.offset);
				this.offset += 8;
				return value;
			}
			case 0xcc:
				return this.u8();
			case 0xcd:
				return this.u16();
			case 0xce:
				return this.u32();
			case 0xcf: {
				this.need(8);
				const value = this.view.getBigUint64(this.offset);
				this.offset += 8;
				return this.safe(value);
			}
			case 0xd0: {
				this.need(1);
				const value = this.view.getInt8(this.offset);
				this.offset += 1;
				return value;
			}
			case 0xd1: {
				this.need(2);
				const value = this.view.getInt16(this.offset);
				this.offset += 2;
				return value;
			}
			case 0xd2: {
				this.need(4);
				const value = this.view.getInt32(this.offset);
				this.offset += 4;
				return value;
			}
			case 0xd3: {
				this.need(8);
				const value = this.view.getBigInt64(this.offset);
				this.offset += 8;
				return this.safe(value);
			}
			case 0xd4:
				return this.ext(1);
			case 0xd5:
				return this.ext(2);
			case 0xd6:
				return this.ext(4);
			case 0xd7:
				return this.ext(8);
			case 0xd8:
				return this.ext(16);
			case 0xd9:
				return this.str(this.u8());
			case 0xda:
				return this.str(this.u16());
			case 0xdb:
				return this.str(this.u32());
			case 0xdc:
				return this.array(this.u16());
			case 0xdd:
				return this.array(this.u32());
			case 0xde:
				return this.map(this.u16());
			case 0xdf:
				return this.map(this.u32());
			default:
				throw new RangeError(
					`msgpack: 0x${prefix.toString(16)} is not a type byte`,
				);
		}
	}
}
