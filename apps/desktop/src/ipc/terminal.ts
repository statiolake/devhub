/**
 * The versioned terminal PTY wire contract.
 *
 * Ported from the Tauri app's `src-tauri/src/terminal/contract.rs` and the
 * generated TypeScript decoder that faced it. Both sides of the wire are here
 * because there is exactly one framing: the main process encodes, the page
 * decodes, and a single file is the only way the two cannot drift.
 *
 * The contract carries only the semantic surface key and the opaque attachment
 * handle. Workspace paths, shells, and PTY handles are main-process values and
 * stop there. Terminal output travels as raw bytes in a binary frame, never as
 * JSON or base64, so PTY output crosses the boundary once.
 *
 * Nothing here may import Electron, Node, or the DOM: the file is compiled into
 * the main process, the preload, and the page alike.
 */

import {
	FRAME_HEADER_BYTES,
	FRAME_KINDS,
	FramingFailure,
	decodeChannelFrame,
	encodeChannelFrame,
	type FrameLimits,
} from "./frame.js";

export const TERMINAL_PROTOCOL_VERSION = 1 as const;
export const MAX_ATTACH_REQUEST_BYTES = 16 * 1024;
export const MAX_INPUT_BYTES = 64 * 1024;
export const MAX_OUTPUT_FRAME_BYTES = 32 * 1024;
export const MAX_OUTPUT_BUFFER_BYTES = 256 * 1024;
export const MAX_CHANNEL_FRAME_BYTES = 40 * 1024;
export const MAX_SURFACE_KEY_BYTES = 256;
export const MAX_ATTACHMENT_ID_BYTES = 64;
export const MAX_ERROR_SUMMARY_BYTES = 256;
export const MIN_COLS = 1;
export const MAX_COLS = 500;
export const MIN_ROWS = 1;
export const MAX_ROWS = 500;
export const MAX_PIXEL = 10_000;
/**
 * Input, output, and cumulative ACK sequences cross the JavaScript Number
 * boundary and therefore share the exact safe-integer ceiling.
 */
export const MAX_INPUT_SEQUENCE = 9_007_199_254_740_991;
/** Generations travel as a Number; keep the ledger in the same exact range. */
export const MAX_TARGET_GENERATION = MAX_INPUT_SEQUENCE;
export const RESIZE_INTERVAL_MS = 16;
/** The fixed binary header: version, kind, two reserved bytes, header length. */
export const TERMINAL_FRAME_HEADER_BYTES = FRAME_HEADER_BYTES;

export const TERMINAL_FRAME_KINDS = FRAME_KINDS;

const FRAME_LIMITS: FrameLimits = {
	maxFrameBytes: MAX_CHANNEL_FRAME_BYTES,
	maxOutputBytes: MAX_OUTPUT_FRAME_BYTES,
};

export type TerminalErrorCode =
	| "invalid_request"
	| "invalid_surface"
	| "surface_unavailable"
	| "stale_target"
	| "wrong_attachment"
	| "attachment_limit"
	| "session_unavailable"
	| "pty_unavailable"
	| "input_too_large"
	| "invalid_resize"
	| "channel_closed"
	| "backpressure"
	| "runtime_unavailable"
	| "internal";

export interface TerminalError {
	readonly code: TerminalErrorCode;
	readonly summary: string;
}

export type ExitReason = "eof" | "detached" | "childExited";

const ERROR_SUMMARIES: Readonly<Record<TerminalErrorCode, string>> = {
	invalid_request: "The terminal request is invalid.",
	invalid_surface: "The selected terminal surface is invalid.",
	surface_unavailable: "The selected terminal surface is unavailable.",
	stale_target: "The terminal target is stale.",
	wrong_attachment: "The terminal attachment is not owned by this view.",
	attachment_limit: "This terminal surface already has an attachment.",
	session_unavailable: "The terminal session is unavailable.",
	pty_unavailable: "The terminal client could not be attached.",
	input_too_large: "Terminal input exceeded the allowed size.",
	invalid_resize: "The terminal size is invalid.",
	channel_closed: "The terminal view is disconnected.",
	backpressure: "Terminal output exceeded the view buffer.",
	runtime_unavailable: "The terminal runtime is unavailable.",
	internal: "The terminal runtime could not complete the request.",
};

