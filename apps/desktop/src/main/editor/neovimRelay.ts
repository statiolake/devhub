/**
 * RPC to a Neovim on another machine, through Neovim itself.
 *
 * A managed Neovim on an SSH host listens on a unix socket *there*
 * (`~/.devhub-server/run/nvim/<digest>.sock`). DevHub reaches it by running a
 * relay over the connection it already holds — `ssh -T` on the host's master,
 * the same transport every stream DevHub reads from a host uses — and the
 * relay splices its stdio to the socket. The relay is Neovim: `nvim --clean
 * --headless -l relay.lua <socket>`, a few lines of `vim.uv` below.
 *
 * Why not the two alternatives:
 *
 * - **OpenSSH stream-local forwarding** (`-L local.sock:remote.sock`, or
 *   `-O forward` on the master) needs `AllowStreamLocalForwarding` on the
 *   server, which hardened hosts turn off, and a forward is a socket file on
 *   this Mac to clean up and a second thing to be stale. Worse, it is not a
 *   death detector: the forward stays up while the Neovim behind it is gone,
 *   and the first sign is a refused connection on the next jump.
 * - **`socat` / `nc -U`** are not on a bare host, and not on the NAS this was
 *   written for.
 *
 * The relay needs nothing the host does not already have once DevHub has put
 * its Neovim there, and it keeps the property the local client depends on:
 * one long-lived connection per server, whose end *is* the server's end — the
 * socket closes, the relay exits, ssh exits, stdout ends.
 *
 * stdout is msgpack and nothing else, so the relay speaks to DevHub on
 * stderr: one line, `devhub-relay connected` or `devhub-relay refused
 * <ERRNO>`, before any byte of RPC. A refusal carries the errno as a `code`,
 * the way a local `connect` does, so the lifecycle above tells a stale socket
 * (`ECONNREFUSED`, `ENOENT`) from a live server in one place for both.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { StreamLaunch } from "../runtime/byteStream.js";
import { NeovimClient, type NeovimRpc, type NeovimWire } from "./neovimRpc.js";

/**
 * The relay. `vim.uv` with a fallback to `vim.loop`, so a host's own Neovim
 * from before 0.10 can be the relay too (`-l` itself is 0.9).
 */
export const NEOVIM_RELAY_LUA = `-- DevHub: splice stdio to a Neovim server's socket (docs/terminal-mode.md).
local uv = vim.uv or vim.loop
local path = _G.arg[1]
local done, status = false, 0
local function finish(code)
  if not done then done, status = true, code end
end
local input = uv.new_pipe(false)
input:open(0)
local output = uv.new_pipe(false)
output:open(1)
local socket = uv.new_pipe(false)
socket:connect(path, function(err)
  if err then
    io.stderr:write("devhub-relay refused " .. tostring(err):match("^[%w_]+") .. "\\n")
    finish(2)
    return
  end
  io.stderr:write("devhub-relay connected\\n")
  socket:read_start(function(e, data)
    if e or not data then finish(0) return end
    output:write(data)
  end)
  input:read_start(function(e, data)
    if e or not data then finish(0) return end
    socket:write(data)
  end)
end)
while not done do
  vim.wait(60000, function() return done end, 20)
end
vim.wait(2000, function() return output:get_write_queue_size() == 0 end, 10)
os.exit(status)
`;

/** What the relay file is called on a machine: its content, so a change is a new file. */
export function relayFileName(): string {
	const digest = createHash("sha256")
		.update(NEOVIM_RELAY_LUA)
		.digest("hex")
		.slice(0, 12);
	return `devhub-relay-${digest}.lua`;
}

/** The relay's argv on the far machine, ahead of nothing: the socket is last. */
export function relayArgv(
	nvim: string,
	relayPath: string,
	socketPath: string,
): readonly string[] {
	return [
		nvim,
		"--clean",
		"--headless",
		"-n",
		"-i",
		"NONE",
		"-l",
		relayPath,
		socketPath,
	];
}

/** The relay's handshake, read off its stderr. */
export type RelayHandshake =
	| { readonly kind: "connected" }
	| { readonly kind: "refused"; readonly code: string };

export function parseRelayLine(line: string): RelayHandshake | undefined {
	const trimmed = line.trim();
	if (trimmed === "devhub-relay connected") return { kind: "connected" };
	const refused = /^devhub-relay refused (\S+)$/.exec(trimmed);
	if (refused?.[1] !== undefined) {
		return { kind: "refused", code: refused[1] };
	}
	return undefined;
}

/** A refused relay, shaped like the errno a local `connect` rejects with. */
export class RelayRefused extends Error {
	constructor(
		readonly code: string,
		readonly socketPath: string,
	) {
		super(`Neovim at ${socketPath} refused the connection (${code})`);
		this.name = "RelayRefused";
	}
}

/** A spawned relay, as the client and the handshake need it. */
export interface RelayProcess {
	readonly stdin: { write(bytes: Uint8Array): void; end(): void };
	onStdout(listener: (chunk: Uint8Array) => void): void;
	onStderr(listener: (chunk: Uint8Array) => void): void;
	/** Once: the process and its pipes are gone. */
	onExit(listener: (code: number | null) => void): void;
	kill(): void;
}

