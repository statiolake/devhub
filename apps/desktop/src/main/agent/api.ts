/**
 * Minimal bounded JSON API transport for the pinned Herdr session.
 *
 * The transport deliberately has no public provider model. It carries provider
 * JSON only between this module and the Herdr process; callers see only typed
 * adapter results.
 *
 * Ported from `src-tauri/src/agent/api.rs`. The subscription worker was a
 * thread with a short blocking read; here it is a long-lived socket plus a
 * reconnect loop driven by the event loop. `Invalidation` keeps the same
 * coalescing contract (50 ms) because reconciliation depends on it.
 */

import { connect, type Socket } from "node:net";
import { isAbsolute, join } from "node:path";

import {
	HERDR_SESSION_NAME,
	expectedProtocol,
	expectedVersion,
	requiredCapabilities,
} from "./contract.js";
import { HerdrTerminalControl, NoopTerminalControl } from "./control.js";
import {
	AgentRuntimeError,
	AgentRuntimeErrorCode,
	ProviderErrorCategory,
	agentError,
	classifyIo,
} from "./error.js";
import type { TerminalControl } from "./model.js";

export const API_TIMEOUT_MS = 5_000;
export const SUBSCRIPTION_RETRY_MS = 100;
/**
 * Herdr's `MAX_INITIAL_REQUEST_BYTES` is an inclusive read limit, so the
 * adapter keeps the terminating newline below the exact 1 MiB boundary.
 */
export const HERDR_INITIAL_REQUEST_BYTES = 1024 * 1024;
export const MAX_API_LINE_BYTES = 512 * 1024;
export const MAX_TERMINAL_READ_BYTES = 256 * 1024;
const INVALIDATION_COALESCE_MS = 50;

/**
 * Adapter-owned event invalidation state. Herdr events are hints only; the
 * next reconciliation always obtains an authoritative session snapshot.
 */
export class Invalidation {
	#pending = false;
	#disconnected = false;
	#generation = 0;
	#lastEvent: number | undefined;

	mark(): void {
		this.#pending = true;
		this.#generation += 1;
		this.#lastEvent = Date.now();
	}

	markDisconnected(): void {
		this.#disconnected = true;
		this.mark();
	}

	markConnected(): void {
		this.#disconnected = false;
	}

	get isDisconnected(): boolean {
		return this.#disconnected;
	}

	get generation(): number {
		return this.#generation;
	}

	/** Milliseconds still to wait before a snapshot is worth taking. */
	pendingWait(): number | undefined {
		if (!this.#pending) {
			return undefined;
		}
		const elapsed =
			this.#lastEvent === undefined ? 0 : Date.now() - this.#lastEvent;
		return Math.max(INVALIDATION_COALESCE_MS - elapsed, 0);
	}

	clearPending(): void {
		this.#pending = false;
	}
}

/**
 * A persistent subscription worker. Stopping the handle requests shutdown and
 * waits for the loop to observe it, keeping reconnect work bounded during
 * bootstrap recovery and teardown.
 */
export class SubscriptionHandle {
	#stopped = false;
	#ready = false;
	#finished: Promise<void>;
	#onStop: (() => void) | undefined;

	constructor(finished: Promise<void>, onStop?: () => void) {
		this.#finished = finished;
		this.#onStop = onStop;
	}

	markReady(ready: boolean): void {
		this.#ready = ready;
	}

	get isStopped(): boolean {
		return this.#stopped;
	}

	async waitReady(deadline: number): Promise<boolean> {
		while (!this.#ready && Date.now() < deadline) {
			if (this.#stopped) {
				return false;
			}
			await delay(5);
		}
		return this.#ready;
	}

	async stop(): Promise<boolean> {
		return this.stopUntil(Date.now() + 5_000);
	}

	/**
	 * Requests subscription shutdown and waits only until the caller's
	 * lifecycle deadline. Herdr sessions are provider-owned and are never
	 * terminated by this local listener cleanup.
	 */
	async stopUntil(deadline: number): Promise<boolean> {
		this.#stopped = true;
		this.#ready = false;
		this.#onStop?.();
		let settled = false;
		await Promise.race([
			this.#finished.then(() => {
				settled = true;
			}),
			(async () => {
				while (Date.now() < deadline && !settled) {
					await delay(5);
				}
			})(),
		]);
		return settled;
	}
}

