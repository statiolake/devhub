/**
 * Ports in a dev container, reachable on this Mac.
 *
 * VS Code's Ports view, its automatic forwarding ("Your application running
 * on port 3000 is available") and `devcontainer.json`'s `forwardPorts` all end
 * in one question: give me a port on this Mac that reaches port N over there.
 * The workbench asks it through the resolver's `tunnelFactory`
 * (`extensions/devhub-remote`), which asks DevHub over the control socket, and
 * this is the answer: a listener on loopback whose every accepted connection
 * gets a relay of its own into the container — the same shape as the bridge to
 * the remote extension host, pointed at a TCP port instead of a unix socket.
 *
 * **The local port is a wish, not a demand.** VS Code asks for the same port
 * number it found over there, and a person's own Postgres on 5432 is a
 * perfectly good reason for that to be taken. So the forward takes the next
 * port the OS gives it, and the Ports view shows which — unless the definition
 * said `requireLocalPort`, which is the person saying a different port is no
 * use to them.
 *
 * **`localhost`, both of them.** A browser opened on `http://localhost:3000`
 * may try `::1` before `127.0.0.1`, and a forward on only one of them is a
 * forward that works in one browser. So the port is taken on both loopbacks,
 * and a port whose `::1` half belongs to somebody else is not taken at all —
 * that would be a `localhost` that reaches two different programs.
 *
 * **Never `0.0.0.0`.** A forwarded dev server is the person's, not their
 * network's.
 */

import { createServer, type Server, type Socket } from "node:net";

/** One forwarded port: where it listens here, and how to stop it. */
export interface PortForward {
	readonly remoteHost: string;
	readonly remotePort: number;
	readonly localPort: number;
	close(): void;
}

/** Bind `server` on `host:port`, or say why not. */
function bind(
	server: Server,
	port: number,
	host: string,
): Promise<NodeJS.ErrnoException | undefined> {
	return new Promise((resolve) => {
		const onError = (error: NodeJS.ErrnoException): void => {
			server.off("listening", onListening);
			resolve(error);
		};
		const onListening = (): void => {
			server.off("error", onError);
			resolve(undefined);
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen({ port, host, exclusive: true });
	});
}

function boundPort(server: Server): number {
	const address = server.address();
	return address !== null && typeof address === "object" ? address.port : 0;
}

/** The IPv6 loopback being absent is not a reason to refuse a forward. */
function noSuchAddress(error: NodeJS.ErrnoException): boolean {
	return error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT";
}

/**
 * Listen on `localhost` at `preferred`, or at a port the OS picks when
 * `preferred` is taken (or not given). Rejects only when `required` and the
 * preferred port is not to be had, or when loopback refuses outright.
 */
export async function listenOnLocalhost(
	onConnection: (socket: Socket) => void,
	preferred: number | undefined,
	required = false,
): Promise<{ port: number; close: () => void }> {
	const ATTEMPTS = 5;
	let wanted = preferred !== undefined && preferred > 0 ? preferred : 0;
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		const v4 = createServer(onConnection);
		const failedV4 = await bind(v4, wanted, "127.0.0.1");
		if (failedV4 !== undefined) {
			if (wanted !== 0 && !required) {
				wanted = 0;
				continue;
			}
			throw new Error(
				wanted === 0
					? `DevHub could not listen on 127.0.0.1: ${failedV4.message}`
					: `Local port ${String(wanted)} is already in use.`,
			);
		}
		const port = boundPort(v4);
		const v6 = createServer(onConnection);
		const failedV6 = await bind(v6, port, "::1");
		if (failedV6 === undefined) {
			return {
				port,
				close: () => {
					v4.close();
					v6.close();
				},
			};
		}
		if (noSuchAddress(failedV6)) {
			return { port, close: () => v4.close() };
		}
		// `::1:<port>` is somebody else's: `localhost:<port>` would be two
		// programs. Let go and try another.
		v4.close();
		if (required && wanted !== 0) {
			throw new Error(`Local port ${String(wanted)} is already in use.`);
		}
		wanted = 0;
	}
	throw new Error("DevHub could not find a free local port for the forward.");
}

