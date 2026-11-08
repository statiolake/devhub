/**
 * tmux's command syntax, as far as DevHub reads a binding (`list-keys`) to
 * do what tmux does not do for a control client itself (phase 3,
 * `docs/terminal-mode.md`): the commands of a binding, each its words, and
 * a `display-popup`'s flags.
 *
 * The rules are tmux's (`cmd-parse.y`): words split on blanks; `'…'` is
 * literal; `"…"` takes `` escapes; `{…}` is one word, kept as written; a
 * `;` word (or `\;`) ends a command. Formats (`#{…}`) are left as they are:
 * tmux expands them, never DevHub.
 */

/** A binding's commands, each its words. */
export function parseCommands(text: string): string[][] {
	const commands: string[][] = [];
	let words: string[] = [];
	let word = "";
	let inWord = false;
	const end = () => {
		if (inWord) words.push(word);
		word = "";
		inWord = false;
	};
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === " " || c === "\t" || c === "\n") {
			end();
			continue;
		}
		if (c === ";" && !inWord) {
			commands.push(words);
			words = [];
			continue;
		}
		if (c === "\\" && text[i + 1] === ";" && !inWord) {
			i++;
			commands.push(words);
			words = [];
			continue;
		}
		inWord = true;
		if (c === "'") {
			const close = text.indexOf("'", i + 1);
			const stop = close < 0 ? text.length : close;
			word += text.slice(i + 1, stop);
			i = stop;
		} else if (c === '"') {
			i++;
			for (; i < text.length && text[i] !== '"'; i++) {
				if (text[i] === "\\" && i + 1 < text.length) {
					const next = text[++i];
					word += next === "n" ? "\n" : next === "t" ? "\t" : next;
				} else word += text[i];
			}
		} else if (c === "{") {
			let depth = 0;
			const start = i;
			for (; i < text.length; i++) {
				if (text[i] === "{") depth++;
				else if (text[i] === "}" && --depth === 0) break;
			}
			word += text.slice(start + 1, i).trim();
		} else if (c === "\\" && i + 1 < text.length) {
			word += text[++i];
		} else {
			word += c;
		}
	}
	end();
	if (words.length > 0) commands.push(words);
	return commands.filter((command) => command.length > 0);
}

/** `display-popup`'s arguments, as tmux's `args_parse` reads them. */
export interface PopupArgs {
	/** `-E` once: closed when the command exits; twice: only when it succeeds. */
	readonly closeOnExit: 0 | 1 | 2;
	readonly noBorder: boolean;
	readonly width?: string;
	readonly height?: string;
	readonly x?: string;
	readonly y?: string;
	readonly title?: string;
	readonly directory?: string;
	readonly target?: string;
	readonly environment: readonly string[];
	/** The shell command, as one string; absent: the default shell. */
	readonly command?: string;
}

const POPUP_NAMES = new Set(["display-popup", "popup"]);
const VALUE_FLAGS = new Set("bcdehsStTwxy");
const BARE_FLAGS = new Set("BCEkN");

/**
 * A binding that is one `display-popup` and nothing else, read; anything
 * else (another command beside it, `-C`, a flag tmux does not know) is not.
 */
export function popupOf(binding: string): PopupArgs | undefined {
	const commands = parseCommands(binding);
	if (commands.length !== 1) return undefined;
	const [name, ...words] = commands[0];
	if (!POPUP_NAMES.has(name)) return undefined;
	const values = new Map<string, string>();
	const environment: string[] = [];
	let closeOnExit = 0;
	let noBorder = false;
	let i = 0;
	for (; i < words.length; i++) {
		const word = words[i];
		if (word === "--") {
			i++;
			break;
		}
		if (!word.startsWith("-") || word.length < 2) break;
		for (let j = 1; j < word.length; j++) {
			const flag = word[j];
			if (BARE_FLAGS.has(flag)) {
				if (flag === "E") closeOnExit++;
				else if (flag === "B") noBorder = true;
				else if (flag === "C") return undefined;
				continue;
			}
			if (!VALUE_FLAGS.has(flag)) return undefined;
			const rest = word.slice(j + 1);
			const value = rest.length > 0 ? rest : words[++i];
			if (value === undefined) return undefined;
			if (flag === "e") environment.push(value);
			else values.set(flag, value);
			break;
		}
	}
	const command = words.slice(i).join(" ");
	const value = (flag: string) => values.get(flag);
	return {
		closeOnExit: Math.min(closeOnExit, 2) as 0 | 1 | 2,
		noBorder,
		environment,
		...(value("w") === undefined ? {} : { width: value("w") }),
		...(value("h") === undefined ? {} : { height: value("h") }),
		...(value("x") === undefined ? {} : { x: value("x") }),
		...(value("y") === undefined ? {} : { y: value("y") }),
		...(value("T") === undefined ? {} : { title: value("T") }),
		...(value("d") === undefined ? {} : { directory: value("d") }),
		...(value("t") === undefined ? {} : { target: value("t") }),
		...(command === "" ? {} : { command }),
	};
}

/** A size as `-w`/`-h` give it: cells, or a percentage of `whole`. */
export function popupSize(
	value: string | undefined,
	whole: number,
	fallback: number,
): number {
	if (value === undefined) return fallback;
	const percent = /^(\d+)%$/.exec(value);
	const n =
		percent !== null
			? Math.floor((whole * Number(percent[1])) / 100)
			: Number(value);
	if (!Number.isFinite(n) || n < 1) return fallback;
	return Math.min(Math.floor(n), whole);
}

/**
 * Where a popup of `size` goes on an axis of `whole` cells: `C` (the
 * default) centres it, a number is its first cell, a percentage of `whole`
 * too. tmux's other positions (`P`, `M`, `W`, `R`, `S`) are of a mouse or a
 * status line a control client has not got; they centre it.
 */
export function popupPosition(
	value: string | undefined,
	whole: number,
	size: number,
	/** `-y`: a number is the popup's last line, as tmux takes it. */
	fromBottom = false,
): number {
	const centre = Math.floor((whole - size) / 2);
	if (value === undefined || value === "C") return centre;
	const percent = /^(\d+)%$/.exec(value);
	const n =
		percent !== null
			? Math.floor((whole * Number(percent[1])) / 100)
			: Number(value);
	if (!Number.isFinite(n) || !/^\d+%?$/.test(value)) return centre;
	const first = fromBottom ? n - size + 1 : n;
	return Math.max(0, Math.min(first, whole - size));
}

/**
 * `bytes` as `printf` writes them back: every byte an octal escape, so the
 * command passes one line of a terminal whatever it holds.
 */
export function printfEscaped(text: string): string {
	return Array.from(
		new TextEncoder().encode(text),
		(byte) => `\\${byte.toString(8).padStart(3, "0")}`,
	).join("");
}