const ERROR_CODES = new Set<string>(Object.keys(ERROR_SUMMARIES));

/**
 * Fit a summary inside the frame budget the decoder enforces.
 *
 * A search list is as long as the user's PATH, and a sentence the wire refuses
 * would turn a legible failure into an unrelated framing error — the failure
 * about the failure, which is the worst outcome of the three.
 */
function boundedSummary(summary: string): string {
	const encoder = new TextEncoder();
	if (encoder.encode(summary).byteLength <= MAX_ERROR_SUMMARY_BYTES) {
		return summary;
	}
	const ellipsis = "…";
	const budget = MAX_ERROR_SUMMARY_BYTES - encoder.encode(ellipsis).byteLength;
	let kept = "";
	let bytes = 0;
	// Whole code points, so the truncation can never split one and produce a
	// string whose byte length the decoder measures differently.
	for (const character of summary) {
		const width = encoder.encode(character).byteLength;
		if (bytes + width > budget) break;
		kept += character;
		bytes += width;
	}
	return kept + ellipsis;
}
const EXIT_REASONS = new Set<string>(["eof", "detached", "childExited"]);

/**
 * The one failure type the terminal raises.
 *
 * It is an `Error` so a rejected request keeps a stack on the way to the root
 * handler, and it carries the wire code so the page can render exactly what the
 * main process decided instead of re-deriving a reason from a message.
 */
export interface TerminalFailureOptions extends ErrorOptions {
	/**
	 * A sentence that replaces the code's stock summary on the wire.
	 *
	 * Only for a failure whose stock words leave out the whole diagnostic — a
	 * runtime that is unavailable because a *named* executable was not found in
	 * *named* directories. It is composed from DevHub's own configuration, never
	 * from provider output; see `PortFailure.detail`.
	 */
	readonly summary?: string;
}

export class TerminalFailure extends Error {
	readonly code: TerminalErrorCode;
	readonly summary: string;

	constructor(code: TerminalErrorCode, options?: TerminalFailureOptions) {
		// The wire carries only the code and its summary. The cause stays on
		// this side, where the log and the root handler can still read why.
		const summary = boundedSummary(options?.summary ?? ERROR_SUMMARIES[code]);
		super(summary, { cause: options?.cause });
		this.name = "TerminalFailure";
		this.code = code;
		this.summary = summary;
	}

	/** The wire projection: exactly the two fields an Error frame carries. */
	toWire(): TerminalError {
		return { code: this.code, summary: this.summary };
	}
}

export interface TerminalSize {
	readonly cols: number;
	readonly rows: number;
	readonly pixelWidth: number;
	readonly pixelHeight: number;
}

export interface TerminalAttachRequest extends TerminalSize {
	readonly schemaVersion: 1;
	readonly surfaceKey: string;
	/**
	 * Must be zero on attach. Main allocates the opaque attachment generation
	 * after resolving the active semantic surface.
	 */
	readonly targetGeneration: 0;
}

export interface TerminalAttachReceipt {
	readonly schemaVersion: 1;
	readonly attachmentId: string;
	readonly surfaceKey: string;
	readonly targetGeneration: number;
}

export type TerminalReceipt = TerminalAttachReceipt;

export interface TerminalInputRequest {
	readonly schemaVersion: 1;
	readonly surfaceKey: string;
	readonly attachmentId: string;
	readonly targetGeneration: number;
	readonly inputSequence: number;
	readonly bytes: readonly number[];
}

