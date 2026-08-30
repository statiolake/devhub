/**
 * A self-contained wire-level Herdr harness.
 *
 * This is intentionally a test server, not a production fallback. It implements
 * the pinned JSON and protocol-20 control messages on isolated Unix sockets so
 * lifecycle tests exercise the real `HerdrTransport` and `HerdrTerminalControl`
 * without invoking a user's configured agent.
 *
 * Ported from `src-tauri/src/agent/harness.rs`. The Rust harness lived behind
 * `#[cfg(test)]`; here it is a plain module imported only by `harness.test.ts`,
 * because TypeScript has no equivalent gate. It is never imported by
 * `index.ts`, so it cannot reach a shipped main process.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import { HERDR_PROTOCOL_VERSION, HERDR_VERSION } from "./contract.js";
import { HerdrTransport } from "./api.js";
import { pushBytes, pushVarint, readVarint, type Cursor } from "./control.js";

export const HARNESS_AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const HARNESS_WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

interface HarnessState {
	workspaceLive: boolean;
	paneLive: boolean;
	agentLive: boolean;
	agentStatus: string;
	failPaneClose: boolean;
	dropSubscriptions: boolean;
	controlOwner: boolean;
	startedName: string | undefined;
	startedKind: string | undefined;
	startedArgs: string[];
	workspaceCwd: string | undefined;
}

export class HerdrHarness {
	readonly root: string;
	readonly apiSocket: string;
	readonly clientSocket: string;
	readonly state: HarnessState = {
		workspaceLive: false,
		paneLive: false,
		agentLive: false,
		agentStatus: "working",
		failPaneClose: false,
		dropSubscriptions: false,
		controlOwner: false,
		startedName: undefined,
		startedKind: undefined,
		startedArgs: [],
		workspaceCwd: undefined,
	};
	#apiServer: Server | undefined;
	#clientServer: Server | undefined;
	readonly #sockets = new Set<Socket>();

	private constructor(root: string) {
		this.root = root;
		this.apiSocket = join(root, "herdr.sock");
		this.clientSocket = join(root, "herdr-client.sock");
	}

	/**
	 * Sockets live beside the test, never in `$TMPDIR`: a sandboxed run sees a
	 * different temp path inside and outside, and a Unix socket path is short
	 * by necessity.
	 */
	static async start(baseDir: string): Promise<HerdrHarness> {
		const harness = new HerdrHarness(mkdtempSync(join(baseDir, "h-")));
		harness.#apiServer = await harness.#listen(harness.apiSocket, (socket) =>
			harness.#serveApi(socket),
		);
		harness.#clientServer = await harness.#listen(
			harness.clientSocket,
			(socket) => harness.#serveControl(socket),
		);
		return harness;
	}

	transport(): HerdrTransport {
		return new HerdrTransport(this.apiSocket);
	}

	setNaturalExit(): void {
		this.state.agentLive = false;
		this.state.agentStatus = "done";
	}

	setTransientMissingAgent(): void {
		this.state.agentLive = false;
		this.state.agentStatus = "working";
	}

	restoreAgent(): void {
		this.state.agentLive = true;
		this.state.agentStatus = "working";
	}

	setCleanupFailure(failed: boolean): void {
		this.state.failPaneClose = failed;
	}

	dropSubscriptions(drop: boolean): void {
		this.state.dropSubscriptions = drop;
		if (drop) {
			for (const socket of this.#sockets) {
				socket.destroy();
			}
		}
	}

	launchObserved(): {
		name: string;
		kind: string;
		args: string[];
		cwd: string;
	} {
		const { startedName, startedKind, startedArgs, workspaceCwd } = this.state;
		if (
			startedName === undefined ||
			startedKind === undefined ||
			workspaceCwd === undefined
		) {
			throw new Error("the harness observed no agent launch");
		}
		return {
			name: startedName,
			kind: startedKind,
			args: startedArgs,
			cwd: workspaceCwd,
		};
	}

	async stop(): Promise<void> {
		for (const socket of this.#sockets) {
			socket.destroy();
		}
		this.#sockets.clear();
		for (const server of [this.#apiServer, this.#clientServer]) {
			if (server !== undefined) {
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		}
		rmSync(this.root, { recursive: true, force: true });
	}

	async #listen(
		path: string,
		onConnection: (socket: Socket) => void,
	): Promise<Server> {
		const server = createServer((socket) => {
			this.#sockets.add(socket);
			socket.on("close", () => this.#sockets.delete(socket));
			socket.on("error", () => undefined);
			onConnection(socket);
		});
		await new Promise<void>((resolve) => server.listen(path, resolve));
		return server;
	}

	#serveApi(socket: Socket): void {
		let buffer = "";
		let subscribed = false;
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) {
					return;
				}
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (subscribed) {
					// A subscribed connection ignores further client lines; the
					// harness only ever pushes events on it.
					continue;
				}
				let request: {
					id?: unknown;
					method?: unknown;
					params?: Record<string, unknown>;
				};
				try {
					request = JSON.parse(line);
				} catch {
					socket.destroy();
					return;
				}
				const id = request.id ?? "harness";
				const method = typeof request.method === "string" ? request.method : "";
				const params = request.params ?? {};
				if (method === "events.subscribe") {
					subscribed = true;
					if (this.state.dropSubscriptions) {
						socket.destroy();
						return;
					}
					write(socket, {
						id,
						result: { type: "subscription_started" },
					});
					continue;
				}
				if (method === "pane.close" && this.state.failPaneClose) {
					write(socket, {
						id,
						error: { code: "provider_error", message: "cleanup failure" },
					});
					socket.end();
					return;
				}
				write(socket, { id, result: this.#apiResult(method, params) });
				socket.end();
				return;
			}
		});
	}

	#apiResult(method: string, params: Record<string, unknown>): unknown {
		switch (method) {
			case "ping":
				return {
					type: "pong",
					version: HERDR_VERSION,
					protocol: HERDR_PROTOCOL_VERSION,
					capabilities: { terminal_control: true },
				};
			case "session.snapshot":
				return this.#sessionSnapshot();
			case "workspace.list":
				return {
					type: "workspace_list",
					workspaces: this.state.workspaceLive
						? [{ workspace_id: "provider-workspace" }]
						: [],
				};
			case "tab.list":
				return {
					type: "tab_list",
					tabs: this.state.paneLive ? [{ tab_id: "provider-tab" }] : [],
				};
			case "pane.list":
				return {
					type: "pane_list",
					panes: this.state.paneLive ? [{ pane_id: "provider-pane" }] : [],
				};
			case "agent.list":
				return {
					type: "agent_list",
					agents: this.state.agentLive
						? [{ terminal_id: "provider-terminal" }]
						: [],
				};
			case "workspace.create":
				this.state.workspaceLive = true;
				this.state.paneLive = true;
				this.state.agentLive = false;
				this.state.workspaceCwd =
					typeof params.cwd === "string" ? params.cwd : undefined;
				return {
					type: "workspace_created",
					workspace: { workspace_id: "provider-workspace" },
					tab: { tab_id: "provider-tab" },
					root_pane: {
						pane_id: "provider-pane",
						terminal_id: "provider-terminal",
					},
				};
			case "agent.start":
				this.state.agentLive = true;
				this.state.agentStatus = "working";
				this.state.startedName =
					typeof params.name === "string" ? params.name : undefined;
				this.state.startedKind =
					typeof params.kind === "string" ? params.kind : undefined;
				this.state.startedArgs = Array.isArray(params.args)
					? params.args.filter((arg): arg is string => typeof arg === "string")
					: [];
				return {
					type: "agent_started",
					agent: { terminal_id: "provider-terminal" },
					argv: this.state.startedArgs,
				};
			case "pane.close":
				this.state.paneLive = false;
				this.state.agentLive = false;
				return { type: "pane_info", pane: { pane_id: "provider-pane" } };
			case "workspace.close":
				this.state.workspaceLive = false;
				return {
					type: "workspace_info",
					workspace: { workspace_id: "provider-workspace" },
				};
			default:
				return { type: "ok" };
		}
	}

	#sessionSnapshot(): unknown {
		return {
			type: "session_snapshot",
			snapshot: {
				version: HERDR_VERSION,
				protocol: HERDR_PROTOCOL_VERSION,
				focused_workspace_id: null,
				focused_tab_id: null,
				focused_pane_id: null,
				workspaces: this.state.workspaceLive
					? [
							{
								workspace_id: "provider-workspace",
								label: `devhub-agent-${HARNESS_AGENT_ID}`,
							},
						]
					: [],
				tabs: [],
				panes: this.state.paneLive
					? [
							{
								pane_id: "provider-pane",
								terminal_id: "provider-terminal",
								workspace_id: "provider-workspace",
								tab_id: "provider-tab",
								agent: this.state.agentLive ? "codex" : null,
								agent_status: this.state.agentStatus,
							},
						]
					: [],
				layouts: [],
				agents: [],
			},
		};
	}

	#serveControl(socket: Socket): void {
		let buffer = Buffer.alloc(0);
		let sawHello = false;
		socket.on("data", (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			for (;;) {
				if (buffer.length < 4) {
					return;
				}
				const length = buffer.readUInt32LE(0);
				if (buffer.length < 4 + length) {
					return;
				}
				const frame = buffer.subarray(4, 4 + length);
				buffer = buffer.subarray(4 + length);
				const cursor: Cursor = { offset: 0 };
				const tag = readVarint(frame, cursor);
				if (!sawHello) {
					if (tag !== 0) {
						socket.destroy();
						return;
					}
					sawHello = true;
					writeFrame(socket, welcomeFrame());
					continue;
				}
				if (tag === 4) {
					this.state.controlOwner = false;
					socket.end();
					return;
				}
				if (tag === 9) {
					readVarint(frame, cursor);
					// The target string's bytes are skipped: the harness owns a
					// single terminal, and its identity is already asserted by
					// the API-side snapshot.
					const takeover = frame.at(-1) === 1;
					if (this.state.controlOwner && !takeover) {
						writeFrame(socket, Buffer.from([4, 0]));
						socket.end();
						return;
					}
					this.state.controlOwner = true;
					writeFrame(socket, terminalFrame());
					continue;
				}
				if (tag !== 1) {
					socket.destroy();
					return;
				}
			}
		});
	}
}

function write(socket: Socket, value: unknown): void {
	socket.write(`${JSON.stringify(value)}\n`);
}

function writeFrame(socket: Socket, payload: Buffer): void {
	const header = Buffer.alloc(4);
	header.writeUInt32LE(payload.length, 0);
	socket.write(Buffer.concat([header, payload]));
}

function welcomeFrame(): Buffer {
	const payload: number[] = [0];
	pushVarint(payload, HERDR_PROTOCOL_VERSION);
	pushVarint(payload, 1);
	payload.push(0);
	return Buffer.from(payload);
}

function terminalFrame(): Buffer {
	const payload: number[] = [2];
	pushVarint(payload, 1);
	pushVarint(payload, 80);
	pushVarint(payload, 24);
	payload.push(1);
	pushBytes(payload, Buffer.from("herdr-harness\n"));
	return Buffer.from(payload);
}
