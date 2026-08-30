/**
 * The Agent Surface wire contract between the App Shell page and main.
 *
 * Ported from the Tauri app's `src-tauri/src/terminal/contract.rs` (the part
 * the agent channel used) plus `src/agent/client.ts`. It intentionally carries
 * only the semantic DevHub surface key (`agent:<uuid>`) and an opaque
 * attachment handle: Herdr pane, terminal, workspace and socket identifiers
 * are adapter-private and never appear here.
 *
 * Output is a raw frame — an 8-byte header, bounded JSON metadata, then the
 * terminal bytes verbatim — so binary PTY output never becomes base64 JSON.
 * Electron's structured clone carries the `Uint8Array` as-is.
 *
 * Workstream B owns the identical contract for workspace terminals in
 * `src/ipc/terminal.ts`. The two are deliberately separate files until
 * integration: agent surfaces and PTY terminals differ in their surface-key
 * grammar and in whether resize reaches a real PTY.
 */

export const TERMINAL_PROTOCOL_VERSION = 1;
export const MAX_ATTACH_REQUEST_BYTES = 16 * 1024;
export const MAX_INPUT_BYTES = 64 * 1024;
export const MAX_OUTPUT_FRAME_BYTES = 32 * 1024;
export const MAX_OUTPUT_BUFFER_BYTES = 256 * 1024;
export const MAX_CHANNEL_FRAME_BYTES = 40 * 1024;
export const MAX_SURFACE_KEY_BYTES = 256;
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
export const MAX_TARGET_GENERATION = MAX_INPUT_SEQUENCE;
export const RESIZE_INTERVAL_MS = 16;
export const FRAME_HEADER_BYTES = 8;

export enum FrameKind {
	Started = 1,
	Output = 2,
	Exited = 3,
	Error = 4,
}

export enum TerminalErrorCode {
	InvalidRequest = "invalid_request",
	InvalidSurface = "invalid_surface",
	SurfaceUnavailable = "surface_unavailable",
	StaleTarget = "stale_target",
	WrongAttachment = "wrong_attachment",
	AttachmentLimit = "attachment_limit",
	SessionUnavailable = "session_unavailable",
	PtyUnavailable = "pty_unavailable",
	InputTooLarge = "input_too_large",
	InvalidResize = "invalid_resize",
	ChannelClosed = "channel_closed",
	Backpressure = "backpressure",
	RuntimeUnavailable = "runtime_unavailable",
	Internal = "internal",
}

const SUMMARIES: Record<TerminalErrorCode, string> = {
	[TerminalErrorCode.InvalidRequest]: "The terminal request is invalid.",
	[TerminalErrorCode.InvalidSurface]:
		"The selected terminal surface is invalid.",
	[TerminalErrorCode.SurfaceUnavailable]:
		"The selected terminal surface is unavailable.",
	[TerminalErrorCode.StaleTarget]: "The terminal target is stale.",
	[TerminalErrorCode.WrongAttachment]:
		"The terminal attachment is not owned by this view.",
	[TerminalErrorCode.AttachmentLimit]:
		"This terminal surface already has an attachment.",
	[TerminalErrorCode.SessionUnavailable]:
		"The terminal session is unavailable.",
	[TerminalErrorCode.PtyUnavailable]:
		"The terminal client could not be attached.",
	[TerminalErrorCode.InputTooLarge]:
		"Terminal input exceeded the allowed size.",
	[TerminalErrorCode.InvalidResize]: "The terminal size is invalid.",
	[TerminalErrorCode.ChannelClosed]: "The terminal view is disconnected.",
	[TerminalErrorCode.Backpressure]: "Terminal output exceeded the view buffer.",
	[TerminalErrorCode.RuntimeUnavailable]:
		"The terminal runtime is unavailable.",
	[TerminalErrorCode.Internal]:
		"The terminal runtime could not complete the request.",
};

export interface TerminalErrorBody {
	readonly code: TerminalErrorCode;
	readonly summary: string;
}

/**
 * The one error type this surface reports. It carries a stable code and a
 * fixed summary — never a provider message — and it is thrown, never swallowed.
 */
export class TerminalError extends Error {
	readonly code: TerminalErrorCode;
	readonly summary: string;

	constructor(code: TerminalErrorCode) {
		super(SUMMARIES[code]);
		this.name = "TerminalError";
		this.code = code;
		this.summary = SUMMARIES[code];
		this.stack = `TerminalError: ${SUMMARIES[code]}`;
	}

	get body(): TerminalErrorBody {
		return { code: this.code, summary: this.summary };
	}
}

