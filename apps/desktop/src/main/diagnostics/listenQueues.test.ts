/**
 * A connection waiting on a frozen workbench's listening socket, read from
 * macOS's netstat + lsof and from Linux's /proc, on fixtures.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	parseLsofListening,
	parseNetstatListenQueues,
	parseProcNetTcp,
	pidsWithWaitingConnections,
	socketInodes,
} from "./listenQueues.js";

const fixture = (name: string) =>
	readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("macOS: netstat -Lan and lsof", () => {
	it("reads each listening socket's queue and its address", () => {
		expect(parseNetstatListenQueues(fixture("netstat-Lan-darwin.txt"))).toEqual(
			[
				{ key: "127.0.0.1:53117", queued: 0 },
				{ key: "127.0.0.1:49731", queued: 2 },
				{ key: "*:3000", queued: 0 },
				{ key: "::1:49731", queued: 1 },
				{ key: "fe80::1:631", queued: 0 },
			],
		);
	});

	it("reads who listens where, brackets and wildcards as netstat says them", () => {
		expect(parseLsofListening(fixture("lsof-listen-darwin.txt"))).toEqual([
			{ pid: 121, key: "127.0.0.1:49731" },
			{ pid: 121, key: "::1:49731" },
			{ pid: 122, key: "*:3000" },
			{ pid: 124, key: "127.0.0.1:53117" },
		]);
	});

	it("names the pids somebody is waiting for, and only those", () => {
		const waiting = pidsWithWaitingConnections(
			parseLsofListening(fixture("lsof-listen-darwin.txt")),
			parseNetstatListenQueues(fixture("netstat-Lan-darwin.txt")),
		);
		expect([...waiting]).toEqual([121]);
	});

	it("an empty reading is nobody waiting", () => {
		expect(parseNetstatListenQueues("")).toEqual([]);
		expect(parseLsofListening("")).toEqual([]);
		expect(pidsWithWaitingConnections([], [])).toEqual(new Set());
	});
});

describe("Linux: /proc/net/tcp and /proc/<pid>/fd", () => {
	it("reads the backlog of listening sockets only, by inode", () => {
		expect(parseProcNetTcp(fixture("proc-net-tcp-linux.txt"))).toEqual([
			{ key: "inode:1138", queued: 0 },
			{ key: "inode:3108", queued: 3 },
		]);
	});

	it("keeps only the socket links of a process's fds", () => {
		expect(
			socketInodes(["/dev/null", "socket:[3108]", "pipe:[1]", "socket:[9]"]),
		).toEqual(["inode:3108", "inode:9"]);
	});

	it("joins the two on the inode", () => {
		const waiting = pidsWithWaitingConnections(
			[
				{ pid: 40, key: "inode:1138" },
				{ pid: 41, key: "inode:3108" },
			],
			parseProcNetTcp(fixture("proc-net-tcp-linux.txt")),
		);
		expect([...waiting]).toEqual([41]);
	});
});
