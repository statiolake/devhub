/**
 * DevHub's own windows and a Neovim session, against DevHub's own Neovim
 * (`testNeovim.ts`): a session written with a GUI window open brings back
 * the windows without it, the person's editing window current; the layout
 * an attach saved is not put back over windows that came since.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeScratchDir, removeScratchDir } from "../../model/testScratch.js";
import {
	LAYOUT_RESTORE_LUA,
	LAYOUT_SAVE_LUA,
	SESSION_LUA,
} from "./neovimSession.js";
import { TEST_NVIM } from "./testNeovim.js";

const directories: string[] = [];
afterEach(() => {
	for (const d of directories.splice(0)) removeScratchDir(d);
});

/** The windows of the current tab: `*` the current one, buffer, size. */
const WINDOWS_LUA = `
local out = {}
for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
  table.insert(out, (w == vim.api.nvim_get_current_win() and "*" or "") ..
    vim.fn.bufname(vim.api.nvim_win_get_buf(w)) .. " " ..
    vim.api.nvim_win_get_width(w) .. "x" .. vim.api.nvim_win_get_height(w))
end
vim.fn.writefile(out, OUT)
`;

/** Runs `lua` files in order in a fresh headless Neovim at 160x40. */
function nvim(dir: string, ...scripts: string[]): void {
	const args = ["--clean", "--headless", "-c", "set columns=160 lines=40"];
	scripts.forEach((script, i) => {
		const file = join(dir, `step${String(i)}.lua`);
		writeFileSync(file, script);
		args.push("-c", `luafile ${file}`);
	});
	args.push("-c", "qa!");
	const run = spawnSync(TEST_NVIM as string, args, {
		cwd: dir,
		encoding: "utf8",
		timeout: 20_000,
	});
	expect(run.status, run.stderr).toBe(0);
}

/** a.txt beside [b.txt over [GUI window, a.txt]], the GUI window current. */
const LAYOUT = `
vim.opt.sessionoptions = { "blank", "buffers", "curdir", "help", "tabpages", "winsize", "terminal", "localoptions" }
vim.o.equalalways = true
vim.cmd("edit a.txt | vsplit b.txt | split a.txt")
local buf = vim.api.nvim_create_buf(false, true)
vim.bo[buf].buftype = "nofile"
vim.bo[buf].bufhidden = "wipe"
vim.api.nvim_buf_set_var(buf, "devhub_gui_id", 1)
vim.api.nvim_buf_set_name(buf, "devhub://Outline/1")
vim.bo[buf].filetype = "devhub_gui"
vim.cmd("vsplit")
vim.api.nvim_win_set_buf(0, buf)
vim.cmd("vertical resize 40")
-- Back in the editing window, then into the GUI window: it is current.
vim.cmd("wincmd p | wincmd p")
`;

describe.skipIf(TEST_NVIM === undefined)(
	"DevHub's windows in a session",
	() => {
		it("are not brought back, and the window edited before is current", () => {
			const dir = makeScratchDir("nvim-session");
			directories.push(dir);
			writeFileSync(join(dir, "a.txt"), "a\n");
			writeFileSync(join(dir, "b.txt"), "b\n");
			const before = join(dir, "before");
			const after = join(dir, "after");
			nvim(
				dir,
				SESSION_LUA,
				LAYOUT,
				`OUT = "${before}"\n${WINDOWS_LUA}`,
				'vim.cmd("mksession! s.vim")',
			);
			expect(readFileSync(before, "utf8")).toContain(
				"*devhub://Outline/1 40x19",
			);
			// Sourced where DevHub is not (a new server, as after :restart).
			nvim(dir, 'vim.cmd("source s.vim")', `OUT = "${after}"\n${WINDOWS_LUA}`);
			// The GUI window gone, its columns to the window beside it, the
			// others as they were; the cursor where it was before the GUI window.
			expect(readFileSync(after, "utf8").trim().split("\n")).toEqual([
				"*a.txt 107x19",
				"b.txt 107x18",
				"a.txt 52x38",
			]);
		});

		it("come back at their sizes when the session is sourced while a UI attaches at another size", () => {
			const dir = makeScratchDir("nvim-session-sizes");
			directories.push(dir);
			writeFileSync(join(dir, "a.txt"), "a\n");
			writeFileSync(join(dir, "b.txt"), "b\n");
			const out = join(dir, "out");
			nvim(dir, SESSION_LUA, LAYOUT, 'vim.cmd("mksession! s.vim")');
			// As after :restart: DevHub's priming attach at half the size, the
			// session sourced there, then the real attach at the full size.
			nvim(
				dir,
				SESSION_LUA,
				'vim.o.columns = 80; vim.o.lines = 20; vim.cmd("source s.vim")',
				"vim.wait(50); vim.o.columns = 160; vim.o.lines = 40; vim.wait(50)",
				`OUT = "${out}"\n${WINDOWS_LUA}`,
			);
			expect(readFileSync(out, "utf8").trim().split("\n")).toEqual([
				"*a.txt 107x19",
				"b.txt 107x18",
				"a.txt 52x38",
			]);
		});

		it("an attach's saved sizes are not put back over other windows", () => {
			const dir = makeScratchDir("nvim-layout");
			directories.push(dir);
			const out = join(dir, "out");
			nvim(
				dir,
				// Saved with one window (a restarted server before its session).
				`_G.L = loadstring([==[${LAYOUT_SAVE_LUA}]==])()`,
				'vim.cmd("vsplit | vertical resize 50")',
				`loadstring([==[${LAYOUT_RESTORE_LUA}]==])(_G.L)`,
				`OUT = "${out}"\n${WINDOWS_LUA}`,
			);
			expect(readFileSync(out, "utf8").split("\n").slice(0, 2)).toEqual([
				"* 50x38",
				" 109x38",
			]);
		});
	},
);
