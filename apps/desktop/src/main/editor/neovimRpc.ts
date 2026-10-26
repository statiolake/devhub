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
 * Neovim sends notifications only to a client that subscribed, and requests
 * only to one that registered as a channel; this does neither, so anything it
 * receives that is not a response is ignored (a request is answered with an
 * error rather than left hanging on Neovim's side).
 */

import { connect as netConnect, type Socket } from "node:net";
import { decode, encode, MsgpackIncomplete } from "./msgpack.js";

/** What a caller needs from a connection to a Neovim server. */
export interface NeovimRpc {
	request(method: string, params: readonly unknown[]): Promise<unknown>;
	/** Run once the connection has ended, or now if it already has. */
	onClose(listener: () => void): void;
	readonly closed: boolean;
	close(): void;
}

/**
 * The bytes between DevHub and one Neovim server, however they travel.
 *
 * A unix socket on this Mac, or the stdio of a relay process that reaches a
 * socket on another machine (`neovimRelay.ts`). The client neither knows nor
 * needs to know which: both are a stream of msgpack each way that ends once,
 * and its ending is the server having gone.
 */
export interface NeovimWire {
	write(bytes: Uint8Array): void;
	onData(listener: (chunk: Uint8Array) => void): void;
	/** Once, however it ended. */
	onClose(listener: () => void): void;
	destroy(): void;
}

/** A connected socket as a wire. */
export function socketWire(socket: Socket): NeovimWire {
	socket.on("error", () => {
		// `close` follows every `error`, and that is where it is handled.
	});
	return {
		write: (bytes) => {
			socket.write(bytes);
		},
		onData: (listener) => {
			socket.on("data", listener);
		},
		onClose: (listener) => {
			socket.on("close", listener);
		},
		destroy: () => {
			socket.destroy();
		},
	};
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
	private ended = false;

	private constructor(
		private readonly socket: NeovimWire,
		private readonly timeoutMs: number,
	) {
		socket.onData((chunk) => {
			this.receive(chunk);
		});
		socket.onClose(() => {
			this.end(new Error("the connection to Neovim closed"));
		});
	}

	/** A client over a wire that is already connected. */
	static over(
		wire: NeovimWire,
		options: { readonly timeoutMs?: number } = {},
	): NeovimClient {
		return new NeovimClient(
			wire,
			options.timeoutMs ?? NEOVIM_REQUEST_TIMEOUT_MS,
		);
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
				resolve(new NeovimClient(socketWire(socket), timeoutMs));
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

	request(method: string, params: readonly unknown[]): Promise<unknown> {
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
				reject(new Error(`Neovim did not answer ${method} in time`));
			}, this.timeoutMs);
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
		if (kind === 0) {
			const [, id] = message as [number, number];
			this.socket.write(encode([1, id, "DevHub answers no requests", null]));
		}
	}
}
