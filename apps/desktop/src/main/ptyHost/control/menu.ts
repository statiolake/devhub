/**
 * `display-menu` for a control client (phase 3, `docs/terminal-mode.md`),
 * and the `if-shell -F` a binding wraps one in (tmux's right-click menu).
 *
 * tmux draws a menu as an overlay on the client and takes the client's next
 * keys; a control client gets none of it drawn, and while it is open the
 * client's command queue waits. So DevHub reads the binding's menu, has tmux
 * expand every title, item name and command against the menu's target pane
 * (`display-message -p`, as `format_single_from_state` would), and asks it:
 * tmux's keys (`menu_key_cb`: an item's key, Up/Down and `k`/`j`, Home/End
 * and `g`/`G`, PPage/NPage, Enter, Escape/`q`/`C-c`/`C-g`), placed by
 * tmux's `-x`/`-y` rules (`cmd_display_menu_get_pos`). The chosen item's
 * command is tmux's to run (`controlClient.ts`).
 *
 * Pure: `controlClient.ts` reads and sends.
 */

import type { MenuItem } from "../../../ipc/terminalControl.js";
import { parseCommands, readFlags } from "./tmuxCommand.js";

/** A `display-menu` binding's items, as written (formats unexpanded). */
export interface MenuArgs {
	readonly title: string;
	readonly items: readonly MenuItemArgs[];
	readonly x?: string;
	readonly y?: string;
	/** `-t`: the target pane; `=` is the mouse's. */
	readonly target?: string;
	/** `-C`: the item chosen at first; -1 none. */
	readonly startingChoice: number;
	/** `-O`: stays open after a choice (with the mouse, as tmux has it). */
	readonly stayOpen: boolean;
}

export interface MenuItemArgs {
	/** `""` is a separator. A name beginning `-` is shown and not chosen. */
	readonly name: string;
	readonly key: string;
	readonly command: string;
}

/** A binding that is one `display-menu` and nothing else, read. */
export function menuOf(binding: string): MenuArgs | undefined {
	const commands = parseCommands(binding);
	if (commands.length !== 1) return undefined;
	const [name, ...words] = commands[0];
	if (name !== "display-menu" && name !== "menu") return undefined;
	const read = readFlags(words, "bcCHsStTxy", "MO");
	if (read === undefined || read.flags.has("c")) return undefined;
	const items: MenuItemArgs[] = [];
	const rest = read.rest;
	for (let i = 0; i < rest.length; ) {
		const itemName = rest[i++];
		if (itemName === "") {
			items.push({ name: "", key: "", command: "" });
			continue;
		}
		if (rest.length - i < 2) return undefined;
		items.push({ name: itemName, key: rest[i++], command: rest[i++] });
	}
	const choice = read.flags.get("C");
	const flag = (f: string) => read.flags.get(f);
	return {
		title: flag("T") ?? "",
		items,
		...(flag("x") === undefined ? {} : { x: flag("x") }),
		...(flag("y") === undefined ? {} : { y: flag("y") }),
		...(flag("t") === undefined ? {} : { target: flag("t") }),
		startingChoice:
			choice === undefined ? 0 : choice === "-" ? -1 : Number(choice) || 0,
		stayOpen: read.count.has("O"),
	};
}

/** A binding that is one `if-shell -F`: tmux decides by a format, no shell. */
export interface IfShellArgs {
	readonly condition: string;
	readonly target?: string;
	readonly then: string;
	readonly otherwise?: string;
}

export function ifShellOf(binding: string): IfShellArgs | undefined {
	const commands = parseCommands(binding);
	if (commands.length !== 1) return undefined;
	const [name, ...words] = commands[0];
	if (name !== "if-shell" && name !== "if") return undefined;
	const read = readFlags(words, "t", "bF");
	if (read === undefined || !read.count.has("F")) return undefined;
	const [condition, then, otherwise] = read.rest;
	if (condition === undefined || then === undefined || read.rest.length > 3)
		return undefined;
	const target = read.flags.get("t");
	return {
		condition,
		then,
		...(target === undefined ? {} : { target }),
		...(otherwise === undefined ? {} : { otherwise }),
	};
}