export interface TerminalResizeRequest extends TerminalSize {
	readonly schemaVersion: 1;
	readonly surfaceKey: string;
	readonly attachmentId: string;
	readonly targetGeneration: number;
}

export interface TerminalAckRequest {
	readonly schemaVersion: 1;
	readonly surfaceKey: string;
	readonly attachmentId: string;
	readonly targetGeneration: number;
	readonly sequence: number;
}

export interface TerminalDetachRequest {
	readonly schemaVersion: 1;
	readonly surfaceKey: string;
	readonly attachmentId: string;
	readonly targetGeneration: number;
}

export interface StartedFrame {
	readonly type: "started";
	readonly schemaVersion: 1;
	readonly attachmentId: string;
	readonly sequence: 0;
	readonly surfaceKey: string;
	readonly targetGeneration: number;
	readonly cols: number;
	readonly rows: number;
}

export interface OutputFrame {
	readonly type: "output";
	readonly schemaVersion: 1;
	readonly attachmentId: string;
	readonly sequence: number;
	readonly bytes: Uint8Array;
}

export interface ExitedFrame {
	readonly type: "exited";
	readonly schemaVersion: 1;
	readonly attachmentId: string;
	readonly sequence: number;
	readonly reason: ExitReason;
}

export interface ErrorFrame {
	readonly type: "error";
	readonly schemaVersion: 1;
	readonly attachmentId: string;
	readonly sequence: number;
	readonly error: TerminalError;
}

export type TerminalFrame =
	| StartedFrame
	| OutputFrame
	| ExitedFrame
	| ErrorFrame;

/**
 * Channel names.
 *
 * Requests are `invoke`/`handle`. Output frames are the one main→page push, and
 * they carry the view's channel id so a page with several mounted surfaces
 * routes each frame to exactly the surface that asked for it.
 */
export const TERMINAL_CHANNELS = {
	attach: "devhub:terminal:attach",
	input: "devhub:terminal:input",
	resize: "devhub:terminal:resize",
	acknowledge: "devhub:terminal:acknowledge",
	detach: "devhub:terminal:detach",
	frame: "devhub:terminal:frame",
} as const;

/**
 * What a terminal request replies.
 *
 * The wire code is the whole point of the contract's error type, and an
 * exception thrown across `invoke` arrives as a message with no structure. So a
 * refusal travels as a value and is turned back into a thrown failure in
 * exactly one place — the preload — which is the page's root for it.
 */
export type TerminalResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: TerminalError };

/**
 * The surface the preload puts on `window.devhub.terminal`.
 *
 * Every call is addressed by `channelId`: the page's identity for one mounted
 * terminal surface. It is what lets one page hold several surfaces at once and
 * still have each request and each frame belong to exactly one of them.
 *
 * A refusal comes back as a `TerminalResult`, not as a thrown error: a custom
 * error class does not survive the context bridge with its code intact, and the
 * code is the contract. The page's client is where a refusal becomes a throw.
 */
export interface DevhubTerminalApi {
	attach(
		channelId: string,
		request: TerminalAttachRequest,
		onFrame: (frame: unknown) => void,
	): Promise<TerminalResult<TerminalAttachReceipt>>;
	input(
		channelId: string,
		request: TerminalInputRequest,
	): Promise<TerminalResult<void>>;
	resize(
		channelId: string,
		request: TerminalResizeRequest,
	): Promise<TerminalResult<void>>;
	acknowledge(
		channelId: string,
		request: TerminalAckRequest,
	): Promise<TerminalResult<void>>;
	detach(
		channelId: string,
		request: TerminalDetachRequest,
	): Promise<TerminalResult<void>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const expected = new Set(keys);
	const actual = Object.keys(value);
	return (
		actual.length === keys.length && actual.every((key) => expected.has(key))
	);
}

