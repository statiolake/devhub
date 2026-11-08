/**
 * `command-prompt` and `confirm-before` for a control client (phase 3,
 * `docs/terminal-mode.md`). tmux keeps a prompt's state on the client and
 * draws it in the client's status line; a control client has no status
 * line, and tmux says nothing about the prompt's buffer to it. So the prompt
 * is edited here, by tmux's rules — `status_prompt_key` and
 * `status_prompt_translate_key` of tmux 3.7c, ported key for key, the
 * `status-keys` emacs and vi tables both — and drawn by the page as one line
 * at the terminal's foot.
 *
 * What the prompt *means* stays tmux's: once the person has answered, the
 * binding's own command is run with `-b` (so it does not hold the client's
 * queue) and the answer is typed into tmux's own prompt with `send-keys -K`
 * — `C-u`, the answer as literal keys, `Enter`, once per prompt; the key
 * itself for `-1`, `-k`, `-N` and `confirm-before`. tmux then fills the
 * template (`%%`, `%1`…, `-F`), adds the answer to its prompt history and
 * runs the command, as for a key typed into its status line. All of it is
 * one command line, so tmux's prompt is open for no key but those.
 * An incremental prompt (`-i`) is tmux's from the start: each key is typed
 * into tmux's prompt as it is typed here.
 *
 * Pure: `controlClient.ts` reads what a prompt needs (the expanded prompt
 * and input, the history, `status-keys`, `word-separators`) and sends.
 */

import { parseCommands, readFlags } from "./tmuxCommand.js";

/** tmux's prompt types (`-T`): each has its own history. */
export type PromptType = "command" | "search" | "target" | "window-target";

/** A binding that is one `command-prompt` or `confirm-before`, read. */
export interface PromptArgs {
	readonly command: "command-prompt" | "confirm-before";
	/**
	 * The binding as written, with `-b` after its name: what is run once the
	 * person has answered.
	 */
	readonly replay: string;
	/** Each prompt and its initial input, as tmux has them before expansion. */
	readonly prompts: readonly {
		readonly prompt: string;
		readonly input: string;
	}[];
	readonly type: PromptType;
	/** `-1`, `-N`, `-k`, `-i`, `-e`: one of them at most, as tmux takes them. */
	readonly mode: "line" | "single" | "numeric" | "key" | "incremental";
	readonly backspaceExits: boolean;
	/**
	 * No template: what is typed is the command (prefix `:`), so it is looked
	 * at before tmux runs it (`keyGuard.ts`).
	 */
	readonly bare: boolean;
}

const PROMPT_NAMES = new Set(["command-prompt"]);
const CONFIRM_NAMES = new Set(["confirm-before", "confirm"]);
const TYPES = new Set<PromptType>([
	"command",
	"search",
	"target",
	"window-target",
]);

/** The binding's text with `-b` after the command's name. */
function withBackground(binding: string): string {
	const text = binding.trim();
	const name = /^\S+/.exec(text)?.[0] ?? "";
	return `${name} -b${text.slice(name.length)}`;
}

/**
 * A binding that is one `command-prompt` or `confirm-before` and nothing
 * else, read; anything else (another command beside it, `-t` naming another
 * client, a flag tmux does not know) is not.
 */
