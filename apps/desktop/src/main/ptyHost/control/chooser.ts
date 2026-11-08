/**
 * `choose-tree` (`prefix w`, `prefix s`, `find-window`) and `display-panes`
 * for a control client (phase 3, `docs/terminal-mode.md`). tmux draws both
 * into the client (a mode in the pane, an overlay) and a control client
 * gets neither, so DevHub draws them: a picker with the tree on the left,
 * the chosen item's pane on the right, and type-to-filter; pane numbers
 * over the panes.
 *
 * What a choice does is tmux's: the binding's template (`switch-client -Zt
 * '%%'` by default) with `%%` filled by tmux's `cmd_template_replace`
 * (ported below), and the target named as `window_tree_get_target` names it
 * (`=session:`, `=session:index.`, `=session:index.%pane`).
 *
 * Pure: `controlClient.ts` reads the tree from tmux and sends.
 */

import type { ChooserRow } from "../../../ipc/terminalControl.js";
import { parseCommands, readFlags } from "./tmuxCommand.js";

/** tmux's `cmd_template_replace`: `%%` (once) or `%idx`, `%%%` quoted. */
export function templateReplace(template: string, s: string, idx = 1): string {
	if (!template.includes("%")) return template;
	let out = "";
	let replaced = false;
	for (let i = 0; i < template.length; ) {
		const ch = template[i++];
		if (ch === "%") {
			const next = template[i];
			const numbered = next >= "1" && next <= "9" && Number(next) === idx;
			if (numbered || (next === "%" && !replaced)) {
				if (!numbered) replaced = true;
				i++;
				const quoted = template[i] === "%";
				if (quoted) i++;
				for (const c of s) out += quoted && '"\\$;~'.includes(c) ? `\\${c}` : c;
				continue;
			}
		}
		out += ch;
	}
	return out;
}

export interface ChooserArgs {
	/** The level the tree starts collapsed at: `-s` sessions, `-w` windows. */
	readonly collapse: "none" | "sessions" | "windows";
	readonly template: string;
	/** `-f`: tmux's filter format. */
	readonly filter?: string;
	/** `find-window`'s match: the picker's filter to start with. */
	readonly match?: string;
	readonly zoom: boolean;
}

/** A binding that is one `choose-tree` or `find-window`, read. */
export function chooserOf(binding: string): ChooserArgs | undefined {
	const commands = parseCommands(binding);
	if (commands.length !== 1) return undefined;
	const [name, ...words] = commands[0];
	if (name === "choose-tree") {
		const read = readFlags(words, "FfKOt", "GNrswyZ");
		if (read === undefined || read.rest.length > 1) return undefined;
		const filter = read.flags.get("f");
		return {
			collapse: read.count.has("s")
				? "sessions"
				: read.count.has("w")
					? "windows"
					: "none",
			template: read.rest[0] ?? "switch-client -Zt '%%'",
			...(filter === undefined ? {} : { filter }),
			zoom: read.count.has("Z"),
		};
	}
	if (name === "find-window" || name === "findw") {
		const read = readFlags(words, "t", "CiNrTZ");
		if (read === undefined || read.rest.length !== 1) return undefined;
		return {
			collapse: "none",
			template: "switch-client -Zt '%%'",
			match: read.rest[0],
			zoom: read.count.has("Z"),
		};
	}
	return undefined;
}

export interface DisplayPanesArgs {
	readonly template: string;
	/** `-d`: how long the numbers stay, in ms; 0 until a key. */
	readonly duration?: number;
	/** `-N`: no key chooses. */
	readonly noKeys: boolean;
}

