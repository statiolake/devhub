/**
 * The channel framing, once.
 *
 * A terminal surface and an Agent surface carry different messages, but they
 * carry them the same way: a fixed 8-byte header, bounded JSON metadata, and —
 * for an output frame only — the raw bytes after it. That envelope was written
 * twice, and the copies had already drifted apart in how strictly they checked
 * what arrived, which is the failure mode a duplicated parser always has: the
 * lenient one is the one an attacker or a bug reaches.
 *
 * So the envelope lives here and is strict. What the metadata has to *say* is
 * still each channel's own business, because that genuinely differs; only the
 * bytes around it are shared.
 *
 *     0  protocol version
 *     1  frame kind
 *     2  reserved, zero
 *     3  reserved, zero
 *   4-7  metadata length, little endian
 */

export const FRAME_HEADER_BYTES = 8;

/** The frame kinds both channels use, with the same numbers on both. */
export const FRAME_KINDS = {
	started: 1,
	output: 2,
	exited: 3,
	error: 4,
} as const;

export type FrameKindName = keyof typeof FRAME_KINDS;

/**
 * Why a frame could not be built or read.
 *
 * `too_large` is a back-pressure decision — the sender must not send it — and
 * `malformed` means the bytes are not a frame. The two channels turn these
 * into their own error algebras, which is the only reason this is a distinct
 * type rather than a message.
 */
export type FramingFailureReason = "too_large" | "malformed";

export class FramingFailure extends Error {
	readonly reason: FramingFailureReason;

	constructor(reason: FramingFailureReason, detail: string) {
		super(detail);
		this.name = "FramingFailure";
		this.reason = reason;
	}
}

export interface FrameLimits {
	/** The largest a whole frame may be, header included. */
	readonly maxFrameBytes: number;
	/** The largest payload an output frame may carry. */
	readonly maxOutputBytes: number;
}

export interface RawFrame {
	readonly kind: number;
	/** The parsed metadata. Its shape is the channel's to check. */
	readonly metadata: unknown;
	/** Empty for every kind but output. */
	readonly payload: Uint8Array;
}

export function encodeChannelFrame(
	protocolVersion: number,
	kind: number,
	metadata: unknown,
	payload: Uint8Array,
	limits: FrameLimits,
): Uint8Array {
	const header = new TextEncoder().encode(JSON.stringify(metadata));
	if (
		payload.byteLength > limits.maxOutputBytes ||
		header.byteLength > limits.maxFrameBytes ||
		header.byteLength + payload.byteLength + FRAME_HEADER_BYTES >
			limits.maxFrameBytes
	) {
		throw new FramingFailure("too_large", "frame exceeds the channel bound");
	}
	const encoded = new Uint8Array(
		FRAME_HEADER_BYTES + header.byteLength + payload.byteLength,
	);
	encoded[0] = protocolVersion;
	encoded[1] = kind;
	encoded[2] = 0;
	encoded[3] = 0;
	new DataView(encoded.buffer).setUint32(4, header.byteLength, true);
	encoded.set(header, FRAME_HEADER_BYTES);
	encoded.set(payload, FRAME_HEADER_BYTES + header.byteLength);
	return encoded;
}

/**
 * Read one whole frame. A truncated or malformed one fails closed.
 *
 * The metadata is returned parsed but unexamined: a channel that accepted a
 * frame whose envelope was right and whose contents were not would be exactly
 * the leniency this module exists to remove, so every caller validates.
 */
export function decodeChannelFrame(
	protocolVersion: number,
	bytes: Uint8Array,
	limits: FrameLimits,
): RawFrame {
	if (
		bytes.byteLength < FRAME_HEADER_BYTES ||
		bytes.byteLength > limits.maxFrameBytes
	) {
		throw new FramingFailure("malformed", "frame length is invalid");
	}
	if (bytes[0] !== protocolVersion || bytes[2] !== 0 || bytes[3] !== 0) {
		throw new FramingFailure("malformed", "frame header is invalid");
	}
	const headerLength = new DataView(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	).getUint32(4, true);
	if (
		headerLength > limits.maxFrameBytes - FRAME_HEADER_BYTES ||
		headerLength > bytes.byteLength - FRAME_HEADER_BYTES
	) {
		throw new FramingFailure("malformed", "frame header length is invalid");
	}
	let metadata: unknown;
	try {
		metadata = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(
				bytes.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + headerLength),
			),
		);
	} catch {
		// Not a swallow: metadata that is not valid UTF-8 JSON has exactly one
		// meaning, and the caller is told it as its own failure.
		throw new FramingFailure("malformed", "frame metadata is invalid");
	}
	return {
		kind: bytes[1] ?? 0,
		metadata,
		payload: bytes.subarray(FRAME_HEADER_BYTES + headerLength),
	};
}
