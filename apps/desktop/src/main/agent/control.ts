/**
 * Private Herdr terminal-control client.
 *
 * Herdr exposes terminal ownership on a second binary socket. This module
 * contains the small protocol subset needed by AgentRuntime and deliberately
 * keeps every provider identifier inside the adapter.
 *
 * Ported from `src-tauri/src/agent/control.rs`. The Rust client held one
 * socket with a short blocking read timeout and drained it inside
 * `read_recent`; Node cannot block, so the socket's `data` events feed a
 * bounded pending queue and `readRecent` drains that queue instead. The
 * observable contract is the same: every byte Herdr sent since the previous
 * read, in order, binary-exact.
 */

import { connect, type Socket } from "node:net";

import { MAX_TERMINAL_READ_BYTES } from "./api.js";
import {
	AgentRuntimeErrorCode,
	agentError,
	classifyIo,
	type AgentRuntimeError,
} from "./error.js";
import type { TerminalControl } from "./model.js";

const PROTOCOL_VERSION = 20;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const ATTACH_ACK_TIMEOUT_MS = 5_000;

/** Server frame tags this adapter understands. Everything else is a mismatch. */
const SERVER_WELCOME = 0;
const SERVER_TERMINAL = 2;
const SERVER_SHUTDOWN = 4;

/** Client frame tags. */
const CLIENT_HELLO = 0;
const CLIENT_INPUT = 1;
const CLIENT_DETACH = 4;
const CLIENT_CONTROL_TERMINAL = 9;

export function pushVarint(payload: number[], value: number): void {
	if (value < 251) {
		payload.push(value);
	} else if (value <= 0xffff) {
		payload.push(251, value & 0xff, (value >>> 8) & 0xff);
	} else if (value <= 0xffff_ffff) {
		payload.push(
			252,
			value & 0xff,
			(value >>> 8) & 0xff,
			(value >>> 16) & 0xff,
			(value >>> 24) & 0xff,
		);
	} else {
		const big = BigInt(value);
		payload.push(253);
		for (let index = 0n; index < 8n; index += 1n) {
			payload.push(Number((big >> (index * 8n)) & 0xffn));
		}
	}
}

export function pushBytes(payload: number[], value: Uint8Array): void {
	if (value.length > MAX_FRAME_BYTES) {
		throw agentError(AgentRuntimeErrorCode.BoundedInput);
	}
	pushVarint(payload, value.length);
	for (const byte of value) {
		payload.push(byte);
	}
}

export function pushString(payload: number[], value: string): void {
	pushBytes(payload, Buffer.from(value, "utf8"));
}

export interface Cursor {
	offset: number;
}

export function readVarint(frame: Buffer, cursor: Cursor): number {
	const marker = frame[cursor.offset];
	if (marker === undefined) {
		throw agentError(AgentRuntimeErrorCode.ProtocolMismatch);
	}
	cursor.offset += 1;
	if (marker <= 250) {
		return marker;
	}
	const width =
		marker === 251 ? 2 : marker === 252 ? 4 : marker === 253 ? 8 : 0;
	if (width === 0) {
		throw agentError(AgentRuntimeErrorCode.ProtocolMismatch);
	}
	const bytes = readFixed(frame, cursor, width);
	let value = 0n;
	for (let index = bytes.length - 1; index >= 0; index -= 1) {
		value = (value << 8n) | BigInt(bytes[index]);
	}
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw agentError(AgentRuntimeErrorCode.BoundedInput);
	}
	return Number(value);
}

function readFixed(frame: Buffer, cursor: Cursor, length: number): Buffer {
	const end = cursor.offset + length;
	if (end > frame.length) {
		throw agentError(AgentRuntimeErrorCode.ProtocolMismatch);
	}
	const bytes = frame.subarray(cursor.offset, end);
	cursor.offset = end;
	return bytes;
}

function readBool(frame: Buffer, cursor: Cursor): boolean {
	const value = frame[cursor.offset];
	if (value !== 0 && value !== 1) {
		throw agentError(AgentRuntimeErrorCode.ProtocolMismatch);
	}
	cursor.offset += 1;
	return value === 1;
}

export function readBytes(frame: Buffer, cursor: Cursor): Buffer {
	const length = readVarint(frame, cursor);
	if (length > MAX_FRAME_BYTES) {
		throw agentError(AgentRuntimeErrorCode.BoundedInput);
	}
	return readFixed(frame, cursor, length);
}

function readString(frame: Buffer, cursor: Cursor): string {
	return readBytes(frame, cursor).toString("utf8");
}

export function serverTag(frame: Buffer): number {
	return readVarint(frame, { offset: 0 });
}

function decodeTag(frame: Buffer): [number, Cursor] {
	const cursor: Cursor = { offset: 0 };
	return [readVarint(frame, cursor), cursor];
}