export function displayPanesOf(binding: string): DisplayPanesArgs | undefined {
	const commands = parseCommands(binding);
	if (commands.length !== 1) return undefined;
	const [name, ...words] = commands[0];
	if (name !== "display-panes" && name !== "displayp") return undefined;
	const read = readFlags(words, "dt", "bN");
	if (read === undefined || read.rest.length > 1) return undefined;
	const duration = read.flags.get("d");
	return {
		template: read.rest[0] ?? "select-pane -t '%%'",
		...(duration === undefined ? {} : { duration: Number(duration) || 0 }),
		noKeys: read.count.has("N"),
	};
}

/** One node of the tree, as tmux lists it. */
export interface TreeNode {
	readonly kind: "session" | "window" | "pane";
	/** As `window_tree_get_target` names it. */
	readonly target: string;
	/** tmux's id: `$1`, `@2`, `%3`. */
	readonly id: string;
	/** The line tmux's format gave it. */
	readonly text: string;
	readonly children: TreeNode[];
	/** The client's current session, window or pane. */
	readonly current: boolean;
}

export type ChooserStep =
	| { readonly kind: "changed" }
	| { readonly kind: "unchanged" }
	| { readonly kind: "close" }
	| { readonly kind: "choose"; readonly command: string }
	| { readonly kind: "kill"; readonly node: TreeNode };

/**
 * The picker: tmux's mode-tree, with what the person types filtering it.
 * A letter cannot be both a filter character and a command, so the keys
 * of tmux's choose mode that are letters (`j`/`k`, `h`/`l`, `x`, `q`) are
 * its named and Ctrl keys here: Up/Down and `C-p`/`C-n`, Left/Right,
 * `C-x`, Escape and `C-c`/`C-g`.
 */
export class ChooserSession {
	readonly args: ChooserArgs;
	readonly #roots: readonly TreeNode[];
	readonly #expanded = new Map<string, boolean>();
	#filter: string;
	#choice = 0;
	#rows: { node: TreeNode; depth: number }[] = [];