function utf8Length(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

// --- Validation -----------------------------------------------------------
//
// Every validator below is the exact rule the Rust enforced, with the same
// error code, so a request rejected on one side is rejected on the other.

export function validateSchema(schemaVersion: unknown): void {
	if (schemaVersion !== TERMINAL_PROTOCOL_VERSION) {
		throw new TerminalFailure("invalid_request");
	}
}

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export const GLOBAL_TERMINAL_SURFACE_KEY = "global-terminal";
export const WORKSPACE_TERMINAL_SURFACE_PREFIX = "workspace-terminal:";

/** The surface key for a workspace's terminal, from its workspace id. */
export function workspaceTerminalSurfaceKey(workspaceId: string): string {
	return `${WORKSPACE_TERMINAL_SURFACE_PREFIX}${workspaceId}`;
}

export function validateSurfaceKey(value: unknown): string {
	if (typeof value !== "string") throw new TerminalFailure("invalid_surface");
	if (
		value.length === 0 ||
		utf8Length(value) > MAX_SURFACE_KEY_BYTES ||
		/[\s\0]/u.test(value)
	) {
		throw new TerminalFailure("invalid_surface");
	}
	const valid =
		value === GLOBAL_TERMINAL_SURFACE_KEY ||
		(value.startsWith(WORKSPACE_TERMINAL_SURFACE_PREFIX) &&
			UUID_PATTERN.test(value.slice(WORKSPACE_TERMINAL_SURFACE_PREFIX.length)));
	if (!valid) throw new TerminalFailure("invalid_surface");
	return value;
}

export function validateAttachmentId(value: unknown): string {
	if (typeof value !== "string" || !/^[0-9a-f]{32}$/u.test(value)) {
		throw new TerminalFailure("wrong_attachment");
	}
	return value;
}

function safeInteger(value: unknown, code: TerminalErrorCode): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new TerminalFailure(code);
	}
	return value;
}

export function validateSize(value: unknown): TerminalSize {
	if (!isRecord(value)) throw new TerminalFailure("invalid_resize");
	const cols = safeInteger(value.cols, "invalid_resize");
	const rows = safeInteger(value.rows, "invalid_resize");
	const pixelWidth = safeInteger(value.pixelWidth, "invalid_resize");
	const pixelHeight = safeInteger(value.pixelHeight, "invalid_resize");
	if (
		cols < MIN_COLS ||
		cols > MAX_COLS ||
		rows < MIN_ROWS ||
		rows > MAX_ROWS ||
		pixelWidth > MAX_PIXEL ||
		pixelHeight > MAX_PIXEL
	) {
		throw new TerminalFailure("invalid_resize");
	}
	return { cols, rows, pixelWidth, pixelHeight };
}

export function validateTargetGeneration(value: unknown): number {
	const generation = safeInteger(value, "wrong_attachment");
	if (generation === 0 || generation > MAX_TARGET_GENERATION) {
		throw new TerminalFailure("wrong_attachment");
	}
	return generation;
}

export function validateInputSequence(value: unknown): number {
	const sequence = safeInteger(value, "invalid_request");
	if (sequence < 1 || sequence > MAX_INPUT_SEQUENCE) {
		throw new TerminalFailure("invalid_request");
	}
	return sequence;
}

export function validateInputBytes(value: unknown): Uint8Array {
	if (!Array.isArray(value)) throw new TerminalFailure("invalid_request");
	if (value.length > MAX_INPUT_BYTES) {
		throw new TerminalFailure("input_too_large");
	}
	const bytes = new Uint8Array(value.length);
	for (const [index, byte] of value.entries()) {
		if (
			typeof byte !== "number" ||
			!Number.isInteger(byte) ||
			byte < 0 ||
			byte > 255
		) {
			throw new TerminalFailure("invalid_request");
		}
		bytes[index] = byte;
	}
	return bytes;
}