export function promptOf(binding: string): PromptArgs | undefined {
	const commands = parseCommands(binding);
	if (commands.length !== 1) return undefined;
	const [name, ...words] = commands[0];
	if (PROMPT_NAMES.has(name)) {
		const read = readFlags(words, "IptT", "1CbeFiklN");
		if (read === undefined || read.flags.has("t") || read.rest.length > 1)
			return undefined;
		const { flags, count, rest } = read;
		const type = (flags.get("T") ?? "command") as PromptType;
		if (!TYPES.has(type)) return undefined;
		const template = rest[0];
		// tmux: no -p is "(template) ", or ":" with no template.
		const given = flags.get("p");
		const literal = count.has("l");
		const promptTexts =
			given !== undefined
				? literal
					? [given]
					: given.split(",")
				: [template !== undefined ? `(${template})` : ":"];
		const space = given !== undefined || template !== undefined;
		const inputText = flags.get("I");
		const inputs =
			inputText === undefined
				? []
				: literal
					? [inputText]
					: inputText.split(",");
		const has = (flag: string) => count.has(flag);
		return {
			command: "command-prompt",
			replay: withBackground(binding),
			prompts: promptTexts.map((prompt, i) => ({
				prompt: space ? `${prompt} ` : prompt,
				input: inputs[i] ?? "",
			})),
			type,
			// The order tmux tests them in.
			mode: has("1")
				? "single"
				: has("N")
					? "numeric"
					: has("i")
						? "incremental"
						: has("k")
							? "key"
							: "line",
			backspaceExits:
				has("e") && !has("1") && !has("N") && !has("i") && !has("k"),
			bare: template === undefined,
		};
	}
	if (CONFIRM_NAMES.has(name)) {
		const read = readFlags(words, "cpt", "by");
		if (read === undefined || read.flags.has("t") || read.rest.length !== 1)
			return undefined;
		const confirmKey = read.flags.get("c") ?? "y";
		if (!/^[\x20-\x7e]$/.test(confirmKey)) return undefined;
		const given = read.flags.get("p");
		const first = parseCommands(read.rest[0])[0]?.[0] ?? read.rest[0];
		return {
			command: "confirm-before",
			replay: withBackground(binding),
			prompts: [
				{
					prompt:
						given !== undefined
							? `${given} `
							: `Confirm '${first}'? (${confirmKey}/n) `,
					input: "",
				},
			],
			type: "command",
			mode: "single",
			backspaceExits: false,
			bare: false,
		};
	}
	return undefined;
}

/**
 * Text up to its first control character: what tmux takes into a prompt
 * from a paste (`status_prompt_paste`).
 */
export function untilControl(text: string): string {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) return text.slice(0, i);
	}
	return text;
}

/** What a prompt is drawn from: the page's `prompt` message. */
export interface PromptView {
	readonly prompt: string;
	readonly input: string;
	/** The cursor, in characters of `input`. */
	readonly cursor: number;
	/** `status-keys vi`, and in command (normal) mode. */
	readonly vi: boolean;
	readonly command: boolean;
	readonly confirm: boolean;
}

/** What a key did to the prompt. */
export type PromptStep =
	| { readonly kind: "changed" }
	| { readonly kind: "unchanged" }
	| { readonly kind: "cancel" }
	/** Answered: send-keys argument lists to type into tmux's prompt, in order. */
	| { readonly kind: "done"; readonly keys: readonly (readonly string[])[] };

export interface PromptEnvironment {
	/** `status-keys vi`. */
	readonly vi: boolean;
	readonly separators: string;
	/** This type's history, oldest first, as `show-prompt-history` lists it. */
	readonly history: readonly string[];
	/** The top paste buffer, for `C-y`. */
	readonly paste: string | undefined;
	/** Words Tab completes to: commands and aliases, then options and layouts. */
	readonly commands: readonly string[];
	readonly options: readonly string[];
}

const LAYOUTS = [
	"even-horizontal",
	"even-vertical",
	"main-horizontal",
	"main-horizontal-mirrored",
	"main-vertical",
	"main-vertical-mirrored",
	"tiled",
];

/** A key as tmux names it, taken apart. */
interface Key {
	readonly name: string;
	readonly ctrl: boolean;
	readonly meta: boolean;
	/** The key without modifiers: one character, or a name (`Left`). */
	readonly base: string;
}

function keyOf(name: string): Key {
	let rest = name;
	let ctrl = false;
	let meta = false;
	for (;;) {
		if (rest.length > 2 && rest.startsWith("C-")) ctrl = true;
		else if (rest.length > 2 && rest.startsWith("M-")) meta = true;
		else break;
		rest = rest.slice(2);
	}
	if (rest === "Space") rest = " ";
	// C-[ is Escape to tmux's prompt, in both tables.
	if (ctrl && !meta && rest === "[")
		return { name, ctrl: false, meta: false, base: "Escape" };
	return { name, ctrl, meta, base: rest };
}

/** A key that is a character (with no modifier), and which. */
function charOf(key: Key): string | undefined {
	if (key.ctrl || key.meta) return undefined;
	return [...key.base].length === 1 ? key.base : undefined;
}

