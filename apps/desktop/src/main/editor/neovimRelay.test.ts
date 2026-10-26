/**
 * The relay's client half, with the relay process faked: the handshake on
 * stderr, a refusal carried as an errno `code`, a relay that dies before it
 * says anything, and its exit being the connection's end. The relay itself
 * runs against a real Neovim at the bottom, when there is one
 * (`DEVHUB_TEST_NVIM`); the whole lifecycle through it, in a real tmux, is in
 * `test/terminal/editorPanes.real.test.ts`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encode } from "./msgpack.js";
import {
	connectThroughRelay,
	NEOVIM_RELAY_LUA,
	parseRelayLine,
	relayArgv,
	relayFileName,
	RelayRefused,
	spawnRelayProcess,
	type RelayProcess,
} from "./neovimRelay.js";
import { makeSocketDir } from "../../model/testScratch.js";

/** A relay process whose every stream the test drives. */
class FakeRelay implements RelayProcess {
	readonly written: Uint8Array[] = [];
	killed = false;
	private readonly stdout: ((chunk: Uint8Array) => void)[] = [];
	private readonly stderr: ((chunk: Uint8Array) => void)[] = [];
	private readonly exit: ((code: number | null) => void)[] = [];
	readonly stdin = {
		write: (bytes: Uint8Array) => {
			this.written.push(bytes);
		},
		end: () => undefined,
	};

	onStdout(listener: (chunk: Uint8Array) => void): void {
		this.stdout.push(listener);
	}
	onStderr(listener: (chunk: Uint8Array) => void): void {
		this.stderr.push(listener);
	}
	onExit(listener: (code: number | null) => void): void {
		this.exit.push(listener);
	}
	kill(): void {
		this.killed = true;
		this.ends(null);
	}

	says(text: string): void {
		for (const listener of this.stderr) listener(Buffer.from(text));
	}
	answers(value: unknown): void {
		for (const listener of this.stdout) listener(encode(value));
	}
	ends(code: number | null): void {
		for (const listener of this.exit.splice(0)) listener(code);
	}
}

describe("the relay's handshake", () => {
	it("reads the two lines the relay says, and nothing else", () => {
		expect(parseRelayLine("devhub-relay connected")).toEqual({
			kind: "connected",
		});
		expect(parseRelayLine("devhub-relay refused ECONNREFUSED\n")).toEqual({
			kind: "refused",
			code: "ECONNREFUSED",
		});
		expect(parseRelayLine("E5113: Error while calling lua chunk")).toBe(
			undefined,
		);
	});

	it("names its file by its content", () => {
		expect(relayFileName()).toMatch(/^devhub-relay-[0-9a-f]{12}\.lua$/u);
		expect(relayArgv("/n", "/r.lua", "/s.sock")).toEqual([
			"/n",
			"--clean",
			"--headless",
			"-n",
			"-i",
			"NONE",
			"-l",
			"/r.lua",
			"/s.sock",
		]);
	});

	it("connects once the relay says so, and carries RPC both ways", async () => {
		const relay = new FakeRelay();
		const connecting = connectThroughRelay(relay, "/run/a.sock");
		relay.says("devhub-relay conn");
		relay.says("ected\n");
		const client = await connecting;
		const answer = client.request("nvim_eval", ["1+1"]);
		expect(relay.written).toHaveLength(1);
		relay.answers([1, 1, null, 2]);
		expect(await answer).toBe(2);
		let closed = false;
		client.onClose(() => {
			closed = true;
		});
		// The relay ending is the server having gone.
		relay.ends(0);
		expect(closed).toBe(true);
		expect(client.closed).toBe(true);
	});

	it("rejects a refusal with the errno as its code, so a stale socket reads as one", async () => {
		const relay = new FakeRelay();
		const connecting = connectThroughRelay(relay, "/run/a.sock");
		relay.says("devhub-relay refused ECONNREFUSED\n");
		const error = await connecting.catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(RelayRefused);
		expect((error as RelayRefused).code).toBe("ECONNREFUSED");
		expect(relay.killed).toBe(true);
	});

	it("says what the relay said when it could not run at all", async () => {
		const relay = new FakeRelay();
		const connecting = connectThroughRelay(relay, "/run/a.sock");
		relay.says(
			"nvim: error while loading shared libraries: libnsl.so.1: cannot open shared object file\n",
		);
		relay.ends(127);
		await expect(connecting).rejects.toThrow(/libnsl\.so\.1/u);
	});

	it("gives up on a relay that never answers", async () => {
		const relay = new FakeRelay();
		await expect(
			connectThroughRelay(relay, "/run/a.sock", { timeoutMs: 20 }),
		).rejects.toThrow(/did not connect/u);
		expect(relay.killed).toBe(true);
	});
});

function findNvim(): string | undefined {
	const named = process.env.DEVHUB_TEST_NVIM;
	if (named !== undefined && named.length > 0) return named;
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		const candidate = join(directory, "nvim");
		if (directory.length > 0 && existsSync(candidate)) return candidate;
	}
	return undefined;
}

const NVIM = findNvim();
const children: ChildProcess[] = [];
const directories: string[] = [];

afterEach(() => {
	for (const child of children.splice(0)) child.kill("SIGKILL");
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe.skipIf(NVIM === undefined)("the relay, run by a real Neovim", () => {
	function relayTo(directory: string, socket: string): RelayProcess {
		const relayPath = join(directory, relayFileName());
		writeFileSync(relayPath, NEOVIM_RELAY_LUA);
		const [file, ...args] = relayArgv(NVIM as string, relayPath, socket);
		return spawnRelayProcess({
			file: file as string,
			args,
			cwd: undefined,
			env: process.env,
		});
	}

	it("says ENOENT for a socket that is not there", async () => {
		const directory = makeSocketDir("relay");
		directories.push(directory);
		const error = await connectThroughRelay(
			relayTo(directory, join(directory, "none.sock")),
			join(directory, "none.sock"),
		).catch((failure: unknown) => failure);
		expect((error as RelayRefused).code).toBe("ENOENT");
	});

	it("carries RPC to a server, and ends when the server does", async () => {
		const directory = makeSocketDir("relay");
		directories.push(directory);
		const socket = join(directory, "n.sock");
		const server = spawn(
			NVIM as string,
			["--headless", "--clean", "--listen", socket],
			{ stdio: "ignore" },
		);
		children.push(server);
		for (let attempt = 0; attempt < 200 && !existsSync(socket); attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		const client = await connectThroughRelay(
			relayTo(directory, socket),
			socket,
		);
		expect(await client.request("nvim_eval", ["6*7"])).toBe(42);
		// A large answer crosses whole: the relay flushes before it exits.
		const big = (await client.request("nvim_eval", [
			"repeat('x', 300000)",
		])) as string;
		expect(big.length).toBe(300_000);
		const closed = new Promise<void>((resolve) => {
			client.onClose(resolve);
		});
		await client.request("nvim_command", ["qa!"]).catch(() => undefined);
		await closed;
		expect(client.closed).toBe(true);
	}, 20_000);
});