export function validateAttachRequest(value: unknown): TerminalAttachRequest {
	if (!isRecord(value)) throw new TerminalFailure("invalid_request");
	if (
		!exactKeys(value, [
			"schemaVersion",
			"surfaceKey",
			"targetGeneration",
			"cols",
			"rows",
			"pixelWidth",
			"pixelHeight",
		])
	) {
		throw new TerminalFailure("invalid_request");
	}
	validateSchema(value.schemaVersion);
	const surfaceKey = validateSurfaceKey(value.surfaceKey);
	// Attach has no caller-selected capability generation. Main allocates the
	// generation only after resolving the current immutable surface.
	if (value.targetGeneration !== 0) {
		throw new TerminalFailure("invalid_request");
	}
	const size = validateSize(value);
	if (surfaceKey.length + 64 > MAX_ATTACH_REQUEST_BYTES) {
		throw new TerminalFailure("invalid_request");
	}
	return {
		schemaVersion: TERMINAL_PROTOCOL_VERSION,
		surfaceKey,
		targetGeneration: 0,
		...size,
	};
}

/** The identity every non-attach request must carry, validated as a unit. */
export interface AttachmentIdentity {
	readonly surfaceKey: string;
	readonly attachmentId: string;
	readonly targetGeneration: number;
}

function validateIdentity(value: Record<string, unknown>): AttachmentIdentity {
	validateSchema(value.schemaVersion);
	return {
		surfaceKey: validateSurfaceKey(value.surfaceKey),
		attachmentId: validateAttachmentId(value.attachmentId),
		targetGeneration: validateTargetGeneration(value.targetGeneration),
	};
}

export interface ValidatedInput extends AttachmentIdentity {
	readonly inputSequence: number;
	readonly bytes: Uint8Array;
}

export function validateInputRequest(value: unknown): ValidatedInput {
	if (
		!isRecord(value) ||
		!exactKeys(value, [
			"schemaVersion",
			"surfaceKey",
			"attachmentId",
			"targetGeneration",
			"inputSequence",
			"bytes",
		])
	) {
		throw new TerminalFailure("invalid_request");
	}
	return {
		...validateIdentity(value),
		inputSequence: validateInputSequence(value.inputSequence),
		bytes: validateInputBytes(value.bytes),
	};
}

export interface ValidatedResize extends AttachmentIdentity {
	readonly size: TerminalSize;
}

export function validateResizeRequest(value: unknown): ValidatedResize {
	if (
		!isRecord(value) ||
		!exactKeys(value, [
			"schemaVersion",
			"surfaceKey",
			"attachmentId",
			"targetGeneration",
			"cols",
			"rows",
			"pixelWidth",
			"pixelHeight",
		])
	) {
		throw new TerminalFailure("invalid_request");
	}
	return { ...validateIdentity(value), size: validateSize(value) };
}

export interface ValidatedAck extends AttachmentIdentity {
	readonly sequence: number;
}

export function validateAckRequest(value: unknown): ValidatedAck {
	if (
		!isRecord(value) ||
		!exactKeys(value, [
			"schemaVersion",
			"surfaceKey",
			"attachmentId",
			"targetGeneration",
			"sequence",
		])
	) {
		throw new TerminalFailure("invalid_request");
	}
	return {
		...validateIdentity(value),
		sequence: validateInputSequence(value.sequence),
	};
}

export function validateDetachRequest(value: unknown): AttachmentIdentity {
	if (
		!isRecord(value) ||
		!exactKeys(value, [
			"schemaVersion",
			"surfaceKey",
			"attachmentId",
			"targetGeneration",
		])
	) {
		throw new TerminalFailure("invalid_request");
	}
	return validateIdentity(value);
}

// --- Framing --------------------------------------------------------------

/**
 * Raw frame encoding. Every message is a complete frame, so the page can reject
 * a malformed or truncated frame without retaining partial PTY data. The fixed
 * header is JSON metadata (bounded by `MAX_CHANNEL_FRAME_BYTES`) followed by
 * raw output bytes, and only an Output frame has any.
 */
