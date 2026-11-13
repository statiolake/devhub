/**
 * The footers' Lua (`neovimStatusline.ts`) in a real Neovim, attached as
 * DevHub attaches: which rule each window's status line row takes, that the
 * trees are made at most once per turn of the event loop and sent only when
 * they changed, and the windows a row is kept for.
 *
 * DevHub's own Neovim (`testNeovim.ts`).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NeovimClient } from "./neovimRpc.js";
import { NeovimUi } from "./neovimUi.js";
import { makeSocketDir } from "../../model/testScratch.js";
import { TEST_NVIM } from "./testNeovim.js";

const children: ChildProcess[] = [];
const directories: string[] = [];

afterEach(() => {
	for (const child of children.splice(0)) child.kill("SIGKILL");
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

interface Sent {
	readonly laststatus: number;
	readonly current: number;
	readonly wins: Record<
		string,
		{ kind: string; edge?: boolean; node?: unknown }
	>;
	readonly keep: number[];
	readonly flush?: boolean;
}

async function attached() {
	const sockets = makeSocketDir("nvim-stl");
	directories.push(sockets);
	const socket = join(sockets, "n.sock");
	const child = spawn(
		TEST_NVIM as string,
		["--headless", "--clean", "--listen", socket],
		{ stdio: "ignore" },
	);
	children.push(child);
	let client: NeovimClient | undefined;
	for (let attempt = 0; attempt < 200 && !client; attempt += 1) {
		if (existsSync(socket)) {
			try {
				client = await NeovimClient.connect(socket);
				break;
			} catch {
				// Not listening yet.
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	if (!client) throw new Error("nvim did not open its socket");
	const sent: Sent[] = [];
	/** Footers and flushes, in the order they came on the UI's channel. */
	const order: string[] = [];
	const ui = new NeovimUi(client, {
		read: () => Promise.resolve(""),
		write: () => undefined,
	});
	await ui.attach(
		{
			redraw: (batches) => {
				if (JSON.stringify(batches).includes('"flush"')) order.push("flush");
			},
			guiWindows: () => undefined,
			guiOpen: () => undefined,
			guiClose: () => undefined,
			guiSend: () => undefined,
			guiEvent: (kind, payload) => {
				if (kind !== "statusline") return;
				sent.push(payload as Sent);
				const p = payload as Sent;
				order.push(
					`statusline${p.flush === true ? " flush" : ""} ${JSON.stringify(p.wins)}`,
				);
			},
		},
		80,
		24,
	);
	const lua = (code: string, args: unknown[] = []) =>
		ui.request("nvim_exec_lua", [code, args]);
	/** Every window's rule, by the Lua's own decision. */
	const rules = async () =>
		(await lua(
			`local M = package.loaded.devhub_gui
local out, cur = {}, vim.api.nvim_get_current_win()
for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
  local e = M._statusline_entry(w, w == cur)
  table.insert(out, e.kind == "tree" and (e.default and "default" or "tree") or "cells")
end
return out`,
		)) as string[];
	/** Let scheduled work run: a request answered after it. */
	const settle = async () => {
		await new Promise((resolve) => setTimeout(resolve, 60));
		await lua("return 1");
	};
	return { ui, lua, rules, sent, order, settle };
}

