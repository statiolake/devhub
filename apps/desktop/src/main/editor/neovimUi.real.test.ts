/**
 * DevHub as a real Neovim's UI: the attach with every `ext_*` the GUI asks
 * for, keys sent as the page sends them, and the redraw reducer's grid,
 * popupmenu, command line and tab line read back — the protocol as Neovim
 * really speaks it, not as a fixture says it does. Also the clipboard
 * provider and the GUI-window Lua module the attach installs.
 *
 * DevHub's own Neovim (`testNeovim.ts`).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NeovimClient } from "./neovimRpc.js";
import {
	NeovimUi,
	type NeovimUiSink,
	type WindowLayoutReport,
} from "./neovimUi.js";
import { makeSocketDir } from "../../model/testScratch.js";
import {
	applyRedraw,
	gridRowText,
	initialUiState,
	layoutGrids,
	placeUnplacedWindows,
	type NeovimUiState,
} from "../../shell/neovim/redraw.js";
import { floatLabelsOf } from "../../shell/neovim/frame.js";
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

let lastSocket = "";

async function startNvim(): Promise<NeovimClient> {
	const sockets = makeSocketDir("nvim-ui");
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
				lastSocket = socket;
				return await NeovimClient.connect(socket);
			} catch {
				// Not listening yet.
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("nvim did not open its socket");
}

interface Harness {
	readonly ui: NeovimUi;
	readonly state: NeovimUiState;
	readonly clipboard: { text: string };
	readonly gui: {
		opened: unknown[];
		windows: unknown[];
		sent: unknown[];
		events: { kind: string; payload: unknown }[];
	};
	/** Wait until `check` holds of the state after a flush. */
	until(check: (state: NeovimUiState) => boolean, what: string): Promise<void>;
}

async function attached(cols = 60, rows = 20): Promise<Harness> {
	const client = await startNvim();
	const state = initialUiState();
	const clipboard = { text: "" };
	const gui = {
		opened: [] as unknown[],
		windows: [] as unknown[],
		sent: [] as unknown[],
		events: [] as { kind: string; payload: unknown }[],
	};
	const waiters: (() => void)[] = [];
	const sink: NeovimUiSink = {
		redraw: (batches) => {
			const changes = applyRedraw(state, batches);
			if (changes.flushed) for (const wake of waiters.splice(0)) wake();
		},
		guiWindows: (windows, current) => gui.windows.push({ windows, current }),
		guiOpen: (open) => gui.opened.push(open),
		guiClose: () => undefined,
		guiSend: (id, message) => gui.sent.push({ id, message }),
		guiEvent: (kind, payload) => gui.events.push({ kind, payload }),
	};
	const ui = new NeovimUi(client, {
		read: () => Promise.resolve(clipboard.text),
		write: (text) => {
			clipboard.text = text;
		},
	});
	await ui.attach(sink, cols, rows);
	const until = async (
		check: (s: NeovimUiState) => boolean,
		what: string,
	): Promise<void> => {
		const deadline = Date.now() + 5_000;
		while (!check(state)) {
			if (Date.now() > deadline)
				throw new Error(`timed out waiting for ${what}`);
			await new Promise<void>((resolve) => {
				waiters.push(resolve);
				setTimeout(resolve, 50);
			});
		}
	};
	return { ui, state, clipboard, gui, until };
}

/** The text of every row of the window grid the cursor is in. */
function cursorGridText(state: NeovimUiState): string[] {
	const grid = state.grids.get(state.cursor.grid);
	if (!grid) return [];
	return Array.from({ length: grid.height }, (_, row) =>
		gridRowText(grid, row).trimEnd(),
	);
}