/** tmux's styles (`#[...]`) and its `##` in an expanded name: text alone. */
export function plainText(text: string): string {
	return text.replace(/#\[[^\]]*\]/g, "").replace(/##/g, "#");
}

/** An item tmux kept, with its expanded command. */
interface Kept {
	readonly name: string | undefined;
	readonly key: string;
	readonly command: string;
}

/**
 * The menu's items once tmux expanded them, kept as `menu_add_item` keeps
 * them: no item whose name is empty once expanded, no separator first or
 * twice in a row.
 */
export function keptItems(
	args: MenuArgs,
	expanded: readonly { readonly name: string; readonly command: string }[],
): Kept[] {
	const kept: Kept[] = [];
	args.items.forEach((item, i) => {
		const line = item.name === "";
		if (line) {
			if (kept.length === 0 || kept[kept.length - 1].name === undefined) return;
			kept.push({ name: undefined, key: "", command: "" });
			return;
		}
		const name = expanded[i]?.name ?? "";
		if (name === "") return;
		kept.push({ name, key: item.key, command: expanded[i]?.command ?? "" });
	});
	return kept;
}

export type MenuStep =
	| { readonly kind: "changed" }
	| { readonly kind: "unchanged" }
	| { readonly kind: "close" }
	| { readonly kind: "run"; readonly command: string };

/** A menu being asked: tmux's `menu_key_cb`. */
export class MenuSession {
	readonly #items: readonly Kept[];
	readonly title: string;
	#choice: number;

	constructor(title: string, items: readonly Kept[], startingChoice: number) {
		this.title = title;
		this.#items = items;
		this.#choice =
			startingChoice < 0 || items.length === 0
				? -1
				: Math.min(startingChoice, items.length - 1);
		if (this.#choice !== -1 && !this.#selectable(this.#choice)) {
			const first = items.findIndex((_, i) => this.#selectable(i));
			this.#choice = first;
		}
	}

	get choice(): number {
		return this.#choice;
	}

	get items(): MenuItem[] {
		return this.#items.map((item) => {
			if (item.name === undefined) return {};
			const disabled = item.name.startsWith("-");
			const name = plainText(disabled ? item.name.slice(1) : item.name);
			const key =
				item.key === "" || item.key === "-" || disabled ? undefined : item.key;
			return {
				name,
				...(key === undefined ? {} : { key }),
				...(disabled ? { disabled } : {}),
			};
		});
	}

	/** The menu's size as tmux works it out: its widest line, and four. */
	get width(): number {
		let width = [...plainText(this.title)].length;
		for (const item of this.items) {
			if (item.name === undefined) continue;
			const w =
				[...item.name].length +
				(item.key === undefined ? 0 : item.key.length + 3);
			width = Math.max(width, w);
		}
		return width + 4;
	}

	get height(): number {
		return this.#items.length + 2;
	}

	#selectable(i: number): boolean {
		const name = this.#items[i]?.name;
		return name !== undefined && !name.startsWith("-");
	}

	/** An item chosen by the mouse, or by its key. */
	choose(index: number): MenuStep {
		if (index < 0 || index >= this.#items.length) return { kind: "close" };
		this.#choice = index;
		if (!this.#selectable(index)) return { kind: "close" };
		return { kind: "run", command: this.#items[index].command };
	}

	key(name: string): MenuStep {
		const count = this.#items.length;
		for (let i = 0; i < count; i++) {
			if (!this.#selectable(i)) continue;
			if (this.#items[i].key === name) return this.choose(i);
		}
		const old = this.#choice;
		const step = (delta: 1 | -1) => {
			const start = old === -1 ? 0 : old;
			do {
				if (delta < 0)
					this.#choice =
						this.#choice === -1 || this.#choice === 0
							? count - 1
							: this.#choice - 1;
				else
					this.#choice =
						this.#choice === -1 || this.#choice === count - 1
							? 0
							: this.#choice + 1;
			} while (!this.#selectable(this.#choice) && this.#choice !== start);
			return { kind: "changed" } as const;
		};
		switch (name) {
			case "BTab":
			case "Up":
			case "k":
				return count === 0 ? { kind: "unchanged" } : step(-1);
			case "Down":
			case "j":
				return count === 0 ? { kind: "unchanged" } : step(1);
			case "PPage":
			case "C-b": {
				if (this.#choice < 6) this.#choice = 0;
				else {
					let i = 5;
					while (i > 0) {
						this.#choice--;
						if (this.#choice !== 0 && this.#selectable(this.#choice)) i--;
						else if (this.#choice === 0) break;
					}
				}
				return { kind: "changed" };
			}
			case "NPage": {
				if (this.#choice > count - 6) this.#choice = count - 1;
				else {
					let i = 5;
					while (i > 0) {
						this.#choice++;
						if (this.#choice !== count - 1 && this.#selectable(this.#choice))
							i--;
						else if (this.#choice === count - 1) break;
					}
				}
				while (this.#choice > 0 && !this.#selectable(this.#choice))
					this.#choice--;
				return { kind: "changed" };
			}
			case "g":
			case "Home":
				this.#choice = 0;
				while (this.#choice < count - 1 && !this.#selectable(this.#choice))
					this.#choice++;
				return { kind: "changed" };
			case "G":
			case "End":
				this.#choice = count - 1;
				while (this.#choice > 0 && !this.#selectable(this.#choice))
					this.#choice--;
				return { kind: "changed" };
			case "Enter":
				return this.#choice === -1
					? { kind: "close" }
					: this.choose(this.#choice);
			case "Escape":
			case "C-[":
			case "C-c":
			case "C-g":
			case "q":
				return { kind: "close" };
		}
		return { kind: "unchanged" };
	}
}

/** Where the client's panes are, as `cmd_display_menu_get_pos` reads them. */
export interface MenuPlace {
	readonly cols: number;
	readonly rows: number;
	/** The target pane's rectangle. */
	readonly pane: {
		readonly x: number;
		readonly y: number;
		readonly width: number;
		readonly height: number;
	};
	/** Where the mouse was, if a click opened it. */
	readonly mouse?: { readonly x: number; readonly y: number };
}

/**
 * The menu's top-left cell, by tmux's rules for `-x`/`-y`: `C` centred, `P`
 * the target pane's left / bottom, `R` its right, `M` the mouse, a number
 * (the menu's last line for `-y`), or one of tmux's `#{popup_*}` formats.
 * `W` and `S` are positions on tmux's status line: DevHub's windows are
 * below the panes, so `W` is `"W"` (the page puts it over the window's tab)
 * and `-y W`/`S` is the panes' foot.
 */
export function menuPosition(
	x: string | undefined,
	y: string | undefined,
	w: number,
	h: number,
	place: MenuPlace,
): { x: number | "W"; y: number } {
	const { cols, rows, pane, mouse } = place;
	const values: Record<string, number | undefined> = {
		popup_width: w,
		popup_height: h,
		popup_centre_x: Math.max(0, Math.floor((cols - 1) / 2) - Math.floor(w / 2)),
		popup_centre_y: Math.min(
			rows - h,
			Math.floor((rows - 1) / 2) + Math.floor(h / 2),
		),
		popup_pane_top: Math.min(rows - h, pane.y + h),
		popup_pane_bottom: pane.y + pane.height,
		popup_pane_left: pane.x,
		popup_pane_right: Math.max(0, pane.x + pane.width - w),
		popup_status_line_y: rows,
		popup_window_status_line_y: rows,
		...(mouse === undefined
			? {}
			: {
					popup_mouse_x: mouse.x,
					popup_mouse_y: mouse.y,
					popup_mouse_centre_x: Math.max(0, mouse.x - Math.floor(w / 2)),
					popup_mouse_centre_y:
						mouse.y - Math.floor(h / 2) + h >= rows
							? rows - h
							: mouse.y - Math.floor(h / 2),
					popup_mouse_top: Math.min(rows - 1, mouse.y + h),
					popup_mouse_bottom: Math.max(0, mouse.y - h),
				}),
	};
	const read = (value: string): number => {
		const format = /^#\{(popup_[a-z_]+)\}$/.exec(value);
		const n = format !== null ? values[format[1]] : Number.parseInt(value, 10);
		return n === undefined || Number.isNaN(n) ? 0 : n;
	};
	let px: number | "W";
	if (x === "W") px = "W";
	else {
		const name =
			x === undefined || x === "C"
				? "#{popup_centre_x}"
				: x === "R"
					? "#{popup_pane_right}"
					: x === "P"
						? "#{popup_pane_left}"
						: x === "M"
							? "#{popup_mouse_centre_x}"
							: x;
		const n = read(name);
		px = n + w >= cols ? Math.max(0, cols - w) : Math.max(0, n);
	}
	const yName =
		y === undefined || y === "C"
			? "#{popup_centre_y}"
			: y === "P"
				? "#{popup_pane_bottom}"
				: y === "M"
					? "#{popup_mouse_top}"
					: y === "S"
						? "#{popup_status_line_y}"
						: y === "W"
							? "#{popup_window_status_line_y}"
							: y;
	let n = read(yName);
	n = n < h ? 0 : n - h;
	if (n + h >= rows) n = Math.max(0, rows - h);
	return { x: px, y: n };
}
