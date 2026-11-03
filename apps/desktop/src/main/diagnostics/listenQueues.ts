/**
 * Who is waiting to be accepted on a frozen workbench's listening sockets.
 *
 * A stopped process cannot `accept()`, but the kernel still completes the
 * handshake of every TCP connection to its listening sockets and queues it.
 * A queue that is not empty is somebody trying to reach a frozen workbench —
 * an extension's loopback server, a language server's port — and the
 * workbench is thawed for it (`WorkbenchLifecycle.connectionArrived`).
 *
 * The owners are read once, when a workbench is frozen: a stopped process
 * opens no socket, so the set it listens on cannot change until it is
 * thawed. Each poll is then one reading of every queue, for every frozen pid
 * at once:
 *
 * - **macOS**: owners from `lsof -F pn`, queues from `netstat -Lan -p tcp`
 *   (`qlen/incqlen/maxqlen` and the local address). netstat names no owner,
 *   so the two are joined on the local address.
 * - **Linux** (tests, CI): owners from `/proc/<pid>/fd` (`socket:[inode]`),
 *   queues from `/proc/net/tcp` and `tcp6`, whose `rx_queue` of a listening
 *   socket is its accept backlog. Joined on the inode.
 *
 * Only TCP. Pure parsing, tested on fixtures; reading is the caller's.
 */

/** A listening socket as both readings name it: `host:port`, or `inode:<n>`. */
export type SocketKey = string;

export interface ListeningSocket {
	readonly pid: number;
	readonly key: SocketKey;
}

export interface ListenQueue {
	readonly key: SocketKey;
	/** Connections completed and waiting to be accepted. */
	readonly queued: number;
}

export const NETSTAT_LISTEN_ARGUMENTS: readonly string[] = [
	"-Lan",
	"-p",
	"tcp",
];

export function lsofListenArguments(pids: readonly number[]): string[] {
	return [
		"-nP",
		"-a",
		"-p",
		pids.join(","),
		"-iTCP",
		"-sTCP:LISTEN",
		"-F",
		"pn",
	];
}

/** `*` for a wildcard; otherwise the address without brackets or zone. */
function hostKey(raw: string): string {
	const bare = raw.replace(/^\[|\]$/gu, "").replace(/%.*$/u, "");
	return bare === "*" || bare === "0.0.0.0" || bare === "::" ? "*" : bare;
}

function addressKey(host: string, port: string): SocketKey | undefined {
	const number = Number(port);
	if (!Number.isInteger(number) || number <= 0) return undefined;
	return `${hostKey(host)}:${String(number)}`;
}

/** macOS `netstat -Lan -p tcp`: `qlen/incqlen/maxqlen  host.port`. */
export function parseNetstatListenQueues(stdout: string): ListenQueue[] {
	const queues: ListenQueue[] = [];
	for (const line of stdout.split("\n")) {
		const match = /^\s*(\d+)\/(\d+)\/(\d+)\s+(\S+)/u.exec(line);
		if (!match) continue;
		const address = match[4]!;
		const at = address.lastIndexOf(".");
		if (at <= 0) continue;
		const key = addressKey(address.slice(0, at), address.slice(at + 1));
		if (key !== undefined) queues.push({ key, queued: Number(match[1]) });
	}
	return queues;
}

/** macOS `lsof -nP -a -p … -iTCP -sTCP:LISTEN -F pn`: `p<pid>`, `n<host:port>`. */
export function parseLsofListening(stdout: string): ListeningSocket[] {
	const sockets: ListeningSocket[] = [];
	let pid: number | undefined;
	for (const line of stdout.split("\n")) {
		if (line.startsWith("p")) {
			pid = Number(line.slice(1));
			continue;
		}
		if (!line.startsWith("n") || pid === undefined) continue;
		const name = line.slice(1).split(" ")[0]!;
		const at = name.lastIndexOf(":");
		if (at <= 0) continue;
		const key = addressKey(name.slice(0, at), name.slice(at + 1));
		if (key !== undefined) sockets.push({ pid, key });
	}
	return sockets;
}

/** The socket inodes among one process's `/proc/<pid>/fd` link targets. */
export function socketInodes(links: readonly string[]): SocketKey[] {
	return links.flatMap((link) => {
		const match = /^socket:\[(\d+)\]$/u.exec(link);
		return match ? [`inode:${match[1]!}`] : [];
	});
}

/** Linux `/proc/net/tcp` or `tcp6`: every listening socket's backlog. */
export function parseProcNetTcp(text: string): ListenQueue[] {
	const queues: ListenQueue[] = [];
	for (const line of text.split("\n")) {
		// sl local rem st tx_queue:rx_queue tr:when retrnsmt uid timeout inode
		const fields = line.trim().split(/\s+/u);
		if (fields.length < 10 || fields[3] !== "0A") continue;
		const rx = fields[4]!.split(":")[1];
		if (rx === undefined) continue;
		queues.push({
			key: `inode:${fields[9]!}`,
			queued: Number.parseInt(rx, 16),
		});
	}
	return queues;
}

/** The pids, of those given, with a connection waiting on a socket they listen on. */
export function pidsWithWaitingConnections(
	sockets: readonly ListeningSocket[],
	queues: readonly ListenQueue[],
): Set<number> {
	const waiting = new Set(
		queues.filter((queue) => queue.queued > 0).map((queue) => queue.key),
	);
	return new Set(
		sockets.filter((socket) => waiting.has(socket.key)).map(({ pid }) => pid),
	);
}