	constructor(args: ChooserArgs, roots: readonly TreeNode[]) {
		this.args = args;
		this.#roots = roots;
		this.#filter = args.match ?? "";
		const walk = (nodes: readonly TreeNode[]) => {
			for (const node of nodes) {
				const collapsed =
					(node.kind === "session" && args.collapse === "sessions") ||
					(node.kind === "window" && args.collapse !== "none");
				// The client's own session or window starts open, as tmux has it.
				this.#expanded.set(node.id, !collapsed || node.current);
				walk(node.children);
			}
		};
		walk(roots);
		this.#layout();
		// The keys start on the client's current item, deepest first.
		let best = -1;
		this.#rows.forEach((row, i) => {
			if (row.node.current) best = i;
		});
		if (best >= 0) this.#choice = best;
	}

	get filter(): string {
		return this.#filter;
	}

	get choice(): number {
		return this.#choice;
	}

	get chosen(): TreeNode | undefined {
		return this.#rows[this.#choice]?.node;
	}

	rows(): ChooserRow[] {
		const filtering = this.#filter !== "";
		return this.#rows.map(({ node, depth }) => ({
			depth,
			text: node.text,
			kind: node.kind,
			...(node.children.length === 0
				? {}
				: { expanded: filtering || this.#expanded.get(node.id) === true }),
			current: node.current,
		}));
	}

	/** The rows shown: open nodes, or every node that matches and its parents. */
	#layout(): void {
		const rows: { node: TreeNode; depth: number }[] = [];
		const needle = this.#filter.toLowerCase();
		const matches = (node: TreeNode): boolean =>
			node.text.toLowerCase().includes(needle) || node.children.some(matches);
		const walk = (nodes: readonly TreeNode[], depth: number) => {
			for (const node of nodes) {
				if (needle !== "" && !matches(node)) continue;
				rows.push({ node, depth });
				if (needle !== "" || this.#expanded.get(node.id) === true)
					walk(node.children, depth + 1);
			}
		};
		walk(this.#roots, 0);
		const before = this.#rows[this.#choice]?.node.id;
		this.#rows = rows;
		const kept = rows.findIndex((row) => row.node.id === before);
		this.#choice = kept >= 0 ? kept : 0;
		if (needle !== "") {
			// The first item that matches itself, not only through a child.
			const own = rows.findIndex((row) =>
				row.node.text.toLowerCase().includes(needle),
			);
			if (kept < 0 || !rows[kept].node.text.toLowerCase().includes(needle))
				this.#choice = Math.max(0, own);
		}
	}

	/** Text typed: the filter's. */
	text(text: string): ChooserStep {
		if (text === "") return { kind: "unchanged" };
		this.#filter += text;
		this.#layout();
		return { kind: "changed" };
	}

	/** A row clicked. */
	choose(index: number): ChooserStep {
		if (index < 0 || index >= this.#rows.length) return { kind: "unchanged" };
		this.#choice = index;
		return this.#chosen();
	}

	#chosen(): ChooserStep {
		const node = this.chosen;
		if (node === undefined) return { kind: "close" };
		return {
			kind: "choose",
			command: templateReplace(this.args.template, node.target),
		};
	}

	key(name: string): ChooserStep {
		const count = this.#rows.length;
		const node = this.chosen;
		switch (name) {
			case "Enter":
				return this.#chosen();
			case "Escape":
			case "C-c":
			case "C-g":
			case "C-[":
				return { kind: "close" };
			case "Up":
			case "C-p":
				this.#choice = count === 0 ? 0 : (this.#choice + count - 1) % count;
				return { kind: "changed" };
			case "Down":
			case "C-n":
				this.#choice = count === 0 ? 0 : (this.#choice + 1) % count;
				return { kind: "changed" };
			case "PPage":
				this.#choice = Math.max(0, this.#choice - 10);
				return { kind: "changed" };
			case "NPage":
				this.#choice = Math.min(count - 1, this.#choice + 10);
				return { kind: "changed" };
			case "Home":
				this.#choice = 0;
				return { kind: "changed" };
			case "End":
				this.#choice = Math.max(0, count - 1);
				return { kind: "changed" };
			case "Right":
				if (node !== undefined && node.children.length > 0) {
					this.#expanded.set(node.id, true);
					this.#layout();
				}
				return { kind: "changed" };
			case "Left": {
				if (node === undefined) return { kind: "unchanged" };
				// tmux: collapse an open node, else go to its parent.
				if (node.children.length > 0 && this.#expanded.get(node.id) === true) {
					this.#expanded.set(node.id, false);
					this.#layout();
					return { kind: "changed" };
				}
				const depth = this.#rows[this.#choice].depth;
				for (let i = this.#choice - 1; i >= 0; i--) {
					if (this.#rows[i].depth < depth) {
						this.#choice = i;
						break;
					}
				}
				return { kind: "changed" };
			}
			case "C-x":
				return node === undefined
					? { kind: "unchanged" }
					: { kind: "kill", node };
			case "BSpace":
				if (this.#filter === "") return { kind: "unchanged" };
				this.#filter = [...this.#filter].slice(0, -1).join("");
				this.#layout();
				return { kind: "changed" };
			case "C-u":
			case "C-w":
				this.#filter = "";
				this.#layout();
				return { kind: "changed" };
			case "Space":
				return this.text(" ");
		}
		if ([...name].length === 1) return this.text(name);
		return { kind: "unchanged" };
	}
}

/** The confirm tmux's choose mode asks before `x` kills an item. */
export function killConfirm(node: TreeNode): string {
	const what =
		node.kind === "session"
			? ["kill-session", `session ${node.text.split(":")[0]}`]
			: node.kind === "window"
				? ["kill-window", `window ${node.text.split(":")[0]}`]
				: ["kill-pane", `pane ${node.text.split(":")[0]}`];
	return `confirm-before -p "Kill ${what[1].replace(/["\\$]/g, "")}? (y/n)" "${what[0]} -t ${node.id}"`;
}