export function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Provider transport seam. The real implementation speaks Herdr's newline JSON
 * API; tests can use a deterministic in-memory endpoint without exposing
 * provider IDs outside this module.
 */
export interface ProviderTransport {
	request(method: string, params: unknown): Promise<unknown>;
	/**
	 * Bounded operation-specific request seam. Implementations may widen a
	 * transport deadline for a provider operation whose server-side readiness
	 * timeout is explicitly larger than the ordinary API budget.
	 */
	requestWithTimeout?(
		method: string,
		params: unknown,
		timeoutMs: number,
	): Promise<unknown>;
	checkCapabilities?(): Promise<void>;
	openControl?(terminalId: string, takeover: boolean): Promise<TerminalControl>;
	subscribe(invalidation: Invalidation): Promise<SubscriptionHandle>;
}

export async function transportRequestWithTimeout(
	transport: ProviderTransport,
	method: string,
	params: unknown,
	timeoutMs: number,
): Promise<unknown> {
	return transport.requestWithTimeout !== undefined
		? transport.requestWithTimeout(method, params, timeoutMs)
		: transport.request(method, params);
}

export async function transportOpenControl(
	transport: ProviderTransport,
	terminalId: string,
	takeover: boolean,
): Promise<TerminalControl> {
	return transport.openControl !== undefined
		? transport.openControl(terminalId, takeover)
		: new NoopTerminalControl();
}

export async function transportCheckCapabilities(
	transport: ProviderTransport,
): Promise<void> {
	await transport.checkCapabilities?.();
}

export class HerdrTransport implements ProviderTransport {
	readonly #socketPath: string;
	readonly #timeoutMs: number;

	constructor(socketPath: string, timeoutMs: number = API_TIMEOUT_MS) {
		this.#socketPath = socketPath;
		this.#timeoutMs = timeoutMs;
	}

