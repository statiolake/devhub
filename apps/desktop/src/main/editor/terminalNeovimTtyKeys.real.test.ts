/**
 * The shim's tty reader against a real Neovim: the bytes tmux writes into a
 * pane, in each encoding tmux may use, arrive as that Neovim's keys and
 * pastes. DevHub's own Neovim (`testNeovim.ts`).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NeovimClient } from "./neovimRpc.js";
import { TTY_KEYS_LUA } from "./terminalNeovimTtyKeys.js";
import { makeScratchDir, makeSocketDir } from "../../model/testScratch.js";
import { TEST_NVIM } from "./testNeovim.js";

const NVIM = TEST_NVIM;
const children: ChildProcess[] = [];
const directories: string[] = [];

afterEach(() => {
	for (const child of children.splice(0)) child.kill("SIGKILL");
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

const RECORD = `
_G.got = {}
_G.pasted = {}
vim.on_key(function(key, typed)
	typed = typed or key
	if typed ~= "" then table.insert(_G.got, vim.fn.keytrans(typed)) end
end)
local paste = vim.paste
vim.paste = function(lines, phase)
	table.insert(_G.pasted, table.concat(lines, "\\n"))
	return paste(lines, phase)
end
`;

async function start(): Promise<{
	client: NeovimClient;
	reader: ChildProcess;
}> {
	const sockets = makeSocketDir("nvim-keys");
	const scratch = makeScratchDir("nvim-keys");
	directories.push(sockets, scratch);
	const socket = join(sockets, "n.sock");
	children.push(
		spawn(NVIM as string, ["--headless", "--clean", "--listen", socket], {
			stdio: "ignore",
		}),
	);
	let client: NeovimClient | undefined;
	for (let attempt = 0; attempt < 200 && client === undefined; attempt += 1) {
		if (existsSync(socket)) {
			client = await NeovimClient.connect(socket).catch(() => undefined);
		}
		if (client === undefined) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	if (client === undefined) throw new Error("nvim did not open its socket");
	await client.request("nvim_exec_lua", [RECORD, []]);
	const script = join(scratch, "keys.lua");
	writeFileSync(script, TTY_KEYS_LUA);
	const reader = spawn(
		NVIM as string,
		["-u", "NONE", "-i", "NONE", "-n", "--headless", "-l", script, socket],
		{ stdio: ["pipe", "ignore", "ignore"] },
	);
	children.push(reader);
	return { client, reader };
}

/**
 * The keys Neovim was given after `chunks` were written into the reader's
 * input, each `[bytes, keys]`: once a chunk is written, the next waits
 * until Neovim has had that many keys in all. A fixed pause between them
 * was not enough on a loaded machine: two chunks written before the reader
 * read the first came to it as one read, and a lone ESC followed by a
 * sequence is Alt with it, not two keys.
 */
async function keysAfter(
	client: NeovimClient,
	reader: ChildProcess,
	chunks: readonly (readonly [string, number])[],
): Promise<string[]> {
	const got = async () =>
		(await client.request("nvim_exec_lua", ["return _G.got", []])) as string[];
	let had = 0;
	for (const [chunk, count] of chunks) {
		reader.stdin?.write(Buffer.from(chunk, "latin1"));
		if (count === had) continue;
		had = count;
		for (let attempt = 0; attempt < 400; attempt += 1) {
			if ((await got()).length >= count) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	return await got();
}

describe.skipIf(NVIM === undefined)("what tmux writes into a pane", () => {
	it("reaches Neovim as keys, in every encoding tmux uses", async () => {
		const { client, reader } = await start();
		const got = await keysAfter(client, reader, [
			["\x11", 1], // C-q, legacy: send-prefix
			["\x1b[113;5u", 2], // C-q, CSI u
			["\x1b[27;5;113~", 3], // C-q, xterm's modifyOtherKeys
			["a<", 5],
			["\t\r\x7f\x1b", 9], // a lone ESC, read by itself
			["\x1b[1;5A\x1b[15~\x1bOP", 12],
			["\x1b[2", 12], // a sequence split across two reads
			["4~", 13],
			["\xc3\xa9", 14], // é
		]);
		expect(got).toEqual([
			"<C-Q>",
			"<C-Q>",
			"<C-Q>",
			"a",
			"<lt>",
			"<Tab>",
			"<CR>",
			"<BS>",
			"<Esc>",
			"<C-Up>",
			"<F5>",
			"<F1>",
			"<F12>",
			"é",
		]);
		client.close();
	});

	it("reaches Neovim as one paste when it is bracketed", async () => {
		const { client, reader } = await start();
		await client.request("nvim_input", ["i"]);
		await keysAfter(client, reader, [
			["\x1b[200~one\rtw", 0],
			["o\x1b[20", 0],
			["1~", 0],
		]);
		let pasted: string[] = [];
		for (let attempt = 0; attempt < 400 && pasted.length === 0; attempt += 1) {
			pasted = (await client.request("nvim_exec_lua", [
				"return _G.pasted",
				[],
			])) as string[];
			if (pasted.length === 0) {
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		}
		expect(pasted).toEqual(["one\ntwo"]);
		expect(
			await client.request("nvim_buf_get_lines", [0, 0, -1, false]),
		).toEqual(["one", "two"]);
		client.close();
	});
});