export function terminalError(code: TerminalErrorCode): TerminalError {
	return new TerminalError(code);
}

export interface AttachRequest {
	readonly schemaVersion: number;
	readonly surfaceKey: string;
	/**
	 * Must be zero on attach. Main allocates the opaque attachment generation
	 * after resolving the active semantic surface.
	 */
	readonly targetGeneration: number;
	readonly cols: number;
	readonly rows: number;
	readonly pixelWidth: number;
	readonly pixelHeight: number;
}

export interface AttachReceipt {
	readonly schemaVersion: number;
	readonly attachmentId: string;
	readonly surfaceKey: string;
	readonly targetGeneration: number;
}

export interface InputRequest {
	readonly schemaVersion: number;
	readonly surfaceKey: string;
	readonly attachmentId: string;
	readonly targetGeneration: number;
	readonly inputSequence: number;
	readonly bytes: readonly number[];
}

export interface ResizeRequest {
	readonly schemaVersion: number;
	readonly surfaceKey: string;
	readonly attachmentId: string;
	readonly targetGeneration: number;
	readonly cols: number;
	readonly rows: number;
	readonly pixelWidth: number;
	readonly pixelHeight: number;
}

export interface DetachRequest {
	readonly schemaVersion: number;
	readonly surfaceKey: string;
	readonly attachmentId: string;
	readonly targetGeneration: number;
}

export interface AckRequest {
	readonly schemaVersion: number;
	readonly surfaceKey: string;
	readonly attachmentId: string;
	readonly targetGeneration: number;
	readonly sequence: number;
}

export interface PtySize {
	readonly cols: number;
	readonly rows: number;
	readonly pixelWidth: number;
	readonly pixelHeight: number;
}

export function validatePtySize(size: PtySize): PtySize {
	if (
		!Number.isInteger(size.cols) ||
		!Number.isInteger(size.rows) ||
		size.cols < MIN_COLS ||
		size.cols > MAX_COLS ||
		size.rows < MIN_ROWS ||
		size.rows > MAX_ROWS ||
		!Number.isInteger(size.pixelWidth) ||
		!Number.isInteger(size.pixelHeight) ||
		size.pixelWidth < 0 ||
		size.pixelHeight < 0 ||
		size.pixelWidth > MAX_PIXEL ||
		size.pixelHeight > MAX_PIXEL
	) {
		throw terminalError(TerminalErrorCode.InvalidResize);
	}
	return size;
}

export enum ExitReason {
	Eof = "eof",
	Detached = "detached",
	ChildExited = "childExited",
}

export type TerminalFrame =
	| {
			readonly type: "started";
			readonly schemaVersion: number;
			readonly attachmentId: string;
			readonly sequence: number;
			readonly surfaceKey: string;
			readonly targetGeneration: number;
			readonly cols: number;
			readonly rows: number;
	  }
	| {
			readonly type: "output";
			readonly schemaVersion: number;
			readonly attachmentId: string;
			readonly sequence: number;
			readonly bytes: Uint8Array;
	  }
	| {
			readonly type: "exited";
			readonly schemaVersion: number;
			readonly attachmentId: string;
			readonly sequence: number;
			readonly reason: ExitReason;
	  }
	| {
			readonly type: "error";
			readonly schemaVersion: number;
			readonly attachmentId: string;
			readonly sequence: number;
			readonly error: TerminalErrorBody;
	  };

const FRAME_KINDS: Record<TerminalFrame["type"], FrameKind> = {
	started: FrameKind.Started,
	output: FrameKind.Output,
	exited: FrameKind.Exited,
	error: FrameKind.Error,
};

/**
 * Raw framing. Every message is a complete frame, so the page can reject a
 * malformed or truncated one without retaining partial terminal data. The
 * fixed 8-byte header is followed by bounded JSON metadata, then — for an
 * Output frame only — the raw bytes.
 */
export function encodeFrame(frame: TerminalFrame): Uint8Array {
	const metadata =
		frame.type === "output"
			? {
					type: "output",
					schemaVersion: frame.schemaVersion,
					attachmentId: frame.attachmentId,
					sequence: frame.sequence,
				}
			: frame;
	const header = Buffer.from(JSON.stringify(metadata), "utf8");
	const output = frame.type === "output" ? frame.bytes : new Uint8Array(0);
	if (
		output.length > MAX_OUTPUT_FRAME_BYTES ||
		header.length > MAX_CHANNEL_FRAME_BYTES ||
		header.length + output.length + FRAME_HEADER_BYTES > MAX_CHANNEL_FRAME_BYTES
	) {
		throw terminalError(TerminalErrorCode.Backpressure);
	}
	const encoded = Buffer.alloc(
		FRAME_HEADER_BYTES + header.length + output.length,
	);
	encoded[0] = TERMINAL_PROTOCOL_VERSION;
	encoded[1] = FRAME_KINDS[frame.type];
	encoded.writeUInt32LE(header.length, 4);
	header.copy(encoded, FRAME_HEADER_BYTES);
	Buffer.from(output).copy(encoded, FRAME_HEADER_BYTES + header.length);
	return encoded;
}