describe.skipIf(NVIM === undefined)("DevHub as a real Neovim's UI", () => {
	it("draws what is typed into a window grid of its own, with the cursor after it", async () => {
		const h = await attached();
		h.ui.call("nvim_input", ["ihello 日本語<Esc>"]);
		await h.until(
			(s) =>
				cursorGridText(s)[0] === "hello 日本語" && s.mode.name === "normal",
			"the typed line",
		);
		// ext_multigrid: the text is on the window's grid, placed on grid 1.
		expect(h.state.cursor.grid).not.toBe(1);
		const boxes = layoutGrids(h.state);
		expect(boxes.some((box) => box.grid === h.state.cursor.grid)).toBe(true);
		// A double-width character takes two cells, the second empty.
		const grid = h.state.grids.get(h.state.cursor.grid)!;
		expect(grid.chars.slice(6, 12)).toEqual(["日", "", "本", "", "語", ""]);
		// Normal mode after <Esc>: on the last character.
		expect(h.state.cursor.row).toBe(0);
		expect(h.state.cursor.col).toBe(10);
		expect(h.state.modes.length).toBeGreaterThan(0);
		expect(h.state.defaults.background).toBeTypeOf("number");
		h.ui.client.close();
	});

	it(
		"gets every cell again when a new UI attaches to a Neovim that had one",
		{ timeout: 15_000 },
		async () => {
			const h = await attached();
			h.ui.call("nvim_input", [
				"ifirst<CR>second<Esc>:vsplit|vsplit|split<CR>:vertical resize 12<CR>",
			]);
			await h.until(
				(s) => cursorGridText(s)[1] === "second",
				"the typed lines",
			);
			h.ui.client.close();
			const client = await NeovimClient.connect(lastSocket);
			const state = initialUiState();
			let layout: readonly WindowLayoutReport[] = [];
			const ui = new NeovimUi(client, {
				read: () => Promise.resolve(""),
				write: () => undefined,
			});
			await ui.attach(
				{
					redraw: (batches) => applyRedraw(state, batches),
					guiWindows: (_windows, _current, reported) => {
						layout = reported;
					},
					guiOpen: () => undefined,
					guiClose: () => undefined,
					guiSend: () => undefined,
				},
				60,
				20,
			);
			for (
				let i = 0;
				i < 100 && cursorGridText(state)[1] !== "second";
				i += 1
			) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			expect(cursorGridText(state).slice(0, 3)).toEqual([
				"first",
				"second",
				"~",
			]);
			// Every window placed again: by win_pos, or — the current one, which
			// did not move — from where Lua reports it.
			for (let i = 0; i < 100 && state.windows.size < 5; i += 1) {
				if (layout.length > 0) placeUnplacedWindows(state, layout);
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			const placed = layoutGrids(state).filter((box) => box.win !== undefined);
			expect(placed).toHaveLength(4);
			// The same windows, not new ones.
			expect(placed.map((box) => box.win).sort()).toEqual([
				1000, 1001, 1002, 1003,
			]);
			client.close();
		},
	);

	it(
		"keeps every tab's window sizes when a new UI attaches to a Neovim that had one",
		{ timeout: 15_000 },
		async () => {
			const h = await attached(60, 20);
			const heights = `return vim.tbl_map(function(tab)
				return vim.tbl_map(vim.api.nvim_win_get_height, vim.api.nvim_tabpage_list_wins(tab))
			end, vim.api.nvim_list_tabpages())`;
			// The upper window small, the lower large, in two tabs; the
			// second tab's split across, its left window narrow.
			await h.ui.request("nvim_exec_lua", [
				"vim.cmd('split | resize 4 | tabnew | vsplit | vertical resize 9 | split | resize 13 | tabfirst')",
				[],
			]);
			const before = (await h.ui.request("nvim_exec_lua", [
				heights,
				[],
			])) as number[][];
			const widths = `return vim.tbl_map(vim.api.nvim_win_get_width, vim.api.nvim_tabpage_list_wins(vim.api.nvim_list_tabpages()[2]))`;
			const widthsBefore = await h.ui.request("nvim_exec_lua", [widths, []]);
			h.ui.client.close();
			const client = await NeovimClient.connect(lastSocket);
			const ui = new NeovimUi(client, {
				read: () => Promise.resolve(""),
				write: () => undefined,
			});
			await ui.attach(
				{
					redraw: () => undefined,
					guiWindows: () => undefined,
					guiOpen: () => undefined,
					guiClose: () => undefined,
					guiSend: () => undefined,
				},
				60,
				20,
			);
			expect(before[0]![0]).toBeLessThan(before[0]![1]! / 2);
			expect(await ui.request("nvim_exec_lua", [heights, []])).toEqual(before);
			expect(await ui.request("nvim_exec_lua", [widths, []])).toEqual(
				widthsBefore,
			);
			client.close();
		},
	);

	it(
		"gives a Neovim that grew at the attach its rows in the windows, not the command line",
		{ timeout: 15_000 },
		async () => {
			// An `--embed` Neovim before its first UI: 24 rows, the person's
			// cmdheight 2. The attach is taller: the window takes the rows.
			const client = await startNvim();
			await client.request("nvim_exec_lua", ["vim.o.cmdheight = 2", []]);
			const ui = new NeovimUi(client, {
				read: () => Promise.resolve(""),
				write: () => undefined,
			});
			const sink: NeovimUiSink = {
				redraw: () => undefined,
				guiWindows: () => undefined,
				guiOpen: () => undefined,
				guiClose: () => undefined,
				guiSend: () => undefined,
			};
			await ui.attach(sink, 60, 40);
			const sizes = `return { vim.o.lines, vim.o.cmdheight, vim.api.nvim_win_get_height(0) }`;
			// lines, cmdheight, the window (a status line under it).
			expect(await ui.request("nvim_exec_lua", [sizes, []])).toEqual([
				40, 2, 37,
			]);
			// A split, attached again at another size: still the person's
			// cmdheight, the windows sharing the rest in the same proportion.
			await ui.request("nvim_exec_lua", ["vim.cmd('split | resize 9')", []]);
			client.close();
			const again = await NeovimClient.connect(lastSocket);
			const ui2 = new NeovimUi(again, {
				read: () => Promise.resolve(""),
				write: () => undefined,
			});
			await ui2.attach(sink, 60, 60);
			const split = `return { vim.o.lines, vim.o.cmdheight, unpack(vim.tbl_map(vim.api.nvim_win_get_height, vim.api.nvim_tabpage_list_wins(0))) }`;
			const [lines, cmdheight, upper, lower] = (await ui2.request(
				"nvim_exec_lua",
				[split, []],
			)) as number[];
			expect([lines, cmdheight]).toEqual([60, 2]);
			// Two status lines under the two windows.
			expect(upper! + lower! + 2 + cmdheight!).toBe(60);
			expect(upper).toBeGreaterThan(9);
			expect(upper).toBeLessThan(lower! / 2);
			again.close();
		},
	);

	it(
		"attaches once to an --embed Neovim waiting for its first UI: the config runs at the real size, its cmdheight kept",
		{ timeout: 15_000 },
		async () => {
			const scratch = makeSocketDir("nvim-first");
			directories.push(scratch);
			const socket = join(scratch, "n.sock");
			const file = join(scratch, "text.txt");
			writeFileSync(file, "first line of the file\nsecond\n");
			const start = async (config: string, background?: "light") => {
				const init = join(scratch, `init-${String(children.length)}.lua`);
				writeFileSync(init, config);
				rmSync(socket, { force: true });
				// The shim's way (`terminalNeovimShim.ts`): `--embed --listen`,
				// its stdin a pipe nothing writes to.
				const child = spawn(
					NVIM as string,
					["--embed", "--listen", socket, "-u", init, "-i", "NONE", "-n", file],
					{ stdio: ["pipe", "ignore", "ignore"] },
				);
				children.push(child);
				for (
					let attempt = 0;
					attempt < 200 && !existsSync(socket);
					attempt += 1
				)
					await new Promise((resolve) => setTimeout(resolve, 25));
				const client = await NeovimClient.connect(socket);
				const asked: string[] = [];
				const request = client.request.bind(client);
				client.request = (method, params) => {
					asked.push(
						method === "nvim_call_atomic"
							? (params[0] as [string][]).map(([m]) => m).join("+")
							: method,
					);
					return request(method, params);
				};
				const state = initialUiState();
				const ui = new NeovimUi(client, {
					read: () => Promise.resolve(""),
					write: () => undefined,
				});
				const sink: NeovimUiSink = {
					redraw: (batches) => {
						applyRedraw(state, batches);
					},
					guiWindows: () => undefined,
					guiOpen: () => undefined,
					guiClose: () => undefined,
					guiSend: () => undefined,
				};
				await ui.attach(sink, 60, 40, background);
				return { client, ui, asked, state, sink };
			};
			const sizes = `return { vim.o.lines, vim.o.columns, vim.o.cmdheight, vim.api.nvim_win_get_height(0), vim.g.config_saw }`;

			// The config sees the real size; its cmdheight 2 stays.
			const first = await start(
				"vim.o.cmdheight = 2\nvim.g.config_saw = vim.o.columns .. 'x' .. vim.o.lines",
			);
			const attaches = first.asked.filter((m) => m.includes("nvim_ui_attach"));
			// One request: DevHub's setup, then the attach.
			expect(attaches).toHaveLength(1);
			expect(attaches[0]).toMatch(
				/^(nvim_exec_lua\+){9}nvim_ui_attach\+nvim_exec_lua$/,
			);
			expect(first.asked).not.toContain("nvim_ui_detach");
			expect(await first.ui.request("nvim_exec_lua", [sizes, []])).toEqual([
				40,
				60,
				2,
				37,
				"60x40",
			]);
			// Neovim's first screen came to this UI: the file in its window.
			const text = [...first.state.grids.values()].some((grid) =>
				gridRowText(grid, 0).startsWith("first line of the file"),
			);
			expect(text).toBe(true);
			// Attached again (a page that loaded again): still the person's 2.
			first.client.close();
			const again = await NeovimClient.connect(socket);
			const ui2 = new NeovimUi(again, {
				read: () => Promise.resolve(""),
				write: () => undefined,
			});
			await ui2.attach(first.sink, 60, 30);
			expect(await ui2.request("nvim_exec_lua", [sizes, []])).toEqual([
				30,
				60,
				2,
				27,
				"60x40",
			]);
			again.close();

			// A config that leaves cmdheight alone: Neovim's 1, not the 0 the
			// attach set before the config ran.
			const plain = await start("vim.g.config_saw = 'plain'");
			expect(await plain.ui.request("nvim_exec_lua", [sizes, []])).toEqual([
				40,
				60,
				1,
				38,
				"plain",
			]);
			plain.client.close();

			// A config that waits before it sets cmdheight: Neovim answers
			// DevHub's request after the attach while it waits, and the value
			// the config sets after is still the person's.
			const waits = await start(
				"vim.wait(300, function() return false end)\nvim.o.cmdheight = 3\nvim.g.config_saw = 'waited'",
			);
			// (The attach may be answered while it waits too: started is after.)
			while ((await waits.ui.request("nvim_get_vvar", ["vim_did_enter"])) !== 1)
				await new Promise((resolve) => setTimeout(resolve, 25));
			expect(await waits.ui.request("nvim_exec_lua", [sizes, []])).toEqual([
				40,
				60,
				3,
				36,
				"waited",
			]);
			waits.client.close();
			const later = await NeovimClient.connect(socket);
			const ui3 = new NeovimUi(later, {
				read: () => Promise.resolve(""),
				write: () => undefined,
			});
			await ui3.attach(waits.sink, 60, 30);
			expect(
				(await ui3.request("nvim_exec_lua", [sizes, []])) as unknown[],
			).toEqual([30, 60, 3, 26, "waited"]);
			later.close();
			// The theme's background, before the config, as a TUI's terminal's.
			const light = await start(
				"vim.g.config_saw_background = vim.o.background",
				"light",
			);
			expect(
				await light.ui.request("nvim_exec_lua", [
					"return vim.g.config_saw_background",
					[],
				]),
			).toBe("light");
			light.client.close();
		},
	);

	it(
		"attaches a channel once when two attaches race on it (main's preattach and the page's own): the second joins the first, at its size",
		{ timeout: 15_000 },
		async () => {
			const scratch = makeSocketDir("nvim-race");
			directories.push(scratch);
			const socket = join(scratch, "n.sock");
			const sink: NeovimUiSink = {
				redraw: () => undefined,
				guiWindows: () => undefined,
				guiOpen: () => undefined,
				guiClose: () => undefined,
				guiSend: () => undefined,
			};
			const connect = async () => {
				for (let attempt = 0; attempt < 200; attempt += 1) {
					if (existsSync(socket)) {
						try {
							return await NeovimClient.connect(socket);
						} catch {
							// Not listening yet.
						}
					}
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
				throw new Error("nvim did not open its socket");
			};
			const race = async () => {
				const client = await connect();
				const attaches: string[] = [];
				const request = client.request.bind(client);
				client.request = (method, params) => {
					if (
						method === "nvim_ui_attach" ||
						(method === "nvim_call_atomic" &&
							(params[0] as [string][]).some(([m]) => m === "nvim_ui_attach"))
					)
						attaches.push(method);
					return request(method, params);
				};
				const ui = new NeovimUi(client, {
					read: () => Promise.resolve(""),
					write: () => undefined,
				});
				// Both asked at once, as main's and the page's are.
				const answers = await Promise.allSettled([
					ui.attach(sink, 60, 30),
					ui.attach(sink, 70, 32),
				]);
				const sizes = (await ui.request("nvim_exec_lua", [
					"return { #vim.api.nvim_list_uis(), vim.o.columns, vim.o.lines }",
					[],
				])) as number[];
				client.close();
				return { answers: answers.map((a) => a.status), sizes, attaches };
			};

			// A pane's `nvim`, waiting for its first UI.
			const embedded = spawn(
				NVIM as string,
				["--embed", "--listen", socket, "--clean", "-i", "NONE", "-n"],
				{ stdio: ["pipe", "ignore", "ignore"] },
			);
			children.push(embedded);
			const first = await race();
			expect(first.answers).toEqual(["fulfilled", "fulfilled"]);
			// The first UI attached in the setup's one request, and no other.
			expect(first.attaches).toEqual(["nvim_call_atomic"]);
			expect(first.sizes).toEqual([1, 70, 32]);

			// The same Neovim, its UI gone (DevHub restarted): the priming
			// attach's way, raced the same.
			const again = await race();
			expect(again.answers).toEqual(["fulfilled", "fulfilled"]);
			expect(again.sizes).toEqual([1, 70, 32]);
		},
	);

	it(
		"drops what it would tell a UI whose channel has gone, and tells the next UI",
		{ timeout: 15_000 },
		async () => {
			const h = await attached(60, 20);
			// DevHub quits: its channel closes, the Neovim runs on.
			h.ui.client.close();
			const other = await NeovimClient.connect(lastSocket);
			await other.request("nvim_exec_lua", [
				`local M = package.loaded.devhub_gui
				vim.cmd("messages clear")
				-- What a window event or a timer does while no UI is there.
				M._schedule_place()
				vim.schedule(function() M._event("notify", { msg = "x" }) end)
				vim.schedule(M._report)`,
				[],
			]);
			await new Promise((resolve) => setTimeout(resolve, 200));
			const messages = (await other.request("nvim_exec_lua", [
				'return vim.fn.execute("messages") .. vim.v.errmsg',
				[],
			])) as string;
			expect(messages).not.toContain("Invalid channel");
			other.close();
			// A new DevHub attaches: it is told what happens from then on.
			const client = await NeovimClient.connect(lastSocket);
			const events: string[] = [];
			const ui = new NeovimUi(client, {
				read: () => Promise.resolve(""),
				write: () => undefined,
			});
			await ui.attach(
				{
					redraw: () => undefined,
					guiWindows: () => undefined,
					guiOpen: () => undefined,
					guiClose: () => undefined,
					guiSend: () => undefined,
					guiEvent: (kind) => events.push(kind),
				},
				60,
				20,
			);
			await ui.request("nvim_exec_lua", [
				'package.loaded.devhub_gui._event("notify", { msg = "y" })',
				[],
			]);
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(events).toContain("notify");
			client.close();
		},
	);

	it("scrolls the grid as the buffer scrolls", async () => {
		const h = await attached(40, 10);
		h.ui.call("nvim_exec_lua", [
			"local l = {} for i = 1, 100 do l[i] = 'line ' .. i end vim.api.nvim_buf_set_lines(0, 0, -1, false, l)",
			[],
		]);
		await h.until(
			(s) => cursorGridText(s)[0] === "line 1",
			"line 1 at the top",
		);
		h.ui.call("nvim_input", ["<C-e><C-e><C-e>"]);
		await h.until(
			(s) => cursorGridText(s)[0] === "line 4",
			"three lines scrolled",
		);
		expect(cursorGridText(h.state)[1]).toBe("line 5");
		h.ui.client.close();
	});

	it("shows the command line as a widget, not in the grid", async () => {
		const h = await attached();
		h.ui.call("nvim_input", [":echo 'x'"]);
		await h.until(
			(s) =>
				s.cmdline.length === 1 &&
				s.cmdline[0]!.content.map((c) => c[1]).join("") === "echo 'x'",
			"the command line",
		);
		expect(h.state.cmdline[0]!.firstc).toBe(":");
		expect(h.state.cmdline[0]!.pos).toBe(8);
		h.ui.call("nvim_input", ["<Esc>"]);
		await h.until((s) => s.cmdline.length === 0, "the command line hidden");
		h.ui.client.close();
	});

	it("shows completion as a popupmenu with its items and the selected one", async () => {
		const h = await attached();
		h.ui.call("nvim_input", ["ialpha alpine alps<CR>al<C-n>"]);
		await h.until((s) => s.popupmenu !== undefined, "the popupmenu");
		const words = h.state.popupmenu!.items.map((item) => item.word);
		expect(words).toEqual(expect.arrayContaining(["alpha", "alpine", "alps"]));
		expect(h.state.popupmenu!.selected).toBe(0);
		h.ui.call("nvim_input", ["<C-n>"]);
		await h.until((s) => s.popupmenu?.selected === 1, "the next item selected");
		h.ui.call("nvim_input", ["<Esc>"]);
		await h.until((s) => s.popupmenu === undefined, "the popupmenu hidden");
		h.ui.client.close();
	});

	it("draws tab pages as a tab line", async () => {
		const h = await attached();
		h.ui.call("nvim_command", ["tabnew"]);
		await h.until((s) => (s.tabline?.tabs.length ?? 0) === 2, "two tabs");
		expect(h.state.tabline!.current).toBe(h.state.tabline!.tabs[1]!.tab);
		h.ui.client.close();
	});

	it("is a GUI to the person's config, and yanks to and pastes from DevHub's clipboard", async () => {
		const h = await attached();
		expect(await h.ui.request("nvim_eval", ["g:devhub_gui"])).toBe(true);
		expect(await h.ui.request("nvim_eval", ["has('gui_running')"])).toBe(1);
		h.ui.call("nvim_input", ['iyanked text<Esc>"+yy']);
		await h.until(
			() => h.clipboard.text === "yanked text\n",
			"the yank on the clipboard",
		);
		h.clipboard.text = "from the Mac";
		h.ui.call("nvim_input", ['0"+P']);
		await h.until(
			(s) => cursorGridText(s)[0] === "from the Macyanked text",
			"the paste",
		);
		h.ui.client.close();
	});

	it("opens a GUI window as an ordinary split, reports it, and hears its page", async () => {
		const h = await attached();
		await h.ui.request("nvim_exec_lua", [
			"_G.got = nil; local gui = require('devhub_gui'); local w = gui.webview{ title = 'demo', html = '<b>hi</b>' }; w:on_message(function(m) _G.got = m end); w:send('ping')",
			[],
		]);
		await h.until(
			() =>
				h.gui.opened.length > 0 &&
				(h.gui.windows.at(-1) as { windows: unknown[] } | undefined)?.windows
					.length === 1,
			"the GUI window",
		);
		expect(h.gui.opened[0]).toMatchObject({
			id: 1,
			title: "demo",
			html: "<b>hi</b>",
		});
		expect(h.gui.sent).toEqual([{ id: 1, message: "ping" }]);
		const last = h.gui.windows.at(-1) as {
			windows: { id: number; win: number }[];
			current: number;
		};
		expect(last.windows).toHaveLength(1);
		expect(last.current).toBe(last.windows[0]!.win);
		expect(await h.ui.request("nvim_eval", ["winnr('$')"])).toBe(2);
		h.ui.guiMessage(1, { kind: "clicked" });
		for (let i = 0; i < 50; i += 1) {
			const got = await h.ui.request("nvim_exec_lua", ["return _G.got", []]);
			if (got !== null) {
				expect(got).toEqual({ kind: "clicked" });
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		h.ui.client.close();
	});

	it("gives a GUI window's keys to Neovim: lines are its elements, a field is insert mode", async () => {
		const h = await attached();
		const lua = (code: string) => h.ui.request("nvim_exec_lua", [code, []]);
		await lua(
			"_G.w = require('devhub_gui').webview{ title = 'keys', html = '<button>a</button>' }",
		);
		await h.until(() => h.gui.opened.length > 0, "the GUI window");
		expect(h.gui.opened[0]).toMatchObject({ keyboard: "neovim" });
		const controls = () =>
			h.gui.events
				.filter((e) => e.kind === "gui_keys")
				.map(
					(e) => e.payload as { action: string; index: number; caret?: string },
				);
		const mode = async () =>
			((await h.ui.request("nvim_get_mode", [])) as { mode: string }).mode;
		const settle = async (
			check: () => boolean | Promise<boolean>,
			what: string,
		) => {
			for (let i = 0; i < 100; i += 1) {
				if (await check()) return;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			throw new Error(`timed out waiting for ${what}`);
		};
		// The page tells its elements: they are the buffer's lines.
		h.ui.call("nvim_exec_lua", [
			"require('devhub_gui')._gui_items(1, ...)",
			[
				[
					{ label: "gg", editable: false },
					{ label: "Filter", editable: true },
					{ label: "Go", editable: false },
				],
			],
		]);
		await settle(
			async () =>
				(await lua("return vim.api.nvim_buf_line_count(_G.w.buf)")) === 3,
			"the lines",
		);
		expect(
			await lua("return vim.api.nvim_buf_get_lines(_G.w.buf, 0, -1, false)"),
		).toEqual(["gg", "Filter", "Go"]);
		expect(await lua("return vim.bo[_G.w.buf].modifiable")).toBe(false);
		// Motions are Neovim's; the cursor line is the focus.
		h.ui.call("nvim_input", ["G"]);
		await settle(() => controls().at(-1)?.index === 2, "the focus on Go");
		h.ui.call("nvim_input", ["<CR>"]);
		await settle(
			() => controls().some((c) => c.action === "activate" && c.index === 2),
			"Go pressed",
		);
		// i on a button does nothing; on the field, insert mode.
		h.ui.call("nvim_input", ["i"]);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(await mode()).toBe("n");
		h.ui.call("nvim_input", ["kA"]);
		await settle(async () => (await mode()) === "i", "insert mode");
		expect(controls().at(-1)).toMatchObject({
			action: "edit",
			index: 1,
			caret: "end",
		});
		// <Esc> from the field: normal mode, and the page is told.
		h.ui.call("nvim_input", ["<Esc>"]);
		await settle(async () => (await mode()) === "n", "normal mode");
		await settle(
			() => controls().some((c) => c.action === "leave"),
			"the field left",
		);
		expect(await lua("return vim.bo[_G.w.buf].modifiable")).toBe(false);
		// A click on the field (the page's focus moving) enters it too.
		h.ui.call("nvim_exec_lua", [
			"require('devhub_gui')._gui_focused(1, 1)",
			[],
		]);
		await settle(async () => (await mode()) === "i", "insert mode by a click");
		// Leaving the window leaves the field.
		h.ui.call("nvim_command", ["wincmd p"]);
		await settle(
			async () => (await mode()) === "n",
			"normal mode in the other window",
		);
		// The page's own keys are maps on the buffer.
		h.ui.call("nvim_exec_lua", [
			"require('devhub_gui')._gui_declare(1, { 'X' })",
			[],
		]);
		h.ui.call("nvim_command", ["wincmd p"]);
		// (nvim_input is a fast call: it would be typed before the command ran.)
		expect(await lua("return vim.bo.filetype")).toBe("devhub_gui");
		h.ui.call("nvim_input", ["X"]);
		await settle(
			() => controls().some((c) => c.action === "key"),
			"the page's key",
		);
		h.ui.client.close();
	});

	it("keeps a url page's keys its own, and refuses to drive one from Neovim", async () => {
		const h = await attached();
		await h.ui.request("nvim_exec_lua", [
			"require('devhub_gui').webview{ title = 'web', url = 'https://example.com' }",
			[],
		]);
		await h.until(() => h.gui.opened.length > 0, "the GUI window");
		expect(h.gui.opened[0]).toMatchObject({ keyboard: "content" });
		await expect(
			h.ui.request("nvim_exec_lua", [
				"require('devhub_gui').webview{ url = 'https://example.com', keyboard = 'neovim' }",
				[],
			]),
		).rejects.toThrow(/keyboard = 'content'/);
		h.ui.client.close();
	});

	it("frames a float's border, blank or lines, in place", async () => {
		const h = await attached(60, 20);
		await h.ui.request("nvim_exec_lua", [
			"local buf = vim.api.nvim_create_buf(false, true); vim.api.nvim_buf_set_lines(buf, 0, -1, false, { 'hello' }); _G.f = vim.api.nvim_open_win(buf, false, { relative = 'editor', row = 2, col = 3, width = 10, height = 2, border = 'rounded' })",
			[],
		]);
		const float = () => layoutGrids(h.state).find((b) => b.float);
		await h.until(
			() => float()?.frame?.corners.tl === "╭",
			"a border of lines",
		);
		await h.ui.request("nvim_exec_lua", [
			"vim.api.nvim_win_set_config(_G.f, { border = 'solid' })",
			[],
		]);
		await h.until(() => float()?.frame?.corners.tl === " ", "the blank border");
		expect(float()).toMatchObject({
			row: 2,
			col: 3,
			width: 12,
			height: 4,
		});
		expect(float()?.frame?.margins).toEqual({
			top: 1,
			right: 1,
			bottom: 1,
			left: 1,
		});
		await h.ui.request("nvim_exec_lua", [
			"vim.api.nvim_win_set_config(_G.f, { border = 'none' })",
			[],
		]);
		await h.until(() => float()?.width === 10, "no border");
		expect(float()?.frame).toBeUndefined();
		expect(float()?.lined).toBeUndefined();
		h.ui.client.close();
	});

	it("frames a float's border of lines, its title's cells on it once its config is known", async () => {
		const h = await attached(60, 20);
		const win = (await h.ui.request("nvim_exec_lua", [
			"local buf = vim.api.nvim_create_buf(false, true); vim.api.nvim_buf_set_lines(buf, 0, -1, false, { 'hello' }); return vim.api.nvim_open_win(buf, false, { relative = 'editor', row = 2, col = 3, width = 20, height = 3, border = 'rounded', title = ' Files ', title_pos = 'center', footer = { { '1', 'Title' }, { '/2', 'Comment' } }, footer_pos = 'right' })",
			[],
		])) as number;
		const float = () => layoutGrids(h.state).find((b) => b.float);
		// The border holds text its (unknown) config has to explain first.
		await h.until(() => float()?.wantsLabels === true, "the border's text");
		expect(float()?.frame).toBeUndefined();
		const config = await h.ui.request("nvim_win_get_config", [win]);
		h.state.floatLabels.set(win, floatLabelsOf(config));
		const box = float();
		expect(box?.wantsLabels).toBeUndefined();
		expect(box?.frame?.corners).toEqual({ tl: "╭", tr: "╮", br: "╯", bl: "╰" });
		expect(box?.frame?.sides.left?.glyph).toBe("│");
		expect(
			box?.frame?.labels.map((l) => [
				l.side,
				l.col,
				l.cells,
				l.runs.map((r) => r.text).join(""),
			]),
		).toEqual([
			// Centred: (22 - 7) / 2 = 7, its blanks its own.
			["top", 7, 7, " Files "],
			// Right: against the corner.
			["bottom", 18, 3, "1/2"],
		]);
		// Two highlights in the footer: two runs.
		expect(box?.frame?.labels[1]?.runs.length).toBe(2);
		// A new title the config does not have yet: cell for cell again.
		await h.ui.request("nvim_win_set_config", [win, { title: " Grep " }]);
		await h.until(() => float()?.wantsLabels === true, "the new title");
		h.ui.client.close();
	});

	it("sends toasts, and places an image where its windows show it", async () => {
		const h = await attached(60, 20);
		const hasBase64 = (await h.ui.request("nvim_exec_lua", [
			"return vim.base64 ~= nil",
			[],
		])) as boolean;
		await h.ui.request("nvim_exec_lua", [
			"require('devhub_gui').notify{ title = 'Build', msg = 'done', level = vim.log.levels.WARN }",
			[],
		]);
		const waitFor = async (check: () => boolean, what: string) => {
			const deadline = Date.now() + 5_000;
			while (!check()) {
				if (Date.now() > deadline)
					throw new Error(`timed out waiting for ${what}`);
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		};
		await waitFor(
			() => h.gui.events.some((e) => e.kind === "notify"),
			"notify",
		);
		expect(h.gui.events.find((e) => e.kind === "notify")?.payload).toEqual({
			title: "Build",
			msg: "done",
			level: "warn",
		});
		// Kept to be read again: work in progress only once done, a key once.
		const history = (await h.ui.request("nvim_exec_lua", [
			`local M = require('devhub_gui')
			M.notify{ group = 'lua_ls', key = 'p', title = 'Indexing', progress = true, percent = 10 }
			M.notify{ group = 'lua_ls', key = 'p', title = 'Indexing', msg = 'done', progress = true, done = true }
			return vim.tbl_map(function(n) return { n.group, n.title, n.msg, n.level, type(n.time) } end, M.history())`,
			[],
		])) as unknown[];
		expect(history).toEqual([
			["Build", "Build", "done", "warn", "number"],
			["lua_ls", "Indexing", "done", "info", "number"],
		]);
		const lastPlace = () =>
			h.gui.events.filter((e) => e.kind === "place").at(-1)?.payload as
				| {
						images: { row: number; rows: number }[] | object;
				  }
				| undefined;
		if (hasBase64) {
			await h.ui.request("nvim_exec_lua", [
				"vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'a', 'b', 'c', 'd' }); local M = require('devhub_gui'); M.image(0, 2, M._demo_image(), { height_rows = 3 })",
				[],
			]);
			await waitFor(() => {
				const images = lastPlace()?.images;
				return Array.isArray(images) && images.length > 0;
			}, "the image placed");
			const image = h.gui.events.find((e) => e.kind === "image")?.payload as {
				src: string;
			};
			expect(image.src.startsWith("data:image/png;base64,iVBOR")).toBe(true);
			// Under line 2, from the window's top: rows 2, 3, 4.
			expect(lastPlace()?.images).toMatchObject([{ row: 2, col: 0, rows: 3 }]);
			// The rows are virt_lines: Neovim leaves them blank in its grid.
			await h.until(
				(state) => cursorGridText(state)[5] === "c",
				"the reserved rows",
			);
			expect(cursorGridText(h.state).slice(0, 6)).toEqual([
				"a",
				"b",
				"",
				"",
				"",
				"c",
			]);
			// A second image under the same line: each in its own rows, one
			// after the other as Neovim stacks their virt_lines.
			await h.ui.request("nvim_exec_lua", [
				"local M = require('devhub_gui'); M.image(0, 2, M._demo_image(), { height_rows = 2 })",
				[],
			]);
			await waitFor(() => {
				const images = lastPlace()?.images;
				return Array.isArray(images) && images.length === 2;
			}, "both images placed");
			const both = [
				...(lastPlace()?.images as { row: number; rows: number }[]),
			].sort((a, b) => a.row - b.row);
			expect(both[0]?.row).toBe(2);
			expect(both[1]?.row).toBe(2 + (both[0]?.rows ?? 0));
			expect(both.map((i) => i.rows).sort()).toEqual([2, 3]);
			await h.until(
				(state) => cursorGridText(state)[7] === "c",
				"both images' rows",
			);
		}

		h.ui.client.close();
	});
	it("shows a popup at its anchor, follows it, gives it the keys when focused, and closes it", async () => {
		const h = await attached(60, 20);
		const waitFor = async (check: () => boolean, what: string) => {
			const deadline = Date.now() + 3_000;
			while (!check()) {
				if (Date.now() > deadline)
					throw new Error(`timed out waiting for ${what}`);
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		};
		const last = (kind: string) =>
			h.gui.events.filter((e) => e.kind === kind).at(-1)?.payload as
				| Record<string, unknown>
				| undefined;
		const popups = (): Record<string, unknown>[] => {
			const v = last("layers")?.["popups"];
			return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
		};
		const lua = (code: string) => h.ui.request("nvim_exec_lua", [code, []]);
		await lua(`vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'alpha', 'beta gamma', 'delta' })
			vim.api.nvim_win_set_cursor(0, { 2, 5 })
			_G.closed = 0
			_G.pop = require('devhub_gui').popup{ component = { type = 'markdown', text = '**hi** there' },
				max_width = 40, text = 'hi there', on_close = function() _G.closed = _G.closed + 1 end }`);
		await waitFor(() => popups().length === 1, "the popup placed");
		expect(last("popup")).toMatchObject({
			node: { type: "markdown", text: "**hi** there" },
			placement: "below",
			max_width: 40,
		});
		// The anchor's cell, from the window's top-left: line 2, column 6.
		expect(popups()[0]).toMatchObject({ row: 1, col: 5, focused: false });
		// Focused: the keys are the popup's; j scrolls it and moves nothing.
		await lua("_G.pop.focus()");
		await waitFor(() => popups()[0]?.["focused"] === true, "focused");
		await lua("vim.api.nvim_feedkeys('j', 'x', false)");
		await waitFor(
			() => last("popup_scroll")?.["by"] === "line",
			"a scroll asked for",
		);
		expect(last("popup_scroll")).toMatchObject({ by: "line", n: 1 });
		await lua(
			"vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<C-d>', true, false, true), 'x', false)",
		);
		await waitFor(() => last("popup_scroll")?.["by"] === "half", "half a page");
		expect(
			await h.ui.request("nvim_exec_lua", [
				"return vim.api.nvim_win_get_cursor(0)",
				[],
			]),
		).toEqual([2, 5]);
		// y yanks its text.
		await lua("vim.api.nvim_feedkeys('y', 'x', false)");
		expect(
			await h.ui.request("nvim_exec_lua", ["return vim.fn.getreg('\"')", []]),
		).toBe("hi there");
		// q closes it, and its keys go with it.
		await lua("vim.api.nvim_feedkeys('q', 'x', false)");
		await waitFor(() => last("popup_clear") !== undefined, "closed");
		expect(
			await h.ui.request("nvim_exec_lua", [
				"return { _G.closed, vim.fn.maparg('j', 'n') }",
				[],
			]),
		).toEqual([1, ""]);
		// Not focused, the cursor moving closes it.
		await lua(
			"_G.pop2 = require('devhub_gui').popup{ component = { type = 'markdown', text = 'two' } }",
		);
		await waitFor(() => popups().length === 1, "the second popup");
		await lua("vim.api.nvim_feedkeys('j', 'x', false)");
		await waitFor(() => popups().length === 0, "closed by the cursor");
		expect(
			await h.ui.request("nvim_exec_lua", ["return _G.pop2.is_open()", []]),
		).toBe(false);
		h.ui.client.close();
	});

	it("moves a popup's list selection by index, and scrolls a pane inside it", async () => {
		const h = await attached(60, 20);
		const waitFor = async (check: () => boolean, what: string) => {
			const deadline = Date.now() + 3_000;
			while (!check()) {
				if (Date.now() > deadline)
					throw new Error(`timed out waiting for ${what}`);
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		};
		const all = (kind: string) => h.gui.events.filter((e) => e.kind === kind);
		const last = (kind: string) =>
			all(kind).at(-1)?.payload as Record<string, unknown> | undefined;
		const lua = (code: string) => h.ui.request("nvim_exec_lua", [code, []]);
		await lua(`_G.list = { type = 'stack', band = 'PmenuSel', selected = 1,
				{ type = 'text', text = 'a', anchor = true }, { type = 'text', text = 'b' } }
			_G.pop = require('devhub_gui').popup{ min_width = 36, close_on = {},
				component = { type = 'stack', _G.list, { type = 'stack', pane = 'doc', max_height = 120,
					{ type = 'markdown', text = 'doc' } } } }`);
		await waitFor(() => last("popup") !== undefined, "the popup");
		expect(last("popup")).toMatchObject({
			min_width: 36,
			node: {
				children: [
					{ band: "PmenuSel", selected: 1, children: [{ anchor: true }, {}] },
					{ pane: "doc", max_height: 120 },
				],
			},
		});
		expect(
			(last("popup")?.["hl"] as Record<string, unknown>)["PmenuSel"],
		).toBeDefined();
		const sent = all("popup").length;
		// The selection alone: its index, not the tree.
		await lua("_G.pop:select(2)");
		await waitFor(() => last("popup_select") !== undefined, "the selection");
		expect(last("popup_select")).toMatchObject({ n: 2 });
		expect(all("popup").length).toBe(sent);
		// Kept in the tree, so a tree sent again (a replay) says the same.
		expect(await lua("return _G.list.selected")).toBe(2);
		await lua("_G.pop:select(0)");
		await waitFor(() => last("popup_select")?.["n"] === 0, "no selection");
		expect(await lua("return _G.list.selected")).toBe(null);
		// A pane's content alone: not the tree.
		await lua(
			"_G.pop:pane('doc', { type = 'markdown', text = 'other', hl = 'Title' })",
		);
		await waitFor(() => last("popup_pane") !== undefined, "the pane");
		expect(last("popup_pane")).toMatchObject({
			pane: "doc",
			children: [{ type: "markdown", text: "other" }],
		});
		expect(
			(last("popup_pane")?.["hl"] as Record<string, unknown>)["Title"],
		).toBeDefined();
		expect(all("popup").length).toBe(sent);
		await lua("_G.pop:scroll(4, 'doc')");
		await waitFor(() => last("popup_scroll") !== undefined, "the scroll");
		expect(last("popup_scroll")).toMatchObject({
			by: "line",
			n: 4,
			pane: "doc",
		});
		await lua("_G.pop:scroll('-page')");
		await waitFor(
			() => last("popup_scroll")?.["by"] === "page",
			"the popup's scroll",
		);
		expect(last("popup_scroll")?.["pane"]).toBeUndefined();
		h.ui.client.close();
	});

	it("puts a popup against the command line's box, and closes it with the command line", async () => {
		const h = await attached(60, 20);
		const waitFor = async (check: () => boolean, what: string) => {
			const deadline = Date.now() + 3_000;
			while (!check()) {
				if (Date.now() > deadline)
					throw new Error(`timed out waiting for ${what}`);
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		};
		const all = (kind: string) => h.gui.events.filter((e) => e.kind === kind);
		const last = (kind: string) =>
			all(kind).at(-1)?.payload as Record<string, unknown> | undefined;
		const popups = (): Record<string, unknown>[] => {
			const v = last("layers")?.["popups"];
			return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
		};
		const lua = (code: string) => h.ui.request("nvim_exec_lua", [code, []]);
		expect(await lua("return require('devhub_gui').popup_cmdline")).toBe(true);
		// No command line: nothing to stand on.
		expect(
			await lua(
				"return require('devhub_gui').popup{ anchor = 'cmdline', component = { type = 'text', text = 'x' } } == nil",
			),
		).toBe(true);
		await h.ui.request("nvim_input", [":echo abcdef"]);
		await waitFor(() => h.state.cmdline.length > 0, "the command line");
		await lua(`_G.closed = 0
			_G.cp = require('devhub_gui').popup{ anchor = { cmdline = 5 }, close_on = {},
				component = { type = 'text', text = 'abcdef', anchor = true },
				on_close = function() _G.closed = _G.closed + 1 end }
			_G.cp:focus()`);
		await waitFor(() => popups().length === 1, "the popup placed");
		// The byte it is lined up with; the page knows where the box is.
		expect(popups()[0]).toMatchObject({ cmdline: 5, focused: false });
		expect(popups()[0]?.["win"]).toBeUndefined();
		// Up from the command line, as Neovim's wildmenu.
		expect(last("popup")).toMatchObject({ placement: "above" });
		// Past the text: its end.
		await lua(
			"_G.far = require('devhub_gui').popup{ anchor = { cmdline = 99 }, placement = 'below', close_on = {}, component = { type = 'text', text = 'y' } }",
		);
		await waitFor(() => popups().length === 2, "the second placed");
		expect(popups().map((p) => p["cmdline"])).toEqual(
			expect.arrayContaining([5, 11]),
		);
		expect(last("popup")).toMatchObject({ placement: "below" });
		// Typing keeps it; leaving the command line closes both.
		await h.ui.request("nvim_input", ["g"]);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(all("popup_clear")).toHaveLength(0);
		await h.ui.request("nvim_input", ["<Esc>"]);
		await waitFor(() => all("popup_clear").length === 2, "closed");
		expect(await lua("return { _G.closed, _G.cp:is_open() }")).toEqual([
			1,
			false,
		]);
		h.ui.client.close();
	});

	it("keeps a popup where it was when text goes in at its anchor", async () => {
		const h = await attached(60, 20);
		const waitFor = async (check: () => boolean, what: string) => {
			const deadline = Date.now() + 3_000;
			while (!check()) {
				if (Date.now() > deadline)
					throw new Error(`timed out waiting for ${what}`);
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		};
		const layers = () => h.gui.events.filter((e) => e.kind === "layers");
		const popups = (): Record<string, unknown>[] => {
			const v = (layers().at(-1)?.payload as Record<string, unknown>)?.[
				"popups"
			];
			return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
		};
		const lua = (code: string) => h.ui.request("nvim_exec_lua", [code, []]);
		await lua(`vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'alpha', 'beta gamma' })
			vim.api.nvim_win_set_cursor(0, { 2, 5 })
			_G.pop = require('devhub_gui').popup{ component = { type = 'markdown', text = 'hover' }, close_on = {} }`);
		await waitFor(() => popups().length === 1, "the popup placed");
		expect(popups()[0]).toMatchObject({ row: 1, col: 5 });
		// Text put in at the anchor, as a completion's preview is: the
		// anchor stays before it, so the popup does not jump right.
		const before = layers().length;
		await lua(`vim.api.nvim_buf_set_text(0, 1, 5, 1, 5, { 'pre' })
			require('devhub_gui')._schedule_place()`);
		await waitFor(() => layers().length > before, "placed again");
		expect(
			await h.ui.request("nvim_exec_lua", [
				"return vim.api.nvim_buf_get_lines(0, 1, 2, false)[1]",
				[],
			]),
		).toBe("beta pregamma");
		expect(popups()[0]).toMatchObject({ row: 1, col: 5 });
		h.ui.client.close();
	});

	it("reports a view's items and cursor, and a card's reserved rows round trip", async () => {
		const h = await attached(60, 20);
		const waitFor = async (check: () => boolean, what: string) => {
			const deadline = Date.now() + 3_000;
			while (!check()) {
				if (Date.now() > deadline)
					throw new Error(`timed out waiting for ${what}`);
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		};
		const last = (kind: string) =>
			h.gui.events.filter((e) => e.kind === kind).at(-1)?.payload as
				| Record<string, unknown>
				| undefined;
		const list = (value: unknown): Record<string, unknown>[] =>
			Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
		// A view: one item per line, the second with a clickable badge.
		await h.ui.request("nvim_exec_lua", [
			`local gui = require('devhub_gui')
			local buf = vim.api.nvim_create_buf(false, true)
			vim.api.nvim_buf_set_lines(buf, 0, -1, false, { 'one', 'two', 'three' })
			_G.clicked = {}
			_G.view = gui.view{ buf = buf, win = 'vsplit', keys = { { 'q', 'close' } },
				items = function(lnum, line)
					if lnum == 2 then
						return { type = 'hstack', children = { { type = 'badge', text = line, tone = 'warn',
							on_click = function(l) table.insert(_G.clicked, 'badge' .. l) end } } }
					end
				end,
				on_click = function(l) table.insert(_G.clicked, 'item' .. l) end }`,
			[],
		]);
		await waitFor(
			() => list(last("layers")?.["views"]).length > 0,
			"the view placed",
		);
		const view = last("view") as {
			id: number;
			items: unknown[];
			keys: unknown;
			hl: Record<string, unknown>;
		};
		expect(view.items).toMatchObject([
			{ line: 1, text: "one" },
			{
				line: 2,
				text: "two",
				node: {
					type: "hstack",
					children: [
						{ type: "badge", text: "two", hl: "DiagnosticWarn", action: 1 },
					],
				},
			},
			{ line: 3, text: "three" },
		]);
		expect(view.keys).toEqual([["q", "close"]]);
		expect(Object.keys(view.hl)).toContain("Comment");
		const placed = list(last("layers")?.["views"])[0] as {
			win: number;
			cursor: number;
		};
		expect(placed).toMatchObject({ id: view.id, cursor: 1, current: true });
		// A click on the badge moves the cursor there and runs its function;
		// one on the item runs the view's.
		await h.ui.request("nvim_exec_lua", [
			"local M = require('devhub_gui'); local id, win = ...; M._layers_click('view', id, win, 2, 1); M._layers_click('view', id, win, 2, nil)",
			[view.id, placed.win],
		]);
		expect(
			await h.ui.request("nvim_exec_lua", ["return _G.clicked", []]),
		).toEqual(["badge2", "item2"]);
		await waitFor(
			() =>
				(list(last("layers")?.["views"])[0] as { cursor?: number } | undefined)
					?.cursor === 2,
			"the cursor on the item",
		);
		// An edit re-renders it.
		await h.ui.request("nvim_exec_lua", [
			"vim.api.nvim_buf_set_lines(_G.view.buf, 0, 1, false, { 'ONE' })",
			[],
		]);
		await waitFor(
			() =>
				list((last("view") as { items?: unknown })?.items)[0]?.["text"] ===
				"ONE",
			"the edit",
		);
		// A double click reaches the view's on_click as two clicks.
		await h.ui.request("nvim_exec_lua", [
			"local M = require('devhub_gui'); local id, win = ...; M._layers_click('view', id, win, 3, nil, 2)",
			[view.id, placed.win],
		]);
		expect(
			await h.ui.request("nvim_exec_lua", ["return _G.clicked", []]),
		).toEqual(["badge2", "item2", "item3"]);
		// Visual mode over it: the lines selected go with its place.
		await h.ui.request("nvim_input", ["ggVj"]);
		await waitFor(() => {
			const v = list(last("layers")?.["views"])[0] as
				| { visual?: unknown }
				| undefined;
			return JSON.stringify(v?.visual) === "[1,2]";
		}, "the visual lines");
		await h.ui.request("nvim_input", ["<Esc>"]);
		await waitFor(
			() =>
				(list(last("layers")?.["views"])[0] as { visual?: unknown })?.visual ===
				undefined,
			"no visual lines after it",
		);
		// A tree: an item's depth and stickiness, the view's indent and row
		// height go to the page.
		await h.ui.request("nvim_exec_lua", [
			`local gui = require('devhub_gui')
			local buf = vim.api.nvim_create_buf(false, true)
			vim.api.nvim_buf_set_lines(buf, 0, -1, false, { 'root', 'src', 'a.ts' })
			_G.tree = gui.view{ buf = buf, win = 'vsplit', indent = 16, row_height = 22,
				items = function(lnum, line)
					return { node = { type = 'text', text = line }, depth = math.max(lnum - 2, 0), sticky = lnum == 1 }
				end }`,
			[],
		]);
		await waitFor(
			() => (last("view") as { indent?: number } | undefined)?.indent === 16,
			"the tree view",
		);
		const tree = last("view") as {
			row_height: number;
			items: { line: number; depth?: number; sticky?: boolean }[];
		};
		expect(tree.row_height).toBe(22);
		expect(tree.items.map((i) => [i.line, i.depth, i.sticky ?? false])).toEqual(
			[
				[1, 0, true],
				[2, 0, false],
				[3, 1, false],
			],
		);
		await h.ui.request("nvim_exec_lua", [
			"_G.tree:close(); vim.cmd('close')",
			[],
		]);

		// An inline card under line 2 of a fresh window: two rows at first, as
		// many as the page measures after.
		await h.ui.request("nvim_exec_lua", [
			`vim.cmd('only | enew')
			vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'a', 'b', 'c', 'd' })
			_G.card = require('devhub_gui').inline{ buf = 0, lnum = 2, component = { type = 'text', text = 'hi' } }`,
			[],
		]);
		const card = () =>
			list(last("layers")?.["inlines"])[0] as
				| {
						id: number;
						row: number;
						rows: number;
				  }
				| undefined;
		await waitFor(() => card() !== undefined, "the card placed");
		expect(card()).toMatchObject({
			row: 2,
			col: 0,
			rows: 2,
			active: false,
		});
		await h.ui.request("nvim_exec_lua", [
			"require('devhub_gui')._inline_rows(...)",
			[card()?.id, 4],
		]);
		await waitFor(() => card()?.rows === 4, "the measured rows");
		await h.until(
			(state) => cursorGridText(state)[6] === "c",
			"four reserved rows",
		);
		expect(cursorGridText(h.state).slice(0, 7)).toEqual([
			"a",
			"b",
			"",
			"",
			"",
			"",
			"c",
		]);
		// Scrolled so that line 3 is the top: the card's last row is filler
		// above it, the rest above the window (the page cuts it there).
		await h.ui.request("nvim_exec_lua", [
			"vim.fn.winrestview({ lnum = 3, topline = 3, topfill = 1 })",
			[],
		]);
		await waitFor(() => card()?.row === -3, "the card above the top");
		expect(card()).toMatchObject({ row: -3, rows: 4 });
		// A window's height above: still placed, as the page shows that much
		// beyond Neovim's view while it scrolls in pixels.
		await h.ui.request("nvim_exec_lua", [
			"vim.fn.winrestview({ lnum = 4, topline = 4, topfill = 0 })",
			[],
		]);
		await waitFor(() => card()?.row === -5, "the card further above");

		await h.ui.request("nvim_exec_lua", [
			"_G.card.clear(); _G.view.close()",
			[],
		]);
		await waitFor(
			() =>
				["inline_clear", "view_clear"].every((k) =>
					h.gui.events.some((e) => e.kind === k),
				),
			"everything cleared",
		);
		h.ui.client.close();
	}, 20_000);

	it("draws a framed view: the query's text and caret, the list's rows and cursor, the preview's rect", async () => {
		const h = await attached(80, 24);
		const waitFor = async (check: () => boolean, what: string) => {
			const deadline = Date.now() + 3_000;
			while (!check()) {
				if (Date.now() > deadline)
					throw new Error(`timed out waiting for ${what}`);
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		};
		const last = (kind: string) =>
			h.gui.events.filter((e) => e.kind === kind).at(-1)?.payload as
				| Record<string, unknown>
				| undefined;
		const frames = () =>
			(last("layers")?.["frames"] ?? []) as Record<string, unknown>[];
		// A frame; a hidden query and list relative to it (a hidden float's
		// place is worked out from its config); a preview.
		await h.ui.request("nvim_exec_lua", [
			`local gui = require('devhub_gui')
			local function float(buf, cfg)
				return vim.api.nvim_open_win(buf, false, vim.tbl_extend('force', { style = 'minimal' }, cfg))
			end
			local frame = float(vim.api.nvim_create_buf(false, true), { relative = 'editor', row = 2, col = 4, width = 60, height = 18, zindex = 50 })
			local qbuf = vim.api.nvim_create_buf(false, true)
			local query = float(qbuf, { relative = 'win', win = frame, row = 0, col = 0, width = 60, height = 2, hide = true, zindex = 51 })
			local lbuf = vim.api.nvim_create_buf(false, true)
			vim.api.nvim_buf_set_lines(lbuf, 0, -1, false, { 'one', 'two', '' })
			local list = float(lbuf, { relative = 'win', win = frame, row = 2, col = 0, width = 30, height = 16, hide = true, zindex = 51 })
			local preview = float(vim.api.nvim_create_buf(false, true), { relative = 'editor', row = 5, col = 34, width = 30, height = 14, zindex = 51 })
			_G.got = {}
			_G.view = gui.view{ buf = lbuf,
				items = function(lnum, line)
					if line == '' then return nil end
					return { node = { type = 'text', text = line:upper() }, heading = lnum == 1 and { type = 'text', text = 'h' } or nil }
				end,
				on_click = function(l, n) table.insert(_G.got, 'click' .. l .. ':' .. n) end,
				on_rows = function(r) table.insert(_G.got, 'rows' .. r) end,
				on_scroll = function(r) table.insert(_G.got, 'scroll' .. r) end,
				keys = { { '<CR>', 'open' } },
				frame = { win = frame, query = { win = query, placeholder = 'Search' },
					preview = { win = preview, title = { type = 'text', text = 'src' } },
					title = { type = 'badge', text = 'Files' } } }
			vim.api.nvim_set_current_win(query)
			vim.api.nvim_buf_set_lines(qbuf, 0, -1, false, { 'cönf' })
			vim.cmd('startinsert!')`,
			[],
		]);
		await waitFor(() => frames().length === 1, "the frame placed");
		// The page asks to settle the floats it has not drawn: Lua sends
		// where everything is, the frame's windows claimed, then `settled`
		// with the page's seq, in that order on the stream the redraws use.
		const before = h.gui.events.length;
		await h.ui.request("nvim_exec_lua", [
			"require('devhub_gui')._settle(...)",
			[41],
		]);
		await waitFor(
			() => h.gui.events.slice(before).some((e) => e.kind === "settled"),
			"settled",
		);
		const after = h.gui.events.slice(before);
		const settledAt = after.findIndex((e) => e.kind === "settled");
		expect(after[settledAt]?.payload).toEqual({ seq: 41 });
		const placedBefore = after
			.slice(0, settledAt)
			.filter((e) => e.kind === "layers")
			.at(-1)?.payload as { frames?: { wins: number[] }[] } | undefined;
		expect(placedBefore?.frames?.[0]?.wins).toHaveLength(4);
		const view = last("view") as {
			id: number;
			items: unknown[];
			keys: unknown;
			frame: { placeholder: string; title: unknown };
		};
		expect(view.items).toMatchObject([
			{ line: 1, text: "one", node: { text: "ONE" }, heading: { text: "h" } },
			{ line: 2, text: "two", node: { text: "TWO" } },
			{ line: 3, text: "" },
		]);
		expect(view.frame).toMatchObject({
			placeholder: "Search",
			title: { text: "Files" },
		});
		expect(view.keys).toEqual([["<CR>", "open"]]);
		await waitFor(
			() => (frames()[0]?.["query"] as { insert?: boolean })?.insert === true,
			"the query in Insert mode",
		);
		const placed = frames()[0] as Record<string, Record<string, unknown>>;
		// Its windows, claimed for the page: frame, list, query, preview.
		expect((frames()[0] as { wins: number[] }).wins).toHaveLength(4);
		expect(placed["frame"]).toMatchObject({
			row: 2,
			col: 4,
			width: 60,
			height: 18,
		});
		expect(placed["query"]).toMatchObject({
			row: 2,
			col: 4,
			height: 2,
			text: "cönf",
			caret: 5,
			current: true,
		});
		expect(placed["list"]).toMatchObject({
			row: 4,
			col: 4,
			width: 30,
			height: 16,
			cursor: 1,
			current: false,
		});
		expect(placed["preview"]).toMatchObject({
			row: 5,
			col: 34,
			width: 30,
			height: 14,
		});
		// The page's calls reach the view's functions; the keys stay in the query.
		await h.ui.request("nvim_exec_lua", [
			"local M = require('devhub_gui'); local id = ...; M._frame_click(id, 2, 2); M._view_rows(id, 12); M._view_rows(id, 12); M._view_scroll(id, -3)",
			[view.id],
		]);
		expect(
			await h.ui.request("nvim_exec_lua", [
				"return { _G.got, vim.bo[vim.api.nvim_get_current_buf()].buftype == 'nofile' and vim.fn.mode() }",
				[],
			]),
		).toEqual([["click2:2", "rows12", "scroll-3"], "i"]);
		await h.ui.request("nvim_exec_lua", [
			"_G.view:frame{ status = { type = 'text', text = '2 / 2' } }",
			[],
		]);
		await waitFor(
			() =>
				(last("view")?.["frame"] as { status?: { text?: string } } | undefined)
					?.status?.text === "2 / 2",
			"the status",
		);
		await h.ui.request("nvim_exec_lua", ["_G.view:close()", []]);
		await waitFor(() => last("view_clear") !== undefined, "closed");
		await waitFor(() => frames().length === 0, "unplaced");
		h.ui.client.close();
	}, 20_000);

	it("sets Neovim's own virtual text in the UI face and leaves a plugin's as cells", async () => {
		const h = await attached(60, 12);
		const decor = () => {
			const last = h.gui.events.filter((e) => e.kind === "decor").at(-1)
				?.payload as
				| { wins?: Record<string, { kind: string; text: string }[]> }
				| undefined;
			return Object.values(last?.wins ?? {}).flat();
		};
		await h.ui.request("nvim_exec_lua", [
			`vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'local x = 1', 'local y = 2' })
			local plugin = vim.api.nvim_create_namespace('a_plugin')
			vim.api.nvim_buf_set_extmark(0, plugin, 0, 0, { virt_text = { { 'plugin words' } } })
			vim.api.nvim_buf_set_extmark(0, plugin, 0, 0, { virt_lines = { { { '- deleted line' } } } })
			local diag = vim.api.nvim_create_namespace('test.diagnostics')
			vim.diagnostic.config({ virtual_text = true })
			vim.diagnostic.set(diag, 0, { { lnum = 1, col = 0, message = 'unused y', severity = vim.diagnostic.severity.WARN } })
			vim.cmd('redraw')`,
			[],
		]);
		const deadline = Date.now() + 3_000;
		while (!decor().some((d) => d.text.includes("unused y"))) {
			if (Date.now() > deadline) throw new Error("no diagnostic in decor");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		const texts = decor().map((d) => d.text);
		expect(texts.some((t) => t.includes("unused y"))).toBe(true);
		expect(texts.some((t) => t.includes("plugin words"))).toBe(false);
		expect(texts.some((t) => t.includes("deleted line"))).toBe(false);
		h.ui.client.close();
	});
});
