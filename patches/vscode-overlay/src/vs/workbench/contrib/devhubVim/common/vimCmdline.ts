/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub native Vim: the `:` `/` `?` prompt, without the DOM.
//
// The prompt is a real one-line editor at the bottom of the window
// (../browser/vimCmdline.ts): typing, the caret, selection, IME and undo are
// that editor's own. What makes it Vim's command line are commands
// (`devhubVim.cmdline.*`), each an ordinary keybinding on
// `devhubVim.cmdlineFocus` (CMDLINE_KEYBINDINGS): Enter submits, Esc / CTRL-C
// / CTRL-[ cancel (also while the completion menu shows), <BS> on an empty line cancels, <Up> / <Down> walk the
// history (only the entries starting with the text before the caret, as in
// Vim), CTRL-P / CTRL-N walk all of it, CTRL-R {register} inserts a register,
// CTRL-W / CTRL-U delete the word / everything before the caret, Tab completes.
// In a `:` line the completion menu also shows by itself as you type
// (`devhub.vim.cmdline.autoComplete`), with nothing selected: Enter runs the
// line exactly as typed unless a match was picked (Tab, Down, CTRL-N), and
// then takes that match first.
// VimCmdlineController implements them on an IVimCmdlineLine: the browser
// editor, or a string (VimStringLine) for keys the engine feeds itself
// (`:normal /foo<CR>`, a register run with `@a`) and for the tests. Fed keys
// are resolved against CMDLINE_KEYBINDINGS as the keybinding service resolves
// real ones, so both paths run the same commands.
//
// The engine (vimEngine.ts) keeps only what Vim's grammar needs: that a prompt
// is open (so `d/foo<CR>` keeps its operator, count and register), its kind
// and the text it started with (`'<,'>` from visual mode, `.,.+2` after a
// count), and what to run when it is submitted. Imports nothing but the
// keymap's helpers and the ex command names.

import { canonicalExName, exRangeLength } from './vimEx.js';
import type { VimKeybinding } from './vimKeymap.js';
import { evaluateWhen, jisKeys, keybindingForVimKey } from './vimKeymap.js';

export type VimCmdlineKind = ':' | '/' | '?';

export function isVimCmdlineKind(v: unknown): v is VimCmdlineKind {
	return v === ':' || v === '/' || v === '?';
}

// ---- commands and keys ----------------------------------------------------------

/** The prompt's commands; the workbench registers each one. */
export const VIM_CMDLINE_COMMANDS = [
	'devhubVim.cmdline.submit',
	'devhubVim.cmdline.cancel',
	'devhubVim.cmdline.historyPrev',
	'devhubVim.cmdline.historyNext',
	'devhubVim.cmdline.insertRegister',
	'devhubVim.cmdline.deleteWord',
	'devhubVim.cmdline.deleteToStart',
	'devhubVim.cmdline.complete',
] as const;

export type VimCmdlineCommand = typeof VIM_CMDLINE_COMMANDS[number];

/** The context keys the prompt sets inside its own element (so they hold exactly while it has the focus). */
export const VIM_CMDLINE_CONTEXT = {
	focus: 'devhubVim.cmdlineFocus',
	kind: 'devhubVim.cmdlineKind',
	empty: 'devhubVim.cmdlineEmpty',
	awaitingRegister: 'devhubVim.cmdlineAwaitingRegister',
} as const;

const C = VIM_CMDLINE_CONTEXT;
const FOCUS = C.focus;
const NO_MENU = `${FOCUS} && !suggestWidgetVisible`;
const MENU = `${FOCUS} && suggestWidgetVisible`;
/** The menu shows and a match in it was picked (Tab, Down, CTRL-N); a menu that showed by itself has none. */
const PICKED = `${MENU} && suggestWidgetHasFocusedSuggestion`;
const NOT_PICKED = `${MENU} && !suggestWidgetHasFocusedSuggestion`;
const EX = `${FOCUS} && ${C.kind} == ':'`;

/** The when clauses the prompt's defaults use. */
export const VIM_CMDLINE_WHEN = { focus: FOCUS, noMenu: NO_MENU, menu: MENU, picked: PICKED, notPicked: NOT_PICKED, ex: EX } as const;

function key(k: string, command: string, when: string, args?: Record<string, unknown>): VimKeybinding {
	return { key: k, command, when, weight: 'cmdline', ...(args ? { args } : {}) };
}