/** The page's half of the framing. A malformed frame is an error, not a skip. */
export function decodeFrame(raw: Uint8Array): TerminalFrame {
	if (raw.length < FRAME_HEADER_BYTES) {
		throw terminalError(TerminalErrorCode.InvalidRequest);
	}
	const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
	if (raw[0] !== TERMINAL_PROTOCOL_VERSION) {
		throw terminalError(TerminalErrorCode.InvalidRequest);
	}
	const kind = raw[1];
	const headerBytes = view.getUint32(4, true);
	if (FRAME_HEADER_BYTES + headerBytes > raw.length) {
		throw terminalError(TerminalErrorCode.InvalidRequest);
	}
	const metadata = JSON.parse(
		new TextDecoder().decode(
			raw.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + headerBytes),
		),
	) as Record<string, unknown>;
	if (kind === FrameKind.Output) {
		return {
			type: "output",
			schemaVersion: metadata.schemaVersion as number,
			attachmentId: metadata.attachmentId as string,
			sequence: metadata.sequence as number,
			bytes: raw.subarray(FRAME_HEADER_BYTES + headerBytes),
		};
	}
	return metadata as unknown as TerminalFrame;
}

export function validateSchema(schemaVersion: number): void {
	if (schemaVersion !== TERMINAL_PROTOCOL_VERSION) {
		throw terminalError(TerminalErrorCode.InvalidRequest);
	}
}

/** `agent:<uuid v4>` and nothing else. A path or a bare id is refused. */
export function validateAgentSurfaceKey(surfaceKey: string): void {
	if (
		surfaceKey.length === 0 ||
		Buffer.byteLength(surfaceKey) > MAX_SURFACE_KEY_BYTES ||
		/[\0\s]/.test(surfaceKey) ||
		!surfaceKey.startsWith("agent:")
	) {
		throw terminalError(TerminalErrorCode.InvalidSurface);
	}
	const value = surfaceKey.slice("agent:".length);
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
			value,
		)
	) {
		throw terminalError(TerminalErrorCode.InvalidSurface);
	}
}

export function agentSurfaceKey(agentId: string): string {
	return `agent:${agentId}`;
}

export function agentIdFromSurfaceKey(surfaceKey: string): string {
	validateAgentSurfaceKey(surfaceKey);
	return surfaceKey.slice("agent:".length);
}

export function validateAttachmentId(value: string): void {
	if (value.length !== 32 || !/^[0-9a-f]{32}$/.test(value)) {
		throw terminalError(TerminalErrorCode.WrongAttachment);
	}
}

export function validateInput(bytes: readonly number[]): void {
	if (bytes.length > MAX_INPUT_BYTES) {
		throw terminalError(TerminalErrorCode.InputTooLarge);
	}
	if (bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
		throw terminalError(TerminalErrorCode.InvalidRequest);
	}
}

export function validateInputSequence(sequence: number): void {
	if (
		!Number.isInteger(sequence) ||
		sequence < 1 ||
		sequence > MAX_INPUT_SEQUENCE
	) {
		throw terminalError(TerminalErrorCode.InvalidRequest);
	}
}

/** The channel names. Requests are `invoke`/`handle`; frames are one push. */
export const AGENT_CHANNELS = {
	attach: "devhub:agent-surface-attach",
	input: "devhub:agent-surface-input",
	resize: "devhub:agent-surface-resize",
	acknowledge: "devhub:agent-surface-acknowledge",
	detach: "devhub:agent-surface-detach",
	frame: "devhub:agent-surface-frame",
} as const;

/** The surface the preload puts on `window.devhub.agent`. */
export interface AgentApi {
	attach(request: AttachRequest): Promise<AttachReceipt>;
	input(request: InputRequest): Promise<void>;
	resize(request: ResizeRequest): Promise<void>;
	acknowledge(request: AckRequest): Promise<void>;
	detach(request: DetachRequest): Promise<void>;
	/** Every frame for every attachment; the client routes by attachment id. */
	onFrame(listener: (raw: Uint8Array) => void): () => void;
}
