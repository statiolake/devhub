import { describe, expect, it } from "vitest";
import {
	ChooserSession,
	chooserOf,
	displayPanesOf,
	killConfirm,
	templateReplace,
	type TreeNode,
} from "./chooser.js";

const pane = (id: string, text: string, current = false): TreeNode => ({
	kind: "pane",
	id,
	target: `=s:0.${id}`,
	text,
	children: [],
	current,
});

const TREE: TreeNode[] = [
	{
		kind: "session",
		id: "$0",
		target: "=s:",
		text: "s: 2 windows (attached)",
		current: true,
		children: [
			{
				kind: "window",
				id: "$0@0",
				target: "=s:0.",
				text: "0: server*",
				current: true,
				children: [pane("%0", "0: node*", true), pane("%1", "1: zsh")],
			},
			{
				kind: "window",
				id: "$0@1",
				target: "=s:1.",
				text: "1: build",
				current: false,
				children: [],
			},
		],
	},
	{
		kind: "session",
		id: "$1",
		target: "=agent:",
		text: "agent: 1 windows",
		current: false,
		children: [],
	},
];

describe("tmux's template, as cmd_template_replace fills it", () => {
	it("fills %% once, %1 always, and quotes in %%%", () => {
		expect(templateReplace("switch-client -Zt '%%'", "=s:0.%1")).toBe(
			"switch-client -Zt '=s:0.%1'",
		);
		expect(templateReplace("a %% b %%", "x")).toBe("a x b %%");
		expect(templateReplace("a %1 %1", "x")).toBe("a x x");
		expect(templateReplace('rename "%%%"', 'a"b;c')).toBe(
			String.raw`rename "a\"b\;c"`,
		);
	});
});

describe("the picker", () => {
	it("reads choose-tree, find-window and display-panes", () => {
		expect(chooserOf("choose-tree -Zw")).toMatchObject({
			collapse: "windows",
			zoom: true,
			template: "switch-client -Zt '%%'",
		});
		expect(chooserOf("choose-tree -s 'kill-session -t %%'")?.template).toBe(
			"kill-session -t %%",
		);
		expect(chooserOf('find-window -Z -- "log"')).toMatchObject({
			match: "log",
		});
		expect(displayPanesOf("display-panes -d 0")).toEqual({
			template: "select-pane -t '%%'",
			duration: 0,
			noKeys: false,
		});
	});

	it("starts on the client's pane, filters as typed and chooses with the template", () => {
		const s = new ChooserSession(
			{ collapse: "windows", template: "switch-client -Zt '%%'", zoom: true },
			TREE,
		);
		// -w: windows start closed, but the client's own is open.
		expect(s.rows().map((r) => r.text)).toEqual([
			"s: 2 windows (attached)",
			"0: server*",
			"0: node*",
			"1: zsh",
			"1: build",
			"agent: 1 windows",
		]);
		expect(s.chosen?.id).toBe("%0");
		s.key("z");
		s.key("s");
		expect(s.rows().map((r) => r.text)).toEqual([
			"s: 2 windows (attached)",
			"0: server*",
			"1: zsh",
		]);
		expect(s.chosen?.text).toBe("1: zsh");
		expect(s.key("Enter")).toEqual({
			kind: "choose",
			command: "switch-client -Zt '=s:0.%1'",
		});
		s.key("C-u");
		s.key("Left");
		expect(s.key("C-x")).toMatchObject({ kind: "kill" });
		expect(s.key("Escape")).toEqual({ kind: "close" });
	});

	it("asks before a kill as tmux does", () => {
		expect(killConfirm(pane("%3", "1: zsh"))).toBe(
			'confirm-before -p "Kill pane 1? (y/n)" "kill-pane -t %3"',
		);
	});
});
