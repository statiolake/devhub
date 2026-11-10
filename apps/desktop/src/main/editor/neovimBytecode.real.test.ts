/**
 * DevHub's setup Lua sent as the bytecode the build compiles it to
 * (`neovimBytecode.ts`), to DevHub's own Neovim (`testNeovim.ts`): loaded
 * as the source was, and the source sent again when a Neovim refuses it.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NeovimClient } from "./neovimRpc.js";
import { NeovimUi, SETUP_CHUNKS, type NeovimUiSink } from "./neovimUi.js";
import { SetupLua, compileLua, type CompiledLua } from "./neovimBytecode.js";
import { makeSocketDir } from "../../model/testScratch.js";
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

const sink: NeovimUiSink = {
	redraw: () => undefined,
	guiWindows: () => undefined,
	guiOpen: () => undefined,
	guiClose: () => undefined,
	guiSend: () => undefined,
};

/** An `--embed` Neovim waiting for its first UI, as a pane's `nvim` is. */
async function embedded(): Promise<string> {
	const scratch = makeSocketDir("nvim-bytecode");
	directories.push(scratch);
	const socket = join(scratch, "n.sock");
	const child = spawn(
		NVIM as string,
		["--embed", "--listen", socket, "--clean", "-i", "NONE", "-n"],
		{ stdio: ["pipe", "ignore", "ignore"] },
	);
	children.push(child);
	for (let attempt = 0; attempt < 200 && !existsSync(socket); attempt += 1)
		await new Promise((resolve) => setTimeout(resolve, 25));
	return socket;
}

/** `setup` attaching to the Neovim at `socket`: what it asked, how it went. */
async function attach(socket: string, setup: SetupLua) {
	const client = await NeovimClient.connect(socket);
	const asked: string[] = [];
	const request = client.request.bind(client);
	client.request = (method, params) => {
		if (method === "nvim_call_atomic") {
			const calls = params[0] as [string, unknown[]][];
			asked.push(
				calls
					.slice(0, SETUP_CHUNKS.length)
					.map(([, [code]]) =>
						code instanceof Uint8Array ? "bytecode" : "source",
					)
					.join(","),
			);
		}
		return request(method, params);
	};
	const ui = new NeovimUi(
		client,
		{ read: () => Promise.resolve(""), write: () => undefined },
		setup,
	);
	await ui.attach(sink, 60, 20);
	// Which chunk `devhub_gui`'s functions came from, and that the module
	// and the attach are whole.
	const [source, attached, uis] = (await ui.request("nvim_exec_lua", [
		`local M = package.loaded.devhub_gui
		return { debug.getinfo(M._notify, "S").source, M._attached_first_ui == true or M._chan ~= nil, #vim.api.nvim_list_uis() }`,
		[],
	])) as [string, boolean, number];
	return { client, ui, asked, source, attached, uis };
}

const all = (code: string) => SETUP_CHUNKS.map(() => code).join(",");

describe.skipIf(NVIM === undefined)("DevHub's setup Lua as bytecode", () => {
	it(
		"is loaded from the bytecode, the first UI attached in the same request",
		{ timeout: 15_000 },
		async () => {
			const compiled = compileLua(NVIM as string, SETUP_CHUNKS);
			const setup = new SetupLua(() => compiled);
			const socket = await embedded();
			const first = await attach(socket, setup);
			expect(first.asked).toEqual([all("bytecode")]);
			// Compiled with its chunk's name: an error says where it is.
			expect(first.source).toBe("=devhub:setup");
			expect(first.attached).toBe(true);
			expect(first.uis).toBe(1);
			first.client.close();
			// Attached again (a page that loaded again): the bytecode again.
			const again = await attach(socket, setup);
			expect(again.asked[0]).toBe(all("bytecode"));
			expect(again.uis).toBe(1);
			again.client.close();
		},
	);

	it(
		"sends the source again when Neovim refuses the bytecode, and from then on",
		{ timeout: 15_000 },
		async () => {
			const compiled = compileLua(NVIM as string, SETUP_CHUNKS);
			// The LuaJIT of another build (its frame layout, GC64 or not):
			// the third chunk's header flags say the other.
			const third = Object.keys(compiled.bytecode)[2] as string;
			const bytes = Buffer.from(compiled.bytecode[third] as string, "base64");
			bytes[4] = (bytes[4] as number) ^ 0x08;
			const refused: CompiledLua = {
				...compiled,
				bytecode: { ...compiled.bytecode, [third]: bytes.toString("base64") },
			};
			const setup = new SetupLua(() => refused);
			const socket = await embedded();
			const first = await attach(socket, setup);
			// The first two ran from bytecode, then the whole setup as source,
			// and still a first UI's single attach.
			expect(first.asked).toEqual([all("bytecode"), all("source")]);
			expect(first.source).toBe("<nvim>");
			expect(first.attached).toBe(true);
			expect(first.uis).toBe(1);
			first.client.close();
			const again = await attach(socket, setup);
			expect(again.asked[0]).toBe(all("source"));
			again.client.close();
		},
	);

	it(
		"is the source for a Neovim of another version",
		{ timeout: 15_000 },
		async () => {
			const compiled = compileLua(NVIM as string, SETUP_CHUNKS);
			const setup = new SetupLua(() => ({ ...compiled, nvimVersion: "0.0.1" }));
			const first = await attach(await embedded(), setup);
			expect(first.asked).toEqual([all("source")]);
			expect(first.source).toBe("<nvim>");
			first.client.close();
		},
	);
});