/**
 * The prompt's default keys (US notation, put on the Apple JIS keys like the
 * Vim keymap). Where VS Code's suggest widget has a key of its own while it
 * shows (<Down>, and <Up> once a match is picked), the prompt's key gives
 * way to it; Tab, Enter and Esc do not: Tab steps through the matches (Vim's
 * 'wildmenu'), Enter runs the line as typed, taking the picked match first
 * when there is one (a menu that showed by itself as you typed has none, so
 * `:w` Enter is `:w` whatever it lists), and Esc / CTRL-C / CTRL-[ abandon the line
 * with the menu (as Esc abandons Vim's command line with its wildmenu; the
 * prompt's weight is above the suggest widget's Esc, EditorContrib + 90, and
 * every other Esc an editor binds). `ctrl+...` is Control on macOS too.
 */
const KEYS_BY_CHARACTER: readonly VimKeybinding[] = [
	key('enter', 'devhubVim.cmdline.submit', NO_MENU),
	key('enter', 'devhubVim.cmdline.submit', NOT_PICKED),
	key('enter', 'devhubVim.cmdline.submit', PICKED, { accept: true }),
	key('ctrl+m', 'devhubVim.cmdline.submit', FOCUS, { accept: true }),
	key('ctrl+j', 'devhubVim.cmdline.submit', FOCUS, { accept: true }),
	key('escape', 'devhubVim.cmdline.cancel', FOCUS),
	key('ctrl+c', 'devhubVim.cmdline.cancel', FOCUS),
	key('ctrl+[', 'devhubVim.cmdline.cancel', FOCUS),
	// Vim: <BS> / CTRL-H on an empty command line abandons it
	key('backspace', 'devhubVim.cmdline.cancel', `${FOCUS} && ${C.empty}`),
	key('ctrl+h', 'devhubVim.cmdline.cancel', `${FOCUS} && ${C.empty}`),
	key('ctrl+h', 'deleteLeft', `${FOCUS} && !${C.empty}`),
	// history: <Up> <Down> only the entries that start like the line, <S-Up> <PageUp> CTRL-P (no menu) all
	key('up', 'devhubVim.cmdline.historyPrev', NO_MENU),
	// the menu that shows as you type does not take <Up> from the history until a match in it is picked
	key('up', 'devhubVim.cmdline.historyPrev', NOT_PICKED),
	key('down', 'devhubVim.cmdline.historyNext', NO_MENU),
	key('shift+up', 'devhubVim.cmdline.historyPrev', NO_MENU, { filter: false }),
	key('shift+down', 'devhubVim.cmdline.historyNext', NO_MENU, { filter: false }),
	key('pageup', 'devhubVim.cmdline.historyPrev', NO_MENU, { filter: false }),
	key('pagedown', 'devhubVim.cmdline.historyNext', NO_MENU, { filter: false }),
	key('ctrl+p', 'devhubVim.cmdline.historyPrev', NO_MENU, { filter: false }),
	key('ctrl+n', 'devhubVim.cmdline.historyNext', NO_MENU, { filter: false }),
	// the completion menu: CTRL-N / CTRL-P step, CTRL-Y takes the match (Vim's popup menu keys)
	key('ctrl+n', 'selectNextSuggestion', MENU),
	key('ctrl+p', 'selectPrevSuggestion', MENU),
	key('ctrl+y', 'acceptSelectedSuggestion', MENU),
	key('tab', 'devhubVim.cmdline.complete', EX),
	key('shift+tab', 'devhubVim.cmdline.complete', EX, { direction: 'previous' }),
	key('ctrl+r', 'devhubVim.cmdline.insertRegister', `${FOCUS} && !${C.awaitingRegister}`),
	key('ctrl+w', 'devhubVim.cmdline.deleteWord', FOCUS),
	key('ctrl+u', 'devhubVim.cmdline.deleteToStart', FOCUS),
	// c_CTRL-B / c_CTRL-E: the caret to the start / end of the line
	key('ctrl+b', 'cursorHome', FOCUS),
	key('ctrl+e', 'cursorEnd', FOCUS),
];

/** The prompt's default keybindings, as registered (on the Apple JIS keys). */
export const CMDLINE_KEYBINDINGS: readonly VimKeybinding[] = KEYS_BY_CHARACTER.flatMap(b => jisKeys(b.key).map(k => k === b.key ? b : { ...b, key: k }));