describe.skipIf(TEST_NVIM === undefined)("each window's footer", () => {
	it(
		"takes the rules: a config's tree, a window's own statusline as cells, Neovim's default as DevHub's footer, a global one as cells",
		{ timeout: 15_000 },
		async () => {
			const h = await attached();
			await h.lua("vim.cmd('vsplit | split')");
			// Neovim's default statusline: DevHub's default footer.
			expect(await h.rules()).toEqual(["default", "default", "default"]);
			// A window's own statusline (quickfix's, a picker's hints): cells.
			await h.lua("vim.wo.statusline = 'mine'");
			expect(await h.rules()).toEqual(["cells", "default", "default"]);
			// One that is the global value again (a window picker puts back
			// what it read, as a local value) is none of its own.
			await h.lua("vim.wo.statusline = vim.go.statusline");
			expect(await h.rules()).toEqual(["default", "default", "default"]);
			await h.lua("vim.wo.statusline = 'mine'");
			// A global one of the person's: cells everywhere…
			await h.lua("vim.go.statusline = '%f'");
			expect(await h.rules()).toEqual(["cells", "cells", "cells"]);
			// …unless they choose the default footer.
			await h.lua("vim.g.devhub_statusline = 'default'");
			expect(await h.rules()).toEqual(["cells", "default", "default"]);
			await h.lua("vim.g.devhub_statusline = nil");
			// A config's function: its tree, nil leaving it to the rules,
			// false an empty footer.
			await h.lua(`package.loaded.devhub_gui.statusline(function(win, ctx)
  if ctx.local_statusline then return nil end
  if not ctx.current then return false end
  return { type = 'hstack', children = { { type = 'line', grow = true }, ctx.default() } }
end)`);
			expect(await h.rules()).toEqual(["cells", "tree", "tree"]);
			const empty = (await h.lua(`local M = package.loaded.devhub_gui
local cur = vim.api.nvim_get_current_win()
for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
  if w ~= cur and vim.api.nvim_get_option_value('statusline', { win = w, scope = 'local' }) == '' then return #M._statusline_entry(w, false).node.children end
end`)) as number;
			expect(empty).toBe(0);
			// One that throws: the rules, and one notification.
			await h.lua(
				"package.loaded.devhub_gui.statusline(function() error('boom') end)",
			);
			expect(await h.rules()).toEqual(["cells", "cells", "cells"]);
			// 'cells' everywhere, and 'default' everywhere but a window's own.
			await h.lua("package.loaded.devhub_gui.statusline('default')");
			expect(await h.rules()).toEqual(["cells", "default", "default"]);
			await h.lua("package.loaded.devhub_gui.statusline('cells')");
			expect(await h.rules()).toEqual(["cells", "cells", "cells"]);
			h.ui.client.close();
		},
	);

	it(
		"is made once per turn of the event loop and sent only when it changed",
		{ timeout: 15_000 },
		async () => {
			const h = await attached();
			await h.settle();
			expect(h.sent.length).toBeGreaterThan(0);
			const first = h.sent.at(-1)!;
			expect(first.laststatus).toBe(2);
			expect(Object.values(first.wins)[0]?.kind).toBe("tree");
			expect(Object.values(first.wins)[0]?.edge).toBe(true);
			// A split, a modified buffer, events by the dozen: one turn, one send.
			h.sent.length = 0;
			await h.lua(`vim.cmd('vsplit')
vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'x' })
for _ = 1, 20 do vim.api.nvim_exec_autocmds('BufEnter', {}) vim.api.nvim_exec_autocmds('WinEnter', {}) end`);
			await h.settle();
			expect(h.sent).toHaveLength(1);
			const split = h.sent[0]!;
			expect(split.keep).toHaveLength(2);
			// Both windows show the modified buffer: both trees new.
			expect(Object.keys(split.wins)).toHaveLength(2);
			// Nothing changed: nothing sent.
			h.sent.length = 0;
			await h.lua("vim.api.nvim_exec_autocmds('BufEnter', {})");
			await h.settle();
			expect(h.sent).toHaveLength(0);
			// The cursor moving is no event of its (slots fill the position).
			await h.lua(
				"vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'a', 'b', 'c' }); vim.bo.modified = false",
			);
			await h.settle();
			h.sent.length = 0;
			await h.lua("vim.cmd('normal! G')");
			await h.settle();
			expect(h.sent).toHaveLength(0);
			// Only the window that changed is sent: the other window's is kept.
			await h.lua("vim.cmd('wincmd l | enew')");
			await h.settle();
			const moved = h.sent.at(-1)!;
			expect(moved.keep).toHaveLength(2);
			h.ui.client.close();
		},
	);

	it(
		"has one row for the current window with laststatus=3 and none with 0",
		{ timeout: 15_000 },
		async () => {
			const h = await attached();
			await h.lua("vim.cmd('vsplit'); vim.o.laststatus = 3");
			await h.settle();
			const three = h.sent.at(-1)!;
			expect(three.laststatus).toBe(3);
			expect(three.keep).toEqual([three.current]);
			await h.lua("vim.o.laststatus = 0");
			await h.settle();
			expect(h.sent.at(-1)!.keep).toEqual([]);
			h.ui.client.close();
		},
	);

	it(
		"goes with the redraw that shows what changed it: made ahead of its flush, and marked so",
		{ timeout: 15_000 },
		async () => {
			// Found by the stability suite (open-file): a file opened showed
			// its text under the last file's name for a frame.
			const h = await attached();
			await h.settle();
			const named = (name: string) => {
				const at = h.order.findIndex(
					(line) => line.startsWith("statusline") && line.includes(name),
				);
				return {
					at,
					line: h.order[at] ?? "",
					next: h.order.indexOf("flush", at),
				};
			};
			// Typed, as a person does: the footer is made in the redraw.
			h.order.length = 0;
			await h.ui.request("nvim_input", [":edit typed-file.txt<CR>"]);
			await h.settle();
			const typed = named("typed-file.txt");
			expect(typed.at).toBeGreaterThanOrEqual(0);
			expect(typed.line.startsWith("statusline flush")).toBe(true);
			expect(typed.next).toBeGreaterThan(typed.at);
			// By RPC, as devhub <file> opens one: the same.
			h.order.length = 0;
			await h.lua("vim.cmd('edit rpc-file.txt')");
			await h.settle();
			const rpc = named("rpc-file.txt");
			expect(rpc.at).toBeGreaterThanOrEqual(0);
			expect(rpc.line.startsWith("statusline flush")).toBe(true);
			expect(rpc.next).toBeGreaterThan(rpc.at);
			h.ui.client.close();
		},
	);

	it("runs a node's on_click from the page", { timeout: 15_000 }, async () => {
		const h = await attached();
		await h.lua(`package.loaded.devhub_gui.statusline(function(win)
  return { type = 'text', text = 'go', on_click = function(w) vim.g.clicked = w end }
end)`);
		await h.settle();
		const win = h.sent.at(-1)!.current;
		const node = h.sent.at(-1)!.wins[String(win)]?.node as { action?: number };
		expect(node.action).toBe(1);
		await h.lua("package.loaded.devhub_gui._statusline_click(...)", [
			win,
			node.action,
		]);
		expect(await h.lua("return vim.g.clicked")).toBe(win);
		h.ui.client.close();
	});
});