/** `child_process.spawn` of a launch, as a `RelayProcess`. */
export function spawnRelayProcess(launch: StreamLaunch): RelayProcess {
	const child = spawn(launch.file, [...launch.args], {
		stdio: ["pipe", "pipe", "pipe"],
		env: launch.env as NodeJS.ProcessEnv,
		...(launch.cwd === undefined ? {} : { cwd: launch.cwd }),
	});
	let released = false;
	const release = (): void => {
		if (released) return;
		released = true;
		launch.release?.();
	};
	child.on("close", release);
	child.on("error", release);
	// A write after the far end went is EPIPE, and the close that follows is
	// where the ending is handled.
	child.stdin.on("error", () => undefined);
	return {
		stdin: {
			write: (bytes) => {
				if (!child.stdin.destroyed) child.stdin.write(bytes);
			},
			end: () => {
				child.stdin.end();
			},
		},
		onStdout: (listener) => {
			child.stdout.on("data", listener);
		},
		onStderr: (listener) => {
			child.stderr.on("data", listener);
		},
		onExit: (listener) => {
			let told = false;
			const tell = (code: number | null): void => {
				if (told) return;
				told = true;
				listener(code);
			};
			child.on("close", (code) => {
				tell(code);
			});
			child.on("error", () => {
				tell(null);
			});
		},
		kill: () => {
			// EOF first: killing a local `ssh` sends nothing across, closing its
			// stdin is how the relay over there learns DevHub let go.
			child.stdin.end();
			child.kill("SIGTERM");
		},
	};
}

/** How long the far end has to say whether it reached the socket. */
export const RELAY_CONNECT_TIMEOUT_MS = 15_000;

/**
 * Connect to a Neovim's socket on another machine through a relay process,
 * resolving once the relay says it is connected. Rejects with `RelayRefused`
 * (a `code` of `ENOENT` or `ECONNREFUSED`) for a socket with nobody behind
 * it, and with what the relay said on stderr when it could not run at all.
 */
export function connectThroughRelay(
	relay: RelayProcess,
	socketPath: string,
	options: {
		readonly timeoutMs?: number;
		readonly requestTimeoutMs?: number;
		readonly log?: (line: string) => void;
	} = {},
): Promise<NeovimRpc> {
	return new Promise((resolve, reject) => {
		let stderr = "";
		let stderrTail = "";
		let settled = false;
		let exited = false;
		const dataListeners: ((chunk: Uint8Array) => void)[] = [];
		const closeListeners: (() => void)[] = [];
		const early: Uint8Array[] = [];
		const timer = setTimeout(() => {
			fail(
				new Error(
					`the relay to Neovim at ${socketPath} did not connect within ${String((options.timeoutMs ?? RELAY_CONNECT_TIMEOUT_MS) / 1_000)} seconds`,
				),
			);
		}, options.timeoutMs ?? RELAY_CONNECT_TIMEOUT_MS);
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			relay.kill();
			reject(error);
		};
		relay.onStdout((chunk) => {
			if (dataListeners.length === 0) early.push(chunk);
			for (const listener of dataListeners) listener(chunk);
		});
		relay.onStderr((chunk) => {
			stderr += Buffer.from(chunk).toString("utf8");
			for (;;) {
				const newline = stderr.indexOf("\n");
				if (newline < 0) break;
				const line = stderr.slice(0, newline);
				stderr = stderr.slice(newline + 1);
				const handshake = settled ? undefined : parseRelayLine(line);
				if (handshake === undefined) {
					if (line.trim().length > 0) options.log?.(line.trim());
					stderrTail = line.trim().length > 0 ? line.trim() : stderrTail;
					continue;
				}
				if (handshake.kind === "refused") {
					fail(new RelayRefused(handshake.code, socketPath));
					continue;
				}
				settled = true;
				clearTimeout(timer);
				const wire: NeovimWire = {
					write: (bytes) => {
						relay.stdin.write(bytes);
					},
					onData: (listener) => {
						dataListeners.push(listener);
						for (const chunk of early.splice(0)) listener(chunk);
					},
					onClose: (listener) => {
						if (exited) listener();
						else closeListeners.push(listener);
					},
					destroy: () => {
						relay.kill();
					},
				};
				resolve(
					NeovimClient.over(
						wire,
						options.requestTimeoutMs === undefined
							? {}
							: { timeoutMs: options.requestTimeoutMs },
					),
				);
			}
		});
		relay.onExit((code) => {
			exited = true;
			for (const listener of closeListeners.splice(0)) listener();
			const tail = (stderrTail || stderr).trim();
			fail(
				new Error(
					tail.length > 0
						? `the relay to Neovim at ${socketPath} ended: ${tail}`
						: `the relay to Neovim at ${socketPath} exited ${String(code)} before it connected`,
				),
			);
		});
	});
}