export function encodeTerminalFrame(frame: TerminalFrame): Uint8Array {
	const metadata: Record<string, unknown> =
		frame.type === "output"
			? {
					type: "output",
					schemaVersion: frame.schemaVersion,
					attachmentId: frame.attachmentId,
					sequence: frame.sequence,
				}
			: { ...frame };
	try {
		return encodeChannelFrame(
			TERMINAL_PROTOCOL_VERSION,
			TERMINAL_FRAME_KINDS[frame.type],
			metadata,
			frame.type === "output" ? frame.bytes : new Uint8Array(0),
			FRAME_LIMITS,
		);
	} catch (failure) {
		// A frame too large to send is back-pressure in this channel's algebra:
		// the sender must slow down, not retry the same bytes.
		if (failure instanceof FramingFailure) {
			throw new TerminalFailure("backpressure");
		}
		throw failure;
	}
}

function frameBytes(value: unknown): Uint8Array {
	if (value instanceof Uint8Array) return value;
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	throw new Error("terminal frame must be raw bytes");
}

function boundedString(value: unknown, maxBytes: number, name: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`invalid ${name}`);
	}
	if (utf8Length(value) > maxBytes) throw new Error(`${name} is too long`);
	return value;
}

function frameSequenceOf(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error("invalid sequence");
	}
	if (value > MAX_INPUT_SEQUENCE) throw new Error("sequence is too large");
	return value;
}

function parseFrameError(value: unknown): TerminalError {
	if (!isRecord(value) || !exactKeys(value, ["code", "summary"])) {
		throw new Error("invalid terminal error");
	}
	if (typeof value.code !== "string" || !ERROR_CODES.has(value.code)) {
		throw new Error("invalid terminal error code");
	}
	return {
		code: value.code as TerminalErrorCode,
		summary: boundedString(
			value.summary,
			MAX_ERROR_SUMMARY_BYTES,
			"error summary",
		),
	};
}

