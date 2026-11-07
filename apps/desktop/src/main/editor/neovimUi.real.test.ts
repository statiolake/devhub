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
import { NeovimUi, type NeovimUiSink } from "./neovimUi.js";
import { makeSocketDir } from "../../model/testScratch.js";
import {
	applyRedraw,
	gridRowText,
	initialUiState,
	layoutGrids,
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
	readonly gui: { opened: unknown[]; windows: unknown[]; sent: unknown[] };
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

	it("gets every cell again when a new UI attaches to a Neovim that had one", async () => {
		const h = await attached();
		h.ui.call("nvim_input", ["ifirst<CR>second<Esc>"]);
		await h.until((s) => cursorGridText(s)[1] === "second", "the typed lines");
		h.ui.client.close();
		const client = await NeovimClient.connect(lastSocket);
		const state = initialUiState();
		const ui = new NeovimUi(client, { read: () => "", write: () => undefined });
		await ui.attach(
			{
				redraw: (batches) => applyRedraw(state, batches),
				guiWindows: () => undefined,
				guiOpen: () => undefined,
				guiClose: () => undefined,
				guiSend: () => undefined,
			},
			60,
			20,
		);
		for (let i = 0; i < 100 && cursorGridText(state)[1] !== "second"; i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(cursorGridText(state).slice(0, 3)).toEqual(["first", "second", "~"]);
		client.close();
	});

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
});
