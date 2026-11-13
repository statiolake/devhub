/**
 * A msgpack-rpc client for one Neovim server's socket (`:help rpc`).
 *
 * The managed Neovim (`managedNeovim.ts`) keeps one of these open per server
 * for as long as the server lives, and that is half of what it is for: the
 * connection closing *is* Neovim having exited — `:q`, its pane killed, a
 * crash — observed the moment it happens, with no polling and nothing spawned.
 * The other half is the requests, which carry their arguments as values: a
 * path with a space, a quote or a `|` in it needs no escaping, because nothing
 * is parsed as a command line. That is why this is a client and not `nvim
 * --server <sock> --remote-send`, which types keys into whatever mode the
 * person left Neovim in.
 *
 * The wire is three message shapes: a request `[0, id, method, params]`, its
 * response `[1, id, error, result]`, and a notification `[2, method, params]`.
 * Neovim sends notifications to a client that attached as a UI (`redraw`) or
 * that a plugin `rpcnotify`s, and requests to one a plugin `rpcrequest`s —
 * the GUI editor (`neovimUi.ts`) is both. Each goes to the handler set with
 * `onNotification` / `onRequest`; with no request handler a request is
 * answered with an error rather than left hanging on Neovim's side.
 */

import { connect as netConnect, type Socket } from "node:net";
import { decode, encode, MsgpackIncomplete } from "./msgpack.js";

/** What a caller needs from a connection to a Neovim server. */
export interface NeovimRpc {
	request(
		method: string,
		params: readonly unknown[],
		options?: RequestOptions,
	): Promise<unknown>;
	/** Run once the connection has ended, or now if it already has. */
	onClose(listener: () => void): void;
	readonly closed: boolean;
	close(): void;
	/** A notification to Neovim: no answer, kept in order with requests. */
	notify?(method: string, params: readonly unknown[]): void;
	/** Every notification Neovim sends on this connection (`redraw`, …). */
	onNotification?(listener: NotificationListener): void;
	/** What answers Neovim's `rpcrequest`s on this connection. */
	onRequest?(handler: RequestHandler): void;
}

export type NotificationListener = (
	method: string,
	params: readonly unknown[],
) => void;
export type RequestHandler = (
	method: string,
	params: readonly unknown[],
) => Promise<unknown>;

export interface RequestOptions {
	/** Instead of the connection's own (`NEOVIM_REQUEST_TIMEOUT_MS`). */
	readonly timeoutMs?: number;
}

/**
 * A request Neovim did not answer in time. It was sent, and the connection
 * is open: Neovim may still run it, once it is free (done starting, a
 * prompt answered).
 */
export class NeovimRequestTimeout extends Error {
	constructor(readonly method: string) {
		super(`Neovim did not answer ${method} in time`);
		this.name = "NeovimRequestTimeout";
	}
}

/** Neovim answered a request with an error (`[type, message]`). */
export class NeovimRpcError extends Error {
	constructor(
		readonly method: string,
		readonly detail: unknown,
	) {
		super(`Neovim refused ${method}: ${describeError(detail)}`);
		this.name = "NeovimRpcError";
	}
}

function describeError(detail: unknown): string {
	if (Array.isArray(detail) && typeof detail[1] === "string") return detail[1];
	if (typeof detail === "string") return detail;
	return JSON.stringify(detail);
}

/** How long one request may take before it is given up on. */
export const NEOVIM_REQUEST_TIMEOUT_MS = 5_000;

interface Pending {
	readonly method: string;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

export class NeovimClient implements NeovimRpc {
	private nextId = 1;
	private buffered: Uint8Array = new Uint8Array(0);
	private readonly pending = new Map<number, Pending>();
	private readonly closeListeners: (() => void)[] = [];
	private readonly notificationListeners: NotificationListener[] = [];
	private requestHandler: RequestHandler | undefined;
	private ended = false;

	private constructor(
		private readonly socket: Socket,
		private readonly timeoutMs: number,
	) {
		socket.on("data", (chunk: Buffer) => {
			this.receive(chunk);
		});
		socket.on("error", () => {
			// `close` follows every `error`, and that is where it is handled.
		});
		socket.on("close", () => {
			this.end(new Error("the connection to Neovim closed"));
		});
	}

