/**
 * Forwarded ports, over real loopback sockets: the relay into the container is
 * replaced by an echo, which is the only part that is the container's.
 */

import { connect, createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
	listenOnLocalhost,
	parsePortEntry,
	PortForwards,
	portsFromConfiguration,
} from "./portForward.js";

const closers: (() => void)[] = [];
afterEach(() => {
	for (const close of closers.splice(0)) close();
});

function occupy(): Promise<{ port: number; server: Server }> {
	return new Promise((resolve) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			closers.push(() => server.close());
			resolve({
				port: typeof address === "object" && address ? address.port : 0,
				server,
			});
		});
	});
}

function roundTrip(port: number, text: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = connect(port, "127.0.0.1");
		let got = "";
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.end(text));
		socket.on("data", (chunk: string) => {
			got += chunk;
		});
		socket.on("close", () => resolve(got));
		socket.on("error", reject);
	});
}

describe("listenOnLocalhost", () => {
	it("takes the port it was asked for when it is free", async () => {
		const free = await occupy();
		free.server.close();
		await new Promise((resolve) => setTimeout(resolve, 20));
		const listener = await listenOnLocalhost(() => {}, free.port);
		closers.push(listener.close);
		expect(listener.port).toBe(free.port);
	});

	it("takes another port when the one asked for is in use", async () => {
		const taken = await occupy();
		const listener = await listenOnLocalhost(() => {}, taken.port);
		closers.push(listener.close);
		expect(listener.port).not.toBe(taken.port);
		expect(listener.port).toBeGreaterThan(0);
	});

	it("refuses when the port is in use and it was required", async () => {
		const taken = await occupy();
		await expect(listenOnLocalhost(() => {}, taken.port, true)).rejects.toThrow(
			/already in use/u,
		);
	});
});

describe("PortForwards", () => {
	it("relays each connection, and stops listening when closed", async () => {
		const relayed: string[] = [];
		const forwards = new PortForwards((socket: Socket, host, port) => {
			relayed.push(`${host}:${String(port)}`);
			// The container's side: an echo.
			socket.pipe(socket);
		});
		closers.push(() => forwards.closeAll());
		const forward = await forwards.open("localhost", 3000);
		expect(await roundTrip(forward.localPort, "hello")).toBe("hello");
		expect(relayed).toEqual(["localhost:3000"]);
		expect(forwards.size).toBe(1);
		forward.close();
		expect(forwards.size).toBe(0);
		await expect(roundTrip(forward.localPort, "x")).rejects.toThrow();
	});

	it("closes every forward at once", async () => {
		const forwards = new PortForwards((socket) => socket.destroy());
		await forwards.open("localhost", 1);
		await forwards.open("db", 5432);
		forwards.closeAll();
		expect(forwards.size).toBe(0);
	});
});

describe("ports in a definition", () => {
	it("reads forwardPorts in each spelling", () => {
		expect(parsePortEntry(3000)).toEqual({ host: "localhost", port: 3000 });
		expect(parsePortEntry("3000")).toEqual({ host: "localhost", port: 3000 });
		expect(parsePortEntry("db:5432")).toEqual({ host: "db", port: 5432 });
		expect(parsePortEntry("nope")).toBeUndefined();
		expect(parsePortEntry(0)).toBeUndefined();
		expect(parsePortEntry(70000)).toBeUndefined();
	});

	it("forwards appPort's container side, once", () => {
		expect(
			portsFromConfiguration({
				forwardPorts: [3000, "db:5432", 3000],
				appPort: ["8080:3000", "127.0.0.1:9000:9001", 4000],
				portsAttributes: { "3000": { label: "web" } },
				otherPortsAttributes: { onAutoForward: "silent" },
			}),
		).toEqual({
			forwardPorts: [
				{ host: "localhost", port: 3000 },
				{ host: "db", port: 5432 },
				{ host: "localhost", port: 9001 },
				{ host: "localhost", port: 4000 },
			],
			portsAttributes: { "3000": { label: "web" } },
			otherPortsAttributes: { onAutoForward: "silent" },
		});
	});

	it("reads a single appPort and a definition with nothing", () => {
		expect(portsFromConfiguration({ appPort: 3000 }).forwardPorts).toEqual([
			{ host: "localhost", port: 3000 },
		]);
		expect(portsFromConfiguration({})).toEqual({
			forwardPorts: [],
			portsAttributes: {},
		});
	});
});