export function encodeHello(): Buffer {
	const payload: number[] = [];
	pushVarint(payload, CLIENT_HELLO);
	pushVarint(payload, PROTOCOL_VERSION);
	pushVarint(payload, 80); // cols
	pushVarint(payload, 24); // rows
	pushVarint(payload, 0); // cell width px
	pushVarint(payload, 0); // cell height px
	pushVarint(payload, 1); // requested encoding: TerminalAnsi
	pushVarint(payload, 0); // keybindings: Server
	pushVarint(payload, 2); // launch mode: TerminalAttach
	return Buffer.from(payload);
}

export function encodeInput(data: Uint8Array): Buffer {
	const payload: number[] = [];
	pushVarint(payload, CLIENT_INPUT);
	pushBytes(payload, data);
	return Buffer.from(payload);
}

export function encodeDetach(): Buffer {
	return Buffer.from([CLIENT_DETACH]);
}

export function encodeControlTerminal(
	target: string,
	takeover: boolean,
): Buffer {
	const payload: number[] = [];
	pushVarint(payload, CLIENT_CONTROL_TERMINAL);
	pushString(payload, target);
	payload.push(takeover ? 1 : 0);
	return Buffer.from(payload);
}

export function verifyWelcome(frame: Buffer): void {
	const [tag, cursor] = decodeTag(frame);
	if (tag !== SERVER_WELCOME) {
		throw agentError(AgentRuntimeErrorCode.ProtocolMismatch);
	}
	if (readVarint(frame, cursor) !== PROTOCOL_VERSION) {
		throw agentError(AgentRuntimeErrorCode.ProtocolMismatch);
	}
	if (readVarint(frame, cursor) !== 1) {
		throw agentError(AgentRuntimeErrorCode.CapabilityMismatch);
	}
	if (readBool(frame, cursor)) {
		readString(frame, cursor);
		throw agentError(AgentRuntimeErrorCode.Unavailable);
	}
	if (cursor.offset !== frame.length) {
		throw agentError(AgentRuntimeErrorCode.ProtocolMismatch);
	}
}

/** Appends a Terminal frame's raw payload; other frame kinds are ignored. */
export function appendTerminalBytes(frame: Buffer, output: Buffer[]): void {
	const [tag, cursor] = decodeTag(frame);
	if (tag !== SERVER_TERMINAL) {
		return;
	}
	readVarint(frame, cursor); // provider sequence
	readVarint(frame, cursor); // width
	readVarint(frame, cursor); // height
	readBool(frame, cursor); // full redraw
	const bytes = readBytes(frame, cursor);
	const total = output.reduce((sum, chunk) => sum + chunk.length, 0);
	if (
		cursor.offset !== frame.length ||
		bytes.length > MAX_TERMINAL_READ_BYTES ||
		total + bytes.length > MAX_TERMINAL_READ_BYTES
	) {
		throw agentError(AgentRuntimeErrorCode.BoundedInput);
	}
	output.push(Buffer.from(bytes));
}

/**
 * One length-prefixed frame socket. Frames arrive on `data` and are parked in
 * `pending`; a waiter takes the head or times out. A socket-level failure is
 * recorded once and handed to every subsequent caller — it is never dropped.
 */
class FrameSocket {
	readonly #socket: Socket;
	#buffer = Buffer.alloc(0);
	readonly #pending: Buffer[] = [];
	#waiter: ((frame: Buffer | AgentRuntimeError) => void) | undefined;
	#failure: AgentRuntimeError | undefined;

	private constructor(socket: Socket) {
		this.#socket = socket;
		socket.on("data", (chunk: Buffer) => this.#ingest(chunk));
		socket.on("error", (error) => this.#fail(classifyIo(error)));
		socket.on("close", () =>
			this.#fail(agentError(AgentRuntimeErrorCode.Disconnected)),
		);
	}

	static open(path: string, timeoutMs: number): Promise<FrameSocket> {
		return new Promise((resolve, reject) => {
			const socket = connect({ path });
			const timer = setTimeout(() => {
				socket.destroy();
				reject(agentError(AgentRuntimeErrorCode.Timeout));
			}, timeoutMs);
			socket.once("connect", () => {
				clearTimeout(timer);
				socket.removeAllListeners("error");
				resolve(new FrameSocket(socket));
			});
			socket.once("error", (error) => {
				clearTimeout(timer);
				reject(classifyIo(error));
			});
		});
	}

	#ingest(chunk: Buffer): void {
		this.#buffer = Buffer.concat([this.#buffer, chunk]);
		for (;;) {
			if (this.#buffer.length < 4) {
				return;
			}
			const length = this.#buffer.readUInt32LE(0);
			if (length > MAX_FRAME_BYTES) {
				this.#fail(agentError(AgentRuntimeErrorCode.BoundedInput));
				return;
			}
			if (this.#buffer.length < 4 + length) {
				return;
			}
			const frame = this.#buffer.subarray(4, 4 + length);
			this.#buffer = this.#buffer.subarray(4 + length);
			this.#deliver(Buffer.from(frame));
		}
	}

	#deliver(frame: Buffer): void {
		const waiter = this.#waiter;
		if (waiter !== undefined) {
			this.#waiter = undefined;
			waiter(frame);
		} else {
			this.#pending.push(frame);
		}
	}