/**
 * Every port forwarded into one container, so that they go when it does.
 *
 * `connect` is the relay: given an accepted socket, carry it to
 * `remoteHost:remotePort` inside the container. It is the container's
 * business, which is why it is passed in.
 */
export class PortForwards {
	readonly #open = new Set<PortForward>();

	constructor(
		private readonly connect: (
			socket: Socket,
			remoteHost: string,
			remotePort: number,
		) => void,
		private readonly listen: typeof listenOnLocalhost = listenOnLocalhost,
	) {}

	async open(
		remoteHost: string,
		remotePort: number,
		localPort?: number,
		requireLocalPort = false,
	): Promise<PortForward> {
		const listener = await this.listen(
			(socket) => this.connect(socket, remoteHost, remotePort),
			localPort,
			requireLocalPort,
		);
		const forward: PortForward = {
			remoteHost,
			remotePort,
			localPort: listener.port,
			close: () => {
				if (!this.#open.delete(forward)) return;
				listener.close();
			},
		};
		this.#open.add(forward);
		return forward;
	}

	get size(): number {
		return this.#open.size;
	}

	closeAll(): void {
		for (const forward of [...this.#open]) forward.close();
	}
}

/** What a `devcontainer.json` says about ports, as the resolver needs it. */
export interface PortsConfiguration {
	/** `forwardPorts` and `appPort`, as `{ host, port }`. */
	readonly forwardPorts: readonly { host: string; port: number }[];
	/** `portsAttributes`, verbatim: keys are ports, ranges or patterns. */
	readonly portsAttributes: Readonly<Record<string, unknown>>;
	readonly otherPortsAttributes?: Readonly<Record<string, unknown>>;
}

function validPort(value: number): boolean {
	return Number.isInteger(value) && value > 0 && value < 65536;
}

/** `3000`, `"3000"`, `"db:5432"`; anything else is not a port. */
export function parsePortEntry(
	entry: unknown,
): { host: string; port: number } | undefined {
	if (typeof entry === "number") {
		return validPort(entry) ? { host: "localhost", port: entry } : undefined;
	}
	if (typeof entry !== "string") return undefined;
	const match = /^(?:(.+):)?(\d+)$/u.exec(entry.trim());
	if (match === null) return undefined;
	const port = Number(match[2]);
	if (!validPort(port)) return undefined;
	return { host: match[1] ?? "localhost", port };
}

/**
 * `appPort` is docker's `-p` spelling: `3000`, `"8080:3000"`,
 * `"127.0.0.1:8080:3000"`. The container side is the last number, and that is
 * the port to forward — a published port already has a host side, but
 * forwarding it too is what makes it show up in the Ports view.
 */
function appPortEntry(
	entry: unknown,
): { host: string; port: number } | undefined {
	if (typeof entry === "number") return parsePortEntry(entry);
	if (typeof entry !== "string") return undefined;
	const last = entry.split("/")[0]?.split(":").at(-1) ?? "";
	return /^\d+$/u.test(last) ? parsePortEntry(Number(last)) : undefined;
}

/** The ports a merged `devcontainer.json` asks for. */
export function portsFromConfiguration(
	configuration: Readonly<Record<string, unknown>>,
): PortsConfiguration {
	const seen = new Set<string>();
	const forwardPorts: { host: string; port: number }[] = [];
	const add = (entry: { host: string; port: number } | undefined): void => {
		if (entry === undefined) return;
		const key = `${entry.host}:${String(entry.port)}`;
		if (seen.has(key)) return;
		seen.add(key);
		forwardPorts.push(entry);
	};
	const forward = configuration["forwardPorts"];
	if (Array.isArray(forward))
		for (const entry of forward) add(parsePortEntry(entry));
	const app = configuration["appPort"];
	for (const entry of Array.isArray(app)
		? app
		: app === undefined
			? []
			: [app]) {
		add(appPortEntry(entry));
	}
	const objectOf = (value: unknown): Record<string, unknown> | undefined =>
		typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	const portsAttributes = objectOf(configuration["portsAttributes"]) ?? {};
	const other = objectOf(configuration["otherPortsAttributes"]);
	return other === undefined
		? { forwardPorts, portsAttributes }
		: { forwardPorts, portsAttributes, otherPortsAttributes: other };
}