	async request(method: string, params: unknown): Promise<unknown> {
		return this.requestWithTimeout(method, params, this.#timeoutMs);
	}

	async requestWithTimeout(
		method: string,
		params: unknown,
		timeoutMs: number,
	): Promise<unknown> {
		const encoded = encodeRequest(`devhub-agent-${method}`, method, params);
		const socket = await openLineSocket(this.#socketPath, timeoutMs);
		try {
			socket.write(encoded);
			return parseResponse(await socket.nextLine(timeoutMs));
		} finally {
			socket.close();
		}
	}

	async checkCapabilities(): Promise<void> {
		const knownContract = new Set([
			"session.snapshot",
			"events.subscribe",
			"workspace.create",
			"workspace.list",
			"workspace.close",
			"tab.create",
			"tab.list",
			"pane.create",
			"pane.list",
			"pane.get",
			"pane.close",
			"pane.send_input",
			"agent.start:codex",
			"agent.start:claude",
			"terminal.control",
		]);
		if (
			requiredCapabilities().some(
				(capability) => !knownContract.has(capability),
			)
		) {
			throw agentError(AgentRuntimeErrorCode.CapabilityMismatch);
		}
		validateCapabilityResult(
			await this.request("session.snapshot", {}),
			"sessionSnapshot",
		);
		for (const [method, kind] of [
			["workspace.list", "workspaceList"],
			["tab.list", "tabList"],
			["pane.list", "paneList"],
			["agent.list", "agentList"],
		] as const) {
			validateCapabilityResult(await this.request(method, {}), kind);
		}
		await this.#probeSubscription();
		await HerdrTerminalControl.probe(clientSocketPath(this.#socketPath));
	}

	async openControl(
		terminalId: string,
		takeover: boolean,
	): Promise<TerminalControl> {
		return HerdrTerminalControl.open(
			clientSocketPath(this.#socketPath),
			terminalId,
			takeover,
		);
	}

	async #probeSubscription(): Promise<void> {
		const encoded = encodeRequest(
			"devhub-agent-capability-subscribe",
			"events.subscribe",
			{ subscriptions: baseSubscriptionKinds() },
		);
		const socket = await openLineSocket(this.#socketPath, this.#timeoutMs);
		try {
			socket.write(encoded);
			parseSubscriptionStarted(await socket.nextLine(this.#timeoutMs));
		} finally {
			socket.close();
		}
	}

	async subscribe(invalidation: Invalidation): Promise<SubscriptionHandle> {
		let currentSocket: LineSocket | undefined;
		let started: () => void = () => {};
		const finished = new Promise<void>((resolve) => {
			started = resolve;
		});
		const handle = new SubscriptionHandle(finished, () =>
			currentSocket?.close(),
		);
		const loop = async (): Promise<void> => {
			while (!handle.isStopped) {
				handle.markReady(false);
				try {
					const socket = await openLineSocket(
						this.#socketPath,
						this.#timeoutMs,
					);
					currentSocket = socket;
					try {
						socket.write(
							encodeRequest("devhub-agent-subscribe", "events.subscribe", {
								subscriptions: baseSubscriptionKinds(),
							}),
						);
						parseSubscriptionStarted(await socket.nextLine(this.#timeoutMs));
						invalidation.markConnected();
						handle.markReady(true);
						for (;;) {
							if (handle.isStopped) {
								return;
							}
							const line = await socket.nextLineOrIdle(200);
							if (line !== undefined && isEventLine(line)) {
								invalidation.mark();
							}
						}
					} finally {
						currentSocket = undefined;
						socket.close();
					}
				} catch {
					// A dropped subscription is a fact the next reconciliation
					// has to see; it is recorded, never swallowed, and the
					// worker retries the provider on its own schedule.
					handle.markReady(false);
					invalidation.markDisconnected();
					if (handle.isStopped) {
						return;
					}
					await delay(SUBSCRIPTION_RETRY_MS);
				}
			}
		};
		void loop().finally(started);
		return handle;
	}
}

function encodeRequest(id: string, method: string, params: unknown): Buffer {
	const encoded = Buffer.from(JSON.stringify({ id, method, params }), "utf8");
	if (encoded.length + 1 >= HERDR_INITIAL_REQUEST_BYTES) {
		throw agentError(AgentRuntimeErrorCode.BoundedInput);
	}
	return Buffer.concat([encoded, Buffer.from("\n")]);
}

/** One newline-delimited JSON socket with a bounded line length. */
class LineSocket {
	readonly #socket: Socket;
	#buffer = Buffer.alloc(0);
	readonly #pending: Buffer[] = [];
	#waiter: ((line: Buffer | AgentRuntimeError) => void) | undefined;
	#failure: AgentRuntimeError | undefined;

	constructor(socket: Socket) {
		this.#socket = socket;
		socket.on("data", (chunk: Buffer) => this.#ingest(chunk));
		socket.on("error", (error) => this.#fail(classifyIo(error)));
		socket.on("close", () =>
			this.#fail(agentError(AgentRuntimeErrorCode.Disconnected)),
		);
	}

	#ingest(chunk: Buffer): void {
		this.#buffer = Buffer.concat([this.#buffer, chunk]);
		for (;;) {
			const newline = this.#buffer.indexOf(0x0a);
			if (newline < 0) {
				if (this.#buffer.length > MAX_API_LINE_BYTES) {
					this.#fail(agentError(AgentRuntimeErrorCode.BoundedInput));
				}
				return;
			}
			let line = this.#buffer.subarray(0, newline);
			this.#buffer = this.#buffer.subarray(newline + 1);
			if (line.length > MAX_API_LINE_BYTES) {
				this.#fail(agentError(AgentRuntimeErrorCode.BoundedInput));
				return;
			}
			if (line.at(-1) === 0x0d) {
				line = line.subarray(0, line.length - 1);
			}
			const waiter = this.#waiter;
			if (waiter !== undefined) {
				this.#waiter = undefined;
				waiter(Buffer.from(line));
			} else {
				this.#pending.push(Buffer.from(line));
			}
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

	nextLine(timeoutMs: number): Promise<Buffer> {
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

	/** A poll that returns `undefined` on an idle interval instead of failing. */
	async nextLineOrIdle(timeoutMs: number): Promise<Buffer | undefined> {
		try {
			return await this.nextLine(timeoutMs);
		} catch (error) {
			if (
				error instanceof AgentRuntimeError &&
				error.code === AgentRuntimeErrorCode.Timeout
			) {
				return undefined;
			}
			throw error;
		}
	}

	write(payload: Buffer): void {
		this.#socket.write(payload);
	}

	close(): void {
		this.#socket.destroy();
	}
}

async function openLineSocket(
	path: string,
	timeoutMs: number,
): Promise<LineSocket> {
	return new Promise((resolve, reject) => {
		const socket = connect({ path });
		const timer = setTimeout(() => {
			socket.destroy();
			reject(agentError(AgentRuntimeErrorCode.Timeout));
		}, timeoutMs);
		socket.once("connect", () => {
			clearTimeout(timer);
			socket.removeAllListeners("error");
			resolve(new LineSocket(socket));
		});
		socket.once("error", (error) => {
			clearTimeout(timer);
			reject(classifyIo(error));
		});
	});
}

type CapabilityKind =
	| "sessionSnapshot"
	| "workspaceList"
	| "tabList"
	| "paneList"
	| "agentList";

const CAPABILITY_SHAPES: Record<
	CapabilityKind,
	{ readonly type: string; readonly collection: string; readonly key: string }
> = {
	sessionSnapshot: {
		type: "session_snapshot",
		collection: "snapshot",
		key: "",
	},
	workspaceList: {
		type: "workspace_list",
		collection: "workspaces",
		key: "workspace_id",
	},
	tabList: { type: "tab_list", collection: "tabs", key: "tab_id" },
	paneList: { type: "pane_list", collection: "panes", key: "pane_id" },
	agentList: { type: "agent_list", collection: "agents", key: "terminal_id" },
};

export function validateCapabilityResult(
	value: unknown,
	expected: CapabilityKind,
): void {
	const result = value as Record<string, unknown> | null;
	if (result === null || typeof result !== "object") {
		throw agentError(AgentRuntimeErrorCode.CapabilityMismatch);
	}
	const shape = CAPABILITY_SHAPES[expected];
	if (result.type !== shape.type) {
		throw agentError(AgentRuntimeErrorCode.CapabilityMismatch);
	}
	if (expected === "sessionSnapshot") {
		const snapshot = result.snapshot as Record<string, unknown> | undefined;
		if (snapshot === undefined || typeof snapshot !== "object") {
			throw agentError(AgentRuntimeErrorCode.CapabilityMismatch);
		}
		if (
			snapshot.version !== expectedVersion() ||
			snapshot.protocol !== expectedProtocol()
		) {
			throw agentError(AgentRuntimeErrorCode.ProtocolMismatch);
		}
		validateRecordIds(snapshot.workspaces, "workspace_id");
		validateRecordIds(snapshot.tabs, "tab_id");
		validateRecordIds(snapshot.panes, "pane_id");
		validateRecordIds(snapshot.agents, "terminal_id");
		return;
	}
	validateRecordIds(result[shape.collection], shape.key);
}

function validateRecordIds(records: unknown, key: string): void {
	if (!Array.isArray(records)) {
		throw agentError(AgentRuntimeErrorCode.CapabilityMismatch);
	}
	for (const record of records) {
		const value = (record as Record<string, unknown> | null)?.[key];
		if (typeof value !== "string" || value.length === 0) {
			throw agentError(AgentRuntimeErrorCode.CapabilityMismatch);
		}
	}
}

export function clientSocketPath(apiSocket: string): string {
	const separator = apiSocket.lastIndexOf("/");
	const parent = separator < 0 ? "" : apiSocket.slice(0, separator);
	const name = separator < 0 ? apiSocket : apiSocket.slice(separator + 1);
	const dot = name.lastIndexOf(".");
	const stem = dot <= 0 ? name : name.slice(0, dot);
	return join(parent, `${stem || "herdr"}-client.sock`);
}

export function baseSubscriptionKinds(): unknown[] {
	return [
		{ type: "workspace.created" },
		{ type: "workspace.updated" },
		{ type: "workspace.closed" },
		{ type: "tab.created" },
		{ type: "tab.closed" },
		{ type: "pane.created" },
		{ type: "pane.updated" },
		{ type: "pane.closed" },
		{ type: "pane.exited" },
		{ type: "pane.agent_detected" },
	];
}

export function parseSubscriptionStarted(line: Buffer): void {
	let value: unknown;
	try {
		value = JSON.parse(line.toString("utf8"));
	} catch {
		throw agentError(AgentRuntimeErrorCode.CapabilityMismatch);
	}
	const result = (value as { result?: { type?: unknown } } | null)?.result;
	if (result?.type !== "subscription_started") {
		throw agentError(AgentRuntimeErrorCode.CapabilityMismatch);
	}
}

export function isEventLine(line: Buffer): boolean {
	try {
		const value = JSON.parse(line.toString("utf8")) as Record<string, unknown>;
		return value !== null && typeof value === "object" && "event" in value;
	} catch {
		return false;
	}
}

export function parseResponse(line: Buffer): unknown {
	let value: Record<string, unknown>;
	try {
		value = JSON.parse(line.toString("utf8")) as Record<string, unknown>;
	} catch {
		throw agentError(AgentRuntimeErrorCode.ProviderRejected);
	}
	if (value !== null && typeof value === "object" && "error" in value) {
		const code = (value.error as { code?: unknown } | null)?.code;
		throw classifyProviderCode(typeof code === "string" ? code : "");
	}
	if (value === null || typeof value !== "object" || !("result" in value)) {
		throw agentError(AgentRuntimeErrorCode.ProviderRejected);
	}
	return value.result;
}

export function classifyProviderCode(code: string): AgentRuntimeError {
	const category =
		code === "agent_name_taken"
			? ProviderErrorCategory.AgentNameTaken
			: code === "agent_pane_busy" || code === "pane_busy"
				? ProviderErrorCategory.AgentPaneBusy
				: code === "agent_pane_not_found" || code === "pane_not_found"
					? ProviderErrorCategory.AgentPaneNotFound
					: code === "agent_pane_unavailable" || code === "pane_unavailable"
						? ProviderErrorCategory.AgentPaneUnavailable
						: code === "agent_start_input_failed" || code === "input_failed"
							? ProviderErrorCategory.AgentStartInputFailed
							: code === "invalid_request" || code === "invalid_params"
								? ProviderErrorCategory.InvalidRequest
								: ProviderErrorCategory.Other;
	const runtimeCode =
		category === ProviderErrorCategory.AgentPaneNotFound ||
		code.includes("not_found") ||
		code.includes("not-found")
			? AgentRuntimeErrorCode.ProviderNotFound
			: code.includes("timeout")
				? AgentRuntimeErrorCode.Timeout
				: AgentRuntimeErrorCode.ProviderRejected;
	return agentError(runtimeCode, category);
}

/**
 * The kernel's cap on a unix-domain socket path — the size of `sun_path` in
 * `struct sockaddr_un`: 104 bytes on the BSDs including macOS, 108 on Linux.
 *
 * It is checked here rather than left to `bind(2)` because Herdr binds two
 * sockets and only reports the first: with a long config home it binds the API
 * socket, fails on the longer client socket and exits, and every DevHub
 * request after that reads as a runtime that is merely unavailable.
 */
export function socketPathLimit(
	platform: NodeJS.Platform = process.platform,
): number {
	return platform === "linux" ? 108 : 104;
}

/**
 * Derives Herdr's named-session API socket from the startup-frozen launch
 * context. The release CLI uses `~/.config/herdr`; tests may supply a direct
 * endpoint through the `HerdrTransport` constructor.
 *
 * A path that cannot hold a socket fails here, before anything is launched.
 * Both of the session's sockets are measured — the client socket is the longer
 * of the two — and the failing one is named, because "too long" without the
 * path and the limit leaves the reader nothing to act on.
 */
export function sessionSocketPath(
	home: string,
	xdgConfigHome: string | undefined,
	limit: number = socketPathLimit(),
): string {
	const configHome =
		xdgConfigHome !== undefined && isAbsolute(xdgConfigHome)
			? xdgConfigHome
			: join(home, ".config");
	const apiSocket = join(
		configHome,
		"herdr",
		"sessions",
		HERDR_SESSION_NAME,
		"herdr.sock",
	);
	const longest = [apiSocket, clientSocketPath(apiSocket)].reduce(
		(widest, candidate) =>
			Buffer.byteLength(candidate) > Buffer.byteLength(widest)
				? candidate
				: widest,
	);
	const bytes = Buffer.byteLength(longest);
	if (bytes > limit) {
		throw agentError(
			AgentRuntimeErrorCode.SocketPathTooLong,
			undefined,
			`The agent runtime's socket path is too long (${bytes} of ${limit} bytes): ${longest}`,
		);
	}
	return apiSocket;
}