	/**
	 * Connect to a server's socket. Refused (`ECONNREFUSED`, `ENOENT`) is a
	 * rejection with the errno's `code` on it, which is how a caller tells a
	 * stale socket file from a live server.
	 */
	static connect(
		path: string,
		options: { readonly timeoutMs?: number } = {},
	): Promise<NeovimClient> {
		const timeoutMs = options.timeoutMs ?? NEOVIM_REQUEST_TIMEOUT_MS;
		return new Promise((resolve, reject) => {
			const socket = netConnect(path);
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new Error(`Neovim at ${path} did not accept a connection`));
			}, timeoutMs);
			socket.once("connect", () => {
				clearTimeout(timer);
				socket.removeAllListeners("error");
				resolve(new NeovimClient(socket, timeoutMs));
			});
			socket.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
		});
	}

	get closed(): boolean {
		return this.ended;
	}

	request(
		method: string,
		params: readonly unknown[],
		options: RequestOptions = {},
	): Promise<unknown> {
		if (this.ended) {
			return Promise.reject(
				new Error(`the connection to Neovim is closed (${method})`),
			);
		}
		const id = this.nextId;
		this.nextId = this.nextId >= 0x7fffffff ? 1 : this.nextId + 1;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new NeovimRequestTimeout(method));
			}, options.timeoutMs ?? this.timeoutMs);
			this.pending.set(id, { method, resolve, reject, timer });
			this.socket.write(encode([0, id, method, [...params]]));
		});
	}

	onClose(listener: () => void): void {
		if (this.ended) {
			listener();
			return;
		}
		this.closeListeners.push(listener);
	}

	onNotification(listener: NotificationListener): void {
		this.notificationListeners.push(listener);
	}

	onRequest(handler: RequestHandler): void {
		this.requestHandler = handler;
	}

	/** A notification to Neovim (`[2, method, params]`): no answer comes. */
	notify(method: string, params: readonly unknown[]): void {
		if (this.ended) return;
		this.socket.write(encode([2, method, [...params]]));
	}

	close(): void {
		this.socket.destroy();
		this.end(new Error("the connection to Neovim was closed by DevHub"));
	}

	private end(reason: Error): void {
		if (this.ended) return;
		this.ended = true;
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(reason);
			this.pending.delete(id);
		}
		for (const listener of this.closeListeners.splice(0)) listener();
	}

	private receive(chunk: Uint8Array): void {
		const joined = new Uint8Array(this.buffered.byteLength + chunk.byteLength);
		joined.set(this.buffered, 0);
		joined.set(chunk, this.buffered.byteLength);
		let offset = 0;
		while (offset < joined.byteLength) {
			let message;
			try {
				message = decode(joined.subarray(offset));
			} catch (error) {
				if (error instanceof MsgpackIncomplete) break;
				// Not msgpack-rpc: nothing more on this connection can be read.
				this.socket.destroy();
				this.end(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			offset += message.length;
			this.dispatch(message.value);
		}
		this.buffered = joined.slice(offset);
	}

	private dispatch(message: unknown): void {
		if (!Array.isArray(message)) return;
		const [kind] = message as unknown[];
		if (kind === 1) {
			const [, id, error, result] = message as [
				number,
				number,
				unknown,
				unknown,
			];
			const pending = this.pending.get(id);
			if (!pending) return;
			this.pending.delete(id);
			clearTimeout(pending.timer);
			if (error !== null && error !== undefined) {
				pending.reject(new NeovimRpcError(pending.method, error));
			} else {
				pending.resolve(result);
			}
			return;
		}
		if (kind === 2) {
			const [, method, params] = message as [number, unknown, unknown];
			if (typeof method !== "string") return;
			const list = Array.isArray(params) ? (params as unknown[]) : [];
			for (const listener of this.notificationListeners) {
				listener(method, list);
			}
			return;
		}
		if (kind === 0) {
			const [, id, method, params] = message as [
				number,
				number,
				unknown,
				unknown,
			];
			const handler = this.requestHandler;
			if (handler === undefined || typeof method !== "string") {
				this.socket.write(encode([1, id, "DevHub answers no requests", null]));
				return;
			}
			const list = Array.isArray(params) ? (params as unknown[]) : [];
			handler(method, list).then(
				(result) => {
					if (!this.ended)
						this.socket.write(encode([1, id, null, result ?? null]));
				},
				(error: unknown) => {
					if (!this.ended) {
						this.socket.write(
							encode([
								1,
								id,
								error instanceof Error ? error.message : String(error),
								null,
							]),
						);
					}
				},
			);
		}
	}
}
