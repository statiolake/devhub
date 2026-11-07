/**
 * DevHub as a real Neovim's UI: the attach with every `ext_*` the GUI asks
 * for, keys sent as the page sends them, and the redraw reducer's grid,
 * popupmenu, command line and tab line read back — the protocol as Neovim
 * really speaks it, not as a fixture says it does. Also the clipboard
 * provider and the GUI-window Lua module the attach installs.
 *
 * Skipped where there is no Neovim; `DEVHUB_TEST_NVIM` names one.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { delimiter, join } from "node:path";
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
		read: () => clipboard.text,
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
				read: () => "",
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
			"_G.got = nil; local gui = require('devhub_gui'); local w = gui.open{ title = 'demo', html = '<b>hi</b>' }; gui.on_message(w, function(m) _G.got = m end); gui.send(w, 'ping')",
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

	it("sends toasts, and places an image and a rich float where their windows show them", async () => {
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
		const lastPlace = () =>
			h.gui.events.filter((e) => e.kind === "place").at(-1)?.payload as
				| {
						images: { row: number; rows: number }[] | object;
						rich: { topline: number; border: boolean }[] | object;
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
			expect(lastPlace()?.images).toMatchObject([
				{ row: 2, col: 0, rows: 3, full: 3 },
			]);
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
		}
		await h.ui.request("nvim_exec_lua", [
			"local buf = vim.api.nvim_create_buf(false, true); vim.api.nvim_buf_set_lines(buf, 0, -1, false, { '# Hi', '```lua', 'x = 1', '```' }); local win = vim.api.nvim_open_win(buf, false, { relative = 'editor', row = 1, col = 1, width = 20, height = 4, border = 'rounded' }); _G.rich_win = win; require('devhub_gui').rich_float(win, { '# Hi', '```lua', 'x = 1', '```' })",
			[],
		]);
		await waitFor(
			() =>
				h.gui.events.some((e) => e.kind === "rich") &&
				Array.isArray(lastPlace()?.rich) &&
				(lastPlace()?.rich as unknown[]).length > 0,
			"the rich float placed",
		);
		expect(lastPlace()?.rich).toMatchObject([{ topline: 1, border: true }]);
		await h.ui.request("nvim_exec_lua", [
			"vim.api.nvim_win_close(_G.rich_win, true)",
			[],
		]);
		await waitFor(
			() => h.gui.events.some((e) => e.kind === "rich_clear"),
			"the rich float cleared",
		);
		h.ui.client.close();
	});
	it("reports a view's items and cursor, a card's reserved rows round trip, and a decorated range", async () => {
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
						full: number;
						clip: number;
				  }
				| undefined;
		await waitFor(() => card() !== undefined, "the card placed");
		expect(card()).toMatchObject({
			row: 2,
			col: 0,
			rows: 2,
			full: 2,
			clip: 0,
			active: false,
		});
		await h.ui.request("nvim_exec_lua", [
			"require('devhub_gui')._inline_rows(...)",
			[card()?.id, 4],
		]);
		await waitFor(() => card()?.full === 4, "the measured rows");
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
		// Scrolled so that line 3 is the top: the card's last row is filler above it.
		await h.ui.request("nvim_exec_lua", [
			"vim.fn.winrestview({ lnum = 3, topline = 3, topfill = 1 })",
			[],
		]);
		await waitFor(() => card()?.clip === 3, "the card clipped at the top");
		expect(card()).toMatchObject({ row: 0, rows: 1, full: 4, clip: 3 });

		// A decoration over lines 3–4.
		await h.ui.request("nvim_exec_lua", [
			"vim.fn.winrestview({ lnum = 1, topline = 1, topfill = 0 }); _G.deco = require('devhub_gui').decorate{ buf = 0, range = { 3, 4 }, style = 'dim', tag = 'NEW' }",
			[],
		]);
		await waitFor(
			() => list(last("layers")?.["decos"]).length > 0,
			"the decoration placed",
		);
		expect(last("deco")).toMatchObject({ style: "dim", tag: "NEW" });
		expect(list(last("layers")?.["decos"])[0]).toMatchObject({
			row: 6,
			rows: 2,
			col: 0,
		});
		await h.ui.request("nvim_exec_lua", [
			"_G.deco.clear(); _G.card.clear(); _G.view.close()",
			[],
		]);
		await waitFor(
			() =>
				["deco_clear", "inline_clear", "view_clear"].every((k) =>
					h.gui.events.some((e) => e.kind === k),
				),
			"everything cleared",
		);
		h.ui.client.close();
	}, 20_000);
});
