/**
 * The pure parts of DevHub as a Neovim UI: the attach options, the clipboard
 * provider's two directions, the window title's buffer name, and Neovim's ext
 * handles made plain for the page. The protocol itself is
 * `neovimUi.real.test.ts`, against a real Neovim.
 */

import { describe, expect, it } from "vitest";
import { encode, MsgpackExt } from "./msgpack.js";
import {
	bufferTitle,
	clipboardCopy,
	clipboardPaste,
	plainHandles,
	uiAttachOptions,
} from "./neovimUi.js";

describe("DevHub as a Neovim UI", () => {
	it("attaches with the ext_* the page draws natively", () => {
		expect(uiAttachOptions()).toMatchObject({
			rgb: true,
			ext_linegrid: true,
			ext_multigrid: true,
			ext_popupmenu: true,
			ext_cmdline: true,
			ext_tabline: true,
			ext_hlstate: true,
			ext_messages: false,
		});
	});

	it("pastes the Mac's clipboard linewise when it ends with a newline", () => {
		expect(clipboardPaste("a\nb\n")).toEqual([["a", "b"], "V"]);
		expect(clipboardPaste("a\r\nb")).toEqual([["a", "b"], "v"]);
	});

	it("copies a yank to the Mac's clipboard, a linewise one ending in a newline", () => {
		expect(clipboardCopy(["one", "two", ""], "V")).toBe("one\ntwo\n");
		expect(clipboardCopy(["one"], "V")).toBe("one\n");
		expect(clipboardCopy(["one", "two"], "v")).toBe("one\ntwo");
	});

	it("titles a file by its name and nothing else at all", () => {
		expect(bufferTitle("/src/app/main.ts", "")).toBe("main.ts");
		expect(bufferTitle("devhub://Outline/1", "nofile")).toBe("");
		expect(bufferTitle("term://~//123:zsh", "terminal")).toBe("");
		expect(bufferTitle("", "")).toBe("");
	});

	it("turns Window, Buffer and Tabpage handles into their numbers", () => {
		const win = new MsgpackExt(1, encode(1000));
		const tab = new MsgpackExt(2, encode(3));
		expect(plainHandles(["win_pos", [2, win, 0, 0, 80, 24]])).toEqual([
			"win_pos",
			[2, 1000, 0, 0, 80, 24],
		]);
		expect(plainHandles({ tab, name: "x" })).toEqual({ tab: 3, name: "x" });
		const untouched = ["grid_line", [1, 0, 0, [["a"]]]];
		expect(plainHandles(untouched)).toBe(untouched);
	});
});