// ---- what the prompt edits and what it talks to -------------------------------------

/** The line: the browser's one-line editor, or a string. Offsets are UTF-16. */
export interface IVimCmdlineLine {
	readonly text: string;
	/** The caret (the selection's active end). */
	readonly caret: number;
	/** Replace [start, end) with `text` as one undoable edit; the caret goes after it. */
	edit(start: number, end: number, text: string): void;
	setCaret(offset: number): void;
}

/** A line in a string: fed keys (`:normal`, `@a`) and the tests. */
export class VimStringLine implements IVimCmdlineLine {
	constructor(public text: string, public caret: number = text.length) { }
	edit(start: number, end: number, text: string): void {
		this.text = this.text.slice(0, start) + text + this.text.slice(end);
		this.caret = start + text.length;
	}
	setCaret(offset: number): void {
		this.caret = Math.max(0, Math.min(this.text.length, offset));
	}
}

/** The engine of the editor the prompt was opened from (VimEngine.cmdlineTarget). */
export interface IVimCmdlineTarget {
	/** `:` lines, or search patterns (`/` and `?` share one history), oldest first. */
	history(kind: VimCmdlineKind): readonly string[];
	/** The text changed ('incsearch'). */
	changed(text: string): void;
	/** Run the line (`devhubVim.ex` / `devhubVim.search`), with the grammar that waited for it. */
	submit(text: string): void;
	/** Abandon the line, as Esc does. */
	cancel(): void;
	/** A register's text (`"a`, `"%`, `"+`, ...), or undefined. */
	registerText(name: string): string | undefined;
	/** CTRL-R is waiting for a name: fetch the clipboard for `"+` / `"*`. */
	prepareRegisters(): void;
}

/** What the browser prompt does itself; without one (fed keys, tests) the controller does the plain version. */
export interface IVimCmdlineUi {
	/** Tab: show / step through the completion menu. False: none here, the controller cycles the matches in the line. */
	complete(direction: 'next' | 'previous'): boolean;
	/** Take the match the completion menu has selected, if it shows and one is (none is until the user picks one). */
	acceptCompletion(): void;
	/** Hide the completion menu (the history replaced the line). */
	closeCompletion?(): void;
	/** CTRL-R waits for its register (the line shows `"` at the caret). */
	awaitingRegister(waiting: boolean): void;
}

// ---- completion ------------------------------------------------------------------

export type VimCmdlineCompletionKind = 'command' | 'file' | 'option' | 'buffer';

/** What Tab completes at the caret: the kind, where the word starts and what of it is typed. */
export interface VimCmdlineCompletionContext {
	readonly kind: VimCmdlineCompletionKind;
	/** Offset of the word being completed; it ends at the caret. */
	readonly start: number;
	readonly typed: string;
	/** The canonical ex command whose argument it is. */
	readonly command?: string;
}

export interface VimCmdlineCompletionItem {
	readonly label: string;
	readonly detail?: string;
	readonly kind: VimCmdlineCompletionKind | 'folder';
}

export interface VimExCommandInfo {
	readonly name: string;
	readonly detail: string;
	readonly user: boolean;
}

export interface VimOptionInfo {
	readonly name: string;
	readonly alias?: string;
	readonly boolean: boolean;
	readonly detail: string;
}

export interface VimBufferInfo {
	readonly name: string;
	readonly detail: string;
}

/** Where the candidates come from: the engine's ex commands and options, the workbench's open editors. */
export interface IVimCmdlineCompletionSources {
	exCommands(): readonly VimExCommandInfo[];
	options(): readonly VimOptionInfo[];
	buffers(): readonly VimBufferInfo[];
}

/** Commands whose argument is a file name (`:e` `:sp` `:vs` `:new` `:vnew` `:tabnew` `:tabe` `:sav`). */
const FILE_COMMANDS: ReadonlySet<string> = new Set(['edit', 'split', 'vsplit', 'new', 'vnew', 'tabnew', 'tabedit', 'saveas']);