/** Decode exactly one raw frame; malformed or truncated frames fail closed. */
export function decodeTerminalFrame(value: unknown): TerminalFrame {
	let raw;
	try {
		raw = decodeChannelFrame(
			TERMINAL_PROTOCOL_VERSION,
			frameBytes(value),
			FRAME_LIMITS,
		);
	} catch (failure) {
		if (failure instanceof FramingFailure) {
			throw new Error(`terminal ${failure.message}`);
		}
		throw failure;
	}
	const { kind, metadata: header, payload } = raw;
	if (!isRecord(header) || typeof header.type !== "string") {
		throw new Error("terminal frame metadata is invalid");
	}
	if (header.schemaVersion !== TERMINAL_PROTOCOL_VERSION) {
		throw new Error("invalid schema version");
	}
	const attachmentId = boundedString(
		header.attachmentId,
		MAX_ATTACHMENT_ID_BYTES,
		"attachment id",
	);
	if (!/^[0-9a-f]{32}$/u.test(attachmentId)) {
		throw new Error("invalid attachment id");
	}
	const sequence = frameSequenceOf(header.sequence);

	if (header.type === "started") {
		if (
			kind !== TERMINAL_FRAME_KINDS.started ||
			payload.byteLength !== 0 ||
			!exactKeys(header, [
				"type",
				"schemaVersion",
				"attachmentId",
				"sequence",
				"surfaceKey",
				"targetGeneration",
				"cols",
				"rows",
			])
		) {
			throw new Error("started frame is invalid");
		}
		const generation = header.targetGeneration;
		if (
			typeof generation !== "number" ||
			!Number.isSafeInteger(generation) ||
			generation <= 0 ||
			generation > MAX_TARGET_GENERATION ||
			sequence !== 0
		) {
			throw new Error("started frame sequence is invalid");
		}
		const size = validateSize({
			cols: header.cols,
			rows: header.rows,
			pixelWidth: 0,
			pixelHeight: 0,
		});
		let surfaceKey: string;
		try {
			surfaceKey = validateSurfaceKey(header.surfaceKey);
		} catch {
			// The frame decoder speaks one failure language; the wire code
			// belongs to a request's rejection, not to a malformed frame.
			throw new Error("invalid surface key");
		}
		return {
			type: "started",
			schemaVersion: TERMINAL_PROTOCOL_VERSION,
			attachmentId,
			sequence: 0,
			surfaceKey,
			targetGeneration: generation,
			cols: size.cols,
			rows: size.rows,
		};
	}
	if (header.type === "output") {
		if (
			kind !== TERMINAL_FRAME_KINDS.output ||
			!exactKeys(header, ["type", "schemaVersion", "attachmentId", "sequence"])
		) {
			throw new Error("output frame is invalid");
		}
		if (
			payload.byteLength === 0 ||
			payload.byteLength > MAX_OUTPUT_FRAME_BYTES
		) {
			throw new Error("output frame bytes are invalid");
		}
		return {
			type: "output",
			schemaVersion: TERMINAL_PROTOCOL_VERSION,
			attachmentId,
			sequence,
			bytes: new Uint8Array(payload),
		};
	}
	if (header.type === "exited") {
		if (
			kind !== TERMINAL_FRAME_KINDS.exited ||
			payload.byteLength !== 0 ||
			!exactKeys(header, [
				"type",
				"schemaVersion",
				"attachmentId",
				"sequence",
				"reason",
			])
		) {
			throw new Error("exited frame is invalid");
		}
		if (typeof header.reason !== "string" || !EXIT_REASONS.has(header.reason)) {
			throw new Error("exit reason is invalid");
		}
		return {
			type: "exited",
			schemaVersion: TERMINAL_PROTOCOL_VERSION,
			attachmentId,
			sequence,
			reason: header.reason as ExitReason,
		};
	}
	if (header.type === "error") {
		if (
			kind !== TERMINAL_FRAME_KINDS.error ||
			payload.byteLength !== 0 ||
			!exactKeys(header, [
				"type",
				"schemaVersion",
				"attachmentId",
				"sequence",
				"error",
			])
		) {
			throw new Error("error frame is invalid");
		}
		return {
			type: "error",
			schemaVersion: TERMINAL_PROTOCOL_VERSION,
			attachmentId,
			sequence,
			error: parseFrameError(header.error),
		};
	}
	throw new Error("unknown terminal frame type");
}

/** Enforce one attachment identity and a contiguous sequence after decoding. */
export class TerminalFrameDecoder {
	private attachment?: string;
	private expectedSequence = 0;
	private started = false;
	private terminal = false;

	get attachmentId(): string | undefined {
		return this.attachment;
	}

	push(value: unknown): TerminalFrame {
		if (this.terminal) throw new Error("terminal frame arrived after exit");
		const frame = decodeTerminalFrame(value);
		if (this.attachment === undefined) this.attachment = frame.attachmentId;
		if (frame.attachmentId !== this.attachment) {
			throw new Error("attachment identity changed");
		}
		if (frame.type === "started") {
			if (this.started || this.expectedSequence !== 0) {
				throw new Error("duplicate started frame");
			}
			this.started = true;
			return frame;
		}
		if (
			frame.type === "error" &&
			!this.started &&
			this.expectedSequence === 0 &&
			frame.sequence === 0
		) {
			this.expectedSequence = frame.sequence;
			this.terminal = true;
			return frame;
		}
		if (frame.type === "output" && !this.started) {
			throw new Error("output arrived before started frame");
		}
		const expected = this.expectedSequence + 1;
		if (frame.sequence !== expected) {
			throw new Error("terminal frame sequence is not contiguous");
		}
		this.expectedSequence = frame.sequence;
		if (frame.type === "exited" || frame.type === "error") {
			this.terminal = true;
		}
		return frame;
	}
}
