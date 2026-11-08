import { describe, expect, it } from "vitest";
import {
	MenuSession,
	ifShellOf,
	keptItems,
	menuOf,
	menuPosition,
	plainText,
} from "./menu.js";

// tmux 3.7c's `>` as `list-keys` prints it, cut short.
const PANE_MENU =
	'display-menu -T "#[align=centre]#{pane_index} (#{pane_id})" -x P -y P "#{?#{>:#{window_panes},1},,-}Swap Up" u { swap-pane -U } "" "Horizontal Split" h { split-window -h } "" Kill X { kill-pane } Zoom z { resize-pane -Z }';

describe("a display-menu binding", () => {
	it("is read as tmux reads its items: name, key, command, or a separator", () => {
		const menu = menuOf(PANE_MENU);
		expect(menu).toMatchObject({
			x: "P",
			y: "P",
			startingChoice: 0,
			stayOpen: false,
		});
		expect(menu?.items.map((i) => i.name)).toEqual([
			"#{?#{>:#{window_panes},1},,-}Swap Up",
			"",
			"Horizontal Split",
			"",
			"Kill",
			"Zoom",
		]);
		expect(menu?.items[2]).toEqual({
			name: "Horizontal Split",
			key: "h",
			command: "split-window -h",
		});
		expect(menuOf("display-menu -C - -O -t = x y z")).toMatchObject({
			startingChoice: -1,
			stayOpen: true,
			target: "=",
		});
		expect(menuOf("display-menu a")).toBeUndefined();
		expect(menuOf("display-menu a b c ; kill-pane")).toBeUndefined();
	});

	it("reads an if-shell -F, as tmux's right-click binding is one", () => {
		expect(
			ifShellOf(
				'if-shell -F -t = "#{mouse_any_flag}" { select-pane -t = ; send-keys -M } { display-menu -t = -x M -y M a b c }',
			),
		).toEqual({
			condition: "#{mouse_any_flag}",
			target: "=",
			then: "select-pane -t = ; send-keys -M",
			otherwise: "display-menu -t = -x M -y M a b c",
		});
		expect(ifShellOf("if-shell 'true' x")).toBeUndefined();
	});

	it("keeps the items tmux keeps once expanded, and draws their text plain", () => {
		const menu = menuOf(PANE_MENU);
		if (menu === undefined) throw new Error("no menu");
		const items = keptItems(
			menu,
			// One pane: "Swap Up" expands to "-Swap Up"; an empty name is no item.
			["-Swap Up", "", "Horizontal Split", "", "Kill", ""].map((name, i) => ({
				name,
				command: menu.items[i].command,
			})),
		);
		const session = new MenuSession("#[align=centre]0 (%1)", items, 0);
		expect(session.items).toEqual([
			{ name: "Swap Up", disabled: true },
			{},
			{ name: "Horizontal Split", key: "h" },
			{},
			{ name: "Kill", key: "X" },
		]);
		expect(plainText(session.title)).toBe("0 (%1)");
		// The first item is disabled: the keys start on the first that is not.
		expect(session.choice).toBe(2);
	});

	it("takes tmux's menu keys", () => {
		const items = [
			{ name: "a", key: "a", command: "one" },
			{ name: undefined, key: "", command: "" },
			{ name: "-b", key: "b", command: "two" },
			{ name: "c", key: "c", command: "three" },
		];
		const session = new MenuSession("", items, 0);
		expect(session.key("j")).toEqual({ kind: "changed" });
		expect(session.choice).toBe(3);
		session.key("Down");
		expect(session.choice).toBe(0);
		session.key("k");
		expect(session.choice).toBe(3);
		expect(session.key("Enter")).toEqual({ kind: "run", command: "three" });
		// A disabled item's key is no item's.
		expect(session.key("b")).toEqual({ kind: "unchanged" });
		expect(session.key("a")).toEqual({ kind: "run", command: "one" });
		expect(session.key("q")).toEqual({ kind: "close" });
		expect(session.key("C-g")).toEqual({ kind: "close" });
		expect(session.width).toBe(1 + 4 + 4);
		expect(session.height).toBe(6);
	});
});

describe("where a menu goes", () => {
	const place = {
		cols: 100,
		rows: 40,
		pane: { x: 50, y: 0, width: 50, height: 20 },
		mouse: { x: 60, y: 10 },
	};
	it("follows tmux's -x and -y", () => {
		// Centred by default.
		expect(menuPosition(undefined, undefined, 20, 10, place)).toEqual({
			x: 39,
			y: 14,
		});
		// P: the pane's left, the menu's last line at the pane's bottom.
		expect(menuPosition("P", "P", 20, 10, place)).toEqual({ x: 50, y: 10 });
		// M: centred on the mouse, its top at the mouse.
		expect(menuPosition("M", "M", 20, 10, place)).toEqual({ x: 50, y: 10 });
		// R: the pane's right edge.
		expect(menuPosition("R", "0", 20, 10, place)).toEqual({ x: 80, y: 0 });
		// Kept on the window.
		expect(menuPosition("95", "200", 20, 10, place)).toEqual({ x: 80, y: 30 });
		// W: over the window's tab, the panes' foot.
		expect(menuPosition("W", "W", 20, 10, place)).toEqual({ x: "W", y: 30 });
	});
});