/**
 * A key tmux's single-key prompt takes (`-1`, `confirm-before`): a character,
 * a control or Meta character, Enter, Escape, Tab, BSpace. Others (arrows,
 * function keys) are ignored by it and leave it open.
 */
function singleKeyTaken(key: Key): boolean {
	return (
		[...key.base].length === 1 ||
		["Enter", "Escape", "Tab", "BSpace"].includes(key.base)
	);
}

/** The unmodified keys vi insert mode does as emacs would. */
const ENTRY_KEYS = new Set([
	"Tab",
	"Enter",
	"BSpace",
	"DC",
	"Down",
	"End",
	"Home",
	"Left",
	"Right",
	"Up",
]);

const isSpace = (c: string | undefined) => c === " ";

/** One prompt being answered, and the answers so far. */
export class PromptSession {
	readonly args: PromptArgs;
	readonly #env: PromptEnvironment;
	/** The expanded prompt and input of each step. */
	readonly #expanded: readonly {
		readonly prompt: string;
		readonly input: string;
	}[];
	#step = 0;
	#buffer: string[] = [];
	#index = 0;
	#commandMode = false;
	#quoteNext = false;
	#saved: string[] | undefined;
	#historyIndex = 0;
	/** Digits a numeric prompt took past its initial input. */
	#appended = "";
	readonly #keys: (readonly string[])[] = [];

	constructor(
		args: PromptArgs,
		expanded: readonly { readonly prompt: string; readonly input: string }[],
		env: PromptEnvironment,
	) {
		this.args = args;
		this.#env = env;
		this.#expanded = expanded;
		this.#begin();
	}

	#begin(): void {
		const input =
			this.args.mode === "incremental"
				? ""
				: (this.#expanded[this.#step]?.input ?? "");
		this.#buffer = [...input];
		this.#index = this.#buffer.length;
		this.#commandMode = false;
		this.#quoteNext = false;
		this.#historyIndex = 0;
		this.#appended = "";
	}

	view(): PromptView {
		const control = (c: string) =>
			c.length === 1 && (c.charCodeAt(0) < 0x20 || c === "\x7f");
		// tmux draws a control character as ^X, two cells.
		const shown = this.#buffer.map((c) =>
			control(c)
				? `^${String.fromCharCode((c.charCodeAt(0) + 0x40) & 0x7f)}`
				: c,
		);
		const cursor = shown
			.slice(0, this.#index)
			.reduce((n, c) => n + [...c].length, 0);
		return {
			prompt: this.#expanded[this.#step]?.prompt ?? "",
			input: shown.join("") + (this.#quoteNext ? "^" : ""),
			cursor,
			vi: this.#env.vi,
			command: this.#commandMode,
			confirm: this.args.command === "confirm-before",
		};
	}

	/** The answer to the step, typed into tmux's prompt when all are in. */
	#answered(keys: readonly (readonly string[])[]): PromptStep {
		this.#keys.push(...keys);
		this.#step++;
		if (this.#step < this.args.prompts.length) {
			this.#begin();
			return { kind: "changed" };
		}
		return { kind: "done", keys: this.#keys };
	}

	/** Text the page sent as text (an IME's, a paste): up to a control character. */
	text(text: string): PromptStep {
		if (this.args.mode !== "line" && this.args.mode !== "incremental")
			return { kind: "unchanged" };
		const chars = [...untilControl(text)];
		if (chars.length === 0) return { kind: "unchanged" };
		this.#buffer.splice(this.#index, 0, ...chars);
		this.#index += chars.length;
		return { kind: "changed" };
	}

	key(name: string): PromptStep {
		const key = keyOf(name);
		const mode = this.args.mode;
		if (mode === "key") return this.#answered([[name]]);
		if (mode === "numeric") {
			const c = charOf(key);
			if (c !== undefined && c >= "0" && c <= "9") {
				this.#appended += c;
				this.#insert(c);
				return { kind: "changed" };
			}
			const typed = this.#appended;
			return this.#answered([...(typed === "" ? [] : [["-l", typed]]), [name]]);
		}
		if (mode === "single") {
			if (!singleKeyTaken(key)) return { kind: "unchanged" };
			return this.#answered([[name]]);
		}
		if (this.#quoteNext) {
			this.#quoteNext = false;
			const c = this.#quoted(key);
			if (c === undefined) return { kind: "changed" };
			this.#insert(c);
			return { kind: "changed" };
		}
		let action = key;
		if (this.#env.vi) {
			const translated = this.#translate(key);
			if (translated === "drop") return { kind: "changed" };
			if (translated === "append") return this.#append(key);
			action = translated;
		}
		return this.#process(action);
	}

	/** C-v: the next key as the character it is, control characters too. */
	#quoted(key: Key): string | undefined {
		if (key.base === "BSpace") return "\x7f";
		if (key.base === "Enter") return "\r";
		if (key.base === "Escape") return "\x1b";
		if (key.base === "Tab") return "\t";
		if ([...key.base].length !== 1) return undefined;
		if (key.ctrl)
			return String.fromCharCode(key.base.toUpperCase().charCodeAt(0) & 0x1f);
		return key.base;
	}

	#insert(c: string): void {
		this.#buffer.splice(this.#index, 0, c);
		this.#index++;
	}

	/** tmux's `append_key`: a character is typed; any other key does nothing. */
	#append(key: Key): PromptStep {
		const c = charOf(key);
		if (c === undefined) return { kind: "unchanged" };
		this.#insert(c);
		return this.#changed();
	}

	#changed(): PromptStep {
		return { kind: "changed" };
	}

	/**
	 * tmux's `status_prompt_translate_key`: a vi key as the emacs key it
	 * does, `append` to type it, `drop` to do nothing more.
	 */
	#translate(key: Key): Key | "append" | "drop" {
		const k = (base: string, ctrl = false, meta = false): Key => ({
			name: base,
			base,
			ctrl,
			meta,
		});
		const vi = (base: string): Key => ({
			name: `vi:${base}`,
			base: `vi:${base}`,
			ctrl: false,
			meta: false,
		});
		const c = charOf(key);
		if (!this.#commandMode) {
			if (key.base === "Escape") {
				this.#commandMode = true;
				if (this.#index !== 0) this.#index--;
				return "drop";
			}
			// The keys insert mode does as emacs would; any other is typed.
			if (key.meta) return "append";
			if (key.ctrl)
				return "aceghknptuvwy".includes(key.base) ||
					key.base === "Left" ||
					key.base === "Right"
					? key
					: "append";
			return ENTRY_KEYS.has(key.base) ? key : "append";
		}
		switch (key.base) {
			case "BSpace":
				return k("Left");
			case "Escape":
				return "drop";
		}
		switch (c) {
			case "A":
			case "I":
			case "C":
			case "s":
			case "a":
				this.#commandMode = false;
				break;
			case "S":
				this.#commandMode = false;
				return k("u", true);
			case "i":
				this.#commandMode = false;
				return "drop";
		}
		if (key.ctrl && key.base === "h") return k("BSpace");
		if (key.ctrl && key.base === "c") return k("c", true);
		if (key.base === "Enter") return key;
		switch (key.base) {
			case "DC":
				return k("DC");
			case "Down":
				return k("Down");
			case "Left":
				return k("Left");
			case "Right":
				return k("Right");
			case "Up":
				return k("Up");
		}
		switch (c) {
			case "A":
			case "$":
				return k("End");
			case "I":
			case "0":
			case "^":
				return k("Home");
			case "C":
			case "D":
				return k("k", true);
			case "X":
				return k("BSpace");
			case "b":
				return k("b", false, true);
			case "B":
				return vi("B");
			case "d":
				return k("u", true);
			case "e":
				return vi("e");
			case "E":
				return vi("E");
			case "w":
				return vi("w");
			case "W":
				return vi("W");
			case "p":
				return k("y", true);
			case "q":
				return k("c", true);
			case "s":
			case "x":
				return k("DC");
			case "j":
				return k("Down");
			case "h":
				return k("Left");
			case "a":
			case "l":
				return k("Right");
			case "k":
				return k("Up");
		}
		return "drop";
	}

	/** tmux's `status_prompt_key` past the translation, for an emacs key. */
	#process(key: Key): PromptStep {
		const size = this.#buffer.length;
		const ctrl = (c: string) => key.ctrl && !key.meta && key.base === c;
		const meta = (c: string) => key.meta && !key.ctrl && key.base === c;
		const plain = (name: string) => !key.ctrl && !key.meta && key.base === name;
		const separators = this.#env.separators;
		if (plain("Left") || ctrl("b")) {
			if (this.#index > 0) this.#index--;
			return this.#changed();
		}
		if (plain("Right") || ctrl("f")) {
			if (this.#index < size) this.#index++;
			return this.#changed();
		}
		if (plain("Home") || ctrl("a")) {
			this.#index = 0;
			return this.#changed();
		}
		if (plain("End") || ctrl("e")) {
			this.#index = size;
			return this.#changed();
		}
		if (plain("Tab")) {
			this.#complete();
			return this.#changed();
		}
		if (plain("BSpace") || ctrl("h")) {
			if (this.args.backspaceExits && size === 0) return { kind: "cancel" };
			if (this.#index !== 0) {
				this.#buffer.splice(this.#index - 1, 1);
				this.#index--;
			}
			return this.#changed();
		}
		if (plain("DC") || ctrl("d")) {
			if (this.#index !== size) this.#buffer.splice(this.#index, 1);
			return this.#changed();
		}
		if (ctrl("u")) {
			this.#buffer = [];
			this.#index = 0;
			return this.#changed();
		}
		if (ctrl("k")) {
			this.#buffer.length = this.#index;
			return this.#changed();
		}
		if (ctrl("w")) {
			let idx = this.#index;
			while (idx !== 0) {
				idx--;
				if (!isSpace(this.#buffer[idx])) break;
			}
			const sep = this.#inList(separators, idx);
			while (idx !== 0) {
				idx--;
				if (
					isSpace(this.#buffer[idx]) ||
					sep !== this.#inList(separators, idx)
				) {
					idx++;
					break;
				}
			}
			this.#saved = this.#buffer.slice(idx, this.#index);
			this.#buffer.splice(idx, this.#index - idx);
			this.#index = idx;
			return this.#changed();
		}
		if ((key.ctrl && !key.meta && key.base === "Right") || meta("f")) {
			this.#forwardWord(false, separators);
			return this.#changed();
		}
		if (key.base === "vi:E") {
			this.#endWord("");
			return this.#changed();
		}
		if (key.base === "vi:e") {
			this.#endWord(separators);
			return this.#changed();
		}
		if (key.base === "vi:W") {
			this.#forwardWord(true, "");
			return this.#changed();
		}
		if (key.base === "vi:w") {
			this.#forwardWord(true, separators);
			return this.#changed();
		}
		if (key.base === "vi:B") {
			this.#backwardWord("");
			return this.#changed();
		}
		if ((key.ctrl && !key.meta && key.base === "Left") || meta("b")) {
			this.#backwardWord(separators);
			return this.#changed();
		}
		if (plain("Up") || ctrl("p")) {
			const history = this.#env.history;
			if (history.length === 0 || this.#historyIndex === history.length)
				return this.#changed();
			this.#historyIndex++;
			this.#setBuffer(history[history.length - this.#historyIndex]);
			return this.#changed();
		}
		if (plain("Down") || ctrl("n")) {
			const history = this.#env.history;
			if (history.length === 0 || this.#historyIndex === 0) {
				this.#setBuffer("");
				return this.#changed();
			}
			this.#historyIndex--;
			this.#setBuffer(
				this.#historyIndex === 0
					? ""
					: history[history.length - this.#historyIndex],
			);
			return this.#changed();
		}
		if (ctrl("y")) {
			const paste = this.#saved ?? [...untilControl(this.#env.paste ?? "")];
			this.#buffer.splice(this.#index, 0, ...paste);
			this.#index += paste.length;
			return this.#changed();
		}
		if (ctrl("t")) {
			let idx = this.#index;
			if (idx < size) idx++;
			if (idx >= 2) {
				const b = this.#buffer;
				[b[idx - 2], b[idx - 1]] = [b[idx - 1], b[idx - 2]];
				this.#index = idx;
			}
			return this.#changed();
		}
		if (plain("Enter")) {
			const answer = this.#buffer.join("");
			if (this.args.mode === "incremental")
				return { kind: "done", keys: [["Enter"]] };
			return this.#answered([
				["C-u"],
				...(answer === "" ? [] : [["-l", answer]]),
				["Enter"],
			]);
		}
		if (plain("Escape") || ctrl("c") || ctrl("g")) {
			return { kind: "cancel" };
		}
		if (ctrl("v")) {
			this.#quoteNext = true;
			return this.#changed();
		}
		if (ctrl("r") || ctrl("s")) {
			if (this.args.mode !== "incremental") return this.#changed();
			if (this.#buffer.length === 0)
				this.#setBuffer(this.#expanded[this.#step]?.input ?? "");
			return this.#changed();
		}
		const c = charOf(key);
		if (c !== undefined) {
			this.#insert(c);
			return this.#changed();
		}
		return { kind: "unchanged" };
	}

	#setBuffer(text: string): void {
		this.#buffer = [...text];
		this.#index = this.#buffer.length;
	}

	#inList(separators: string, idx: number): boolean {
		const c = this.#buffer[idx];
		return c !== undefined && c.length === 1 && separators.includes(c);
	}

	#forwardWord(vi: boolean, separators: string): void {
		const size = this.#buffer.length;
		let idx = this.#index;
		if (!vi) while (idx !== size && isSpace(this.#buffer[idx])) idx++;
		if (idx === size) {
			this.#index = idx;
			return;
		}
		const sep = this.#inList(separators, idx) && !isSpace(this.#buffer[idx]);
		do {
			idx++;
			if (isSpace(this.#buffer[idx])) {
				if (vi) while (idx !== size && isSpace(this.#buffer[idx])) idx++;
				break;
			}
		} while (idx !== size && sep === this.#inList(separators, idx));
		this.#index = idx;
	}

	#endWord(separators: string): void {
		const size = this.#buffer.length;
		let idx = this.#index;
		if (idx === size) return;
		do {
			idx++;
			if (idx === size) {
				this.#index = idx;
				return;
			}
		} while (isSpace(this.#buffer[idx]));
		const sep = this.#inList(separators, idx);
		do {
			idx++;
			if (idx === size) break;
		} while (
			!isSpace(this.#buffer[idx]) &&
			sep === this.#inList(separators, idx)
		);
		this.#index = idx - 1;
	}

	#backwardWord(separators: string): void {
		let idx = this.#index;
		while (idx !== 0) {
			--idx;
			if (!isSpace(this.#buffer[idx])) break;
		}
		const sep = this.#inList(separators, idx);
		while (idx !== 0) {
			--idx;
			if (isSpace(this.#buffer[idx]) || sep !== this.#inList(separators, idx)) {
				idx++;
				break;
			}
		}
		this.#index = idx;
	}

	/**
	 * Tab, as tmux's `status_prompt_complete` does for words: commands and
	 * aliases, and past the first word options and layouts too; one match is
	 * put in with a space, several by their common prefix. tmux's menus of
	 * sessions and windows for `-t` and the target types are not drawn.
	 */
	#complete(): void {
		if (this.args.type !== "command" && this.args.type !== "search") return;
		const b = this.#buffer;
		const idx = this.#index === 0 ? 0 : this.#index - 1;
		let first = idx;
		while (first > 0 && !isSpace(b[first])) first--;
		while (first < b.length && isSpace(b[first])) first++;
		let last = idx;
		while (last < b.length && !isSpace(b[last])) last++;
		while (last > 0 && isSpace(b[last])) last--;
		if (last < b.length) last++;
		if (last < first) return;
		const word = b.slice(first, last).join("");
		if (word === "" || word.startsWith("-t") || word.startsWith("-s")) return;
		const pool = [
			...this.#env.commands,
			...(first === 0 ? [] : [...this.#env.options, ...LAYOUTS]),
		];
		const list = [...new Set(pool.filter((w) => w.startsWith(word)))].sort();
		if (list.length === 0) return;
		let out: string;
		if (list.length === 1) out = `${list[0]} `;
		else {
			out = list[0];
			for (const w of list.slice(1)) {
				let j = 0;
				while (j < out.length && j < w.length && out[j] === w[j]) j++;
				out = out.slice(0, j);
			}
		}
		if (out === word) return;
		b.splice(first, last - first, ...out);
		this.#index = first + [...out].length;
	}
}