	#fail(error: AgentRuntimeError): void {
		this.#failure ??= error;
		const waiter = this.#waiter;
		if (waiter !== undefined) {
			this.#waiter = undefined;
			waiter(this.#failure);
		}
	}

	/** Frames already received, taken and cleared. Never blocks. */
	drain(): Buffer[] {
		const frames = [...this.#pending];
		this.#pending.length = 0;
		return frames;
	}

	get failure(): AgentRuntimeError | undefined {
		return this.#failure;
	}

	nextFrame(timeoutMs: number): Promise<Buffer> {
		const ready = this.#pending.shift();
		if (ready !== undefined) {
			return Promise.resolve(ready);
		}
		if (this.#failure !== undefined) {
			return Promise.reject(this.#failure);
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#waiter = undefined;
				reject(agentError(AgentRuntimeErrorCode.Timeout));
			}, timeoutMs);
			this.#waiter = (value) => {
				clearTimeout(timer);
				if (value instanceof Buffer) {
					resolve(value);
				} else {
					reject(value);
				}
			};
		});
	}

	write(payload: Buffer): void {
		if (payload.length > MAX_FRAME_BYTES) {
			throw agentError(AgentRuntimeErrorCode.BoundedInput);
		}
		const header = Buffer.alloc(4);
		header.writeUInt32LE(payload.length, 0);
		this.#socket.write(Buffer.concat([header, payload]));
	}

	close(): void {
		this.#socket.destroy();
	}
}

/**
 * Used by isolated transport fakes. The production HerdrTransport overrides
 * the factory and never uses this implementation.
 */
export class NoopTerminalControl implements TerminalControl {
	async sendText(_text: string): Promise<void> {}

	async readRecent(): Promise<Buffer> {
		return Buffer.alloc(0);
	}

	detach(): void {}
}

/**
 * A single writable control socket. The stream is separate from the persistent
 * JSON subscription socket, and one attachment owns it exclusively.
 */
export class HerdrTerminalControl implements TerminalControl {
	readonly #socket: FrameSocket;
	#pendingFrames: Buffer[];
	#detached = false;

	private constructor(socket: FrameSocket, pending: Buffer[]) {
		this.#socket = socket;
		this.#pendingFrames = pending;
	}

	static async open(
		socketPath: string,
		terminalId: string,
		takeover: boolean,
	): Promise<TerminalControl> {
		const socket = await FrameSocket.open(socketPath, HANDSHAKE_TIMEOUT_MS);
		try {
			socket.write(encodeHello());
			verifyWelcome(await socket.nextFrame(HANDSHAKE_TIMEOUT_MS));
			socket.write(encodeControlTerminal(terminalId, takeover));

			// Herdr has no separate acknowledgement for ControlTerminal: the
			// first Terminal frame proves ownership, while ServerShutdown
			// rejects it. Silence is ambiguous and must not be success.
			const frame = await socket.nextFrame(ATTACH_ACK_TIMEOUT_MS);
			const tag = serverTag(frame);
			if (tag === SERVER_SHUTDOWN) {
				throw agentError(AgentRuntimeErrorCode.Conflict);
			}
			if (tag !== SERVER_TERMINAL) {
				throw agentError(AgentRuntimeErrorCode.ProtocolMismatch);
			}
			return new HerdrTerminalControl(socket, [frame]);
		} catch (error) {
			socket.close();
			throw error;
		}
	}

	static async probe(socketPath: string): Promise<void> {
		const socket = await FrameSocket.open(socketPath, HANDSHAKE_TIMEOUT_MS);
		try {
			socket.write(encodeHello());
			verifyWelcome(await socket.nextFrame(HANDSHAKE_TIMEOUT_MS));
			socket.write(encodeDetach());
		} finally {
			socket.close();
		}
	}

	async sendText(text: string): Promise<void> {
		const bytes = Buffer.from(text, "utf8");
		if (bytes.length > MAX_TERMINAL_READ_BYTES || text.includes("\0")) {
			throw agentError(AgentRuntimeErrorCode.BoundedInput);
		}
		if (this.#detached) {
			throw agentError(AgentRuntimeErrorCode.Disconnected);
		}
		this.#socket.write(encodeInput(bytes));
	}

	async readRecent(): Promise<Buffer> {
		const frames = [...this.#pendingFrames, ...this.#socket.drain()];
		this.#pendingFrames = [];
		if (frames.length === 0) {
			const failure = this.#socket.failure;
			if (failure !== undefined && !this.#detached) {
				throw failure;
			}
			return Buffer.alloc(0);
		}
		const output: Buffer[] = [];
		for (const frame of frames) {
			appendTerminalBytes(frame, output);
		}
		return Buffer.concat(output);
	}

	detach(): void {
		if (this.#detached) {
			return;
		}
		this.#detached = true;
		try {
			this.#socket.write(encodeDetach());
		} catch {
			// The peer is already gone; the local attachment is what detach
			// owns, and it is now released either way.
		}
		this.#socket.close();
	}
}