/** What Tab completes in a `:` line at `caret`, or undefined (`:s/x`, an argument of a command that takes none). */
export function cmdlineCompletionContext(text: string, caret: number): VimCmdlineCompletionContext | undefined {
	const before = text.slice(0, caret);
	const nameStart = exRangeLength(before);
	const rest = before.slice(nameStart);
	const m = /^[A-Za-z][A-Za-z0-9]*/.exec(rest);
	if (!m) {
		return rest === '' ? { kind: 'command', start: nameStart, typed: '' } : undefined;
	}
	const name = m[0];
	if (rest.length === name.length) {
		return { kind: 'command', start: nameStart, typed: name };
	}
	let after = rest.slice(name.length);
	if (after.startsWith('!')) {
		after = after.slice(1);
	}
	const blank = /^\s+/.exec(after);
	if (!blank) {
		return undefined;
	}
	const args = after.slice(blank[0].length);
	const argStart = caret - args.length;
	const command = canonicalExName(name);
	if (command !== undefined && FILE_COMMANDS.has(command)) {
		return { kind: 'file', start: argStart, typed: args, command };
	}
	if (command === 'buffer') {
		return { kind: 'buffer', start: argStart, typed: args, command };
	}
	if (command === 'set') {
		const word = /\S*$/.exec(args)![0];
		return word.includes('=') ? undefined : { kind: 'option', start: caret - word.length, typed: word, command };
	}
	return undefined;
}

/**
 * The candidates for a context that needs no file system: ex command names
 * (Vim's and `devhub.vim.exCommands`, by prefix, as Vim matches them),
 * `:set` option names (`no` / `inv` forms of the boolean ones once typed),
 * `:b` open editors (by substring, as Vim's `:b`). Files are the browser's
 * (vimCmdline.ts, async).
 */
