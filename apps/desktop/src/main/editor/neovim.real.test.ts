/**
 * The RPC half of the managed Neovim against a real Neovim: the open call's
 * Lua, the cursor it places, the `--wait` marker it deletes, and the
 * connection closing being Neovim's exit.
 *
 * Skipped where there is no Neovim. `DEVHUB_TEST_NVIM` names one that is not
 * on the PATH — a release tarball unpacked somewhere, for instance.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OPEN_FILE_LUA } from "./managedNeovim.js";
import { NeovimClient } from "./neovimRpc.js";
import { makeScratchDir, makeSocketDir } from "../../model/testScratch.js";

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

async function startNvim(): Promise<{ client: NeovimClient; socket: string }> {
	const sockets = makeSocketDir("nvim-real");
	directories.push(sockets);
	const socket = join(sockets, "n.sock");
	const child = spawn(
		NVIM as string,
		["--headless", "--clean", "--listen", socket],
		{ stdio: "ignore" },
	);
	children.push(child);
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (existsSync(socket)) {
			try {
				return { client: await NeovimClient.connect(socket), socket };
			} catch {
				// Not listening yet.
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("nvim did not open its socket");
}

describe.skipIf(NVIM === undefined)("a real Neovim", () => {
	it("opens a file at a line and a column, whatever its path holds", async () => {
		const { client } = await startNvim();
		const scratch = makeScratchDir("nvim-open");
		directories.push(scratch);
		const file = join(scratch, "a file with 'quotes' | and spaces.ts");
		writeFileSync(file, "first\nsecond line\n日本語のテキスト\nlast\n");
		await client.request("nvim_exec_lua", [OPEN_FILE_LUA, [file, 3, 4, null]]);
		expect(await client.request("nvim_buf_get_name", [0])).toBe(file);
		// Line 3, the fourth character: three characters of three bytes each in.
		expect(await client.request("nvim_win_get_cursor", [0])).toEqual([3, 9]);
		// Past the end is the last line, not an error.
		await client.request("nvim_exec_lua", [
			OPEN_FILE_LUA,
			[file, 99, null, null],
		]);
		expect(await client.request("nvim_win_get_cursor", [0])).toEqual([4, 0]);
		client.close();
	});

	it("opens a file that is not there yet as a new buffer for it", async () => {
		const { client } = await startNvim();
		const scratch = makeScratchDir("nvim-new");
		directories.push(scratch);
		const file = join(scratch, "new.md");
		await client.request("nvim_exec_lua", [
			OPEN_FILE_LUA,
			[file, null, null, null],
		]);
		expect(await client.request("nvim_buf_get_name", [0])).toBe(file);
		client.close();
	});

	it("deletes a --wait marker when that buffer is closed", async () => {
		const { client } = await startNvim();
		const scratch = makeScratchDir("nvim-wait");
		directories.push(scratch);
		const file = join(scratch, "COMMIT_EDITMSG");
		const marker = join(scratch, "wait-marker");
		writeFileSync(file, "message\n");
		writeFileSync(marker, "");
		await client.request("nvim_exec_lua", [
			OPEN_FILE_LUA,
			[file, null, null, marker],
		]);
		expect(existsSync(marker)).toBe(true);
		await client.request("nvim_command", ["bdelete!"]);
		expect(existsSync(marker)).toBe(false);
		client.close();
	});

	it("is heard leaving: the connection closes when Neovim quits", async () => {
		const { client } = await startNvim();
		const closed = new Promise<void>((resolve) => {
			client.onClose(resolve);
		});
		// The request never gets its answer; Neovim is gone before it can.
		void client.request("nvim_command", ["qa!"]).catch(() => undefined);
		await closed;
		expect(client.closed).toBe(true);
	});
});
