/**
 * `gui.document` in a real Neovim (`neovimDocument.ts`): the window and
 * buffer it opens, what it tells the page (the text, where it is, the
 * scrolls its keys ask for, the link they follow), and what the page asks
 * of it — the view it scrolled to, a file looked for and read relative to
 * the document's folder, a link to a file opened in Neovim.
 *
 * DevHub's own Neovim (`testNeovim.ts`).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NeovimClient } from "./neovimRpc.js";
import { NeovimUi, type NeovimUiSink } from "./neovimUi.js";
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

async function attached(): Promise<{
	ui: NeovimUi;
	events: { kind: string; payload: unknown }[];
}> {
	const sockets = makeSocketDir("nvim-doc");
	directories.push(sockets);
	const socket = join(sockets, "n.sock");
	const child = spawn(
		NVIM as string,
		["--headless", "--clean", "--listen", socket],
		{ stdio: "ignore" },
	);
	children.push(child);
	let client: NeovimClient | undefined;
	for (let attempt = 0; attempt < 200 && !client; attempt += 1) {
		if (existsSync(socket)) {
			try {
				client = await NeovimClient.connect(socket);
			} catch {
				// Not listening yet.
			}
		}
		if (!client) await new Promise((resolve) => setTimeout(resolve, 25));
	}
	if (!client) throw new Error("nvim did not open its socket");
	const events: { kind: string; payload: unknown }[] = [];
	const sink: NeovimUiSink = {
		redraw: () => undefined,
		guiWindows: () => undefined,
		guiOpen: () => undefined,
		guiClose: () => undefined,
		guiSend: () => undefined,
		guiEvent: (kind, payload) => events.push({ kind, payload }),
	};
	const ui = new NeovimUi(client, {
		read: () => Promise.resolve(""),
		write: () => undefined,
	});
	await ui.attach(sink, 80, 24);
	return { ui, events };
}

type Rec = Record<string, unknown>;

describe.skipIf(NVIM === undefined)("gui.document in a real Neovim", () => {
	it("opens beside the window, tells the page, scrolls, finds and opens files", async () => {
		const { ui, events } = await attached();
		const lua = (code: string, args: unknown[] = []) =>
			ui.request("nvim_exec_lua", [code, args]);
		const waitFor = async (check: () => boolean, what: string) => {
			const deadline = Date.now() + 3_000;
			while (!check()) {
				if (Date.now() > deadline)
					throw new Error(`timed out waiting for ${what}`);
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		};
		const last = (kind: string) =>
			events.filter((e) => e.kind === kind).at(-1)?.payload as Rec | undefined;
		const placed = () =>
			((last("documents")?.["documents"] as Rec[] | undefined) ?? [])[0];

		const folder = makeSocketDir("nvim-doc-files");
		directories.push(folder);
		mkdirSync(join(folder, "img"));
		writeFileSync(
			join(folder, "img", "dot.png"),
			Buffer.from([137, 80, 78, 71]),
		);
		writeFileSync(join(folder, "other.md"), "# Other\n");
		const text = [
			"# Title",
			"",
			"See [the other](other.md) and <https://example.com>.",
			"",
			"![dot](img/dot.png)",
			...Array.from({ length: 60 }, (_, i) => `line ${String(i)}`),
		].join("\n");

		await lua(
			`local text, base = ...
			_G.links = {}
			_G.source = vim.api.nvim_get_current_win()
			_G.doc = require('devhub_gui').document{ text = text, base = base, title = 'notes.md',
				on_link = function(link) table.insert(_G.links, link.path) return _G.take end,
				on_close = function(h) _G.closed = h.id end }`,
			[text, folder],
		);
		await waitFor(() => placed() !== undefined, "the document placed");
		const sent = last("document")!;
		expect(sent).toMatchObject({
			format: "markdown",
			text,
			base: folder,
			title: "notes.md",
		});
		const id = sent["id"] as number;
		// Beside the window it was opened from, which keeps the keys; the
		// buffer is the text, line for line.
		expect(
			await lua(
				"return { #vim.api.nvim_tabpage_list_wins(0), vim.api.nvim_get_current_win() == _G.source, vim.api.nvim_buf_get_lines(_G.doc.buf, 2, 3, false)[1], vim.bo[_G.doc.buf].filetype, vim.bo[_G.doc.buf].modifiable }",
			),
		).toEqual([2, true, text.split("\n")[2], "devhub_document", false]);
		expect(placed()).toMatchObject({
			id,
			win: await lua("return _G.doc.win"),
			topline: 1,
			current: false,
		});

		// The extension follows its cursor: a scroll to a line, asked of the page.
		await lua("_G.doc:scroll_to(30)");
		await waitFor(() => last("document_scroll")?.["by"] === "to", "the scroll");
		expect(last("document_scroll")).toMatchObject({ id, by: "to", line: 30 });

		// The page says what it shows: the window's top follows.
		await lua("require('devhub_gui')._document_view(...)", [id, 12, 30]);
		expect(await lua("return vim.fn.line('w0', _G.doc.win)")).toBe(12);
		expect(await lua("return _G.doc:view()")).toEqual({ top: 12, bottom: 30 });

		// Its keys, in its window: j asks the page to scroll down a line.
		await lua("vim.api.nvim_set_current_win(_G.doc.win)");
		await ui.request("nvim_input", ["3j"]);
		await waitFor(
			() => last("document_scroll")?.["by"] === "line",
			"j as a scroll",
		);
		expect(last("document_scroll")).toMatchObject({ id, by: "line", n: 3 });

		// <Tab> moves to the first link in sight, <CR> follows it.
		await lua("require('devhub_gui')._document_view(...)", [id, 1, 20]);
		await ui.request("nvim_input", ["<Tab>"]);
		await waitFor(() => placed()?.["focus"] !== undefined, "the focus");
		expect(placed()?.["focus"]).toEqual({ line: 3, href: "other.md" });
		await ui.request("nvim_input", ["<Tab>"]);
		await waitFor(
			() =>
				(placed()?.["focus"] as Rec | undefined)?.["href"] ===
				"https://example.com",
			"the next link",
		);
		await ui.request("nvim_input", ["<CR>"]);
		await waitFor(
			() => last("document_activate") !== undefined,
			"the link followed",
		);
		expect(last("document_activate")).toMatchObject({
			id,
			line: 3,
			href: "https://example.com",
		});

		// Files are found relative to the document's folder, and read there.
		const found = await lua(
			"return require('devhub_gui')._document_resolve(...)",
			[id, null, ["img/dot.png", "missing.png", "other.md"]],
		);
		expect(found).toEqual([
			join(folder, "img", "dot.png"),
			null,
			join(folder, "other.md"),
		]);
		const read = (await lua(
			"return require('devhub_gui')._document_read(...)",
			[id, join(folder, "img", "dot.png")],
		)) as Rec;
		expect(read).toMatchObject({ media_type: "image/png", base64: "iVBORw==" });
		expect(typeof read["signature"]).toBe("string");

		// A link to a file: on_link is asked first; when it declines, the
		// file opens in the window the document was opened from.
		await lua("_G.take = true");
		await lua("require('devhub_gui')._document_open(...)", [
			id,
			join(folder, "other.md"),
			1,
			1,
		]);
		expect(
			await lua(
				"return { #_G.links, vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(_G.source)) == vim.api.nvim_buf_get_name(0) }",
			),
		).toEqual([1, false]);
		await lua("_G.take = false");
		await lua("require('devhub_gui')._document_open(...)", [
			id,
			join(folder, "other.md"),
			1,
			1,
		]);
		expect(
			await lua(
				"return { vim.api.nvim_get_current_win() == _G.source, vim.fn.expand('%:t') }",
			),
		).toEqual([true, "other.md"]);

		// An update: the text, again, and the buffer with it.
		await lua("_G.doc:update('# New\\n\\nbody')");
		await waitFor(
			() => last("document")?.["text"] === "# New\n\nbody",
			"the update",
		);
		expect(
			await lua("return vim.api.nvim_buf_get_lines(_G.doc.buf, 0, -1, false)"),
		).toEqual(["# New", "", "body"]);

		// Its window closed (the buffer wiped): the page lets it go.
		await lua("vim.api.nvim_win_close(_G.doc.win, true)");
		await waitFor(() => last("document_clear") !== undefined, "the clear");
		expect(last("document_clear")).toEqual({ id });
		expect(
			await lua("return { _G.doc:is_open(), _G.closed == _G.doc.id }"),
		).toEqual([false, true]);
	});
});