export function cmdlineCompletions(ctx: VimCmdlineCompletionContext, sources: IVimCmdlineCompletionSources): VimCmdlineCompletionItem[] {
	const typed = ctx.typed;
	switch (ctx.kind) {
		case 'command': {
			const seen = new Set<string>();
			const out: VimCmdlineCompletionItem[] = [];
			for (const c of sources.exCommands()) {
				if (c.name.startsWith(typed) && !seen.has(c.name)) {
					seen.add(c.name);
					out.push({ label: c.name, detail: c.detail, kind: 'command' });
				}
			}
			return out.sort((a, b) => a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
		}
		case 'option': {
			const prefix = typed.startsWith('inv') ? 'inv' : typed.startsWith('no') ? 'no' : '';
			const out: VimCmdlineCompletionItem[] = [];
			for (const o of sources.options()) {
				const names = [o.name, ...(o.alias ? [o.alias] : [])];
				for (const n of names) {
					for (const label of prefix && o.boolean ? [n, prefix + n] : [n]) {
						if (label.startsWith(typed) && !out.some(i => i.label === label)) {
							out.push({ label, detail: o.detail, kind: 'option' });
						}
					}
				}
			}
			return out;
		}
		case 'buffer': {
			const t = typed.toLowerCase();
			return sources.buffers().filter(b => b.name.toLowerCase().includes(t)).map(b => ({ label: b.name, detail: b.detail, kind: 'buffer' }));
		}
		case 'file':
			return [];
	}
}

/** A file argument split where the directory ends: `src/fo` -> `src/` and `fo`. */
export function splitFileArg(typed: string): { dir: string; base: string } {
	const i = typed.lastIndexOf('/');
	return i < 0 ? { dir: '', base: typed } : { dir: typed.slice(0, i + 1), base: typed.slice(i + 1) };
}

// ---- editing helpers --------------------------------------------------------------

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const BLANK = /\s/u;

/** Where Vim's c_CTRL-W starts deleting: blanks before the caret, then a run of word characters or of other non-blanks. */
export function wordBeforeCaret(text: string, caret: number): number {
	const chars = Array.from(text.slice(0, caret));
	let i = chars.length;
	while (i > 0 && BLANK.test(chars[i - 1])) {
		i--;
	}
	if (i > 0) {
		const word = WORD_CHAR.test(chars[i - 1]);
		while (i > 0 && !BLANK.test(chars[i - 1]) && WORD_CHAR.test(chars[i - 1]) === word) {
			i--;
		}
	}
	return chars.slice(0, i).join('').length;
}

/** A register's text as one line: without its last line break, the others as blanks. */
export function registerAsLine(text: string): string {
	return text.replace(/\r?\n$/, '').replace(/\r?\n/g, ' ');
}

// ---- the controller ----------------------------------------------------------------

/** One open prompt: its commands, on a line, for the engine that opened it. */
export class VimCmdlineController {

	private history: { readonly prefix: string; readonly original: string; index: number; shown: string } | undefined;
	private cycle: { readonly start: number; end: number; readonly items: readonly string[]; index: number; shown: string } | undefined;
	private _awaitingRegister = false;
	private _done = false;

	constructor(
		readonly kind: VimCmdlineKind,
		readonly line: IVimCmdlineLine,
		private readonly target: IVimCmdlineTarget,
		private readonly sources?: IVimCmdlineCompletionSources,
		private readonly ui?: IVimCmdlineUi,
	) { }

	/** Submitted or cancelled: the prompt is over, and its commands do nothing. */
	get done(): boolean {
		return this._done;
	}

	get awaitingRegister(): boolean {
		return this._awaitingRegister;
	}

	/** The context keys as the prompt's `when` clauses read them (the browser sets the same in its element). */
	context(menu = false, picked = false): Record<string, unknown> {
		return {
			'true': true,
			[C.focus]: true,
			[C.kind]: this.kind,
			[C.empty]: this.line.text === '',
			[C.awaitingRegister]: this._awaitingRegister,
			'devhubVim.mode': 'cmdline',
			suggestWidgetVisible: menu,
			suggestWidgetHasFocusedSuggestion: menu && picked,
			editorTextFocus: true,
			textInputFocus: true,
		};
	}

	/**
	 * A command of the prompt's (VIM_CMDLINE_COMMANDS), or, for fed keys, one of
	 * the editor's that its keys run (deleteLeft, cursorHome, cursorEnd). False:
	 * not one of those.
	 */
	run(command: string, args?: unknown): boolean {
		if (this._done) {
			return true;
		}
		const a = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {};
		switch (command) {
			case 'devhubVim.cmdline.submit':
				if (a.accept === true) {
					this.ui?.acceptCompletion();
				}
				this.submit();
				return true;
			case 'devhubVim.cmdline.cancel':
				this.cancel();
				return true;
			case 'devhubVim.cmdline.historyPrev':
				this.browse(-1, a.filter !== false);
				return true;
			case 'devhubVim.cmdline.historyNext':
				this.browse(1, a.filter !== false);
				return true;
			case 'devhubVim.cmdline.insertRegister':
				this.insertRegister(typeof a.register === 'string' && a.register ? a.register : undefined);
				return true;
			case 'devhubVim.cmdline.deleteWord':
				this.deleteWord();
				return true;
			case 'devhubVim.cmdline.deleteToStart':
				this.deleteToStart();
				return true;
			case 'devhubVim.cmdline.complete':
				this.complete(a.direction === 'previous' ? 'previous' : 'next');
				return true;
			case 'deleteLeft':
				this.deleteLeft();
				return true;
			case 'cursorHome':
				this.line.setCaret(0);
				return true;
			case 'cursorEnd':
				this.line.setCaret(this.line.text.length);
				return true;
		}
		return false;
	}

	submit(): void {
		if (!this._done) {
			this._done = true;
			this.target.submit(this.line.text);
		}
	}

	cancel(): void {
		if (!this._done) {
			this._done = true;
			this.target.cancel();
		}
	}

	/** The line changed (typed, pasted, undone, or one of the commands here): 'incsearch', and history / Tab start over. */
	textChanged(): void {
		const text = this.line.text;
		if (this.history && this.history.shown !== text) {
			this.history = undefined;
		}
		if (this.cycle && this.cycle.shown !== text) {
			this.cycle = undefined;
		}
		if (!this._done) {
			this.target.changed(text);
		}
	}

	/**
	 * Vim's c_<Up> / c_<Down> (`filter`: only entries starting with the text
	 * before the caret when the walk began) and c_<S-Up> / c_CTRL-P (all).
	 * Past the newest entry the line is what it was before the walk.
	 */
	private browse(dir: -1 | 1, filter: boolean): void {
		const entries = this.target.history(this.kind);
		const text = this.line.text;
		if (!this.history || this.history.shown !== text) {
			this.history = { prefix: text.slice(0, this.line.caret), original: text, index: entries.length, shown: text };
		}
		const h = this.history;
		let i = h.index;
		for (; ;) {
			i += dir;
			if (i < 0) {
				return; // Vim beeps: nothing older
			}
			if (i >= entries.length) {
				if (h.index >= entries.length) {
					return;
				}
				i = entries.length;
				break;
			}
			if (!filter || entries[i].startsWith(h.prefix)) {
				break;
			}
		}
		h.index = i;
		const next = i === entries.length ? h.original : entries[i];
		h.shown = next;
		this.ui?.closeCompletion?.();
		this.replaceAll(next);
	}

	private insertRegister(name: string | undefined): void {
		if (name !== undefined) {
			this.insertText(registerAsLine(this.target.registerText(name) ?? ''));
			return;
		}
		this._awaitingRegister = true;
		this.target.prepareRegisters();
		this.ui?.awaitingRegister(true);
	}

	/** The key after CTRL-R: a character names the register; anything else (Esc) only ends the wait. */
	registerKey(key: string): void {
		this._awaitingRegister = false;
		this.ui?.awaitingRegister(false);
		if (Array.from(key).length === 1) {
			this.insertRegister(key);
		}
	}

	private deleteWord(): void {
		const caret = this.line.caret;
		const start = wordBeforeCaret(this.line.text, caret);
		if (start < caret) {
			this.line.edit(start, caret, '');
			this.textChanged();
		}
	}

	private deleteToStart(): void {
		const caret = this.line.caret;
		if (caret > 0) {
			this.line.edit(0, caret, '');
			this.textChanged();
		}
	}

	private deleteLeft(): void {
		const caret = this.line.caret;
		if (caret > 0) {
			const before = Array.from(this.line.text.slice(0, caret));
			const last = before[before.length - 1];
			this.line.edit(caret - last.length, caret, '');
			this.textChanged();
		}
	}

	insertText(text: string): void {
		if (!text) {
			return;
		}
		const caret = this.line.caret;
		this.line.edit(caret, caret, text);
		this.textChanged();
	}

	private replaceAll(text: string): void {
		this.line.edit(0, this.line.text.length, text);
		this.textChanged();
	}

	/** Tab / <S-Tab>: the completion menu; without one, the matches one after another in the line (Vim's 'nowildmenu'). */
	private complete(direction: 'next' | 'previous'): void {
		if (this.kind !== ':' || this.ui?.complete(direction)) {
			return;
		}
		if (!this.cycle || this.cycle.shown !== this.line.text) {
			const ctx = cmdlineCompletionContext(this.line.text, this.line.caret);
			const items = ctx && this.sources ? cmdlineCompletions(ctx, this.sources).map(i => i.label) : [];
			if (!ctx || !items.length) {
				return;
			}
			this.cycle = { start: ctx.start, end: this.line.caret, items, index: -1, shown: '' };
		}
		const c = this.cycle;
		const n = c.items.length;
		c.index = c.index < 0 ? (direction === 'next' ? 0 : n - 1) : (c.index + (direction === 'next' ? 1 : -1) + n) % n;
		const item = c.items[c.index];
		this.line.edit(c.start, c.end, item);
		c.end = c.start + item.length;
		c.shown = this.line.text;
		this.textChanged();
	}

	/**
	 * A key in Vim notation, for keys the engine feeds (`:normal`, `@a`) and
	 * the tests: resolved against CMDLINE_KEYBINDINGS as the keybinding service
	 * resolves a real key while the prompt has the focus; a key no binding
	 * takes is what the editor does with it (a character or <Tab> is typed,
	 * <BS> deletes, <Left> / <Right> / <Home> / <End> move).
	 */
	feedKey(k: string): void {
		if (this._done) {
			return;
		}
		if (this._awaitingRegister) {
			this.registerKey(k);
			return;
		}
		const kb = keybindingForVimKey(k);
		if (kb) {
			const ctx = this.context();
			let found: VimKeybinding | undefined;
			for (const b of CMDLINE_KEYBINDINGS) {
				if (b.key === kb && evaluateWhen(b.when, ctx)) {
					found = b;
				}
			}
			if (found && this.run(found.command, found.args)) {
				return;
			}
		}
		const caret = this.line.caret;
		switch (k) {
			case '<BS>':
				this.deleteLeft();
				return;
			case '<Left>':
				this.line.setCaret(caret - 1);
				return;
			case '<Right>':
				this.line.setCaret(caret + 1);
				return;
			case '<Home>':
				this.line.setCaret(0);
				return;
			case '<End>':
				this.line.setCaret(this.line.text.length);
				return;
			case '<Tab>':
				this.insertText('\t');
				return;
		}
		if (Array.from(k).length === 1 && k !== '\r' && k !== '\n') {
			this.insertText(k);
		}
	}
}
