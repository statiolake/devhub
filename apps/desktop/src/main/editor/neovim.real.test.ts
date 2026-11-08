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
import { OPEN_FILE_LUA, PUBLISH_THEME_LUA } from "./managedNeovim.js";
import {
	ThemeCatalog,
	terminalPaletteOfTheme,
} from "../../model/themes/theme.js";
import {
	publishedThemeOf,
	themeEnvironment,
} from "../../model/publishedTheme.js";
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

	it("is told the theme: g:devhub_theme, the environment, and User DevhubTheme with it", async () => {
		const { client } = await startNvim();
		const resolved = new ThemeCatalog().find("Nord");
		if (!resolved) throw new Error("no Nord");
		const theme = publishedThemeOf({
			theme: resolved,
			terminal: terminalPaletteOfTheme(resolved),
			temporary: true,
		});
		await client.request("nvim_exec_lua", [
			`vim.api.nvim_create_autocmd("User", { pattern = "DevhubTheme", callback = function(event)
				vim.g.heard = event.data.name .. " " .. event.data.colors.background
			end })`,
			[],
		]);
		await client.request("nvim_exec_lua", [
			PUBLISH_THEME_LUA,
			[theme, themeEnvironment(theme, undefined)],
		]);
		expect(await client.request("nvim_get_var", ["devhub_theme"])).toBe("Nord");
		expect(await client.request("nvim_get_var", ["devhub_theme_kind"])).toBe(
			"dark",
		);
		expect(await client.request("nvim_get_var", ["heard"])).toBe(
			"Nord #2e3440",
		);
		expect(
			await client.request("nvim_exec_lua", [
				"return vim.env.DEVHUB_FZF_COLORS",
				[],
			]),
		).toBe(theme.fzf);
		expect(
			await client.request("nvim_exec_lua", [
				"return vim.g.devhub_theme_info.temporary",
				[],
			]),
		).toBe(true);
		client.close();
	});

	const told = (name: string) => {
		const theme = new ThemeCatalog().find(name);
		if (!theme) throw new Error(`no ${name}`);
		const published = publishedThemeOf({
			theme,
			terminal: terminalPaletteOfTheme(theme),
			temporary: false,
		});
		return [published, themeEnvironment(published, undefined)] as const;
	};
	const hl = async (client: NeovimClient, name: string) =>
		(await client.request("nvim_exec_lua", [
			`local h = vim.api.nvim_get_hl(0, { name = ..., link = false })
			return { fg = h.fg and string.format("#%06x", h.fg), bg = h.bg and string.format("#%06x", h.bg) }`,
			[name],
		])) as { fg?: string; bg?: string };

	it("wears DevHub's colorscheme, follows a change, and runs ColorScheme for the person's tweaks", async () => {
		const { client } = await startNvim();
		await client.request("nvim_exec_lua", [
			`vim.api.nvim_create_autocmd("ColorScheme", { callback = function(event)
				vim.g.schemes = (vim.g.schemes or "") .. event.match .. ";"
			end })`,
			[],
		]);
		const nord = told("Nord");
		await client.request("nvim_exec_lua", [PUBLISH_THEME_LUA, nord]);
		expect(await client.request("nvim_get_var", ["colors_name"])).toBe(
			"devhub",
		);
		expect((await hl(client, "Normal")).bg).toBe("#2e3440");
		// Linked through Keyword to Statement, the theme's magenta.
		expect((await hl(client, "@keyword")).fg).toBe(
			nord[0].neovim.highlights["Statement"]?.fg,
		);
		expect(
			await client.request("nvim_get_option_value", ["background", {}]),
		).toBe("dark");
		await client.request("nvim_exec_lua", [
			PUBLISH_THEME_LUA,
			told("Catppuccin Latte"),
		]);
		expect((await hl(client, "Normal")).bg).toBe("#eff1f5");
		expect(
			await client.request("nvim_get_option_value", ["background", {}]),
		).toBe("light");
		expect(await client.request("nvim_get_var", ["schemes"])).toBe(
			"devhub;devhub;",
		);
		client.close();
	});

	it("leaves a colorscheme the person chose alone", async () => {
		const { client } = await startNvim();
		await client.request("nvim_command", ["colorscheme habamax"]);
		const before = await hl(client, "Normal");
		await client.request("nvim_exec_lua", [PUBLISH_THEME_LUA, told("Nord")]);
		expect(await client.request("nvim_get_var", ["colors_name"])).toBe(
			"habamax",
		);
		expect(await hl(client, "Normal")).toEqual(before);
		expect(await client.request("nvim_get_var", ["devhub_theme"])).toBe("Nord");
		client.close();
	});
});
