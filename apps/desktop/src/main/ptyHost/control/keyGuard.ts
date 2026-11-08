/**
 * Which keys a control client may pass to tmux, before DevHub draws what tmux
 * does not draw for control clients (phase 3, `docs/terminal-mode.md`).
 *
 * A key reaches tmux through `send-keys -K`, which runs the client's key
 * tables: the prefix, the bindings, `switch-client -T`. Some commands wait on
 * the client in a way a control client cannot answer: a `display-popup`
 * holds the client's command queue until its command exits (an fzf popup
 * nobody can see never does), a `display-menu` or `display-panes` takes the
 * next key, a `command-prompt` or `confirm-before` waits for an answer typed
 * into a prompt that is never shown. Once one runs, every command DevHub
 * sends after it waits too: the terminal stops.
 *
 * So DevHub keeps its own copy of where tmux is in its key tables, from the
 * bindings tmux lists (`list-keys`), and looks a key up before it sends it:
 * the prefix is held until the key after it says which binding it is, and a
 * binding that would wait is not sent but said (`KeyRoute.refused`); one
 * that is a `display-popup` is handed to DevHub to run (`KeyRoute.popup`,
 * `popup.ts`), one that is a `command-prompt` or `confirm-before` to DevHub
 * to ask (`KeyRoute.prompt`, `prompt.ts`). Pure:
 * `controlClient.ts` reads the bindings and sends.
 */

import { ifShellOf, menuOf, type IfShellArgs, type MenuArgs } from "./menu.js";
import { promptOf, type PromptArgs } from "./prompt.js";
import { popupOf, type PopupArgs } from "./tmuxCommand.js";

export interface Binding {
	readonly command: string;
	/** `bind -r`: the table stays the prefix's for `repeat-time`. */
	readonly repeat: boolean;
}

/** Table → key → binding, as `list-keys` writes them. */
export type Bindings = ReadonlyMap<string, ReadonlyMap<string, Binding>>;

/**
 * The commands that wait on the client. Their aliases too (`popup`, `menu`,
 * `confirm`, `displayp`); `find-window` is choose-tree.
 */
