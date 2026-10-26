/**
 * The RPC client against a server speaking msgpack-rpc on a real unix socket:
 * a stand-in for Neovim, so the client's half of the protocol — requests,
 * responses split across reads, errors, and a closed connection being the
 * server's exit — is checked on every machine, Neovim installed or not.
 * `neovim.real.test.ts` runs the same client against a real Neovim.
 */

import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { decode, encode, MsgpackIncomplete } from "./msgpack.js";
import { NeovimClient, NeovimRpcError } from "./neovimRpc.js";
import { makeSocketDir } from "../../model/testScratch.js";

const servers: Server[] = [];
/** What the fake answers to leave a request unanswered. */
const NO_ANSWER = Symbol("no answer");
const directories: string[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.close();
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

/**
 * A fake Neovim: answers each request with `answer(method, params)`, a
 * thrown error becoming an RPC error. `split` sends every response a byte at
 * a time, which is what a reader that assumes one message per read gets wrong.
 */
async function fakeNeovim(
	answer: (method: string, params: unknown[]) => unknown,
	options: { readonly split?: boolean } = {},
): Promise<{ path: string; sockets: Socket[] }> {
	const directory = makeSocketDir("nvim-rpc");
	directories.push(directory);
	const path = join(directory, "fake.sock");
	const sockets: Socket[] = [];
	const server = createServer((socket) => {
		sockets.push(socket);
		let buffered = Buffer.alloc(0);
		socket.on("data", (chunk) => {
			buffered = Buffer.concat([buffered, chunk]);
			for (;;) {
				let message;
				try {
					message = decode(buffered);
				} catch (error) {
					if (error instanceof MsgpackIncomplete) return;
					throw error;
				}
				buffered = buffered.subarray(message.length);
				const [, id, method, params] = message.value as [
					number,
					number,
					string,
					unknown[],
				];
				let response: unknown[];
				try {
					const result = answer(method, params);
					if (result === NO_ANSWER) continue;
					response = [1, id, null, result];
				} catch (error) {
					response = [1, id, [0, (error as Error).message], null];
				}
				const bytes = encode(response);
				if (options.split) {
					for (const byte of bytes) socket.write(Uint8Array.from([byte]));
				} else {
					socket.write(bytes);
				}
			}
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(path, resolve));
	return { path, sockets };
}

describe("talking to a Neovim server", () => {
	it("sends a request and reads its answer, however the bytes arrive", async () => {
		const { path } = await fakeNeovim(
			(method, params) => ({ method, params }),
			{ split: true },
		);
		const client = await NeovimClient.connect(path);
		const [one, two] = await Promise.all([
			client.request("nvim_get_mode", []),
			client.request("nvim_exec_lua", ["return ...", ["/a b", 3]]),
		]);
		expect(one).toEqual({ method: "nvim_get_mode", params: [] });
		expect(two).toEqual({
			method: "nvim_exec_lua",
			params: ["return ...", ["/a b", 3]],
		});
		client.close();
	});

	it("rejects with Neovim's own words when it refuses a request", async () => {
		const { path } = await fakeNeovim(() => {
			throw new Error("Vim:E492: Not an editor command");
		});
		const client = await NeovimClient.connect(path);
		const refused = client.request("nvim_command", ["nonsense"]);
		await expect(refused).rejects.toBeInstanceOf(NeovimRpcError);
		await expect(refused).rejects.toThrow("E492");
		client.close();
	});

	it("hears the server go away, and fails what was waiting on it", async () => {
		const { path, sockets } = await fakeNeovim(() => NO_ANSWER);
		const client = await NeovimClient.connect(path);
		let heard = 0;
		client.onClose(() => {
			heard += 1;
		});
		const waiting = client.request("nvim_get_mode", []);
		// Received and left unanswered, then the server is gone.
		await new Promise((resolve) => setTimeout(resolve, 30));
		for (const socket of sockets) socket.destroy();
		await expect(waiting).rejects.toThrow("closed");
		expect(client.closed).toBe(true);
		expect(heard).toBe(1);
		// Too late to register is not too late to hear it.
		let late = false;
		client.onClose(() => {
			late = true;
		});
		expect(late).toBe(true);
		await expect(client.request("nvim_get_mode", [])).rejects.toThrow("closed");
	});

	it("tells a stale socket file from a live server by the errno", async () => {
		const directory = makeSocketDir("nvim-stale");
		directories.push(directory);
		const missing = join(directory, "missing.sock");
		await expect(NeovimClient.connect(missing)).rejects.toMatchObject({
			code: "ENOENT",
		});
		// A plain file where the socket should be is refused too, not hung on.
		const file = join(directory, "file.sock");
		writeFileSync(file, "");
		await expect(NeovimClient.connect(file)).rejects.toHaveProperty("code");
	});
});