const WAITING =
	/(?:^|[\s;{"'])(display-popup|popup|display-menu|menu|command-prompt|confirm-before|confirm|choose-tree|choose-client|choose-buffer|choose-session|choose-window|display-panes|displayp|customize-mode|find-window|findw)(?=$|[\s;}"'])/;

/** The first command in `command` that would wait on the client, if any. */
export function waitingCommand(command: string): string | undefined {
	return WAITING.exec(command)?.[1];
}

/** A key name as `list-keys` writes it: `\;`, `'"'`, `\#` are `;`, `"`, `#`. */
function unquoteKey(token: string): string {
	if (
		token.length >= 2 &&
		(token[0] === "'" || token[0] === '"') &&
		token.endsWith(token[0])
	) {
		return token.slice(1, -1);
	}
	if (token.length === 2 && token[0] === "\\") return token[1];
	return token;
}

/** `list-keys`' lines: `bind-key [-r] -T <table> <key> <command…>`. */
export function parseBindings(lines: readonly string[]): Bindings {
	const tables = new Map<string, Map<string, Binding>>();
	for (const line of lines) {
		const match =
			/^bind-key\s+(-r\s+)?(?:-N\s+(?:"[^"]*"|\S+)\s+)?-T\s+(\S+)\s+(\S+)\s+(.*)$/.exec(
				line,
			);
		if (match === null) continue;
		const [, repeat, table, key, command] = match;
		let keys = tables.get(table);
		if (keys === undefined) {
			keys = new Map();
			tables.set(table, keys);
		}
		keys.set(unquoteKey(key), {
			command: command.trim(),
			repeat: repeat !== undefined,
		});
	}
	return tables;
}

export interface KeyRoute {
	/** Keys to send with `send-keys -K`, in order. */
	readonly send: readonly string[];
	/** A binding that would wait on the client, not sent. */
	readonly refused?: { readonly keys: string; readonly command: string };
	/**
	 * A binding that is one `display-popup`: DevHub runs it itself
	 * (`popup.ts`), not sent.
	 */
	readonly popup?: PopupArgs;
	/**
	 * A binding that is one `command-prompt` or `confirm-before`: DevHub asks
	 * it (`prompt.ts`), not sent.
	 */
	readonly prompt?: PromptArgs;
	/** A binding that is one `display-menu`: DevHub asks it (`menu.ts`). */
	readonly menu?: MenuArgs;
	/**
	 * A binding that is one `if-shell -F` with a command that would wait in
	 * it: tmux decides the format, DevHub runs the arm (`controlClient.ts`).
	 */
	readonly conditional?: IfShellArgs;
	/**
	 * tmux may be in a table other than the root one (a repeat, a
	 * `switch-client -T`) after a refusal: it is to be put back in it.
	 */
	readonly resetTable?: boolean;
}

/** What `switch-client -T <table>` in a binding moves to, if it does. */
function switchesTo(command: string): string | undefined {
	return /(?:^|[\s;])(?:switch-client|switchc)\s+(?:-\S+\s+)*-T\s+(\S+)/.exec(
		command,
	)?.[1];
}

/** Where tmux is in its key tables, as far as the keys DevHub sent say. */
export class KeyRouter {
	#bindings: Bindings;
	#prefixes: readonly string[];
	#repeatMs: number;
	/** A prefix key held until the next key says what it binds. */
	#pending: string | undefined;
	/** The table tmux is in, other than root; and until when, for a repeat. */
	#table: { name: string; until?: number } | undefined;

	constructor(
		bindings: Bindings,
		prefixes: readonly string[],
		repeatMs: number,
	) {
		this.#bindings = bindings;
		this.#prefixes = prefixes;
		this.#repeatMs = repeatMs;
	}

	update(
		bindings: Bindings,
		prefixes: readonly string[],
		repeatMs: number,
	): void {
		this.#bindings = bindings;
		this.#prefixes = prefixes;
		this.#repeatMs = repeatMs;
	}

	/** The command bound to `key` in `table`, if any. */
	binding(table: string, key: string): string | undefined {
		return this.#bindings.get(table)?.get(key)?.command;
	}

	/** A prefix is held: the key after it is looked up in the prefix table. */
	get holdingPrefix(): boolean {
		return this.#pending !== undefined;
	}

	route(key: string, now: number): KeyRoute {
		const pending = this.#pending;
		if (pending !== undefined) {
			this.#pending = undefined;
			return this.#bound("prefix", [pending, key], now);
		}
		const table = this.#table;
		if (table !== undefined) {
			this.#table = undefined;
			const live = table.until === undefined || now < table.until;
			const binding = live
				? this.#bindings.get(table.name)?.get(key)
				: undefined;
			// A repeat goes on only with another repeatable key; any other key
			// is the root table's again, as in tmux.
			if (live && (table.until === undefined || binding?.repeat === true)) {
				return this.#bound(table.name, [key], now);
			}
		}
		if (this.#prefixes.includes(key)) {
			this.#pending = key;
			return { send: [] };
		}
		return this.#bound("root", [key], now);
	}

	#bound(table: string, keys: readonly string[], now: number): KeyRoute {
		const key = keys[keys.length - 1];
		const binding = this.#bindings.get(table)?.get(key);
		if (binding === undefined) return { send: keys };
		const waiting = waitingCommand(binding.command);
		const popup = waiting === undefined ? undefined : popupOf(binding.command);
		const prompt =
			waiting === undefined ? undefined : promptOf(binding.command);
		const menu = waiting === undefined ? undefined : menuOf(binding.command);
		const conditional =
			waiting === undefined ? undefined : ifShellOf(binding.command);
		if (
			popup !== undefined ||
			prompt !== undefined ||
			menu !== undefined ||
			conditional !== undefined
		) {
			return {
				send: [],
				...(popup === undefined ? {} : { popup }),
				...(prompt === undefined ? {} : { prompt }),
				...(menu === undefined ? {} : { menu }),
				...(conditional === undefined ? {} : { conditional }),
				resetTable: table !== "root" && keys.length === 1,
			};
		}
		if (waiting !== undefined) {
			return {
				send: [],
				refused: { keys: keys.join(" "), command: waiting },
				// The prefix was never sent; a table tmux was already in was.
				resetTable: table !== "root" && keys.length === 1,
			};
		}
		const next = switchesTo(binding.command);
		if (next !== undefined) this.#table = { name: next };
		else if (binding.repeat && table === "prefix") {
			this.#table = { name: "prefix", until: now + this.#repeatMs };
		}
		return { send: keys };
	}
}
