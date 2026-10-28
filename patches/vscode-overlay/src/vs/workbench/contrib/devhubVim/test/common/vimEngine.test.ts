/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { IVimHost, VimEdit, VimIndentOptions, VimMatch, VimPos, VimRange, VimSearchQuery, VimSubstitution } from '../../common/vimEngine.js';
import { VimEngine, VimSharedState } from '../../common/vimEngine.js';
import { vimFindHost } from './vimFindHost.js';
import { CMDLINE_KEYBINDINGS, VimCmdlineController, VimStringLine } from '../../common/vimCmdline.js';
import { BUILTIN_EX_REGISTRY, ExRegistry, parseExCommands, substituteExArgs, validateExCommandSpec } from '../../common/vimEx.js';
import type { VimKeybinding } from '../../common/vimKeymap.js';
import { DEFAULT_KEYBINDINGS, INSERT_ESCAPE_DISMISSES, JIS_KEYS, VIM_WEIGHTS, VIM_WHEN, evaluateWhen, jisKeys, keyForChar } from '../../common/vimKeymap.js';
import type { VimKeyEvent, VimNavFocus } from '../../common/vimKeys.js';
import { VimNavPrefix, captureKey, typedChar, vimCursorStyle } from '../../common/vimKeys.js';
import { ScriptWordBoundaries } from '../../../../../editor/common/core/scriptWordBoundaries.js';

/** A string-array host: the cursor is drawn as `|` in `state()`. */
class TestHost implements IVimHost {
	lines: string[];
	cursor: VimPos = { line: 0, col: 0 };
	selection: { start: VimPos; end: VimPos } | undefined;
	selections: VimRange[] | undefined;
	clipboard = '';
	top = 0;
	visible = 10;
	hidden = new Set<number>();
	comment: string | undefined = '//';
	formatter = false;
	highlighted: VimSearchQuery | undefined;
	/** The editor's find state (FindReplaceState) as the engine last set it, and each time it did. */
	findState: VimSearchQuery | undefined;
	findStateWrites: { query: VimSearchQuery; isNew: boolean }[] = [];
	findWidgetClosed = 0;
	/** What 'inccommand' shows (computed at once: the test host does not debounce). */
	preview: readonly VimSubstitution[] | undefined;
	incsearch: VimRange | undefined;
	/** Every edit, as the editor reports content changes. */
	onEdit: ((edits: readonly VimEdit[]) => void) | undefined;
	/** Commands run outside the engine (ex commands, awaitChar targets, plain bindings), with the selection they saw. */
	commands: { command: string; args: unknown; selection: { start: VimPos; end: VimPos } | undefined }[] = [];
	private undoStack: { lines: string[]; cursor: VimPos }[] = [];
	private redoStack: { lines: string[]; cursor: VimPos }[] = [];
	private before: { lines: string[]; cursor: VimPos } | undefined;
	private changed = false;

	constructor(text: string) {
		const at = text.indexOf('|');
		const clean = text.replace('|', '');
		this.lines = clean.split('\n');
		if (at >= 0) {
			const pre = text.slice(0, at).split('\n');
			this.cursor = { line: pre.length - 1, col: pre[pre.length - 1].length };
		}
	}
	state(): string {
		const lines = this.lines.slice();
		const l = lines[this.cursor.line];
		lines[this.cursor.line] = l.slice(0, this.cursor.col) + '|' + l.slice(this.cursor.col);
		return lines.join('\n');
	}
	lineCount() { return this.lines.length; }
	lineText(line: number) { return this.lines[line]; }
	getCursor() { return this.cursor; }
	/** Where each cursor or selection put as a Vim jump (TextEditorSelectionSource.JUMP) landed. */
	jumps: VimPos[] = [];
	setCursor(p: VimPos, jump?: boolean) { this.cursor = p; this.selection = undefined; this.selections = undefined; if (jump) { this.jumps.push(p); } }
	getSelection() { return this.selection ? { anchor: this.selection.start, active: this.selection.end } : { anchor: this.cursor, active: this.cursor }; }
	setSelection(start: VimPos, end: VimPos, atStart: boolean, jump?: boolean) { this.selection = { start, end }; this.selections = undefined; this.cursor = atStart ? start : end; if (jump) { this.jumps.push(this.cursor); } }
	setSelections(ranges: readonly VimRange[], primary: number, atStart: boolean) {
		this.selections = ranges.slice();
		this.selection = { start: ranges[0].start, end: ranges[ranges.length - 1].end };
		this.cursor = atStart ? ranges[primary].start : ranges[primary].end;
	}
	applyEdits(edits: readonly VimEdit[]) {
		if (!this.before) { this.undoStack.push({ lines: this.lines.slice(), cursor: this.cursor }); this.redoStack = []; }
		this.changed = true;
		const sorted = edits.slice().sort((a, b) => b.start.line - a.start.line || b.start.col - a.start.col);
		for (const e of sorted) {
			const head = this.lines[e.start.line].slice(0, e.start.col);
			const tail = this.lines[e.end.line].slice(e.end.col);
			const mid = (head + e.text + tail).split('\n');
			this.lines.splice(e.start.line, e.end.line - e.start.line + 1, ...mid);
		}
		this.onEdit?.(edits);
	}
	/** Typing in insert mode, as the editor would do it (`overtype`: replace mode). */
	type(text: string, overtype = false) {
		const c = this.cursor;
		const over = overtype ? Math.min(this.lines[c.line].length - c.col, text.length) : 0;
		this.applyEdits([{ start: c, end: { line: c.line, col: c.col + over }, text }]);
		const parts = text.split('\n');
		this.cursor = parts.length === 1 ? { line: c.line, col: c.col + text.length } : { line: c.line + parts.length - 1, col: parts[parts.length - 1].length };
	}
	/** Backspace in insert mode (VS Code's deleteLeft). */
	backspace() {
		const c = this.cursor;
		if (c.col > 0) {
			this.applyEdits([{ start: { line: c.line, col: c.col - 1 }, end: c, text: '' }]);
			this.cursor = { line: c.line, col: c.col - 1 };
		}
	}
	beginChange() { this.before = { lines: this.lines.slice(), cursor: this.cursor }; this.changed = false; }
	endChange() {
		if (this.before && this.changed) { this.undoStack.push(this.before); this.redoStack = []; }
		this.before = undefined;
	}
	undo() {
		const s = this.undoStack.pop();
		if (s) { this.redoStack.push({ lines: this.lines.slice(), cursor: this.cursor }); this.lines = s.lines; this.cursor = s.cursor; }
	}
	redo() {
		const s = this.redoStack.pop();
		if (s) { this.undoStack.push({ lines: this.lines.slice(), cursor: this.cursor }); this.lines = s.lines; this.cursor = s.cursor; }
	}
	indent: VimIndentOptions = { tabSize: 4, indentSize: 'tabSize', insertSpaces: false };
	indentUnit() { return this.indent.insertSpaces ? ' '.repeat(this.indent.indentSize === 'tabSize' ? this.indent.tabSize : this.indent.indentSize) : '\t'; }
	tabSize() { return this.indent.tabSize; }
	indentOptions() { return this.indent; }
	setIndentOptions(o: Partial<VimIndentOptions>) { this.indent = { ...this.indent, ...o }; }
	defaultIndentOptions(): VimIndentOptions { return { tabSize: 4, indentSize: 'tabSize', insertSpaces: false }; }
	visibleLines() { return { top: this.top, bottom: Math.min(this.lines.length - 1, this.top + this.visible - 1) }; }
	scrollToLine(line: number, at: 'top' | 'center' | 'bottom', moveCursor?: () => void) {
		moveCursor?.();
		this.top = Math.max(0, at === 'top' ? line : at === 'bottom' ? line - this.visible + 1 : line - Math.floor(this.visible / 2));
	}
	isLineHidden(line: number) { return this.hidden.has(line); }
	displayLineMove(from: VimPos, count: number): VimPos | undefined {
		const line = from.line + count;
		return line < 0 || line >= this.lines.length ? undefined : { line, col: Math.min(from.col, Math.max(0, this.lines[line].length - 1)) };
	}
	setClipboard(t: string) { this.clipboard = t; }
	getClipboard() { return this.clipboard; }
	prefetchClipboard() { }
	highlightSearch(r: VimSearchQuery | undefined) { this.highlighted = r; }
	syncFindState(query: VimSearchQuery, isNew: boolean) { this.findState = query; this.findStateWrites.push({ query, isNew }); }
	closeFindWidgets() { this.findWidgetClosed++; }
	previewSubstitute(compute: (() => readonly VimSubstitution[] | undefined) | undefined) { this.preview = compute?.(); }
	private readonly find = vimFindHost(() => this.lines);
	findMatches(q: VimSearchQuery, within: VimRange, limit: number) { return this.find.findMatches(q, within, limit); }
	findNextMatch(q: VimSearchQuery, from: VimPos, backwards: boolean) { return this.find.findNextMatch(q, from, backwards); }
	replaceString(rep: string, m: VimMatch) { return this.find.replaceString(rep, m); }
	showIncSearch(r: VimRange | undefined) { this.incsearch = r; }
	lineComment() { return this.comment; }
	hasRangeFormatter() { return this.formatter; }
	fileName() { return 'test.txt'; }
	/** What the workbench's commands answer (a file's lines, a filter's output ...): a value, or a rejection when it throws. */
	answer: ((command: string, args: unknown) => unknown) | undefined;
	executeCommand(command: string, args: unknown): Promise<unknown> {
		this.commands.push({ command, args, selection: this.selection });
		if (this.answer) {
			try {
				const a = this.answer(command, args);
				if (a !== undefined) {
					return Promise.resolve(a);
				}
			} catch (err) {
				return Promise.reject(err);
			}
		}
		if (command === 'editor.action.commentLine' && this.selection) {
			// what VS Code's toggle does, simply
			const s = this.selection.start.line;
			const e = this.selection.end.line;
			const all = this.lines.slice(s, e + 1).every(l => !l.trim() || l.trimStart().startsWith('//'));
			const edits: VimEdit[] = [];
			for (let l = s; l <= e; l++) {
				const text = this.lines[l];
				const ind = /^\s*/.exec(text)![0].length;
				if (all) {
					const m = /^(\s*)\/\/ ?/.exec(text);
					if (m) { edits.push({ start: { line: l, col: m[1].length }, end: { line: l, col: m[0].length }, text: '' }); }
				} else if (text.trim()) {
					edits.push({ start: { line: l, col: ind }, end: { line: l, col: ind }, text: '// ' });
				}
			}
			this.applyEdits(edits);
		} else if (command === 'deleteLeft') {
			this.backspace();
		} else if (command === 'undo') {
			// VS Code's undo: one step of the stack the engine's changes made
			this.undo();
		} else if (command === 'redo') {
			this.redo();
		}
		return Promise.resolve(undefined);
	}
	refresh() { }
}

// ---- the driver: keys resolved against the keymap, as the workbench does ----

/**
 * The editor's own keys that type or erase a character (coreCommands.ts), with
 * the `when` they are registered with: EditorContextKeys.devhubVimAllowsTyping
 * (editor/test/browser/controller/devhubVimAllowsTyping.test.ts checks the
 * string). They weigh less than the Vim keymap, so they come first.
 */
const ALLOWS_TYPING = 'devhubVim.mode == \'insert\' || devhubVim.mode == \'replace\' || !devhubVim.active && devhubVim.mode != \'nav\'';
const EDITOR_TYPING_KEYS: readonly VimKeybinding[] = [
	{ key: 'backspace', command: 'deleteLeft', when: `textInputFocus && (${ALLOWS_TYPING})` },
	{ key: 'shift+backspace', command: 'deleteLeft', when: `textInputFocus && (${ALLOWS_TYPING})` },
	{ key: 'delete', command: 'deleteRight', when: `textInputFocus && (${ALLOWS_TYPING})` },
	{ key: 'tab', command: 'tab', when: `editorTextFocus && !editorTabMovesFocus && (${ALLOWS_TYPING})` },
	{ key: 'shift+tab', command: 'outdent', when: `editorTextFocus && !editorTabMovesFocus && (${ALLOWS_TYPING})` },
];

interface UserBinding {
	readonly key: string;
	/** `-id` removes the default entries for `id` (on `key`), as in keybindings.json. */
	readonly command: string;
	readonly args?: Readonly<Record<string, unknown>>;
	readonly when?: string;
}

/** Vim key notation to keybinding notation, for the keys tests press. */
const NAMED: Record<string, string> = {
	'<Esc>': 'escape', '<CR>': 'enter', '<BS>': 'backspace', '<Tab>': 'tab', '<S-Tab>': 'shift+tab', '<Space>': 'space', '<Del>': 'delete',
	'<Left>': 'left', '<Right>': 'right', '<Up>': 'up', '<Down>': 'down', '<Home>': 'home', '<End>': 'end',
	'<PageDown>': 'pagedown', '<PageUp>': 'pageup',
};

function keyFor(k: string): string | undefined {
	if (NAMED[k]) {
		return NAMED[k];
	}
	const c = /^<C-(.)>$/.exec(k);
	return c ? `ctrl+${keyForChar(c[1].toLowerCase())}` : undefined;
}

class Vim {
	readonly host: TestHost;
	readonly vim: VimEngine;
	readonly shared: VimSharedState;
	bindings: VimKeybinding[];
	private chord: string[] = [];
	/** The prompt line, as the workbench shows it for each prompt the engine opens (vimCmdline.ts). */
	prompt: VimCmdlineController | undefined;
	private promptId = 0;

	constructor(text: string, user: readonly UserBinding[] = [], shared = new VimSharedState()) {
		this.host = new TestHost(text);
		this.shared = shared;
		this.vim = new VimEngine(this.host, shared);
		this.host.onEdit = edits => this.vim.contentChanged(edits);
		this.bindings = Vim.withUser(user);
	}

	static withUser(user: readonly UserBinding[]): VimKeybinding[] {
		let out = [...EDITOR_TYPING_KEYS, ...DEFAULT_KEYBINDINGS];
		for (const u of user) {
			if (u.command.startsWith('-')) {
				out = out.filter(b => !(b.command === u.command.slice(1) && (!u.key || b.key === u.key)));
			} else {
				out.push({ key: u.key, command: u.command, args: u.args, when: u.when ?? 'true' });
			}
		}
		return out;
	}

	context(): Record<string, unknown> {
		const c = this.vim.context();
		return {
			'true': true,
			'editorTextFocus': true,
			'textInputFocus': true,
			'devhubVim.active': true,
			'devhubVim.mode': c.mode,
			'devhubVim.acceptsMotion': c.acceptsMotion,
			'devhubVim.hasCount': c.hasCount,
			'devhubVim.pending': c.pending,
			'devhubVim.pendingOperator': c.pendingOperator,
			'devhubVim.textObjectPending': c.textObjectPending,
			'devhubVim.awaitingChar': c.awaitingChar,
			'devhubVim.recording': c.recording,
			'devhubVim.visual': c.visual,
			'devhubVim.insert': c.insert,
		};
	}

	private run(b: VimKeybinding): void {
		if (!this.vim.execute(b.command, b.args)) {
			void this.host.executeCommand(b.command, b.args);
		}
	}

	private resolve(keys: string[]): VimKeybinding | undefined {
		const ctx = this.context();
		let found: VimKeybinding | undefined;
		for (const b of this.bindings) {
			if (keys.includes(b.key) && evaluateWhen(b.when, ctx)) {
				found = b;
			}
		}
		return found;
	}

	/** The open prompt's line, opened as the workbench opens it (once per prompt, with the text the engine starts it with). */
	promptLine(): VimCmdlineController | undefined {
		const state = this.vim.cmdlineState;
		if (!state) {
			this.prompt = undefined;
			return undefined;
		}
		if (state.id !== this.promptId) {
			this.promptId = state.id;
			this.prompt = new VimCmdlineController(state.kind, new VimStringLine(state.text), this.vim.cmdlineTarget(), this.vim.cmdlineSources());
		}
		return this.prompt;
	}

	/** The prompt's text, or undefined when none is open. */
	promptText(): string | undefined {
		return this.promptLine()?.line.text;
	}

	/** One key: a character, or <Esc> <CR> <BS> <Tab> <C-x> <Left> <Right> <Up> <Down> ... */
	press(k: string): void {
		// the prompt line has the focus: its keybindings (CMDLINE_KEYBINDINGS), or typing
		const prompt = this.promptLine();
		if (prompt) {
			prompt.feedKey(k);
			return;
		}
		// the editor's own keydown: a waiting command's character
		if (this.vim.awaitingChar) {
			this.vim.awaitKey(k);
			return;
		}
		const named = keyFor(k);
		// a character is pressed on the Apple JIS key that types it
		const keys = named ? [named] : [keyForChar(k) ?? k];
		const full = keys.map(key => [...this.chord, key].join(' '));
		const match = this.resolve(full);
		if (match) {
			this.chord = [];
			this.run(match);
			return;
		}
		const ctx = this.context();
		const prefix = this.bindings.find(b => full.some(f => b.key.startsWith(f + ' ')) && evaluateWhen(b.when, ctx));
		if (prefix) {
			this.chord.push(keys[0]);
			return;
		}
		if (this.chord.length) {
			this.chord = []; // "the key combination is not a command"
			return;
		}
		// no keybinding: the editor's keydown (an unbound key cancels the pending command)
		if (!this.vim.context().insert && Array.from(k).length === 1 && this.vim.pending) {
			this.vim.cancelPending();
		}
	}

	/** Keys as in Vim notation; in insert mode characters are typed, `§` types the next of `insert`. */
	keys(keys: string, insert: string[] = []): this {
		const typed = insert.slice();
		for (const k of keysOf(keys)) {
			const c = this.vim.context();
			if (c.insert && !this.vim.awaitingChar && !this.vim.cmdlineOpen && (Array.from(k).length === 1 || k === '<CR>')) {
				this.host.type(k === '§' ? typed.shift()! : k === '<CR>' ? '\n' : k, this.vim.mode === 'replace');
				continue;
			}
			if (c.insert && k === '<BS>' && this.vim.mode === 'insert') {
				this.host.backspace();
				continue;
			}
			this.press(k);
		}
		return this;
	}

	state(): string {
		return this.host.state();
	}
}

function keysOf(s: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < s.length; i++) {
		if (s.startsWith('<lt>', i)) {
			out.push('<');
			i += 3;
			continue;
		}
		if (s[i] === '<') {
			const j = s.indexOf('>', i);
			if (j > i + 1 && /^<[A-Za-z][-\w[\]]*>$/.test(s.slice(i, j + 1))) { out.push(s.slice(i, j + 1)); i = j; continue; }
		}
		out.push(s[i]);
	}
	return out;
}

function run(text: string, keys: string, insert?: string[]): { host: TestHost; vim: VimEngine; v: Vim } {
	const v = new Vim(text).keys(keys, insert);
	return { host: v.host, vim: v.vim, v };
}

/** Let ex commands' awaited steps run. */
function flush(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

function check(text: string, keys: string, expected: string) {
	assert.strictEqual(run(text, keys).host.state(), expected, `${JSON.stringify(text)} ${keys}`);
}

suite('DevHub Vim engine', () => {

	test('h j k l and counts', () => {
		check('a|bc\ndef', 'l', 'ab|c\ndef');
		check('a|bc\ndef', '5l', 'ab|c\ndef');
		check('ab|c\ndef', 'j', 'abc\nde|f');
		check('abcdef\nx\nabcdef', '4lj', 'abcdef\n|x\nabcdef');
		check('abcdef\nx\nabcdef', '4ljj', 'abcdef\nx\nabcd|ef');
		check('abc', 'h', '|abc');
		check('a|bc\ndef', '<Down>', 'abc\nd|ef');
		check('|abcdef', '10l', 'abcde|f');
	});

	test('word motions', () => {
		check('|foo bar.baz  qux', 'w', 'foo |bar.baz  qux');
		check('|foo bar.baz  qux', '3w', 'foo bar.|baz  qux');
		check('|foo bar.baz  qux', '2W', 'foo bar.baz  |qux');
		check('foo\n\n|bar', 'b', 'foo\n|\nbar');
		check('foo bar.baz  |qux', 'b', 'foo bar.|baz  qux');
		check('foo bar.baz  |qux', 'B', 'foo |bar.baz  qux');
		check('|foo bar', 'e', 'fo|o bar');
		check('fo|o bar', 'e', 'foo ba|r');
		check('foo\n|bar', 'w', 'foo\nba|r');
		check('|foo\n  bar', 'w', 'foo\n  |bar');
		check('foo ba|r', 'ge', 'fo|o bar');
	});

	test('line motions', () => {
		check('  ab|c', '0', '|  abc');
		check('|  abc', '^', '  |abc');
		check('|  abc', '$', '  ab|c');
		check('a\nb\n|c', 'gg', '|a\nb\nc');
		check('|a\nb\nc', 'G', 'a\nb\n|c');
		check('|a\nb\nc', '2G', 'a\n|b\nc');
		check('|a\nb\nc', '2gg', 'a\n|b\nc');
		check('|a\nb\nc', ':2<CR>', 'a\n|b\nc');
		check('|a\nb\nc', ':$<CR>', 'a\nb\n|c');
	});

	test('f t F T ; ,', () => {
		check('|a,b,c,d', 'f,', 'a|,b,c,d');
		check('|a,b,c,d', '2f,', 'a,b|,c,d');
		check('|a,b,c,d', 'f,;', 'a,b|,c,d');
		check('|a,b,c,d', 't,', '|a,b,c,d');
		check('|abc,def,', 't,;', 'abc,de|f,');
		check('a,b,c,|d', 'F,', 'a,b,c|,d');
		check('a,b,c,|d', 'T,', 'a,b,c,|d');
		check('a,b,c,|d', 'F,,', 'a,b,c|,d');
	});

	test('% matches brackets across lines', () => {
		check('|if (a) {\n  x;\n}', '%', 'if (a|) {\n  x;\n}');
		check('if (a) |{\n  x;\n}', '%', 'if (a) {\n  x;\n|}');
		check('if (a) {\n  x;\n|}', '%', 'if (a) |{\n  x;\n}');
	});

	test('operators with motions and counts', () => {
		check('|foo bar baz', 'dw', '|bar baz');
		check('|foo bar baz', '2dw', '|baz');
		check('|foo bar baz', 'd2w', '|baz');
		check('foo |bar', 'dw', 'foo| ');
		check('|foo bar', 'de', '| bar');
		check('fo|o bar', 'd$', 'f|o');
		check('foo b|ar', 'd0', '|ar');
		check('|a\nb\nc\nd', 'dj', '|c\nd');
		check('a\nb\n|c\nd', 'dk', 'a\n|d');
		check('|a(b, c)d', 'dt)', '|)d');
		check('|a(b, c)d', 'df)', '|d');
		check('a\n|b\nc', 'dG', '|a');
		check('a\nb\n|c', 'dgg', '|');
		// an operator that another operator interrupts, or an unbound key, is cancelled
		check('|foo bar', 'dyw', 'foo |bar');
		check('|foo bar', 'dzw', 'foo |bar');
	});

	test('dd yy p P with counts', () => {
		check('|a\nb\nc', 'dd', '|b\nc');
		check('|a\nb\nc', '2dd', '|c');
		check('a\nb\n|c', 'dd', 'a\n|b');
		check('|a\nb\nc', 'yyp', 'a\n|a\nb\nc');
		check('|a\nb\nc', 'yyP', '|a\na\nb\nc');
		check('|a\nb\nc', 'yy2p', 'a\n|a\na\nb\nc');
		check('|ab', 'ylp', 'a|ab');
		check('|ab', 'xp', 'b|a');
		check('|abc', '"ayl"ap', 'a|abc');
		check('|a\nb', 'ddp', 'b\n|a');
	});

	test('system clipboard register', () => {
		const { host } = run('|hello world', '"+yiw');
		assert.strictEqual(host.clipboard, 'hello');
		const r = run('|x', '"+yy');
		assert.strictEqual(r.host.clipboard, 'x\n');
		const v = new Vim('|ab');
		v.host.clipboard = 'line\n';
		v.keys('"+p');
		assert.strictEqual(v.state(), 'ab\n|line');
	});

	test('text objects', () => {
		check('foo b|ar baz', 'diw', 'foo | baz');
		check('foo b|ar baz', 'daw', 'foo |baz');
		check('x = "he|llo" + y', 'di"', 'x = "|" + y');
		check('x = "he|llo" + y', 'da"', 'x = |+ y');
		check('f(a, |b)', 'di(', 'f(|)');
		check('f(a, |b)', 'dib', 'f(|)');
		check('f(a, |b)', 'da(', '|f');
		check('f(a, (|b))', '2di(', 'f(|)');
		check('if {\n  a;\n  |b;\n}', 'di{', 'if {\n|}');
		check('x{a|b}y', 'ci{Z<Esc>', 'x{|Z}y');
		check('a[b|c]d', 'di]', 'a[|]d');
	});

	test('text objects take counts (d2iw, 2aw, d2i()', () => {
		check('foo b|ar baz qux', 'd2iw', 'foo |baz qux');
		check('foo b|ar baz qux', 'd2aw', 'foo |qux');
		check('foo b|ar baz qux', '2daw', 'foo |qux');
		check('f(a, (|b))', 'd2i(', 'f(|)');
		check('foo b|ar baz qux', 'v2iwd', 'foo |baz qux');
	});

	test('c and insert, dot repeat, undo', () => {
		const { host } = run('|foo bar', 'cw§<Esc>', ['baz']);
		assert.strictEqual(host.state(), 'ba|z bar');
		const r = run('|foo bar baz', 'cw§<Esc>w.', ['X']);
		assert.strictEqual(r.host.state(), 'X |X baz');
		const r2 = run('|a b c d', 'dw..', []);
		assert.strictEqual(r2.host.state(), '|d');
		const r3 = run('|a b c d', 'dwdwuu', []);
		assert.strictEqual(r3.host.lines.join('\n'), 'a b c d');
		const r4 = run('|a b c d', 'dwdwuu<C-r>', []);
		assert.strictEqual(r4.host.lines.join('\n'), 'b c d');
		const r5 = run('|ab', 'i§<Esc>u', ['xyz']);
		assert.strictEqual(r5.host.lines.join('\n'), 'ab');
		const r6 = run('|ab', '3i§<Esc>', ['x']);
		assert.strictEqual(r6.host.state(), 'xx|xab');
		const r7 = run('|a\nb', 'A§<Esc>j.', [';']);
		assert.strictEqual(r7.host.state(), 'a;\nb|;');
		// a new count replaces the recorded one
		const r8 = run('|a b c d e', 'dw3.', []);
		assert.strictEqual(r8.host.state(), '|e');
		// f's character and the search pattern are part of the change
		check('|a,b,c,d', 'df,.', '|c,d');
		check('|foo bar foo bar', 'd/bar<CR>w.', 'bar |bar');
	});

	test('o O A I x r J', () => {
		const { host } = run('  |a\nb', 'o§<Esc>', ['x']);
		assert.strictEqual(host.state(), '  a\n  |x\nb');
		const r = run('  |a', 'O§<Esc>', ['x']);
		assert.strictEqual(r.host.state(), '  |x\n  a');
		check('|abc', '2x', '|c');
		check('|abc', 'rx', '|xbc');
		check('|abc', '2rx', 'x|xc');
		check('|a\n   b\nc', 'J', 'a| b\nc');
		check('|a\nb\nc', '3J', 'a b| c');
		check('|aB', '~~', 'A|b');
		check('|abc', 'rx.', '|xbc');
		check('a|bc', 'rxl.', 'ax|x');
	});

	test('> and <', () => {
		// 'nostartofline': the cursor keeps its screen column, the text moves under it
		check('|a\nb', '>>', '|\ta\nb');
		check('|a\nb', '>j', '|\ta\n\tb');
		check('\t|ab', 'l>>', '\t|\tab');
		check('\t|a', '<<', '|a');
		check('    |a', '<<', '|a');
	});

	test('visual char and line', () => {
		check('|abc def', 'vlld', '| def');
		check('|abc def', 'veyP', 'ab|cabc def');
		check('a\n|b\nc\nd', 'Vjd', 'a\n|d');
		check('|abc def', 'viwd', '| def');
		check('|abc def', 'vex', '| def');
		check('|ab\ncd', 'vY', '|ab\ncd');
		check('|abc', 'vlU', '|ABc');
		check('|abc def', 'vllohd', '| def');
	});

	test('visual change', () => {
		const { host } = run('|abc def', 'vlc§<Esc>', ['X']);
		assert.strictEqual(host.state(), '|Xc def');
	});

	test('search / ? n N and *', () => {
		check('|foo bar foo bar', '/bar<CR>', 'foo |bar foo bar');
		check('|foo bar foo bar', '/bar<CR>n', 'foo bar foo |bar');
		check('|foo bar foo bar', '/bar<CR>nN', 'foo |bar foo bar');
		check('foo bar foo |bar', '?foo<CR>', 'foo bar |foo bar');
		check('|foo bar foo', '*', 'foo bar |foo');
		check('foo bar |foo', '#', '|foo bar foo');
		check('|foo bar baz', 'd/baz<CR>', '|baz');
		check('|foo bar baz', 'd/<Esc>w', 'foo |bar baz');
	});

	test('built-in ex commands run their table entries', async () => {
		const { host, vim } = run('|a', ':w<CR>');
		assert.deepStrictEqual(host.commands.map(c => c.command), ['workbench.action.files.save']);
		assert.strictEqual(vim.status(), 'NORMAL');
		const r = run('|a', ':frobnicate<CR>');
		assert.ok(r.vim.status().includes('Not an editor command'));
		const wq = run('|a', ':wq<CR>');
		await flush();
		// the last window of a tab page closes the tab page (devhubVim.tabpage.closeIfEmpty)
		assert.deepStrictEqual(wq.host.commands.map(c => c.command), ['workbench.action.files.save', 'workbench.action.closeActiveEditor', 'devhubVim.tabpage.closeIfEmpty']);
		assert.deepStrictEqual(run('|a', ':q<CR>').host.commands.map(c => c.command), ['workbench.action.closeActiveEditor']);
		assert.deepStrictEqual(run('|a', ':q!<CR>').host.commands.map(c => c.command), ['workbench.action.revertAndCloseActiveEditor']);
		assert.deepStrictEqual(run('|a', ':noh<CR>').host.commands, []);
	});

	test('escape cancels one thing at a time, then does nothing', () => {
		const v = new Vim('|abc');
		v.vim.escape();
		assert.strictEqual(v.vim.mode, 'normal');
		assert.strictEqual(v.state(), '|abc');
		v.press('d');
		v.vim.escape();
		assert.strictEqual(v.vim.pending, false);
		v.press('i');
		assert.strictEqual(v.vim.mode, 'insert');
		v.vim.escape();
		assert.strictEqual(v.vim.mode, 'normal');
		v.press('v');
		v.vim.escape();
		assert.strictEqual(v.vim.mode, 'normal');
		v.vim.escape();
		assert.strictEqual(v.vim.mode, 'normal');
		assert.strictEqual(v.vim.status(), 'NORMAL');
	});

	test('large buffers are read lazily', () => {
		const v = new Vim('|x');
		v.host.lines = new Array(200000).fill('word word');
		let reads = 0;
		const orig = v.host.lineText.bind(v.host);
		v.host.lineText = (l: number) => { reads++; return orig(l); };
		reads = 0;
		v.keys('3wdd');
		assert.ok(reads < 200, `read ${reads} lines`);
		v.keys('G');
		assert.strictEqual(v.host.cursor.line, 199998);
	});

	test('a mouse drag selects what the mouse covers, either way, however many moves it takes', () => {
		// The editor goes on with a drag from the start (the anchor) of the
		// selection it has, which is the one the engine put last.
		const pos = (line: number, col: number): VimPos => ({ line, col });
		const drag = (text: string, from: VimPos, moves: VimPos[]) => {
			const v = new Vim(text);
			let anchor = from;
			const seen: string[] = [];
			for (const to of moves) {
				v.vim.selectionChanged(anchor, to);
				const s = v.host.selection!;
				const backwards = v.host.cursor.line === s.start.line && v.host.cursor.col === s.start.col;
				anchor = backwards ? s.end : s.start;
				seen.push(`${s.start.line}:${s.start.col}-${s.end.line}:${s.end.col}${backwards ? '<' : '>'}`);
			}
			return { v, seen };
		};
		const up = drag('abcdefgh\nijklmnop', pos(1, 6), [pos(1, 4), pos(1, 2), pos(0, 6), pos(0, 3), pos(0, 1)]);
		assert.deepStrictEqual(up.seen, ['1:4-1:6<', '1:2-1:6<', '0:6-1:6<', '0:3-1:6<', '0:1-1:6<'], 'bottom to top: the end stays where the drag began');
		assert.strictEqual(up.v.vim.mode, 'visual');
		up.v.keys('d');
		assert.strictEqual(up.v.state(), 'a|op', 'd deletes what was highlighted');

		const down = drag('abcdefgh\nijklmnop', pos(0, 1), [pos(0, 3), pos(1, 2), pos(1, 6)]);
		assert.deepStrictEqual(down.seen, ['0:1-0:3>', '0:1-1:2>', '0:1-1:6>'], 'top to bottom');
		down.v.keys('d');
		assert.strictEqual(down.v.state(), 'a|op');

		const back = drag('abcdef', pos(0, 5), [pos(0, 1)]);
		back.v.keys('o');
		assert.deepStrictEqual(back.v.vim.visualCursor(), pos(0, 4), 'o: the other end is the last character the mouse covered');
		back.v.keys('o');
		assert.deepStrictEqual(back.v.host.selection, { start: pos(0, 1), end: pos(0, 5) }, 'and back: the same characters');

		const one = drag('abcdef', pos(0, 4), [pos(0, 3)]);
		assert.deepStrictEqual(one.v.host.selection, { start: pos(0, 3), end: pos(0, 4) }, 'one character backwards');

		const eol = drag('ab\ncd', pos(1, 0), [pos(0, 1)]);
		assert.deepStrictEqual(eol.seen, ['0:1-1:0<'], 'backwards from the start of a line: the newline above is the end');
	});
});

suite('DevHub Vim: words end where the script changes (devhub.editor.wordBoundariesByScript)', () => {

	setup(() => ScriptWordBoundaries.setEnabled(true));
	teardown(() => ScriptWordBoundaries.setEnabled(false));

	test('w b e ge: kanji / hiragana / katakana / fullwidth / ASCII / punctuation / emoji', () => {
		check('|漢字ひらがなカタカナ', 'w', '漢字|ひらがなカタカナ');
		check('|漢字ひらがなカタカナ', 'ww', '漢字ひらがな|カタカナ');
		check('|カタカナ漢字', 'w', 'カタカナ|漢字');
		check('|全角ＡＢＣ１２３です', 'ww', '全角ＡＢＣ１２３|です');
		check('|fooバーbaz_qux', 'w', 'foo|バーbaz_qux');
		check('|fooバーbaz_qux', 'ww', 'fooバー|baz_qux');
		check('|漢字、。「かな」', 'w', '漢字|、。「かな」');
		check('|漢字、。「かな」', 'ww', '漢字、。「|かな」');
		check('|絵文字😀😀だ', 'w', '絵文字|😀😀だ');
		check('|絵文字😀😀だ', 'ww', '絵文字😀😀|だ');
		check('|すごーいカナ', 'w', 'すごーい|カナ');
		check('日本語の文章|を', 'b', '日本語の|文章を');
		check('|日本語の文章', 'e', '日本|語の文章');
		check('|日本語の文章', 'ee', '日本語|の文章');
		check('日本語の文|章', 'ge', '日本語|の文章');
		check('|漢字　かな', 'w', '漢字　|かな');
	});

	test('W B E stay whitespace-delimited', () => {
		check('|漢字ひらがな foo', 'W', '漢字ひらがな |foo');
		check('漢字ひらがな f|oo', 'B', '漢字ひらがな |foo');
		check('|漢字ひらがな foo', 'E', '漢字ひらが|な foo');
	});

	test('iw aw', () => {
		check('漢字ひ|らがなカタカナ', 'diw', '漢字|カタカナ');
		check('漢字ひ|らがな カタカナ', 'daw', '漢字|カタカナ');
		check('全角|ＡＢＣ１２３です', 'ciwX<Esc>', '全角|Xです');
		check('a😀|b c', 'diw', 'a😀| c');
		check('a|😀b', 'diw', 'a|b');
	});

	test('*: the word under the cursor in one script, matched by whole word where scripts change (VS Code\'s Match Whole Word)', () => {
		check('|漢字ひらがな\nfoo 漢字カタカナ\n漢字', '*', '漢字ひらがな\nfoo |漢字カタカナ\n漢字');
		check('漢字ひ|らがな\nひらがなx', '*', '漢字ひらがな\n|ひらがなx');
		check('|漢字ひらがな\n漢字x', '*', '漢字ひらがな\n|漢字x');
	});

	test('off: CJK text is one word, as before', () => {
		ScriptWordBoundaries.setEnabled(false);
		check('|漢字ひらがな foo', 'w', '漢字ひらがな |foo');
		check('漢字ひ|らがな', 'diw', '|');
	});
});

suite('DevHub Vim modes stay consistent', () => {

	/** Every way of being "in the middle of something" in normal-side modes. */
	const pendings = ['d', '2d', '"a', '"', 'c', 'g', 'f', 'r', 'q', ':', '/', 'v', 'V', 'vj', 'd/', 'di', 'vi', 'i', 'A', 'o', 'cw', 'qa'];

	test('Esc from any state ends in plain normal mode', () => {
		for (const keys of pendings) {
			const { vim, v } = run('ab|c\ndef', keys);
			v.press('<Esc>');
			if (vim.mode !== 'normal' || vim.pending) {
				v.press('<Esc>');
			}
			assert.strictEqual(vim.mode, 'normal', keys);
			assert.strictEqual(vim.pending, false, keys);
			assert.ok(vim.status().startsWith('NORMAL'), keys);
			// and the next command is a plain normal-mode command
			v.press('l');
			assert.strictEqual(vim.mode, 'normal', keys);
		}
	});

	test('Esc mashed any number of times is plain normal mode, from every state', () => {
		for (const keys of pendings) {
			const { host, vim, v } = run('ab|c\ndef', keys);
			for (let i = 0; i < 7; i++) {
				v.press('<Esc>');
			}
			assert.strictEqual(vim.mode, 'normal', keys);
			assert.strictEqual(vim.pending, false, keys);
			assert.strictEqual(vim.context().mode, 'normal', keys);
			assert.strictEqual(vimCursorStyle(vim.mode, false, 'line'), 'block', keys);
			const before = host.state();
			v.press('<Esc>');
			assert.strictEqual(host.state(), before, `${keys}: Esc in normal mode moved or edited`);
		}
	});

	test('a command that throws half way leaves normal mode, no pending command, a closed change', () => {
		for (const keys of ['dw', 'x', 'p', 'ciw', 'vjd', 'Vd', 'o', '~', 'J', '>>']) {
			const v = new Vim('|abc def\nghi');
			v.keys('yy');
			let open = 0;
			const begin = v.host.beginChange.bind(v.host);
			const end = v.host.endChange.bind(v.host);
			v.host.beginChange = () => { open++; begin(); };
			v.host.endChange = () => { open--; end(); };
			v.host.applyEdits = () => { throw new Error('model is gone'); };
			v.keys(keys);
			assert.strictEqual(v.vim.mode, 'normal', keys);
			assert.strictEqual(v.vim.pending, false, keys);
			assert.strictEqual(open, 0, `${keys}: change left open`);
			assert.strictEqual(v.host.selection, undefined, `${keys}: visual selection left on screen`);
			assert.ok(v.vim.status().includes('model is gone'), keys);
		}
	});

	test('a throwing host during Esc out of insert still lands in normal mode', () => {
		const v = new Vim('|abc');
		v.press('i');
		v.host.type('xy');
		const setCursor = v.host.setCursor.bind(v.host);
		let fail = true;
		v.host.setCursor = (p: VimPos) => { if (fail) { fail = false; throw new Error('boom'); } setCursor(p); };
		assert.doesNotThrow(() => v.press('<Esc>'));
		assert.strictEqual(v.vim.mode, 'normal');
		assert.strictEqual(v.vim.pending, false);
	});

	test('u with nothing to undo, u after a change, u in visual mode', () => {
		let r = run('|abc', 'u');
		assert.strictEqual(r.vim.mode, 'normal');
		assert.strictEqual(r.host.state(), '|abc');

		r = run('|abc def', 'ciwxyz<Esc>u');
		assert.strictEqual(r.vim.mode, 'normal');
		assert.strictEqual(r.host.lines[0], 'abc def');

		// visual `u` is "lowercase", not undo, and returns to normal mode
		r = run('|ABC DEF', 'veu');
		assert.strictEqual(r.vim.mode, 'normal');
		assert.strictEqual(r.host.state(), '|abc DEF');
		r.v.press('u');
		assert.strictEqual(r.host.lines[0], 'ABC DEF');
		assert.strictEqual(r.vim.mode, 'normal');
	});

	test('u and CTRL-R are VS Code\'s undo / redo, a count repeats them (3u, 2<C-r>)', async () => {
		// the keys run the native commands, nothing of the engine's
		for (const [key, command] of [['u', 'undo'], ['ctrl+r', 'redo']]) {
			const b = DEFAULT_KEYBINDINGS.filter(k => k.key === key && evaluateWhen(k.when, { textInputFocus: true, 'devhubVim.active': true, 'devhubVim.acceptsMotion': true, 'devhubVim.mode': 'normal' }));
			assert.deepStrictEqual(b.map(k => [k.command, k.args]), [['devhubVim.repeat', { command, count: '${count}' }]]);
		}
		const r = run('|a b c d e', 'dwdwdw');
		assert.strictEqual(r.host.lines[0], 'd e');
		r.v.keys('3u');
		await flush();
		assert.strictEqual(r.host.lines[0], 'a b c d e');
		assert.deepStrictEqual(r.host.commands.map(c => c.command), ['undo', 'undo', 'undo']);
		r.v.keys('2<C-r>');
		await flush();
		assert.strictEqual(r.host.lines[0], 'c d e');
		r.v.keys('u');
		assert.strictEqual(r.host.lines[0], 'b c d e', 'one undo runs at once');
		assert.strictEqual(r.vim.mode, 'normal');
		// an insert is one step, whatever was typed in it; i_CTRL-W breaks it (Neovim)
		const i = run('|x', 'ifoo bar<CR>baz<Esc>');
		assert.strictEqual(i.host.lines.join('\n'), 'foo bar\nbazx');
		i.v.keys('u');
		assert.strictEqual(i.host.lines.join('\n'), 'x');
		const w = run('|x', 'ifoo bar<C-w>baz<Esc>');
		assert.strictEqual(w.host.lines[0], 'foo bazx');
		w.v.keys('u');
		assert.strictEqual(w.host.lines[0], 'foo barx', 'the break is before the CTRL-W');
		w.v.keys('u');
		assert.strictEqual(w.host.lines[0], 'x');
	});

	test('the caret style is a function of the state', () => {
		assert.strictEqual(vimCursorStyle('insert', false, 'line'), 'line');
		assert.strictEqual(vimCursorStyle('insert', false, 'underline'), 'underline');
		for (const m of ['normal', 'visual', 'visualLine']) {
			assert.strictEqual(vimCursorStyle(m, false, 'line'), 'block', m);
		}
		for (const m of ['normal', 'insert', 'visual']) {
			assert.strictEqual(vimCursorStyle(m, true, 'line'), 'underline-thin', m);
		}
	});

	test('context keys follow the grammar', () => {
		const v = new Vim('|abc def');
		assert.deepStrictEqual(v.vim.context(), { mode: 'normal', acceptsMotion: true, hasCount: false, pending: false, pendingOperator: '', textObjectPending: '', awaitingChar: false, recording: false, visual: false, insert: false });
		v.press('2');
		assert.strictEqual(v.vim.context().hasCount, true);
		v.press('d');
		assert.deepStrictEqual([v.vim.context().mode, v.vim.context().pendingOperator, v.vim.context().hasCount], ['operatorPending', 'delete', false]);
		v.press('i');
		assert.deepStrictEqual([v.vim.context().textObjectPending, v.vim.context().acceptsMotion], ['inner', false]);
		v.press('<Esc>');
		v.press('f');
		assert.deepStrictEqual([v.vim.context().awaitingChar, v.vim.context().acceptsMotion], [true, false]);
		v.press('<Esc>');
		v.press(':');
		assert.strictEqual(v.vim.context().mode, 'cmdline');
		v.press('<Esc>');
		v.keys('qa');
		assert.strictEqual(v.vim.context().recording, true);
		assert.ok(v.vim.status().includes('recording @a'));
	});
});

suite('DevHub Vim keymap is keybindings', () => {

	test('every default entry is an engine command (or a VS Code command in insert mode) with a when clause', () => {
		const ids = new Set(['devhubVim.motion', 'devhubVim.operator', 'devhubVim.textObjectPrefix', 'devhubVim.textObject', 'devhubVim.forceMotion', 'devhubVim.count', 'devhubVim.register', 'devhubVim.awaitChar', 'devhubVim.mode', 'devhubVim.action', 'devhubVim.mark', 'devhubVim.scroll', 'devhubVim.insert', 'devhubVim.run', 'devhubVim.repeat', 'devhubVim.cmdline', 'devhubVim.ex', 'devhubVim.escape']);
		const plainInInsert = new Set(['hideSuggestWidget', 'editor.action.inlineSuggest.hide', 'deleteLeft', 'editor.action.triggerParameterHints', 'editor.action.triggerSuggest', 'selectNextSuggestion', 'selectPrevSuggestion']);
		for (const b of DEFAULT_KEYBINDINGS) {
			if (b.when === VIM_WHEN.elsewhere) {
				// where no Vim buffer has the focus (a list, the side bar): `:`, tab pages, the jump list
				assert.ok(b.command.startsWith('devhubVim.tabpage.') || b.command === 'devhubVim.cmdline' || b.command.startsWith('workbench.action.navigate'), b.command);
				continue;
			}
			if (b.when === VIM_WHEN.comment) {
				// anywhere in a comment widget, a Vim editor or not: Esc is Vim's Esc (or nothing)
				assert.deepStrictEqual([b.key, b.command], ['escape', 'devhubVim.escape']);
				continue;
			}
			assert.ok(ids.has(b.command) || (plainInInsert.has(b.command) && b.when.includes('devhubVim.insert')), b.command);
			assert.ok(b.when.includes('devhubVim.active'), b.key);
			assert.ok(b.key.split(' ').length <= 3, b.key);
		}
		// no layout context key: the keys are the Apple JIS keys
		assert.ok(DEFAULT_KEYBINDINGS.every(b => !b.when.includes('usShiftedDigits')));
	});

	test('two entries for the same key never hold at once', () => {
		const contexts: Record<string, unknown>[] = [];
		const operators = ['delete', 'change', 'yank', 'indent', 'outdent', 'reindent', 'lowercase', 'uppercase', 'toggleCase', 'rot13', 'format', 'formatKeep', 'comment', 'fold'];
		for (const mode of ['normal', 'visual', 'visualLine', 'visualBlock', 'operatorPending', 'insert', 'replace', 'cmdline']) {
			const insert = mode === 'insert' || mode === 'replace';
			for (const acceptsMotion of insert || mode === 'cmdline' ? [false] : [true, false]) {
				for (const pendingOperator of mode === 'operatorPending' ? operators : ['']) {
					for (const hasCount of [true, false]) {
						for (const textObjectPending of acceptsMotion ? [''] : ['', 'inner']) {
							for (const recording of [true, false]) {
								for (const pending of [true, false]) {
									for (const suggestWidgetVisible of insert ? [true, false] : [false]) {
										contexts.push({
											'true': true, editorTextFocus: true, textInputFocus: true, 'devhubVim.active': true, 'devhubVim.mode': mode,
											'devhubVim.acceptsMotion': acceptsMotion, 'devhubVim.hasCount': hasCount, 'devhubVim.textObjectPending': textObjectPending,
											'devhubVim.recording': recording, 'devhubVim.pending': pending, 'devhubVim.pendingOperator': pendingOperator,
											'devhubVim.visual': mode.startsWith('visual'), 'devhubVim.insert': insert, 'devhubVim.awaitingChar': false, suggestWidgetVisible,
										});
									}
								}
							}
						}
					}
				}
			}
		}
		for (const ctx of contexts) {
			const seen = new Map<string, VimKeybinding>();
			for (const b of DEFAULT_KEYBINDINGS) {
				if (evaluateWhen(b.when, ctx)) {
					assert.ok(!seen.has(b.key), `${b.key}: ${JSON.stringify(seen.get(b.key)?.args)} and ${JSON.stringify(b.args)} in ${JSON.stringify(ctx)}`);
					seen.set(b.key, b);
				}
			}
		}
	});

	test('a remapped motion composes with operators, counts and visual mode', () => {
		const user: UserBinding[] = [
			{ key: 'w', command: '-devhubVim.motion' },
			{ key: 'm', command: 'devhubVim.motion', args: { motion: 'wordForward' }, when: VIM_WHEN.motion },
		];
		const v = (text: string, keys: string) => new Vim(text, user).keys(keys).state();
		assert.strictEqual(v('|foo bar baz', 'm'), 'foo |bar baz');
		assert.strictEqual(v('|foo bar baz', 'dm'), '|bar baz');
		assert.strictEqual(v('|foo bar baz', '2dm'), '|baz');
		assert.strictEqual(v('|foo bar baz', 'd2m'), '|baz');
		assert.strictEqual(v('|foo bar baz', 'vmd'), '|ar baz');
		assert.strictEqual(v('|foo bar', 'cmX<Esc>'), '|X bar');
		// `w` is unbound now: it does nothing (and types nothing)
		assert.strictEqual(v('|foo bar baz', 'w'), '|foo bar baz');
		// `w` still names the word text object: only the motion entry was removed
		assert.strictEqual(v('foo b|ar baz', 'diw'), 'foo | baz');
	});

	test('a plain (non-Vim) command can be bound; it does not compose', () => {
		const v = new Vim('|foo', [{ key: 'g d', command: 'editor.action.revealDefinition', when: VIM_WHEN.normal }]);
		v.keys('gd');
		assert.deepStrictEqual(v.host.commands.map(c => c.command), ['editor.action.revealDefinition']);
		v.keys('gg');
		assert.strictEqual(v.state(), '|foo');
	});

	test('a remapped text object key and a text object with an explicit kind', () => {
		const v = new Vim('x = "he|llo"', [
			{ key: 'q', command: 'devhubVim.textObject', args: { object: 'doubleQuote' }, when: VIM_WHEN.textObject },
			{ key: 'shift+q', command: 'devhubVim.textObject', args: { object: 'word', kind: 'inner' }, when: VIM_WHEN.motion + ' && devhubVim.mode == \'operatorPending\'' },
		]);
		v.keys('diq');
		assert.strictEqual(v.state(), 'x = "|"');
		const w = new Vim('foo b|ar baz', [{ key: 'shift+q', command: 'devhubVim.textObject', args: { object: 'word', kind: 'around' }, when: VIM_WHEN.motion + ' && devhubVim.mode == \'operatorPending\'' }]);
		w.keys('dQ');
		assert.strictEqual(w.state(), 'foo |baz');
	});

	test('awaitChar: f t r " and custom commands take the next character', () => {
		check('|a,b,c', 'df,', '|b,c');
		check('|abc', '"ayl"ap', 'a|abc');
		// a sneak-style binding of your own
		const v = new Vim('|a b c', [{ key: 's', command: 'devhubVim.awaitChar', args: { then: { command: 'devhubVim.motion', args: { motion: 'tillForward' } } }, when: VIM_WHEN.motion }]);
		v.keys('dsc');
		assert.strictEqual(v.state(), '|c');
		// a non-Vim command gets the character as `char`
		const n = new Vim('|a', [{ key: 'm', command: 'devhubVim.awaitChar', args: { then: { command: 'my.command', args: { x: 1 } } }, when: VIM_WHEN.normal }]);
		n.keys('mZ');
		assert.deepStrictEqual(n.host.commands.map(c => [c.command, c.args]), [['my.command', { x: 1, char: 'Z' }]]);
		assert.strictEqual(n.vim.pending, false);
		// Esc and keys that are not characters cancel the wait
		for (const k of ['<Esc>', '<CR>', '<BS>']) {
			const c = new Vim('|a,b').keys('df' + k);
			assert.strictEqual(c.vim.pending, false, k);
			assert.strictEqual(c.vim.awaitingChar, false, k);
			c.keys(',');
			assert.strictEqual(c.state(), '|a,b', k);
		}
	});

	test('. repeats commands, not keys: it survives a remap', () => {
		const v = new Vim('|a b c d', [{ key: 'm', command: 'devhubVim.motion', args: { motion: 'wordForward' }, when: VIM_WHEN.motion }]);
		v.keys('dm');
		v.bindings = Vim.withUser([{ key: 'm', command: '-devhubVim.motion' }, { key: 'w', command: '-devhubVim.motion' }]);
		v.keys('.');
		assert.strictEqual(v.state(), '|c d');
		// `.` itself can be any key
		const r = new Vim('|a b c d', [{ key: '.', command: '-devhubVim.action' }, { key: 'z', command: 'devhubVim.action', args: { action: 'repeat' }, when: VIM_WHEN.normal }]);
		r.keys('dwzz');
		assert.strictEqual(r.state(), '|d');
		// an awaited character is part of the change
		check('|xaxbxc', 'rzll.', 'za|zbxc');
	});

	test('macros record commands, typed text and ex lines', () => {
		let v = new Vim('|a\nb\nc').keys('qaA;<Esc>jq');
		assert.strictEqual(v.state(), 'a;\n|b\nc');
		v.keys('@a');
		assert.strictEqual(v.state(), 'a;\nb;\n|c');
		v.keys('@@');
		assert.strictEqual(v.state(), 'a;\nb;\nc|;');
		v = new Vim('|a b c d e f').keys('qqdwq2@q');
		assert.strictEqual(v.state(), '|d e f');
		// remapping keys after recording does not change the macro
		v.bindings = Vim.withUser([{ key: 'd', command: '-devhubVim.operator' }]);
		v.keys('@q');
		assert.strictEqual(v.state(), '|e f');
		v = new Vim('|x').keys('qw:w<CR>q@w');
		assert.deepStrictEqual(v.host.commands.map(c => c.command), ['workbench.action.files.save', 'workbench.action.files.save']);
		v = new Vim('|a,b,c').keys('qsf,xq@s');
		assert.strictEqual(v.state(), 'ab|c');
		assert.ok(new Vim('|a').keys('@z').vim.status().includes('empty'));
	});

	test('the symbol keys are the Apple JIS keys, by scan code', () => {
		const expected: Record<string, string> = {
			'^': '[Equal]', '$': 'shift+[Digit4]', '%': 'shift+[Digit5]', '#': 'shift+[Digit3]', '*': 'shift+[Quote]', ':': '[Quote]',
			'"': 'shift+[Digit2]', '\'': 'shift+[Digit7]', '@': '[BracketLeft]', '`': 'shift+[BracketLeft]', '&': 'shift+[Digit6]',
			'(': 'shift+[Digit8]', ')': 'shift+[Digit9]', '~': 'shift+[Equal]', '{': 'shift+[BracketRight]', '}': 'shift+[Backslash]',
			'[': '[BracketRight]', ']': '[Backslash]', ';': '[Semicolon]', '+': 'shift+[Semicolon]', '-': '[Minus]', '=': 'shift+[Minus]',
			',': '[Comma]', '.': '[Period]', '<': 'shift+[Comma]', '>': 'shift+[Period]', '/': '[Slash]', '?': 'shift+[Slash]', '_': '[IntlRo]', '|': 'shift+[IntlYen]',
		};
		const keys = new Set(DEFAULT_KEYBINDINGS.map(b => b.key));
		for (const [ch, key] of Object.entries(expected)) {
			assert.strictEqual(keyForChar(ch), key, ch);
			assert.ok(keys.has(key), `${ch}: ${key} is bound`);
		}
		for (const key of ['g shift+[Quote]', 'g shift+[Digit3]', '[BracketRight] shift+[Digit8]', '[Backslash] shift+[Digit9]', 'shift+[IntlRo]', 'ctrl+[BracketRight]', 'ctrl+[Backslash]']) {
			assert.ok(keys.has(key), key);
		}
		// the US notation of a symbol is gone (it means another character on JIS)
		for (const key of ['shift+6', 'shift+8', 'shift+;', '[', 'g shift+8', '[ shift+9', 'ctrl+[', 'shift+\'']) {
			assert.ok(!keys.has(key), key);
		}
		assert.deepStrictEqual(jisKeys('g shift+8'), ['g shift+[Quote]']);
		assert.deepStrictEqual(jisKeys('shift+-'), ['[IntlRo]', 'shift+[IntlRo]']);
		assert.deepStrictEqual(jisKeys('ctrl+r'), ['ctrl+r']);
	});

	test('the symbol commands work, pressed on the JIS keys', () => {
		const jis = (text: string, keys: string) => new Vim(text).keys(keys);
		assert.strictEqual(jis('ab  |c', '^').state(), '|ab  c');
		assert.strictEqual(jis('|ab c', '$').state(), 'ab |c');
		assert.strictEqual(jis('|abc', '"ayl"ap').state(), 'a|abc');
		assert.strictEqual(jis('|a b c', 'qqdwq@q').state(), '|c');
		assert.strictEqual(jis('f(a, |b)', 'di(').state(), 'f(|)');
		assert.strictEqual(jis('f(a, |b)', 'di)').state(), 'f(|)');
		assert.strictEqual(jis('|foo bar foo', '*').state(), 'foo bar |foo');
		assert.strictEqual(jis('|(a)', '%').state(), '(a|)');
		assert.strictEqual(jis('|a\nb', '_').state(), '|a\nb');
	});
});

suite('DevHub Vim: the editor\'s typing keys are insert-mode keys', () => {

	function ctx(mode: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
		const typing = mode === 'insert' || mode === 'replace';
		return {
			'true': true, editorTextFocus: true, textInputFocus: true, 'devhubVim.active': true, 'devhubVim.mode': mode,
			'devhubVim.acceptsMotion': !typing && mode !== 'cmdline' && mode !== 'nav', 'devhubVim.visual': mode.startsWith('visual'), 'devhubVim.insert': typing,
			'devhubVim.textObjectPending': '', 'devhubVim.pending': mode === 'operatorPending', 'devhubVim.awaitingChar': false, ...extra,
		};
	}

	test('they apply without Vim, in insert and replace mode, and nowhere else', () => {
		const keys = (c: Record<string, unknown>) => EDITOR_TYPING_KEYS.filter(b => evaluateWhen(b.when, c)).map(b => b.key);
		const all = EDITOR_TYPING_KEYS.map(b => b.key);
		assert.deepStrictEqual(keys({ editorTextFocus: true, textInputFocus: true }), all);
		assert.deepStrictEqual(keys({ editorTextFocus: true, textInputFocus: true, 'devhubVim.active': false, 'devhubVim.mode': 'insert' }), all);
		assert.deepStrictEqual(keys(ctx('insert')), all);
		assert.deepStrictEqual(keys(ctx('replace')), all);
		for (const mode of ['normal', 'visual', 'visualLine', 'visualBlock', 'operatorPending', 'cmdline', 'nav']) {
			assert.deepStrictEqual(keys(ctx(mode)), [], mode);
		}
		assert.deepStrictEqual(keys(ctx('operatorPending', { 'devhubVim.acceptsMotion': false, 'devhubVim.textObjectPending': 'inner' })), []);
	});

	test('so outside insert mode <BS> <Del> <Tab> <S-Tab> are Vim keys: Vim\'s binding or nothing, no weight needed against the editor', () => {
		assert.strictEqual(run('ab|c', '<BS>').host.state(), 'a|bc'); // h, as 'whichwrap' b
		assert.strictEqual(run('ab|c', '<Del>').host.state(), 'a|b');
		let v = new Vim('a|bc');
		v.keys('<S-Tab>');
		assert.strictEqual(v.state(), 'a|bc');
		assert.deepStrictEqual(v.host.commands, []);
		// <Tab> after an operator, after `di`, in visual mode: nothing happens, and the operator is cancelled
		v = new Vim('a|bc');
		v.keys('v<Tab>');
		assert.strictEqual(v.vim.mode, 'visual');
		assert.deepStrictEqual(v.host.commands, []);
		for (const keys of ['d<Tab>', 'di<Tab>', 'v<Tab><Esc>']) {
			v = new Vim('a|bc');
			v.keys(keys);
			assert.strictEqual(v.state(), 'a|bc', keys);
			assert.deepStrictEqual(v.host.commands, [], keys);
			assert.strictEqual(v.vim.context().pendingOperator, '', keys);
			assert.strictEqual(v.vim.pending, false, keys);
		}
	});

	test('<Tab> and <S-Tab> are bound in every mode the editor\'s Tab does not apply to', () => {
		for (const [mode, extra] of [['normal', {}], ['visual', {}], ['visualLine', {}], ['visualBlock', {}], ['operatorPending', {}],
			['operatorPending', { 'devhubVim.acceptsMotion': false, 'devhubVim.textObjectPending': 'inner' }]] as [string, Record<string, unknown>][]) {
			for (const key of ['tab', 'shift+tab']) {
				assert.ok(DEFAULT_KEYBINDINGS.some(b => b.key === key && evaluateWhen(b.when, ctx(mode, extra))), `${key} in ${mode} ${JSON.stringify(extra)}`);
			}
		}
		for (const mode of ['insert', 'replace', 'nav']) {
			assert.ok(!DEFAULT_KEYBINDINGS.some(b => (b.key === 'tab' || b.key === 'shift+tab') && evaluateWhen(b.when, ctx(mode))), mode);
		}
	});
});

suite('DevHub Vim: a printable key is a Vim key only in a Vim editor outside insert mode', () => {

	const ALL = DEFAULT_KEYBINDINGS;
	const JIS_CHORDS = new Set(Object.values(JIS_KEYS).flat());

	/** The first chord types a character: a JIS symbol key, or no Ctrl / Alt / Cmd and not a named key (Esc, Tab, arrows, F-keys, ...). */
	function printableFirst(key: string): boolean {
		const chord = key.split(' ')[0];
		const first = chord.replace(/^shift\+/, '');
		return JIS_CHORDS.has(chord) || (!/(^|\+)(ctrl|alt|cmd|meta|win)\+/.test(chord) && (first.length === 1 || first === 'space'));
	}

	function vimCtx(mode: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
		const typing = mode === 'insert' || mode === 'replace';
		return {
			'true': true, editorTextFocus: true, textInputFocus: true, 'devhubVim.active': true, 'devhubVim.mode': mode,
			'devhubVim.acceptsMotion': !typing && mode !== 'cmdline' && mode !== 'nav', 'devhubVim.visual': mode.startsWith('visual'), 'devhubVim.insert': typing,
			'devhubVim.textObjectPending': '', 'devhubVim.pending': false, 'devhubVim.awaitingChar': false, suggestWidgetVisible: false, ...extra,
		};
	}

	test('none holds in insert / replace / cmdline / nav mode, or with no Vim editor focused', () => {
		const contexts: [string, Record<string, unknown>][] = [];
		for (const mode of ['insert', 'replace', 'cmdline', 'nav']) {
			for (const awaitingChar of [false, true]) {
				for (const suggestWidgetVisible of [false, true]) {
					contexts.push([mode, vimCtx(mode, { 'devhubVim.awaitingChar': awaitingChar, suggestWidgetVisible })]);
				}
			}
		}
		// a plain input, the terminal, a list, a search box: no Vim editor has the focus
		for (const mode of ['insert', '', 'nav']) {
			contexts.push([`no Vim editor, mode '${mode}'`, { 'true': true, textInputFocus: mode === 'insert', 'devhubVim.active': false, 'devhubVim.mode': mode }]);
			contexts.push([`a plain editor, mode '${mode}'`, { 'true': true, editorTextFocus: true, textInputFocus: true, 'devhubVim.active': false, 'devhubVim.mode': mode }]);
		}
		const printable = ALL.filter(b => printableFirst(b.key));
		assert.ok(printable.some(b => b.key === 'g shift+[Quote]') && printable.some(b => b.key === '[Quote]') && printable.some(b => b.key === 'j'));
		for (const [what, c] of contexts) {
			const holding = printable.filter(b => evaluateWhen(b.when, c)).map(b => `${b.key} -> ${b.command}`);
			assert.deepStrictEqual(holding, [], `${what} ${JSON.stringify(c)}`);
		}
	});

	test('a simple widget (SCM commit message, debug console, chat, comment input) has the whole keymap: VS Code sets no editorTextFocus there', () => {
		// CodeEditorWidget: editorTextFocus = hasTextFocus && !isSimpleWidget, textInputFocus = hasTextFocus
		for (const mode of ['normal', 'visual', 'visualLine', 'operatorPending', 'insert', 'replace']) {
			const full = vimCtx(mode);
			const simple = { ...full, editorTextFocus: false, editorFocus: false };
			const inFull = DEFAULT_KEYBINDINGS.filter(b => evaluateWhen(b.when, full)).map(b => `${b.key} -> ${b.command}`);
			const inSimple = DEFAULT_KEYBINDINGS.filter(b => evaluateWhen(b.when, simple)).map(b => `${b.key} -> ${b.command}`);
			assert.ok(inFull.length > 0, mode);
			assert.deepStrictEqual(inSimple, inFull, mode);
		}
		const normal = { ...vimCtx('normal'), editorTextFocus: false };
		assert.deepStrictEqual(DEFAULT_KEYBINDINGS.filter(b => b.key === 'i' && evaluateWhen(b.when, normal)).map(b => [b.command, b.args]), [['devhubVim.mode', { to: 'insert', at: 'before' }]]);
		for (const w of Object.values(VIM_WHEN)) {
			assert.ok(!w.includes('editorTextFocus'), w);
		}
	});

});

suite('DevHub Vim: one Esc leaves insert mode, whatever editor widget shows', () => {

	/** VS Code 1.141's editor widgets that bind Esc while the editor has text focus: [command, weight, when]. */
	const UPSTREAM: [string, number, string][] = [
		['hideSuggestWidget', 190, 'suggestWidgetVisible && textInputFocus'],
		['editor.action.inlineSuggest.hide', 190, 'editorTextFocus && (inlineSuggestionVisible || inlineEditIsVisible)'],
		['cancelLinkedEditingInput', 199, 'editorTextFocus && LinkedEditingInputVisible'],
		['closeParameterHints', 175, 'editorFocus && parameterHintsVisible'],
		['closeMarkersNavigation', 150, 'editorFocus && markersNavigationVisible'],
		['leaveSnippet', 130, 'editorTextFocus && inSnippetMode'],
		['leaveEditorMessage', 130, 'editorFocus && messageVisible'],
		['closeFindWidget', 105, 'editorFocus && findWidgetVisible'],
		['editor.cancelOperation', 100, 'editorTextFocus && cancellableOperation'],
		['closeReferenceSearch', 250, 'inPeekEditor && !config.editor.stablePeek'],
		['closeReferenceSearch', 250, 'referenceSearchVisible && !config.editor.stablePeek && editorTextFocus'],
		// a comment widget's Hide Comment (comments/browser/commentsEditorContribution.ts)
		['workbench.action.hideComment', 100, 'commentEditorFocused || commentFocused'],
	];
	const WIDGETS = ['suggestWidgetVisible', 'inlineSuggestionVisible', 'inlineEditIsVisible', 'LinkedEditingInputVisible', 'parameterHintsVisible', 'markersNavigationVisible', 'inSnippetMode', 'messageVisible', 'findWidgetVisible', 'cancellableOperation', 'inPeekEditor', 'referenceSearchVisible'];

	function ctx(mode: string, widget: string | undefined): Record<string, unknown> {
		const typing = mode === 'insert' || mode === 'replace';
		return {
			'true': true, editorTextFocus: true, editorFocus: true, textInputFocus: true, 'devhubVim.active': true, 'devhubVim.mode': mode,
			'devhubVim.acceptsMotion': !typing, 'devhubVim.visual': mode.startsWith('visual'), 'devhubVim.insert': typing,
			'devhubVim.textObjectPending': '', 'devhubVim.pending': false, 'devhubVim.awaitingChar': false,
			...(widget ? { [widget]: true } : {}),
		};
	}

	/** The binding the dispatcher runs for `key`: the highest weight whose when holds (later registration on a tie). */
	function winner(key: string, c: Record<string, unknown>): string | undefined {
		const vim = DEFAULT_KEYBINDINGS.filter(b => b.key === key).map(b => [b.command, VIM_WEIGHTS[b.weight ?? 'default'], b.when] as [string, number, string]);
		// VS Code's on Windows / Linux: Outdent Lines on CTRL-[, Copy on CTRL-C
		const others: Record<string, [string, number, string][]> = {
			'escape': UPSTREAM,
			'ctrl+[BracketRight]': [['editor.action.outdentLines', 100, 'editorTextFocus']],
			'ctrl+c': [['editor.action.clipboardCopyAction', 100, 'textInputFocus']],
		};
		const all = [...(others[key] ?? []), ...vim].filter(([, , when]) => evaluateWhen(when, c));
		all.sort((a, b) => a[1] - b[1]);
		return all.at(-1)?.[0];
	}

	test('in insert and replace mode Esc, CTRL-[ and CTRL-C are Vim\'s over every widget\'s Esc', () => {
		for (const mode of ['insert', 'replace']) {
			for (const widget of [undefined, ...WIDGETS]) {
				for (const key of ['escape', 'ctrl+[BracketRight]', 'ctrl+c']) {
					assert.strictEqual(winner(key, ctx(mode, widget)), 'devhubVim.escape', `${key} in ${mode} with ${widget}`);
				}
			}
		}
	});

	test('outside insert mode a widget\'s Esc comes first, as before', () => {
		for (const mode of ['normal', 'visual', 'operatorPending']) {
			assert.strictEqual(winner('escape', ctx(mode, undefined)), 'devhubVim.escape', mode);
			assert.strictEqual(winner('ctrl+[BracketRight]', ctx(mode, undefined)), 'devhubVim.escape', `ctrl+[ in ${mode}`);
			for (const widget of WIDGETS) {
				assert.notStrictEqual(winner('escape', ctx(mode, widget)), 'devhubVim.escape', `${mode} with ${widget}`);
			}
		}
	});

	test('in a comment widget Esc is Vim\'s, never Hide Comment: any number of them land in normal mode and the widget stays', () => {
		for (const mode of ['normal', 'visual', 'operatorPending', 'insert', 'replace']) {
			for (const focus of ['commentEditorFocused', 'commentFocused']) {
				const c = { ...ctx(mode, undefined), editorTextFocus: false, [focus]: true };
				assert.strictEqual(winner('escape', c), 'devhubVim.escape', `${mode} in ${focus}`);
				// an editor widget in the comment input still closes first outside insert mode
				for (const widget of WIDGETS) {
					assert.notStrictEqual(winner('escape', { ...c, [widget]: true }), 'workbench.action.hideComment', `${mode} with ${widget}`);
				}
			}
		}
		// on a comment or a button of the widget (no Vim editor has the focus) too
		assert.strictEqual(winner('escape', { 'true': true, commentFocused: true }), 'devhubVim.escape');
		// and in nav mode, whose key the window keydown resolves the same way
		assert.strictEqual(winner('escape', { ...ctx('normal', undefined), 'devhubVim.mode': 'nav', commentEditorFocused: true }), 'devhubVim.escape');
		const comment = DEFAULT_KEYBINDINGS.filter(b => b.key === 'escape' && b.weight === 'commentEscape');
		assert.ok(comment.length === 1 && VIM_WEIGHTS.commentEscape > 100 && VIM_WEIGHTS.commentEscape < 105);
	});

	test('leaving insert closes the transient widgets, not the find widget, a peek or a snippet session', () => {
		const closes = (widget: string) => INSERT_ESCAPE_DISMISSES.filter(d => evaluateWhen(d.when, { [widget]: true })).map(d => d.command);
		assert.deepStrictEqual(closes('suggestWidgetVisible'), ['hideSuggestWidget']);
		assert.deepStrictEqual(closes('inlineSuggestionVisible'), ['editor.action.inlineSuggest.hide']);
		assert.deepStrictEqual(closes('inlineEditIsVisible'), ['editor.action.inlineSuggest.hide']);
		assert.deepStrictEqual(closes('parameterHintsVisible'), ['closeParameterHints']);
		assert.deepStrictEqual(closes('messageVisible'), ['leaveEditorMessage']);
		assert.deepStrictEqual(closes('LinkedEditingInputVisible'), ['cancelLinkedEditingInput']);
		for (const widget of ['findWidgetVisible', 'inPeekEditor', 'referenceSearchVisible', 'inSnippetMode', 'markersNavigationVisible']) {
			assert.deepStrictEqual(closes(widget), [], widget);
		}
	});

	test('CTRL-E closes the completion menu and CTRL-] the inline suggestion, staying in insert mode; otherwise they are what they were', () => {
		const insert = (extra: Record<string, unknown>) => ({ ...ctx('insert', undefined), ...extra });
		const vimFor = (key: string, c: Record<string, unknown>) => DEFAULT_KEYBINDINGS.filter(b => b.key === key && evaluateWhen(b.when, c)).map(b => [b.command, b.args]);
		assert.deepStrictEqual(vimFor('ctrl+e', insert({ suggestWidgetVisible: true })), [['hideSuggestWidget', undefined]]);
		assert.deepStrictEqual(vimFor('ctrl+e', insert({})), [['devhubVim.insert', { action: 'copyFromBelow' }]]);
		for (const k of ['inlineSuggestionVisible', 'inlineEditIsVisible']) {
			assert.deepStrictEqual(vimFor('ctrl+[Backslash]', insert({ [k]: true })), [['editor.action.inlineSuggest.hide', undefined]], k);
		}
		// no Vim entry: VS Code's own CTRL-] (indent lines) applies, as before
		assert.deepStrictEqual(vimFor('ctrl+[Backslash]', insert({})), []);
		// and they outrank VS Code's defaults on those keys where they apply (editor.action.indentLines: EditorContrib)
		for (const b of DEFAULT_KEYBINDINGS.filter(b => b.command === 'hideSuggestWidget' || b.command === 'editor.action.inlineSuggest.hide')) {
			assert.ok(VIM_WEIGHTS[b.weight ?? 'default'] > 100, b.key);
		}
		// in normal mode CTRL-E is still the scroll and CTRL-] the definition
		assert.deepStrictEqual(vimFor('ctrl+e', { ...ctx('normal', undefined), suggestWidgetVisible: true }).map(([c]) => c), ['devhubVim.scroll']);
		assert.deepStrictEqual(vimFor('ctrl+[Backslash]', { ...ctx('normal', undefined), inlineSuggestionVisible: true }).map(([c]) => c), ['devhubVim.run']);
	});
});

suite('DevHub Vim ex commands', () => {

	/** What the parser read of each command of a line. */
	const parse = (line: string, registry = BUILTIN_EX_REGISTRY) => parseExCommands(line, registry).map(p => ({
		range: p.range, ...(p.semicolon ? { semicolon: true } : {}), name: p.name, ...(p.command !== undefined ? { command: p.command } : {}), bang: p.bang, args: p.args.trim(), ...(p.error ? { error: p.error } : {}),
	}));

	test('one parser: range, name, !, the argument as the command takes it, and the next command after |', () => {
		const reg = new ExRegistry({ Sort: { command: 'x', bang: true, range: 'range', nargs: '*' }, Fmt: 'y' });
		assert.deepStrictEqual(parse('w'), [{ range: undefined, name: 'w', command: 'write', bang: false, args: '' }]);
		assert.deepStrictEqual(parse(':q!'), [{ range: undefined, name: 'q', command: 'quit', bang: true, args: '' }]);
		assert.deepStrictEqual(parse('\'<,\'>Sort! u  x', reg), [{ range: ['\'<', '\'>'], name: 'Sort', command: 'Sort', bang: true, args: 'u  x' }]);
		assert.deepStrictEqual(parse('12'), [{ range: ['12', '12'], name: '', bang: false, args: '' }]);
		assert.deepStrictEqual(parse('2;+3d'), [{ range: ['2', '+3'], semicolon: true, name: 'd', command: 'delete', bang: false, args: '' }]);
		// `:d3`: a built-in's name is letters; a user's may have digits
		assert.deepStrictEqual(parse('d3'), [{ range: undefined, name: 'd', command: 'delete', bang: false, args: '3' }]);
		assert.deepStrictEqual(parse('ka'), [{ range: undefined, name: 'k', command: 'mark', bang: false, args: 'a' }]);
		// | between commands; `\|` is a | in the argument
		assert.deepStrictEqual(parse('s/a\\|b/c/ | noh'), [
			{ range: undefined, name: 's', command: 'substitute', bang: false, args: '/a|b/c/' },
			{ range: undefined, name: 'noh', command: 'nohlsearch', bang: false, args: '' },
		]);
		assert.deepStrictEqual(parse('3 | Fmt', reg).map(p => p.name), ['', 'Fmt']);
		// :g and :normal take | as their argument
		assert.deepStrictEqual(parse('g/x/s/a/b/ | d').map(p => [p.command, p.args]), [['global', '/x/s/a/b/ | d']]);
		assert.deepStrictEqual(parse('norm! A|x').map(p => [p.command, p.bang, p.args]), [['normal', true, 'A|x']]);
		// what a command does not take is Vim's error
		assert.strictEqual(parse('noh!')[0].error, 'E477: No ! allowed');
		assert.strictEqual(parse('3noh')[0].error, 'E481: No range allowed');
		assert.strictEqual(parse('noh x')[0].error, 'E488: Trailing characters: x');
		assert.strictEqual(parse('Fmt x', reg)[0].error, 'E488: Trailing characters: x');
		assert.strictEqual(parse('frobnicate')[0].error, 'E492: Not an editor command: frobnicate');
	});

	test('names: Vim\'s abbreviations for the built-ins, a unique prefix for the user\'s', () => {
		const reg = new ExRegistry({ Sort: 'a', Split: 'b', Format: 'c', Fmt: 'd' });
		const name = (typed: string) => { const r = reg.lookup(typed); return 'error' in r ? r.error : r.name; };
		assert.strictEqual(name('So'), 'Sort');
		assert.strictEqual(name('Sp'), 'Split');
		assert.strictEqual(name('S'), 'E464: Ambiguous use of user-defined command: S');
		assert.strictEqual(name('Fo'), 'Format');
		// a full name wins over the longer names it is a prefix of
		assert.strictEqual(name('Fmt'), 'Fmt');
		assert.strictEqual(name('X'), 'E492: Not an editor command: X');
		assert.strictEqual(name('sp'), 'split');
		assert.strictEqual(name('spl'), 'split');
		assert.strictEqual(name('s'), 'substitute');
	});

	test('a spec is checked: names, keys, values; the old forms say what they became', () => {
		const reg = new ExRegistry({
			Sort: 'editor.action.sortLinesAscending', lower: 'x.y', w: { command: 'my.save' }, Bad: 42, Old: ['a', 'b'],
			Older: { run: 'a', bang: 'b' }, Typo: { command: 'a', narg: '*' }, Both: { command: 'a', commands: ['b'] },
			Count: { command: 'a', range: 'count', defaultRange: '%' }, Fine: { commands: ['a', { command: 'b', args: '${args}', ifBang: true }], nargs: '?', bang: true },
		});
		assert.deepStrictEqual([...reg.errors.keys()].sort(), ['Bad', 'Both', 'Count', 'Old', 'Older', 'Typo', 'lower']);
		assert.ok(reg.errors.get('lower')!.startsWith('E183'));
		assert.ok(reg.errors.get('Old')!.includes('"commands"'));
		assert.ok(reg.errors.get('Older')!.includes('ifBang'));
		assert.ok(reg.errors.get('Typo')!.includes('"narg"'));
		assert.strictEqual(validateExCommandSpec({ command: 'a', complete: 'command:my.list' }) !== undefined && typeof validateExCommandSpec({ command: 'a', complete: 'command:my.list' }), 'object');
		assert.strictEqual(typeof validateExCommandSpec({ command: 'a', complete: 'files' }), 'string');
		// a broken entry says why when it is used
		const shared = new VimSharedState();
		shared.setUserExCommands({ lower: 'x.y', Old: ['a'] });
		for (const line of ['lower', 'Old']) {
			const v = new Vim('|a', [], shared).keys(`:${line}<CR>`);
			assert.deepStrictEqual(v.host.commands, []);
			assert.ok(v.vim.status().includes(line === 'lower' ? 'E183' : 'commands'), v.vim.status());
		}
		// an override takes any name the built-in answers to
		const w = new VimSharedState();
		w.setUserExCommands({ w: { command: 'my.save' } });
		assert.deepStrictEqual(new Vim('|a', [], w).keys(':write<CR>').host.commands.map(c => c.command), ['my.save']);
	});

	test('args, range, bang, count and register reach the command', async () => {
		const shared = new VimSharedState();
		shared.setUserExCommands({
			Grep: { command: 'workbench.action.findInFiles', args: { query: '${args}', words: '${argList}', isRegex: '${bang}', range: '${range}', label: 'L${line1}-${line2}${bang}' }, range: 'range', bang: true },
			Two: { commands: [{ command: 'first' }, { command: 'second', args: ['${args}'] }] },
			Del: { commands: [{ command: 'del', args: { force: false }, ifBang: false }, { command: 'del', args: { force: true }, ifBang: true }], bang: true },
			Line: { command: 'devhubVim.motion', args: { motion: 'fileEnd' } },
			All: { command: 'all', args: ['${line1}', '${line2}', '${range}'], range: 'range', defaultRange: '%' },
			Times: { command: 'times', args: '${count}', range: 'count', defaultRange: 1 },
			Reg: { command: 'reg', args: ['${register}', '${args}'], register: true, nargs: '*' },
			One: { command: 'one', args: '${argList}', nargs: '1' },
		});
		let v = new Vim('|a\nb\nc\nd\ne', [], shared).keys(':3,4Grep! foo bar<CR>');
		assert.deepStrictEqual(v.host.commands[0].args, { query: 'foo bar', words: ['foo', 'bar'], isRegex: true, range: { start: 3, end: 4 }, label: 'L3-4!' });
		// the range is selected while the command runs, then the caret is back on its first line
		assert.deepStrictEqual(v.host.commands[0].selection, { start: { line: 2, col: 0 }, end: { line: 3, col: 1 } });
		await flush();
		assert.strictEqual(v.state(), 'a\nb\n|c\nd\ne');
		v = new Vim('a\n|b\nc', [], shared).keys(':Grep x<CR>');
		assert.deepStrictEqual(v.host.commands[0].args, { query: 'x', words: ['x'], isRegex: false, range: null, label: 'L2-2' });
		v = new Vim('|a', [], shared).keys(':Two y<CR>');
		await flush();
		assert.deepStrictEqual(v.host.commands.map(c => [c.command, c.args]), [['first', undefined], ['second', ['y']]]);
		v = new Vim('|a', [], shared).keys(':Del<CR>');
		v.keys(':Del!<CR>');
		await flush();
		assert.deepStrictEqual(v.host.commands.map(c => c.args), [{ force: false }, { force: true }]);
		// an engine command in a spec runs in the engine
		v = new Vim('|a\nb\nc', [], shared).keys(':Line<CR>');
		assert.strictEqual(v.state(), 'a\nb\n|c');
		// defaultRange: the whole file without a typed range (and no ${range})
		v = new Vim('a\n|b\nc', [], shared).keys(':All<CR>:2All<CR>');
		await flush();
		assert.deepStrictEqual(v.host.commands.map(c => c.args), [[1, 3, null], [2, 2, { start: 2, end: 2 }]]);
		// a count before the name or as the first argument, its default without one
		v = new Vim('|a', [], shared).keys(':Times<CR>:3Times<CR>:Times 7<CR>');
		await flush();
		assert.deepStrictEqual(v.host.commands.map(c => c.args), [1, 3, 7]);
		// a register name first; nargs 1 keeps the blanks
		v = new Vim('|a', [], shared).keys(':Reg x a b<CR>:Reg 1 2<CR>:One a  b<CR>');
		await flush();
		assert.deepStrictEqual(v.host.commands.map(c => c.args), [['x', 'a b'], ['', '1 2'], ['a  b']]);
		// E471 without the argument nargs 1 needs; E481 for a range a command does not take
		v = new Vim('|a', [], shared).keys(':One<CR>');
		assert.ok(v.vim.status().includes('E471'), v.vim.status());
		v = new Vim('|a', [], shared).keys(':2Two<CR>');
		assert.ok(v.vim.status().includes('E481'), v.vim.status());
		assert.deepStrictEqual(v.host.commands, []);
	});

	test(':e :sp :vs :new :vne :tabe :tabnew pass their file to devhubVim.edit / devhubVim.open, and an override can too', async () => {
		const run = async (line: string, shared?: VimSharedState) => {
			const v = new Vim('|a', [], shared).keys(`:${line}<CR>`);
			await flush();
			return v.host.commands.map(c => c.args === undefined ? [c.command] : [c.command, c.args]);
		};
		assert.deepStrictEqual(await run('e src/main.ts'), [['devhubVim.edit', { file: 'src/main.ts', bang: false }]]);
		assert.deepStrictEqual(await run('edit'), [['devhubVim.edit', { file: '', bang: false }]]);
		assert.deepStrictEqual(await run('e!'), [['devhubVim.edit', { file: '', bang: true }]]);
		assert.deepStrictEqual(await run('sp %:h/x.ts'), [['workbench.action.splitEditorUp'], ['devhubVim.open', { file: '%:h/x.ts', replace: true }]]);
		assert.deepStrictEqual(await run('vs'), [['workbench.action.splitEditorLeft'], ['devhubVim.open', { file: '', replace: true }]]);
		assert.deepStrictEqual(await run('new n.txt'), [['workbench.action.splitEditorUp'], ['devhubVim.open', { file: 'n.txt', replace: true, untitled: true }]]);
		assert.deepStrictEqual(await run('vne'), [['workbench.action.splitEditorLeft'], ['devhubVim.open', { file: '', replace: true, untitled: true }]]);
		// :tabnew / :tabe: the new page opens its empty buffer itself when there is no file; devhubVim.open the file
		assert.deepStrictEqual(await run('tabe ~/notes.md'), [['devhubVim.tabpage.new', { file: '~/notes.md' }], ['devhubVim.open', { file: '~/notes.md' }]]);
		assert.deepStrictEqual(await run('tabnew'), [['devhubVim.tabpage.new', { file: '' }], ['devhubVim.open', { file: '' }]]);
		// 'splitbelow' as an override (the user's settings): the split of their choice, the file passed on with ${args};
		// the built-in's nargs and completion are kept
		const shared = new VimSharedState();
		shared.setUserExCommands({ split: { commands: ['workbench.action.splitEditorDown', { command: 'devhubVim.open', args: { file: '${args}', replace: true } }] } });
		assert.deepStrictEqual(await run('sp x', shared), [['workbench.action.splitEditorDown'], ['devhubVim.open', { file: 'x', replace: true }]]);
		const split = shared.registry.lookup('sp');
		assert.ok(!('error' in split) && split.spec.complete === 'file' && split.spec.nargs === '?');
		// what the command answers with (E37 ...) is the message
		const e = new Vim('|a');
		e.host.executeCommand = async () => { throw new Error('E37: No write since last change (add ! to override)'); };
		e.keys(':e<CR>');
		await flush();
		assert.ok(e.vim.status().includes('E37'), e.vim.status());
	});

	test(':\'<,\'> from visual mode passes the selected lines', () => {
		const shared = new VimSharedState();
		shared.setUserExCommands({ Sort: { command: 'editor.action.sortLinesAscending', args: { range: '${range}' }, range: 'range' } });
		const v = new Vim('x\n|c\nb\na\ny', [], shared).keys('Vjj:');
		assert.strictEqual(v.promptText(), '\'<,\'>');
		v.keys('Sort<CR>');
		assert.deepStrictEqual(v.host.commands[0].args, { range: { start: 2, end: 4 } });
		assert.deepStrictEqual(v.host.commands[0].selection, { start: { line: 1, col: 0 }, end: { line: 3, col: 1 } });
		assert.strictEqual(v.vim.mode, 'normal');
	});

	test('substitution leaves other strings and unknown placeholders alone', () => {
		const inv = { args: 'a b', argList: ['a', 'b'], bang: false, range: undefined, line1: 7, line2: 7, count: undefined, register: '' };
		assert.deepStrictEqual(substituteExArgs({ n: 1, s: 'x', u: '${nope}', l: ['${line1}', '${bang}x', '${count}'] }, inv), { n: 1, s: 'x', u: '${nope}', l: [7, 'x', null] });
	});

	test('Tab completes ex command names in the prompt', () => {
		const shared = new VimSharedState();
		shared.setUserExCommands({ Sort: 'a', Split: 'b' });
		// without the workbench's completion menu (fed keys, here) Tab puts the matches in the line one after another
		const v = new Vim('|a', [], shared).keys(':S<Tab>');
		assert.strictEqual(v.promptText(), 'Sort');
		v.keys('<Tab>');
		assert.strictEqual(v.promptText(), 'Split');
		v.keys('<S-Tab>');
		assert.strictEqual(v.promptText(), 'Sort');
		v.keys('<Tab><CR>');
		assert.deepStrictEqual(v.host.commands.map(c => c.command), ['b']);
		const r = new Vim('|a', [], shared).keys(':');
		for (const ch of '\'<,\'>So') {
			r.press(ch);
		}
		r.press('<Tab>');
		assert.strictEqual(r.promptText(), '\'<,\'>Sort');
	});

	/** A host whose `slow.*` commands finish when the test says, and edit the buffer then. */
	function slowHost(v: Vim): { finish: () => Promise<void>; log: string[] } {
		const pending: (() => void)[] = [];
		const log: string[] = [];
		const run = v.host.executeCommand.bind(v.host);
		v.host.executeCommand = (command: string, args: unknown) => {
			if (!command.startsWith('slow.')) {
				log.push(command);
				return run(command, args);
			}
			log.push(`${command} start`);
			return new Promise(resolve => pending.push(() => {
				log.push(`${command} end`);
				v.host.lines[0] += command.slice(5);
				resolve(undefined);
			}));
		};
		return {
			log,
			finish: async () => {
				while (pending.length) {
					pending.shift()!();
					await flush();
				}
			},
		};
	}

	test('what comes after a VS Code command waits for it: the next command after |, each line of :g, the rest of a macro, :normal\'s keys', async () => {
		const shared = new VimSharedState();
		shared.setUserExCommands({ Slow: 'slow.S', Mark: 'mark' });
		// `|`: the second command after the first has finished, and none after one that failed
		let v = new Vim('|x\ny', [], shared);
		let h = slowHost(v);
		v.keys(':Slow | %s/y/Y/ | Mark<CR>');
		assert.deepStrictEqual(h.log, ['slow.S start']);
		assert.strictEqual(v.state(), '|x\ny');
		await h.finish();
		assert.deepStrictEqual(h.log, ['slow.S start', 'slow.S end', 'mark']);
		assert.strictEqual(v.host.lines.join('\n'), 'xS\nY');
		v = new Vim('|x', [], shared);
		h = slowHost(v);
		v.keys(':s/nope/a/ | Mark<CR>');
		await flush();
		assert.deepStrictEqual(h.log, []);
		assert.ok(v.vim.status().includes('E486'), v.vim.status());
		// :g: each line's command after the one before has finished
		v = new Vim('|a1\nb\na2', [], shared);
		h = slowHost(v);
		v.keys(':g/a/Slow<CR>');
		assert.deepStrictEqual(h.log, ['slow.S start']);
		await h.finish();
		assert.deepStrictEqual(h.log, ['slow.S start', 'slow.S end', 'slow.S start', 'slow.S end']);
		assert.strictEqual(v.host.lines[0], 'a1SS');
		// a macro: the steps after an ex line wait for its command
		v = new Vim('|ab\ncd', [], shared);
		h = slowHost(v);
		v.keys('qq:Slow<CR>jxq');
		await h.finish();
		v.keys('gg@q');
		assert.strictEqual(v.host.lines.join('\n'), 'abS\nd');
		await h.finish();
		assert.strictEqual(v.host.lines.join('\n'), 'abSS\n');
		// :normal: the keys after one bound to a VS Code command wait for it (`gcc` is VS Code's toggle comment)
		v = new Vim('|a\nb', [], shared);
		v.host.executeCommand = (() => {
			const run = v.host.executeCommand.bind(v.host);
			return (command: string, args: unknown) => new Promise<unknown>(resolve => setTimeout(() => resolve(run(command, args)), 5));
		})();
		v.keys(':normal gccjx<CR>');
		assert.strictEqual(v.host.lines.join('\n'), 'a\nb');
		await new Promise(resolve => setTimeout(resolve, 30));
		assert.strictEqual(v.host.lines.join('\n'), '// a\n');
	});

	test('one ex line is one undo step: every command of it, every line of :g, :normal\'s keys', () => {
		let v = new Vim('|a b\nc');
		v.keys(':s/a/A/ | s/b/B/ | 2d<CR>');
		assert.strictEqual(v.host.lines.join('\n'), 'A B');
		v.keys('u');
		assert.strictEqual(v.host.lines.join('\n'), 'a b\nc');
		v = new Vim('|a\nb\nc');
		v.keys(':%normal Ax<CR>');
		assert.strictEqual(v.host.lines.join('\n'), 'ax\nbx\ncx');
		v.keys('u');
		assert.strictEqual(v.host.lines.join('\n'), 'a\nb\nc');
		v = new Vim('|a\nb\na');
		v.keys(':g/a/s/$/!/ | normal Ay<CR>');
		assert.strictEqual(v.host.lines.join('\n'), 'a!y\nb\na!y');
		v.keys('u');
		assert.strictEqual(v.host.lines.join('\n'), 'a\nb\na');
	});

	test(':set ts= sw= et set the buffer\'s indentation (the host\'s model options); >> follows', () => {
		const v = new Vim('|a');
		v.keys(':set ts=2 sw=3 et<CR>');
		assert.deepStrictEqual(v.host.indent, { tabSize: 2, indentSize: 3, insertSpaces: true });
		v.keys('>>');
		assert.strictEqual(v.host.lines[0], '   a');
		v.keys(':set sw=0 noet<CR>');
		assert.deepStrictEqual(v.host.indent, { tabSize: 2, indentSize: 'tabSize', insertSpaces: false });
		v.keys(':set sw? ts et?<CR>');
		assert.ok(v.vim.status().includes('shiftwidth=0  tabstop=2  noexpandtab'), v.vim.status());
		v.keys(':set et=1<CR>');
		assert.ok(v.vim.status().includes('E474'), v.vim.status());
		v.keys(':set ts=x<CR>');
		assert.ok(v.vim.status().includes('E521'), v.vim.status());
		v.keys(':set ts& et!<CR>');
		assert.deepStrictEqual(v.host.indent, { tabSize: 4, indentSize: 'tabSize', insertSpaces: true });
		// completion lists them with the buffer's values
		const opts = v.vim.cmdlineSources().options().filter(o => ['tabstop', 'shiftwidth', 'expandtab'].includes(o.name)).map(o => [o.name, o.detail]);
		assert.deepStrictEqual(opts, [['expandtab', 'on'], ['shiftwidth', '=0'], ['tabstop', '=4']]);
	});

	test(':set fenc= ff= bomb are VS Code\'s file encoding and line ends: Vim\'s names become its ids, checked here (E474), done by _devhubVim.fileOptions', async () => {
		const run = async (line: string, answer?: (args: unknown) => unknown) => {
			const v = new Vim('|a');
			v.host.answer = (command, args) => command === '_devhubVim.fileOptions' ? (answer ? answer(args) : []) : undefined;
			v.keys(`:${line}<CR>`);
			await flush();
			return { v, options: v.host.commands.filter(c => c.command === '_devhubVim.fileOptions').map(c => (c.args as { options: unknown[] }).options) };
		};
		assert.deepStrictEqual((await run('set fenc=cp932')).options, [[{ option: 'fileencoding', value: 'shiftjis' }]]);
		assert.deepStrictEqual((await run('set fileencoding=UTF-8')).options, [[{ option: 'fileencoding', value: 'utf8' }]]);
		assert.deepStrictEqual((await run('setlocal fenc=euc-jp ff=dos')).options, [[{ option: 'fileencoding', value: 'eucjp' }, { option: 'fileformat', value: 'dos' }]]);
		assert.deepStrictEqual((await run('set fileformat=unix')).options, [[{ option: 'fileformat', value: 'unix' }]]);
		assert.deepStrictEqual((await run('set bomb nobomb invbomb bomb!')).options, [[{ option: 'bomb', value: true }, { option: 'bomb', value: false }, { option: 'bomb', value: 'toggle' }, { option: 'bomb', value: 'toggle' }]]);
		// shown: what the workbench answers, after the engine's own options
		const shown = await run('set tw? fenc? ff?', () => ['fileencoding=shiftjis', 'fileformat=dos']);
		assert.deepStrictEqual(shown.options, [[{ option: 'fileencoding' }, { option: 'fileformat' }]]);
		assert.ok(shown.v.vim.status().endsWith('textwidth=0  fileencoding=shiftjis  fileformat=dos'), shown.v.vim.status());
		assert.deepStrictEqual((await run('set fenc')).options, [[{ option: 'fileencoding' }]]);
		// an option of the engine and these on one line
		const mixed = await run('set ic fenc=latin1 ts=2');
		assert.deepStrictEqual(mixed.options, [[{ option: 'fileencoding', value: 'iso88591' }]]);
		assert.strictEqual(mixed.v.host.indent.tabSize, 2);
		// what the workbench throws is the message
		const failed = await run('set bomb', () => { throw new Error('E474: Invalid argument: bomb (only for UTF-8)'); });
		assert.ok(failed.v.vim.status().includes('E474: Invalid argument: bomb'), failed.v.vim.status());
	});

	test(':set fenc= ff= errors: an encoding VS Code does not have, ff=mac, other forms are E474 and nothing is done', async () => {
		for (const [line, error] of [
			['set fenc=klingon', 'E474: Invalid argument: fenc=klingon'],
			['set fenc=', 'E474: Invalid argument: fenc='],
			['set fenc=utf-32', 'E474: Invalid argument: fenc=utf-32'],
			['set ff=mac', 'E474: Invalid argument: ff=mac (VS Code has no CR line endings)'],
			['set ff=win', 'E474: Invalid argument: ff=win'],
			['set ff=', 'E474: Invalid argument: ff='],
			['set nofenc', 'E474: Invalid argument: nofenc'],
			['set invff', 'E474: Invalid argument: invff'],
			['set fenc!', 'E474: Invalid argument: fenc!'],
			['set fenc&', 'E474: Invalid argument: fenc&'],
			['set fenc+=sjis', 'E474: Invalid argument: fenc+=sjis'],
			['set bomb=1', 'E474: Invalid argument: bomb=1'],
			['set ic fenc=klingon ts=2', 'E474: Invalid argument: fenc=klingon'],
		] as const) {
			const v = new Vim('|a').keys(`:${line}<CR>`);
			await flush();
			assert.ok(v.vim.status().endsWith(error), `${line}: ${v.vim.status()}`);
			assert.deepStrictEqual(v.host.commands.filter(c => c.command === '_devhubVim.fileOptions'), [], line);
		}
		// the ones before the bad one are done, as for any option
		const v = new Vim('|a').keys(':set ts=3 fenc=klingon<CR>');
		assert.strictEqual(v.host.indent.tabSize, 3);
	});

	test(':set fenc ff bomb are completed by name', () => {
		const v = new Vim('|a');
		const options = v.vim.cmdlineSources().options();
		assert.ok(['bomb', 'fileencoding', 'fileformat'].every(n => options.some(o => o.name === n)));
		assert.strictEqual(options.find(o => o.name === 'fileencoding')?.alias, 'fenc');
		assert.strictEqual(options.find(o => o.name === 'fileformat')?.alias, 'ff');
	});

	test(':w ++enc= ++ff= :sav ++enc= :r ++enc= take the words off the file and pass them on; a bad one is E474 and nothing runs', async () => {
		const run = async (text: string, line: string) => {
			const v = new Vim(text);
			v.host.answer = command => command.startsWith('_devhubVim.') ? '"f" 1L, 2B written' : undefined;
			v.keys(`:${line}<CR>`);
			await flush();
			return { v, commands: v.host.commands.map(c => c.args === undefined ? [c.command] : [c.command, c.args]) };
		};
		// no file: not VS Code's plain Save, which has no encoding
		assert.deepStrictEqual((await run('|a', 'w ++enc=sjis')).commands, [['_devhubVim.writeFile', { file: '', lines: ['a'], append: false, force: false, whole: true, enc: 'shiftjis' }]]);
		assert.deepStrictEqual((await run('|a', 'w ++ff=dos')).commands, [['_devhubVim.writeFile', { file: '', lines: ['a'], append: false, force: false, whole: true, ff: 'dos' }]]);
		assert.deepStrictEqual((await run('|a', 'w ++enc=euc-jp ++ff=unix out.txt')).commands, [['_devhubVim.writeFile', { file: 'out.txt', lines: ['a'], append: false, force: false, whole: true, enc: 'eucjp', ff: 'unix' }]]);
		assert.deepStrictEqual((await run('|a', 'w! ++enc=latin1 >> log.txt')).commands, [['_devhubVim.writeFile', { file: 'log.txt', lines: ['a'], append: true, force: true, whole: true, enc: 'iso88591' }]]);
		const partial = await run('|a\nb', '1w ++enc=sjis');
		assert.deepStrictEqual(partial.commands, []);
		assert.ok(partial.v.vim.status().includes('E140'), partial.v.vim.status());
		assert.deepStrictEqual((await run('|a', 'sav ++enc=cp932 b.txt')).commands, [['_devhubVim.saveAs', { file: 'b.txt', enc: 'shiftjis', force: false }]]);
		assert.deepStrictEqual((await run('|a', 'r ++enc=gbk in.txt')).commands, [['_devhubVim.readFile', { file: 'in.txt', enc: 'gbk' }]]);
		for (const line of ['w ++enc=klingon x', 'sav ++ff=mac x', 'r ++bin x']) {
			const bad = await run('|a', line);
			assert.deepStrictEqual(bad.commands, [], line);
			assert.ok(bad.v.vim.status().includes('E474'), bad.v.vim.status());
		}
		// the rest of the line does not run after the error
		const chained = await run('|a', 'w ++enc=klingon | s/a/b/');
		assert.strictEqual(chained.v.state(), '|a');
	});

	test(':w [file], :w >> file, :[range]w! file, :sav file go to the workbench\'s file commands; E140 for a part without !', async () => {
		const run = async (text: string, line: string) => {
			const v = new Vim(text);
			v.host.answer = command => command.startsWith('_devhubVim.') ? '"f" 1L, 2B written' : undefined;
			v.keys(`:${line}<CR>`);
			await flush();
			return { v, commands: v.host.commands.map(c => c.args === undefined ? [c.command] : [c.command, c.args]) };
		};
		assert.deepStrictEqual((await run('|a\nb', 'w')).commands, [['workbench.action.files.save']]);
		assert.deepStrictEqual((await run('|a\nb', '%w')).commands, [['workbench.action.files.save']]);
		const copy = await run('|a\nb', 'w copy.txt');
		assert.deepStrictEqual(copy.commands, [['_devhubVim.writeFile', { file: 'copy.txt', lines: ['a', 'b'], append: false, force: false, whole: true }]]);
		assert.ok(copy.v.vim.status().includes('written'), copy.v.vim.status());
		assert.deepStrictEqual((await run('a\n|b\nc', '2,3w! part.txt')).commands, [['_devhubVim.writeFile', { file: 'part.txt', lines: ['b', 'c'], append: false, force: true, whole: false }]]);
		assert.deepStrictEqual((await run('|a', 'w >> log.txt')).commands, [['_devhubVim.writeFile', { file: 'log.txt', lines: ['a'], append: true, force: false, whole: true }]]);
		assert.deepStrictEqual((await run('|a', 'w>>')).commands, [['_devhubVim.writeFile', { file: '', lines: ['a'], append: true, force: false, whole: true }]]);
		const partial = await run('|a\nb', '1w');
		assert.deepStrictEqual(partial.commands, []);
		assert.ok(partial.v.vim.status().includes('E140'), partial.v.vim.status());
		assert.deepStrictEqual((await run('|a', 'sav! b.txt')).commands, [['_devhubVim.saveAs', { file: 'b.txt', force: true }]]);
		const none = await run('|a', 'sav');
		assert.ok(none.v.vim.status().includes('E471'), none.v.vim.status());
		// what the command throws is the message, and the rest of the line does not run
		const v = new Vim('|a');
		v.host.answer = command => { if (command === '_devhubVim.writeFile') { throw new Error('E13: File exists (add ! to override)'); } return undefined; };
		v.keys(':w x | noh | s/a/b/<CR>');
		await flush();
		assert.ok(v.vim.status().includes('E13'), v.vim.status());
		assert.strictEqual(v.state(), '|a');
	});

	test(':r file puts its lines below the line (:0r above the first), as one undo step, the cursor on the first', async () => {
		const v = new Vim('a\n|b\nc');
		v.host.answer = (command, args) => {
			if (command !== '_devhubVim.readFile') {
				return undefined;
			}
			if ((args as { file: string }).file !== 'x') {
				throw new Error('E484: Can\'t open file nope');
			}
			return ['  x1', 'x2'];
		};
		v.keys(':r x<CR>');
		await flush();
		assert.strictEqual(v.state(), 'a\nb\n  |x1\nx2\nc');
		v.keys(':0r x<CR>');
		await flush();
		assert.strictEqual(v.state(), '  |x1\nx2\na\nb\n  x1\nx2\nc');
		v.keys('u');
		assert.strictEqual(v.host.lines.join('\n'), 'a\nb\n  x1\nx2\nc');
		v.keys(':$r nope<CR>');
		await flush();
		assert.ok(v.vim.status().includes('E484'), v.vim.status());
		// the line it goes below is followed while the file is read
		const w = new Vim('|a\nb');
		let release: (lines: string[]) => void = () => { };
		w.host.answer = command => command === '_devhubVim.readFile' ? new Promise<string[]>(r => release = r) : undefined;
		w.keys(':2r x<CR>');
		w.keys('ggOz<Esc>');
		release(['new']);
		await flush();
		assert.strictEqual(w.host.lines.join('\n'), 'z\na\nb\nnew');
	});

	test(':!cmd runs in a terminal; ! is the previous command, \! a !, :!! runs it again', async () => {
		const v = new Vim('|a');
		v.keys(':!make test<CR>');
		v.keys(':!! -j2<CR>');
		v.keys(':!echo \\! %<CR>');
		await flush();
		assert.deepStrictEqual(v.host.commands.map(c => [c.command, c.args]), [
			['_devhubVim.shell', { cmd: 'make test' }],
			['_devhubVim.shell', { cmd: 'make test -j2' }],
			['_devhubVim.shell', { cmd: 'echo ! %' }],
		]);
		const fresh = new Vim('|a', [], new VimSharedState()).keys(':!!<CR>');
		assert.ok(fresh.vim.status().includes('E34'), fresh.vim.status());
		const empty = new Vim('|a').keys(':!<CR>');
		assert.ok(empty.vim.status().includes('E471'), empty.vim.status());
		// | is part of the command
		const bar = new Vim('|a').keys(':!ls | wc -l<CR>');
		assert.deepStrictEqual(bar.host.commands.map(c => c.args), [{ cmd: 'ls | wc -l' }]);
	});

	test(':{range}!cmd filters the lines: stdout in their place (also on failure), stderr and the exit code in the status bar, one undo step', async () => {
		const filter = (answer: (cmd: string, input: string) => unknown) => {
			const v = new Vim('x\n|c\nb\na\ny');
			v.host.answer = (command, args) => command === '_devhubVim.filter' ? answer((args as { cmd: string }).cmd, (args as { input: string }).input) : undefined;
			return v;
		};
		let v = filter((_cmd, input) => ({ stdout: input.split('\n').filter(l => l).sort().join('\n') + '\n', stderr: '', code: 0, cancelled: false }));
		v.keys(':.,+2!sort<CR>');
		await flush();
		assert.strictEqual(v.state(), 'x\n|a\nb\nc\ny');
		assert.deepStrictEqual(v.host.commands[0].args, { cmd: 'sort', input: 'c\nb\na\n' });
		assert.ok(v.vim.status().includes('3 lines filtered'), v.vim.status());
		v.keys('u');
		assert.strictEqual(v.host.lines.join('\n'), 'x\nc\nb\na\ny');
		// a failing command: its output replaces the lines all the same, as Vim's
		v = filter(() => ({ stdout: 'partial\n', stderr: 'sort: bad option\nmore\n', code: 2, cancelled: false }));
		v.keys(':2,3!sort -Z<CR>');
		await flush();
		assert.strictEqual(v.host.lines.join('\n'), 'x\npartial\na\ny');
		assert.ok(v.vim.status().includes('shell returned 2: sort: bad option'), v.vim.status());
		// no output: the lines go
		v = filter(() => ({ stdout: '', stderr: '', code: 0, cancelled: false }));
		v.keys(':2,3!true<CR>');
		await flush();
		assert.strictEqual(v.host.lines.join('\n'), 'x\na\ny');
		// cancelled (Cancel, CTRL-C): nothing changes
		v = filter(() => ({ stdout: 'x\n', stderr: '', code: null, cancelled: true }));
		v.keys(':%!slow<CR>');
		await flush();
		assert.strictEqual(v.host.lines.join('\n'), 'x\nc\nb\na\ny');
		assert.ok(v.vim.status().includes('Interrupted'), v.vim.status());
		// the lines are followed while the command runs
		v = new Vim('|a\nb');
		let release: (r: unknown) => void = () => { };
		v.host.answer = command => command === '_devhubVim.filter' ? new Promise(r => release = r) : undefined;
		v.keys(':2!tr a-z A-Z<CR>');
		v.keys('ggOz<Esc>');
		release({ stdout: 'B\n', stderr: '', code: 0, cancelled: false });
		await flush();
		assert.strictEqual(v.host.lines.join('\n'), 'z\na\nB');
	});

	test(':r !cmd puts its output below the line; :w !cmd gives the lines to a command in a terminal', async () => {
		const v = new Vim('a\n|b');
		v.host.answer = command => command === '_devhubVim.filter' ? { stdout: 'one\ntwo\n', stderr: 'warn\n', code: 0, cancelled: false } : undefined;
		v.keys(':r !date<CR>');
		await flush();
		assert.strictEqual(v.state(), 'a\nb\n|one\ntwo');
		assert.deepStrictEqual(v.host.commands[0].args, { cmd: 'date', input: '' });
		assert.ok(v.vim.status().includes('warn'), v.vim.status());
		v.keys(':0r!echo top<CR>');
		await flush();
		assert.deepStrictEqual(v.host.commands[1].args, { cmd: 'echo top', input: '' });
		const w = new Vim('a\n|b\nc');
		w.keys(':w !wc -l<CR>:2,3w !cat | grep x<CR>');
		await flush();
		assert.deepStrictEqual(w.host.commands.map(c => [c.command, c.args]), [
			['_devhubVim.shell', { cmd: 'wc -l', input: ['a', 'b', 'c'] }],
			['_devhubVim.shell', { cmd: 'cat | grep x', input: ['b', 'c'] }],
		]);
	});

	test(':js runs code, :js = shows the value; registers go there and come back', async () => {
		const v = new Vim('|abc');
		v.keys('yiw');
		let seen: Record<string, unknown> | undefined;
		v.host.answer = (command, args) => {
			if (command !== '_devhubVim.js') {
				return undefined;
			}
			seen = args as Record<string, unknown>;
			return seen.kind === 'eval' ? { value: '42', registers: {} } : { registers: { a: { text: 'from js', type: 'line' }, B: { text: 'x', type: 'char' } } };
		};
		v.keys(':js await vscode.commands.executeCommand("x") | not a bar<CR>');
		await flush();
		assert.deepStrictEqual({ ...seen, registers: undefined }, { kind: 'exec', code: 'await vscode.commands.executeCommand("x") | not a bar', mode: 'normal', registers: undefined });
		assert.deepStrictEqual((seen!.registers as Record<string, unknown>)['"'], { text: 'abc', type: 'char' });
		assert.deepStrictEqual(v.shared.registers.get('a'), { text: 'from js', type: 'line' });
		assert.deepStrictEqual(v.shared.registers.get('b'), { text: 'x', type: 'char' });
		v.keys(':js =6 * 7<CR>');
		await flush();
		assert.deepStrictEqual({ kind: seen!.kind, code: seen!.code }, { kind: 'eval', code: '6 * 7' });
		assert.ok(v.vim.status().includes('42'), v.vim.status());
		// an error is the message; no range for :js
		v.host.answer = command => command === '_devhubVim.js' ? { registers: {}, error: 'E5108: Error executing JS: boom' } : undefined;
		v.keys(':js throw 1<CR>');
		await flush();
		assert.ok(v.vim.status().includes('E5108'), v.vim.status());
		v.keys(':2js 1<CR>');
		assert.ok(v.vim.status().includes('E481'), v.vim.status());
		// untrusted: the workbench says so
		v.host.answer = command => { if (command === '_devhubVim.js') { throw new Error('E12: Command not allowed in an untrusted workspace (Workspace Trust): :js, :jsdo'); } return undefined; };
		v.keys(':js 1<CR>');
		await flush();
		assert.ok(v.vim.status().includes('E12'), v.vim.status());
	});

	test(':[range]jsdo gives each line and its number; the strings returned replace them, as one undo step', async () => {
		const v = new Vim('a\n|b\nc\nd');
		let seen: Record<string, unknown> | undefined;
		v.host.answer = (command, args) => {
			if (command !== '_devhubVim.js') {
				return undefined;
			}
			seen = args as Record<string, unknown>;
			const lines = seen.lines as string[];
			const first = seen.firstLine as number;
			// what devhub-vim-js does for `return linenr % 2 ? line + linenr : undefined`
			return { lines: lines.map((l, i) => (first + i) % 2 ? l + (first + i) : null), registers: {} };
		};
		v.keys(':2,4jsdo return linenr % 2 ? line + linenr : undefined<CR>');
		await flush();
		assert.deepStrictEqual({ kind: seen!.kind, lines: seen!.lines, firstLine: seen!.firstLine, code: seen!.code }, { kind: 'do', lines: ['b', 'c', 'd'], firstLine: 2, code: 'return linenr % 2 ? line + linenr : undefined' });
		assert.strictEqual(v.host.lines.join('\n'), 'a\nb\nc3\nd');
		v.keys(':jsdo return line.toUpperCase()<CR>');
		await flush();
		assert.deepStrictEqual(seen!.lines, ['a', 'b', 'c3', 'd']);
		assert.strictEqual(v.host.lines.join('\n'), 'a1\nb\nc33\nd');
		// each :jsdo is one undo step
		v.keys('u');
		assert.strictEqual(v.host.lines.join('\n'), 'a\nb\nc3\nd');
		v.keys('u');
		assert.strictEqual(v.host.lines.join('\n'), 'a\nb\nc\nd');
		// an error: the lines before it are changed (Neovim's :luado), the message says which line
		v.host.answer = command => command === '_devhubVim.js' ? { lines: ['A'], registers: {}, error: 'E5108: Error executing JS: the function returned a number, not a string, undefined or null (line 2)' } : undefined;
		v.keys(':%jsdo x<CR>');
		await flush();
		assert.strictEqual(v.host.lines.join('\n'), 'A\nb\nc\nd');
		assert.ok(v.vim.status().includes('(line 2)'), v.vim.status());
		// the lines changed meanwhile: nothing is put
		let release: (r: unknown) => void = () => { };
		v.host.answer = command => command === '_devhubVim.js' ? new Promise(r => release = r) : undefined;
		v.keys(':2jsdo return "X"<CR>');
		v.keys('2Gx');
		release({ lines: ['X'], registers: {} });
		await flush();
		assert.strictEqual(v.host.lines.join('\n'), 'A\n\nc\nd');
		assert.ok(v.vim.status().includes('changed'), v.vim.status());
	});

	test('@: repeats the line typed, not the commands :g ran', () => {
		const v = new Vim('|a\nb\na');
		v.keys(':g/a/s/$/!/<CR>');
		v.keys('@:');
		assert.strictEqual(v.host.lines.join('\n'), 'a!!\nb\na!!');
	});
});

suite('DevHub Vim <C-w> nav prefix', () => {

	/** The default nav keybindings, as the workbench registers them (when devhubVim.mode == nav). */
	const bindings: Record<string, string> = {
		'h': 'devhubVim.nav.left', 'j': 'devhubVim.nav.down', 'k': 'devhubVim.nav.up', 'l': 'devhubVim.nav.right',
		'Escape': 'devhubVim.nav.escape',
	};

	function key(k: string, extra: { metaKey?: boolean; isComposing?: boolean; keyCode?: number } = {}) {
		return { key: k, keyCode: 0, isComposing: false, metaKey: false, ...extra };
	}

	function press(nav: VimNavPrefix, k: string, extra: { metaKey?: boolean; isComposing?: boolean; keyCode?: number } = {}) {
		const bound = nav.active && !extra.metaKey ? bindings[k] : undefined;
		return { action: nav.key(key(k, extra), bound), command: bound };
	}

	test('Esc never enters nav: only <C-w> does', () => {
		const nav = new VimNavPrefix();
		const { vim, v } = run('ab|c', '');
		for (let i = 0; i < 5; i++) {
			v.press('<Esc>');
			assert.strictEqual(nav.active, false);
			assert.strictEqual(vim.mode, 'normal');
		}
		assert.strictEqual(nav.enter('normal'), true);
		assert.strictEqual(nav.active, true);
		assert.strictEqual(vimCursorStyle(vim.mode, nav.active, 'line'), 'underline-thin');
	});

	test('<C-w> h j k l run the nav command once, then the prefix is over', () => {
		for (const [k, command] of [['h', 'devhubVim.nav.left'], ['j', 'devhubVim.nav.down'], ['k', 'devhubVim.nav.up'], ['l', 'devhubVim.nav.right']]) {
			const nav = new VimNavPrefix();
			nav.enter('normal');
			assert.deepStrictEqual(press(nav, k), { action: 'run', command }, k);
			assert.strictEqual(nav.active, false, k);
			// one-shot: the next h is a plain key again
			assert.strictEqual(press(nav, k).action, 'pass', k);
		}
	});

	test('Esc in nav cancels it; the editor is still in plain normal mode', () => {
		const { host, vim, v } = run('ab|c', '');
		const nav = new VimNavPrefix();
		nav.enter('normal');
		assert.strictEqual(press(nav, 'Escape').action, 'run');
		assert.strictEqual(nav.active, false);
		v.press('<Esc>');
		assert.strictEqual(vim.mode, 'normal');
		assert.strictEqual(vim.pending, false);
		assert.strictEqual(host.state(), 'ab|c');
		assert.strictEqual(vimCursorStyle(vim.mode, nav.active, 'line'), 'block');
	});

	test('a key nav does not bind cancels it and is eaten, as in Vim', () => {
		const nav = new VimNavPrefix();
		nav.enter('other');
		assert.strictEqual(press(nav, 'u').action, 'swallow');
		assert.strictEqual(nav.active, false);
		nav.enter('input');
		assert.strictEqual(press(nav, 'x').action, 'swallow');
	});

	test('modifiers wait; Cmd chords and IME keys pass through', () => {
		const nav = new VimNavPrefix();
		nav.enter('normal');
		assert.strictEqual(press(nav, 'Shift').action, 'wait');
		assert.strictEqual(press(nav, 'Control').action, 'wait');
		assert.strictEqual(nav.active, true);
		assert.strictEqual(press(nav, 'w', { metaKey: true }).action, 'pass');
		assert.strictEqual(nav.active, false);
		nav.enter('normal');
		assert.strictEqual(press(nav, 'h', { keyCode: 229 }).action, 'pass');
		assert.strictEqual(nav.active, false);
	});

	test('where <C-w> means something else it is not the prefix', () => {
		const refused: VimNavFocus[] = ['insert', 'pending', 'terminal'];
		for (const focus of refused) {
			const nav = new VimNavPrefix();
			assert.strictEqual(nav.enter(focus), false, focus);
			assert.strictEqual(nav.active, false, focus);
		}
		for (const focus of ['normal', 'input', 'other'] as VimNavFocus[]) {
			assert.strictEqual(new VimNavPrefix().enter(focus), true, focus);
		}
		// a binding on a key the shell does not take (cmd+w, { terminal: true }): also from the terminal; never from insert mode or with keys pending
		assert.strictEqual(new VimNavPrefix().enter('terminal', { terminal: true }), true);
		assert.strictEqual(new VimNavPrefix().enter('insert', { terminal: true }), false);
		assert.strictEqual(new VimNavPrefix().enter('pending', { terminal: true }), false);
	});

	test('whatever the key is bound to while nav waits runs once after <C-w>, then the prefix is over', () => {
		// a user's { key: 'n', command: 'workbench.action.nextEditorInGroup', when: "devhubVim.mode == 'nav'" }
		const nav = new VimNavPrefix();
		nav.enter('normal');
		assert.strictEqual(nav.key(key('n'), 'workbench.action.nextEditorInGroup'), 'run');
		assert.strictEqual(nav.active, false);
		assert.strictEqual(nav.key(key('n'), undefined), 'pass');
	});

	test('<C-w> <BS> / <Tab> / <Del> edit nothing: the editor\'s typing keys do not apply in nav mode', () => {
		for (const active of [true, false]) {
			const ctx = { editorTextFocus: true, textInputFocus: true, 'devhubVim.active': active, 'devhubVim.mode': 'nav' };
			assert.deepStrictEqual(EDITOR_TYPING_KEYS.filter(b => evaluateWhen(b.when, ctx)).map(b => b.key), [], `active: ${active}`);
		}
		const nav = new VimNavPrefix();
		nav.enter('normal');
		assert.strictEqual(nav.key(key('Backspace'), undefined), 'swallow');
	});

	test('no default Vim key binding matches while nav waits', () => {
		const ctx = { editorTextFocus: true, 'devhubVim.active': true, 'devhubVim.mode': 'nav' };
		const matching = DEFAULT_KEYBINDINGS.filter(b => evaluateWhen(b.when, ctx)).map(b => b.key);
		assert.deepStrictEqual(matching, []);
	});

	test('a click or focus change forgets the prefix', () => {
		const nav = new VimNavPrefix();
		nav.enter('other');
		nav.cancel();
		assert.strictEqual(nav.active, false);
		assert.strictEqual(press(nav, 'h').action, 'pass');
	});
});

suite('DevHub Vim IME commits outside insert mode', () => {

	test('dropped unless a command waits for a character', () => {
		const { host, vim } = run('|abc', '');
		assert.strictEqual(vim.handleText('じっこう'), false);
		assert.strictEqual(host.state(), '|abc');
		assert.strictEqual(vim.mode, 'normal');
		assert.strictEqual(vim.pending, false);
	});

	test('f t r and operators take the first committed character', () => {
		let r = run('|ab日本語', 'f');
		assert.strictEqual(r.vim.handleText('本'), true);
		assert.strictEqual(r.host.state(), 'ab日|本語');
		r = run('|ab日本語', 'dt');
		r.vim.handleText('語');
		assert.strictEqual(r.host.state(), '|語');
		r = run('|abc', 'r');
		r.vim.handleText('あい');
		assert.strictEqual(r.host.state(), '|あbc');
		assert.strictEqual(r.vim.pending, false);
		// `"` waits for a register name: the commit names it
		r = run('|abc', '"');
		assert.strictEqual(r.vim.handleText('a'), true);
		r.v.keys('yl"ap');
		assert.strictEqual(r.host.state(), 'a|abc');
	});

	test('the / prompt is an editor of its own: the engine leaves what an IME commits there to it', () => {
		const r = run('|abc 日本語', '/');
		assert.strictEqual(r.vim.handleText('日本'), false);
		r.v.promptLine()!.insertText('日本');
		r.v.press('<CR>');
		assert.strictEqual(r.host.state(), 'abc |日本語');
	});
});

suite('DevHub Vim keys the editor reads itself', () => {

	function ev(key: string, extra: Partial<VimKeyEvent> = {}): VimKeyEvent {
		return { key, keyCode: 0, isComposing: false, ctrlKey: false, metaKey: false, altKey: false, ...extra };
	}

	test('captured keys (a character argument, the prompt)', () => {
		assert.strictEqual(captureKey(ev('j')), 'j');
		assert.strictEqual(captureKey(ev('G')), 'G');
		assert.strictEqual(captureKey(ev('$')), '$');
		assert.strictEqual(captureKey(ev('Enter')), '<CR>');
		assert.strictEqual(captureKey(ev('Escape')), '<Esc>');
		assert.strictEqual(captureKey(ev('Tab')), '<Tab>');
		assert.strictEqual(captureKey(ev('ArrowLeft')), '<Other>');
		assert.strictEqual(captureKey(ev('Shift')), undefined);
		assert.strictEqual(captureKey(ev('s', { metaKey: true })), undefined);
		assert.strictEqual(captureKey(ev('w', { ctrlKey: true })), '<C-w>');
		assert.strictEqual(captureKey(ev('ArrowUp')), '<Up>');
	});

	test('typed characters (layout fallback, cancelling a pending command)', () => {
		assert.strictEqual(typedChar(ev('^')), '^');
		assert.strictEqual(typedChar(ev('Enter')), undefined);
		assert.strictEqual(typedChar(ev('j', { altKey: true })), undefined);
	});

	test('IME keys are the IME\'s, never Vim keys', () => {
		assert.strictEqual(captureKey(ev('Process', { keyCode: 229 })), undefined);
		assert.strictEqual(captureKey(ev('j', { keyCode: 229 })), undefined);
		assert.strictEqual(captureKey(ev('u', { isComposing: true })), undefined);
		assert.strictEqual(typedChar(ev('j', { keyCode: 229 })), undefined);
		assert.strictEqual(typedChar(ev('Enter', { isComposing: true })), undefined);
	});

	test('key notation for characters (Apple JIS)', () => {
		assert.deepStrictEqual(['$', 'G', ':', '"', '{', 'a', ' ', '0', ')', '~'].map(keyForChar),
			['shift+[Digit4]', 'shift+g', '[Quote]', 'shift+[Digit2]', 'shift+[BracketRight]', 'a', 'space', '0', 'shift+[Digit9]', 'shift+[Equal]']);
	});
});

/** The text with the cursor, after the keys and a turn of the event loop (for commands that run VS Code commands). */
async function checkAsync(text: string, keys: string, expected: string) {
	const v = new Vim(text).keys(keys);
	await flush();
	assert.strictEqual(v.state(), expected, `${JSON.stringify(text)} ${keys}`);
}

function lines(n: number, f: (i: number) => string = i => `line ${i}`): string {
	return Array.from({ length: n }, (_, i) => f(i)).join('\n');
}

suite('Neovim motions', () => {

	test('| g_ gM and the line motions', () => {
		check('|abcdef', '4|', 'abc|def');
		check('|abc  ', 'g_', 'ab|c  ');
		check('|ab\ncd  ', '2g_', 'ab\nc|d  ');
		check('|abcdefgh', 'gM', 'abcd|efgh');
		check('a|b\n  c', '+', 'ab\n  |c');
		check('  a\n|b', '-', '  |a\nb');
		check('|a\n  b', '2_', 'a\n  |b');
	});

	test('nostartofline: G gg :{n} dd keep the column', () => {
		check('ab|cd\nefgh', 'G', 'abcd\nef|gh');
		check('abcd\nef|gh', 'gg', 'ab|cd\nefgh');
		check('ab|cd\nefgh\nijkl', ':3<CR>', 'abcd\nefgh\nij|kl');
		check('ab|cd\nefgh\nij', 'dd', 'ef|gh\nij');
		check('abcd\nab|cd\nx', 'dk', '|x');
		const v = new Vim('ab|cd\n  efgh');
		v.keys(':set sol<CR>G');
		assert.strictEqual(v.state(), 'abcd\n  |efgh');
	});

	test('H M L, with counts', () => {
		const v = new Vim(lines(30, () => 'xy'));
		v.host.visible = 10;
		v.keys('L');
		assert.strictEqual(v.host.cursor.line, 9);
		v.keys('M');
		assert.strictEqual(v.host.cursor.line, 4);
		v.keys('3H');
		assert.strictEqual(v.host.cursor.line, 2);
		v.keys('2L');
		assert.strictEqual(v.host.cursor.line, 8);
		v.keys('dL');
		assert.strictEqual(v.host.lines.length, 28);
	});

	test('( ) sentences and { } paragraphs', () => {
		check('|One. Two three.  Four', ')', 'One. |Two three.  Four');
		check('|One. Two three.  Four', '2)', 'One. Two three.  |Four');
		check('One. Two three.  F|our', '(', 'One. Two three.  |Four');
		check('One. Two three.  F|our', '((', 'One. |Two three.  Four');
		check('|a\nb\n\nc\nd', '}', 'a\nb\n|\nc\nd');
		check('|a\nb\n\nc\nd', '2}', 'a\nb\n\nc\n|d');
		check('a\nb\n\nc\n|d', '{', 'a\nb\n|\nc\nd');
		check('|a\nb\n\nc', 'd}', '|\nc');
		check('a\n|b\n\nc', 'y}P', 'a\n|b\nb\n\nc');
	});

	test('[[ ]] sections, [( [{ ]) ]} unmatched brackets', () => {
		check('|a\n{\nb\n}\n{\nc', ']]', 'a\n|{\nb\n}\n{\nc');
		check('a\n{\nb\n}\n|{\nc', '[[', 'a\n|{\nb\n}\n{\nc');
		check('a\n}\nb\n|}\nx', '[]', 'a\n|}\nb\n}\nx');
		check('f(a, (b|), c)', '[(', 'f(a, |(b), c)');
		check('f(a, (b), |c)', '[(', 'f|(a, (b), c)');
		check('f(a, (b), |c)', '])', 'f(a, (b), c|)');
		check('{ a { b } |c }', '[{', '|{ a { b } c }');
		check('{ a { b } |c }', ']}', '{ a { b } c |}');
		check('f(a, (b), |c)', 'd])', 'f(a, (b), |)');
	});

	test('% skips brackets in strings; {count}% is a percentage', () => {
		check('|f("(", x)', '%', 'f("(", x|)');
		check('f("(", x|)', '%', 'f|("(", x)');
		const v = new Vim(lines(10, () => 'abc'));
		v.keys('50%');
		assert.strictEqual(v.host.cursor.line, 4);
	});

	test('marks: m ` \' and operators to marks, following edits', () => {
		check('ab|cd\nef\ngh', 'majj`a', 'ab|cd\nef\ngh');
		check('  ab|cd\nef\ngh', 'majj\'a', '  |abcd\nef\ngh');
		check('ab|cd\nef\ngh', 'mbjjd\'b', '|');
		check('abc|def', 'ma0d`a', '|def');
		// a line added above moves the mark with its line
		check('x\nab|c', 'maggOnew<Esc>`a', 'new\nx\nab|c');
		// a deleted line takes its mark with it
		const v = new Vim('a\n|b\nc').keys('madd');
		v.keys('`a');
		assert.ok(v.vim.status().includes('E20'), v.vim.status());
	});

	test('jumps are VS Code jumps; \'\' and `` go back to where the last one came from', () => {
		const v = new Vim(lines(20));
		v.keys('5G');
		assert.deepStrictEqual(v.host.jumps.map(p => p.line), [4]);
		v.keys('jG');
		assert.deepStrictEqual(v.host.jumps.map(p => p.line), [4, 19]);
		// plain motions are not jumps
		v.keys('kkkj');
		assert.strictEqual(v.host.jumps.length, 2);
		v.keys('\'\'');
		assert.strictEqual(v.host.cursor.line, 5);
		v.keys('``');
		assert.strictEqual(v.host.cursor.line, 17);
		assert.deepStrictEqual(v.host.jumps.map(p => p.line), [4, 19, 5, 17]);
		// a mark, a search, %, H, :{n}, gg, and a jump in visual mode
		const w = new Vim('|a(\nfoo\n)\nfoo\nb');
		w.keys('jmajjj`a');
		w.keys('/foo<CR>');
		w.keys('gg%');
		w.keys(':4<CR>');
		w.keys('H');
		w.keys('vG');
		assert.deepStrictEqual(w.host.jumps.map(p => p.line), [1, 3, 0, 2, 3, 0, 4]);
		// a jump that goes nowhere is none
		const x = new Vim('|a');
		x.keys('gg');
		assert.deepStrictEqual(x.host.jumps, []);
	});

	test('CTRL-O CTRL-I <Tab> g; g, are VS Code\'s history, with a count', async () => {
		const v = new Vim('a\nb');
		v.keys('<C-o>');
		await flush();
		v.keys('3<C-i>');
		await flush();
		v.keys('<Tab>');
		await flush();
		v.keys('2g;');
		await flush();
		v.keys('g,');
		await flush();
		assert.deepStrictEqual(v.host.commands.map(c => c.command), [
			'workbench.action.navigateBack',
			'workbench.action.navigateForward', 'workbench.action.navigateForward', 'workbench.action.navigateForward',
			'workbench.action.navigateForward',
			'workbench.action.navigateBackInEditLocations', 'workbench.action.navigateBackInEditLocations',
			'workbench.action.navigateForwardInEditLocations',
		]);
		assert.strictEqual(v.host.state(), '|a\nb');
	});

	test('gj gk (display lines), j k over closed folds', () => {
		check('a|bc\ndef', 'gj', 'abc\nd|ef');
		const v = new Vim('|a\nb\nc\nd');
		v.host.hidden = new Set([1, 2]);
		v.keys('j');
		assert.strictEqual(v.host.cursor.line, 3);
		v.keys('k');
		assert.strictEqual(v.host.cursor.line, 0);
	});

	test('<Space> and <BS> wrap over line ends (whichwrap b,s)', () => {
		check('a|b\ncd', '  ', 'ab\nc|d');
		check('ab\n|cd', '<BS>', 'a|b\ncd');
	});

	test('gd gD', () => {
		check('int x;\n{\n  int y;\n  y = |x + y;\n}', 'gD', 'int |x;\n{\n  int y;\n  y = x + y;\n}');
		check('int y;\n\n{\n  int y;\n  x = |y;\n}', 'gd', 'int y;\n\n{\n  int |y;\n  x = y;\n}');
	});
});

suite('Neovim operators and text objects', () => {

	test('cw / cW like ce, on a blank like dw; dw at the end of a line', () => {
		check('|a b', 'cwX<Esc>', '|X b');
		check('|foo bar', 'c2wX<Esc>', '|X');
		check('a|  b', 'cwX<Esc>', 'a|Xb');
		check('foo |bar\nbaz', 'dw', 'foo| \nbaz');
		check('    |foo\n  bar', 'dw', '   | \n  bar');
		check('a\n|\nb', 'dw', 'a\n|b');
		check('|foo bar\nbaz', '3dw', '|');
		check('|a b c d e f', '2d2w', '|e f');
		check('fo|o bar', 'yw$p', 'foo baro| ');
	});

	test('o_v o_V: forcing the motion type', () => {
		check('a|bc\ndef', 'dvj', 'a|ef');
		check('|abc def', 'dve', '|c def');
		check('a|bc def\nxyz', 'dVw', 'x|yz');
	});

	test('text objects with nested brackets and quotes', () => {
		check('f("a)", |b)', 'di(', 'f(|)');
		check('x = "a\\"|b"', 'di"', 'x = "|"');
		check('((a) (|b))', 'di(', '((a) (|))');
		check('((a) (|b))', '2di(', '(|)');
		check('foo(b|ar)', 'da(', 'fo|o');
		check('f((a|b))', 'vi(i(d', 'f(|)');
		check('a[1, [2, |3]]', 'ci[x<Esc>', 'a[1, [|x]]');
		check('<a href="x"><b>x|y</b></a>', 'dit', '<a href="x"><b>|</b></a>');
		check('<a href="x"><b>x|y</b></a>', 'dat', '<a href="x">|</a>');
		check('<a href="x"><b>x|y</b></a>', '2dit', '<a href="x">|</a>');
		check('<div>\n  <p>t|ext</p>\n</div>', 'dit', '<div>\n  <p>|</p>\n</div>');
		check('a <|b> c', 'di<', 'a <|> c');
		check('x = `te|mp`', 'ci`y<Esc>', 'x = `|y`');
	});

	test('word objects: aw takes leading blanks at the end of a line, iw on blanks, visual iw extends', () => {
		check('foo b|ar', 'daw', 'fo|o');
		check('foo   |  bar', 'diw', 'foo|bar');
		check('foo   |  bar', 'daw', 'fo|o');
		check('|foo bar baz', 'viwiwd', '|bar baz');
		check('|foo bar baz', 'vawawd', '|baz');
	});

	test('sentence and paragraph objects', () => {
		check('Hello there.  How |are you?  Fine.', 'das', 'Hello there.  |Fine.');
		check('Hello there.  How |are you?  Fine.', 'dis', 'Hello there.  |  Fine.');
		check('|a\nb\n\nc', 'dap', '|c');
		check('|a\nb\n\nc', 'dip', '|\nc');
		check('a\n\n|b\nc', 'dap', '|a');
		check('|a\n\nb\n\nc', 'd2ap', '|c');
		check('|a\nb\n\nc', 'vipd', '|\nc');
		check('|a\n\nb\n\nc', 'vapapd', '|c');
	});

	test('counts with operators', () => {
		check('|a\nb\nc\nd', '3dd', '|d');
		check('|a\nb\nc\nd', 'd2j', '|d');
		check('|abc', '5x', '|');
		check('abc|d', '5X', '|d');
		check('|a\nb\nc', '2yyjp', 'a\nb\n|a\nb\nc');
		check('|a\nb\nc', '3>>', '|\ta\n\tb\n\tc');
		check('a\n|\nb', 'D', 'a\n|\nb');
		check('a\n|\nb', 'd$', 'a\n|\nb');
		check('|ab cd', '3~', 'AB |cd');
	});

	test('gu gU g~ g? and their doubled forms', () => {
		check('|foo bar', 'gUiw', '|FOO bar');
		check('f|oo bar', 'gUU', 'F|OO BAR');
		check('f|oo bar', 'gUgU', 'F|OO BAR');
		check('|FOO BAR', 'guw', '|foo BAR');
		check('|FOO BAR', 'guu', '|foo bar');
		check('|aBc', 'g~~', '|AbC');
		check('|abc', 'g??', '|nop');
		check('|abc def', 'g?iw', '|nop def');
		check('|ab cd', 'g~lw.', 'Ab |Cd');
	});

	test('gq / gw format with \'textwidth\' (no formatter); gq uses the formatter when there is one', async () => {
		const v = new Vim('|aaa bbb ccc ddd eee');
		v.keys(':set tw=10<CR>gqq');
		assert.strictEqual(v.host.lines.join('\n'), 'aaa bbb\nccc ddd\neee');
		assert.strictEqual(v.host.cursor.line, 2);
		const w = new Vim('// aaa bbb ccc\n// ddd|');
		w.keys(':set tw=12<CR>gwip');
		assert.strictEqual(w.host.lines.join('\n'), '// aaa bbb\n// ccc ddd');
		assert.strictEqual(w.host.cursor.line, 1);
		const f = new Vim('|a\nb\nc');
		f.host.formatter = true;
		f.keys('gqj');
		await flush();
		assert.deepStrictEqual(f.host.commands.map(c => [c.command, c.selection?.start.line, c.selection?.end.line]), [['editor.action.formatSelection', 0, 1]]);
	});

	test('= and zf run VS Code\'s reindent / fold on the lines', async () => {
		const v = new Vim('|a\nb\nc').keys('=j');
		await flush();
		assert.deepStrictEqual(v.host.commands.map(c => [c.command, c.selection?.start.line, c.selection?.end.line]), [['editor.action.reindentselectedlines', 0, 1]]);
		const z = new Vim('|a\nb\nc').keys('zfip');
		await flush();
		assert.deepStrictEqual(z.host.commands.map(c => [c.command, c.selection?.start.line, c.selection?.end.line]), [['editor.createFoldingRangeFromSelection', 0, 2]]);
	});

	test('gc / gcc comment (Neovim gc-default), compose with motions, text objects, counts, visual and .', async () => {
		await checkAsync('|a\nb\nc', 'gcc', '|// a\nb\nc');
		await checkAsync('|a\nb\nc', 'gcj', '|// a\n// b\nc');
		await checkAsync('|a\nb\n\nc', 'gcip', '|// a\n// b\n\nc');
		await checkAsync('|a\nb\nc', '2gcc', '|// a\n// b\nc');
		await checkAsync('a\n|b\nc', 'Vjgc', 'a\n|// b\n// c');
		await checkAsync('// a\n// |b\nc', 'gcc', '// a\n|b\nc');
		// o_gc: the comment block (gcgc uncomments it, dgc deletes it)
		await checkAsync('x\n// a\n// |b\nc', 'gcgc', 'x\n|a\nb\nc');
		check('x\n// a\n// |b\nc', 'dgc', 'x\n|c');
		const v = new Vim('|a\nb\nc').keys('gcc');
		await flush();
		v.keys('j.');
		await flush();
		assert.strictEqual(v.host.lines.join('\n'), '// a\n// b\nc');
	});
});

suite('Neovim registers', () => {

	test('numbered registers shift; small deletes go to "-', () => {
		const v = new Vim('|a\nb\nc').keys('dddd');
		assert.strictEqual(v.shared.registers.get('1')?.text, 'b');
		assert.strictEqual(v.shared.registers.get('2')?.text, 'a');
		v.keys('"2p');
		assert.strictEqual(v.state(), 'c\n|a');
		v.keys('"1P');
		assert.strictEqual(v.state(), 'c\n|b\na');
		const s = new Vim('|foo bar').keys('dw');
		assert.strictEqual(s.shared.registers.get('-')?.text, 'foo ');
		assert.strictEqual(s.shared.registers.get('1'), undefined);
		// with a named register: no "- ; a % motion always writes "1
		const n = new Vim('|foo bar').keys('"adw');
		assert.strictEqual(n.shared.registers.get('-'), undefined);
		assert.strictEqual(n.shared.registers.get('a')?.text, 'foo ');
		assert.strictEqual(n.shared.registers.get('"')?.text, 'foo ');
		const p = new Vim('x|(a)y').keys('d%');
		assert.strictEqual(p.shared.registers.get('1')?.text, '(a)');
		assert.strictEqual(p.shared.registers.get('-')?.text, '(a)');
	});

	test('"0 keeps the last yank; "_ writes nothing', () => {
		check('|foo bar', 'yiwwdiw"0p', 'foo fo|o');
		check('|a\nb', 'yyj"_ddP', '|a\na');
	});

	test('A-Z append (charwise, and linewise as new lines)', () => {
		check('|foo bar', '"ayiww"Ayiw$"ap', 'foo barfooba|r');
		check('|l1\nl2\nx', '"ayyj"AyyG"ap', 'l1\nl2\nx\n|l1\nl2');
	});

	test('read-only registers . : / %', () => {
		check('|x', 'ifoo<Esc>".p', 'foofo|ox');
		check('|ab', ':s/a/A/<CR>":p', 'As/a/A|/b');
		check('|ab', '/b<CR>"/P', 'a|bb');
		check('|x', '"%P', 'test.tx|tx');
	});

	test('"1p... : `.` takes the next numbered register', () => {
		check('|a\nb\nc\nx', 'dddddd"1p..', 'x\nc\nb\n|a');
	});

	test('CTRL-R {register} in insert mode', () => {
		check('|foo', 'yiwA <C-r>"<Esc>', 'foo fo|o');
	});
});

suite('Neovim changes', () => {

	test('Y is y$ (Y-default); visual Y yanks lines', () => {
		check('a|bc', 'Yp', 'abb|cc');
		check('a|bc\nd', 'vYjp', 'abc\nd\n|abc');
	});

	test('J and gJ spacing rules', () => {
		check('|a\n   b', 'J', 'a| b');
		check('|a \nb', 'J', 'a |b');
		check('|a\n)b', 'J', 'a|)b');
		check('|a\n\nb', '3J', 'a| b');
		check('|a\t\nb', 'J', 'a\t|b');
		check('|a\n   b', 'gJ', 'a|   b');
		check('|a\nb\nc', 'VjjJ', 'a b| c');
		check('|a.\nb', ':set js<CR>J', 'a.|  b');
	});

	test('p P gp gP ]p, linewise, charwise, multi-line, blockwise', () => {
		check('|ab\ncd', 'vjyP', '|ab\ncab\ncd');
		check('|a\nb', 'yyjgp', 'a\nb\n|a');
		check('|a\nb\nc', 'yygP', 'a\n|a\nb\nc');
		check('|ab', 'ylgp', 'aa|b');
		check('|ab\ncd', '<C-v>jy$p', 'ab|a\ncdc');
		check('|ab\ncd', '<C-v>jyP', '|aab\nccd');
		check('\t|x\ny', 'jyyk]p', '\tx\n\t|y\ny');
		check('|a\n\tb', 'yyj[p', 'a\n\t|a\n\tb');
	});

	test('CTRL-A / CTRL-X: decimal, negative, hex, binary, leading zeros, counts', () => {
		check('|x 9 y', '<C-a>', 'x 1|0 y');
		check('|x -1', '<C-a>', 'x |0');
		check('|x -3', '5<C-a>', 'x |2');
		check('|0', '<C-x>', '-|1');
		check('|0x0f', '<C-a>', '0x1|0');
		check('|0xFF', '<C-a>', '0x10|0');
		check('|0x0F', '<C-a>', '0x1|0');
		check('|007', '<C-a>', '00|8');
		check('|0b101', '<C-a>', '0b11|0');
		check('foo|bar 12', '<C-a>', 'foobar 1|3');
		check('1|23', '<C-x>', '12|2');
		check('|a', '<C-a>', '|a');
		check('|1 1', '<C-a>w.', '2 |2');
	});

	test('visual CTRL-A and g CTRL-A', () => {
		check('|0\n0\n0', 'VG<C-a>', '|1\n1\n1');
		check('|0\n0\n0', 'VGg<C-a>', '|1\n2\n3');
		check('|x1 x1\nx1 x1', '<C-v>jl<C-a>', '|x2 x1\nx2 x1');
	});

	test('r, r<CR>, visual r', () => {
		check('|abcd', '3rx', 'xx|xd');
		check('a|bc', 'r<CR>', 'a\n|c');
		check('|abcd', 'vlrx', '|xxcd');
	});

	test('R replace mode: overwrite, <BS> puts the original back, count, dot', () => {
		check('|abcd', 'Rxy<Esc>', 'x|ycd');
		check('|ab', 'Rxyz<Esc>', 'xy|z');
		check('|abcd', 'Rxy<BS><BS>z<Esc>', '|zbcd');
		check('|abcd', '2Rx<Esc>', 'x|xcd');
		check('|abcd', 'Rxy<Esc>l.', 'xyx|y');
	});

	test('[<Space> ]<Space> add blank lines (Neovim unimpaired defaults)', () => {
		check('a|b\nc', ']<Space>', 'a|b\n\nc');
		check('a|b\nc', '2[<Space>', '\n\na|b\nc');
	});

	test('o O I A gi gI with counts', () => {
		check('|a', '3oab<Esc>', 'a\nab\nab\na|b');
		check('|a', '2Ox<Esc>', 'x\n|x\na');
		check('  |a', 'gIx<Esc>', '|x  a');
		check('|abc\nd', 'Ax<Esc>jgiy<Esc>', 'abcx|y\nd');
	});

	test('dot repeats c s x R and visual changes on the same amount of text', () => {
		check('|foo bar baz', 'ciwX<Esc>w.', 'X |X baz');
		check('|abc', 'sX<Esc>l.', 'X|Xc');
		check('|abcdef', 'vld.', '|ef');
		check('|a\nb\nc\nd\ne', 'Vjd.', '|e');
		check('|ab cd ef', 'vlcX<Esc>w.', 'X |X ef');
		check('|abc\nabc\nabc\nabc', '<C-v>jIX<Esc>jj.', 'Xabc\nXabc\n|Xabc\nXabc');
		check('|ab ab', 'vlUw.', 'AB |AB');
	});

	test('insert mode: CTRL-W CTRL-U CTRL-T CTRL-D CTRL-E CTRL-Y CTRL-A CTRL-O', () => {
		check('|foo bar', 'A<C-w>X<Esc>', 'foo |X');
		check('|foo bar', 'A baz<C-u>X<Esc>', 'foo bar|X');
		check('  |foo bar', 'A<C-u>X<Esc>', '  |X');
		check('|a', 'A<C-t>x<Esc>', '\ta|x');
		check('\t|a', 'A<C-d>x<Esc>', 'a|x');
		check('|\nabc', 'i<C-e><C-e><Esc>', 'a|b\nabc');
		check('abc\n|', 'i<C-y><Esc>', 'abc\n|a');
		check('|x\ny', 'ifoo<Esc>jA<C-a><Esc>', 'foox\nyfo|o');
		check('|abc def', 'A<C-o>0X<Esc>', '|Xabc def');
		check('|abc', 'i<C-o>$Y<Esc>', 'abc|Y');
		// CTRL-W after typing: dot replays what is left, also deleting before the start
		check('|foo bar\nbaz qux', 'A<C-w>X<Esc>j.', 'foo X\nbaz |X');
	});
});

suite('Neovim visual modes', () => {

	test('block visual: d c r $D y p', () => {
		check('|abcd\nabcd', '<C-v>jld', '|cd\ncd');
		check('a|bcd\nabcd', '<C-v>jlcX<Esc>', 'a|Xd\naXd');
		check('|abcd\nabcd', '<C-v>jlrx', '|xxcd\nxxcd');
		check('a|bcd\nab\nabcd', '<C-v>jj$D', '|a\na\na');
		check('|abc\nabc', '<C-v>jlyGo<Esc>p', 'abc\nabc\n|ab\nab');
	});

	test('block visual I and A (short lines, $)', () => {
		check('|abc\nabc\nabc', '<C-v>jjIX<Esc>', '|Xabc\nXabc\nXabc');
		check('|abc\nabc\nabc', '<C-v>jjAY<Esc>', 'a|Ybc\naYbc\naYbc');
		check('|ab\nabcd\na', '<C-v>jj$AZ<Esc>', 'ab|Z\nabcdZ\naZ');
		check('ab|cd\na\nabcd', '<C-v>jjIX<Esc>', 'ab|Xcd\na\nabXcd');
		check('ab|cd\na\nabcd', '<C-v>jjAX<Esc>', 'abc|Xd\na  X\nabcXd');
	});

	test('block visual O, > <, ~', () => {
		check('a|bc\nabc', '<C-v>jlOd', '|a\na');
		check('|ab\nab', '<C-v>j>', '|\tab\n\tab');
		check('|ab\nab', '<C-v>jl~', '|AB\nAB');
	});

	test('gv, visual I A in characterwise and linewise mode', () => {
		check('|abc def', 'vlly0gvd', '| def');
		check('ab|c\ndef', 'vjIX<Esc>', '|Xabc\ndef');
		check('ab|c\ndef', 'VjAX<Esc>', 'abc\ndef|X');
	});

	test('v_p puts and keeps the replaced text in "" ; v_P does not', () => {
		check('|foo bar', 'yiwwviwp0viwp', 'ba|r foo');
		check('|foo bar', 'yiwwviwP0viwP', 'fo|o foo');
	});

	test('v_* / v_# search for the selection (v_star-default)', () => {
		check('|a.b x a.b', 'vll*', 'a.b x |a.b');
		check('a.b x |a.b', 'vll#', '|a.b x a.b');
	});

	test('v_@ runs a register on every line (v_@-default)', () => {
		check('|a\nb\nc', 'qqA;<Esc>qjVj@q', 'a;\nb;\nc|;');
	});

	test('{count}v, v_iw in linewise visual becomes characterwise', () => {
		check('|abcdef', '3vd', '|def');
		check('|foo bar', 'Viwd', '| bar');
	});
});

suite('Neovim search', () => {

	test('case sensitivity: ignorecase, smartcase', () => {
		check('|x Foo foo', '/foo<CR>', 'x Foo |foo');
		check('|x Foo foo', ':set ic scs<CR>/foo<CR>', 'x |Foo foo');
		check('|x FOO foo', ':set ic scs<CR>/\\W\\w+<CR>', 'x| FOO foo');
		check('|x foo Foo', ':set ic<CR>/Foo<CR>', 'x |foo Foo');
		check('|x foo Foo', ':set ic scs<CR>/Foo<CR>', 'x foo |Foo');
	});

	test('patterns are JavaScript regular expressions, as in VS Code\'s find', () => {
		check('|x foobar foo', '/\\bfoo\\b<CR>', 'x foobar |foo');
		check('|ab aab', '/a{2}<CR>', 'ab |aab');
		check('|cat dog', '/(dog|cat)s?<CR>', 'cat |dog');
		check('|a1 b22', '/\\d+<CR>n', 'a1 b|22');
		check('|foo=bar', '/(?<==)bar<CR>', 'foo=|bar');
		check('|x foo(1)', '/foo\\(<CR>', 'x |foo(1)');
		check('|x a+b', '/a\\+<CR>', 'x |a+b');
		check('|a/b a', '/\\/b<CR>', 'a|/b a');
		// multiline, as VS Code's find: \n matches the line break
		check('|ab\nc\nb\nd', '/b\\nd<CR>', 'ab\nc\n|b\nd');
		check('|ab\nc\nb\nd', '/b\\nd<CR>N', 'ab\nc\n|b\nd');
		// an invalid one is an error, and the cursor stays
		const v = new Vim('|a(b').keys('/(b<CR>');
		assert.strictEqual(v.host.state(), '|a(b');
		assert.match(v.vim.status(), /E383/);
	});

	test('search offsets /e /+1 and n with count; * g* whole and partial words', () => {
		check('|x foo y', '/foo/e<CR>', 'x fo|o y');
		check('|x\nfoo\ny', '/foo/+1<CR>', 'x\nfoo\n|y');
		check('|a x a x a x a', '/a<CR>2n', 'a x a x a x |a');
		check('|a x a x a', '/a<CR>2n', '|a x a x a');
		check('|foo foobar foo', '*', 'foo foobar |foo');
		check('|foo foobar foo', 'g*', 'foo |foobar foo');
		check('|foo x', '*', '|foo x');
	});

	test('hlsearch / incsearch / :noh / CTRL-L', () => {
		const v = new Vim('|abc abc');
		v.keys('/b');
		assert.deepStrictEqual(v.host.incsearch, { start: { line: 0, col: 1 }, end: { line: 0, col: 2 } });
		v.keys('<Esc>');
		assert.strictEqual(v.host.incsearch, undefined);
		assert.strictEqual(v.state(), '|abc abc');
		v.keys('/c<CR>');
		assert.ok(v.host.highlighted);
		v.keys(':noh<CR>');
		assert.strictEqual(v.host.highlighted, undefined);
		v.keys('n');
		assert.ok(v.host.highlighted);
		v.keys('<C-l>');
		assert.strictEqual(v.host.highlighted, undefined);
		const w = new Vim('|a b').keys(':set nohls<CR>/b<CR>');
		assert.strictEqual(w.host.highlighted, undefined);
	});

	test('a Vim search is VS Code\'s find state: regex on, Match Case from ignorecase / smartcase, Whole Word for * and #', () => {
		const q = (pattern: string, matchCase: boolean, wholeWord = false) => ({ pattern, matchCase, wholeWord });
		const v = new Vim('|foo Foo foo.bar');
		v.keys('/foo<CR>');
		assert.deepStrictEqual(v.host.findStateWrites, [{ query: q('foo', true), isNew: true }]);
		v.keys(':set ic scs<CR>/foo<CR>');
		assert.deepStrictEqual(v.host.findState, q('foo', false));
		v.keys('/Foo<CR>');
		assert.deepStrictEqual(v.host.findState, q('Foo', true));
		v.keys('?o\\.b<CR>');
		assert.deepStrictEqual(v.host.findState, q('o\\.b', false));
		// * and #: Whole Word, the case 'ignorecase' alone gives (no 'smartcase')
		v.keys('0*');
		assert.deepStrictEqual(v.host.findState, q('foo', false, true));
		v.keys('#');
		assert.deepStrictEqual(v.host.findState, q('Foo', false, true), '# on the Foo * went to');
		v.keys('g*');
		assert.deepStrictEqual(v.host.findState, q('foo', false));
		// :s and :g set the last search pattern, so the find state follows them too
		v.keys(':s/Fo/Fo/<CR>');
		assert.deepStrictEqual(v.host.findState, q('Fo', true));
		v.keys(':g/bar/m0<CR>');
		assert.deepStrictEqual(v.host.findState, q('bar', false));
		assert.ok(v.host.findStateWrites.every(w => w.isNew));
		// n, N and gn search for it again: the state only catches up (not a new search: no history, no find clipboard)
		v.host.findStateWrites = [];
		v.keys('nNgn<Esc>');
		assert.deepStrictEqual(v.host.findStateWrites.map(w => w.isNew), [false, false, false]);
	});

	test('a search made in the find widget is the last search: n forward, N backward, with the widget\'s Match Case and Whole Word', () => {
		const v = new Vim('a A |x a A a');
		v.keys('?x<CR>');
		v.vim.adoptFindSearch({ pattern: 'a', matchCase: true, wholeWord: false });
		assert.deepStrictEqual(v.host.highlighted, { pattern: 'a', matchCase: true, wholeWord: false });
		// the widget's search is forward whatever the last Vim search was
		v.keys('n');
		assert.strictEqual(v.state(), 'a A x |a A a');
		v.keys('n');
		assert.strictEqual(v.state(), 'a A x a A |a');
		v.keys('N');
		assert.strictEqual(v.state(), 'a A x |a A a');
		// the widget's Match Case wins over 'ignorecase' until the next Vim search
		v.keys(':set ic<CR>n');
		assert.strictEqual(v.state(), 'a A x a A |a');
		assert.deepStrictEqual(v.host.findState, { pattern: 'a', matchCase: true, wholeWord: false });
		v.keys('//<CR>');
		assert.strictEqual(v.state(), '|a A x a A a', '`//` keeps the widget\'s Match Case');
		v.keys('/a<CR>');
		assert.strictEqual(v.state(), 'a |A x a A a', 'a Vim search: \'ignorecase\' again');
		// Whole Word
		const w = new Vim('|ab a ab a');
		w.vim.adoptFindSearch({ pattern: 'a', matchCase: false, wholeWord: true });
		w.keys('n');
		assert.strictEqual(w.state(), 'ab |a ab a');
		assert.deepStrictEqual(w.keys(':reg /<CR>').host.findState, { pattern: 'a', matchCase: false, wholeWord: true });
		// the widget's text cleared: no highlight, the last search stays
		w.vim.adoptFindSearch(undefined);
		assert.strictEqual(w.host.highlighted, undefined);
		assert.strictEqual(w.host.findWidgetClosed, 0, 'the widget the user is typing in stays open');
		w.keys('<Esc>n');
		assert.strictEqual(w.state(), 'ab a ab |a');
	});

	test(':noh and CTRL-L clear the highlight and close the find widget; the last search stays for n', () => {
		const v = new Vim('|a b a b');
		v.keys('/b<CR>');
		v.keys(':noh<CR>');
		assert.strictEqual(v.host.highlighted, undefined);
		assert.strictEqual(v.host.findWidgetClosed, 1);
		v.keys('n');
		assert.ok(v.host.highlighted);
		v.keys('<C-l>');
		assert.strictEqual(v.host.highlighted, undefined);
		assert.strictEqual(v.host.findWidgetClosed, 2);
		// :set nohls only stops drawing: the widget is the user's
		v.keys('n:set nohls<CR>');
		assert.strictEqual(v.host.highlighted, undefined);
		assert.strictEqual(v.host.findWidgetClosed, 2);
	});

	test('the last search is global: another editor\'s find state catches up with it at n; one made in its widget is everyone\'s', () => {
		const shared = new VimSharedState();
		const a = new Vim('|x foo x foo', [], shared);
		const b = new Vim('|foo bar bar', [], shared);
		a.keys('/foo<CR>');
		assert.strictEqual(b.host.findState, undefined, 'the other editor\'s find state is left as it is');
		b.keys('n');
		assert.strictEqual(b.state(), '|foo bar bar');
		assert.deepStrictEqual(b.host.findStateWrites, [{ query: { pattern: 'foo', matchCase: true, wholeWord: false }, isNew: false }]);
		b.vim.adoptFindSearch({ pattern: 'bar', matchCase: true, wholeWord: false });
		a.keys('gg0n');
		assert.strictEqual(a.state(), '|x foo x foo', 'no bar in a: E486');
		assert.ok(a.vim.status().includes('E486: Pattern not found: bar'), a.vim.status());
		assert.deepStrictEqual(a.host.findState, { pattern: 'bar', matchCase: true, wholeWord: false });
		b.keys('n');
		assert.strictEqual(b.state(), 'foo |bar bar');
	});

	test('gn: cgn then . changes the next match', () => {
		check('|foo x foo x foo', '/foo<CR>NcgnX<Esc>..', 'X x X x |X');
		check('|a foo b', '/foo<CR>ggdgn', 'a | b');
		check('|a foo b', '/foo<CR>gggnd', 'a | b');
	});

	test('the prompt: history, CTRL-U CTRL-W CTRL-R', () => {
		const v = new Vim('|a b c').keys('/b<CR>/c<CR>gg/<Up><Up><CR>');
		assert.strictEqual(v.state(), 'a |b c');
		check('|foo bar', '/xx yy<C-w><C-w>bar<CR>', 'foo |bar');
		check('|foo bar', '/xx<C-u>bar<CR>', 'foo |bar');
		check('|foo bar', 'wyiw0/<C-r>"<CR>', 'foo |bar');
	});
});

suite('Neovim scrolling and folds', () => {

	test('CTRL-D CTRL-U scroll and move by half a window', () => {
		const v = new Vim(lines(40));
		v.host.visible = 10;
		v.keys('<C-d>');
		assert.deepStrictEqual([v.host.top, v.host.cursor.line], [5, 5]);
		v.keys('<C-u>');
		assert.deepStrictEqual([v.host.top, v.host.cursor.line], [0, 0]);
		v.keys('3<C-d>');
		assert.deepStrictEqual([v.host.top, v.host.cursor.line], [3, 3]);
	});

	test('CTRL-E CTRL-Y keep the cursor in the window; CTRL-F CTRL-B page', () => {
		const v = new Vim(lines(40));
		v.host.visible = 10;
		v.keys('<C-e>');
		assert.deepStrictEqual([v.host.top, v.host.cursor.line], [1, 1]);
		v.keys('<C-y>');
		assert.deepStrictEqual([v.host.top, v.host.cursor.line], [0, 1]);
		v.keys('<C-f>');
		assert.deepStrictEqual([v.host.top, v.host.cursor.line], [8, 8]);
		v.keys('<C-b>');
		assert.deepStrictEqual([v.host.top, v.host.cursor.line], [0, 8]);
	});

	test('zt zz zb z<CR> z. z-', () => {
		const v = new Vim(lines(40, () => '  ab'));
		v.host.visible = 10;
		v.keys('20Glzt');
		assert.deepStrictEqual([v.host.top, v.host.cursor.line, v.host.cursor.col], [19, 19, 1]);
		v.keys('zz');
		assert.strictEqual(v.host.top, 14);
		v.keys('zb');
		assert.strictEqual(v.host.top, 10);
		v.keys('z<CR>');
		assert.deepStrictEqual([v.host.top, v.host.cursor.col], [19, 2]);
		v.keys('5z.');
		assert.deepStrictEqual([v.host.top, v.host.cursor.line], [0, 4]);
	});

	test('folds, LSP and diagnostics keys run VS Code commands (with counts)', async () => {
		const cmds = async (keys: string) => {
			const v = new Vim('|a\nb\nc').keys(keys);
			await flush();
			return v.host.commands.map(c => c.command);
		};
		assert.deepStrictEqual(await cmds('zc'), ['editor.fold']);
		assert.deepStrictEqual(await cmds('zR'), ['editor.unfoldAll']);
		assert.deepStrictEqual(await cmds('za'), ['editor.toggleFold']);
		assert.deepStrictEqual(await cmds('K'), ['editor.action.showHover']);
		assert.deepStrictEqual(await cmds('grn'), ['editor.action.rename']);
		assert.deepStrictEqual(await cmds('gra'), ['editor.action.quickFix']);
		assert.deepStrictEqual(await cmds('grr'), ['editor.action.goToReferences']);
		assert.deepStrictEqual(await cmds('gri'), ['editor.action.goToImplementation']);
		assert.deepStrictEqual(await cmds('grt'), ['editor.action.goToTypeDefinition']);
		assert.deepStrictEqual(await cmds('gO'), ['workbench.action.gotoSymbol']);
		assert.deepStrictEqual(await cmds('<C-]>'), ['editor.action.revealDefinition']);
		assert.deepStrictEqual(await cmds('3]d'), ['editor.action.marker.next', 'editor.action.marker.next', 'editor.action.marker.next']);
		assert.deepStrictEqual(await cmds('[d'), ['editor.action.marker.prev']);
		assert.deepStrictEqual(await cmds(']D'), ['editor.action.marker.prev']);
		assert.deepStrictEqual(await cmds(']q'), ['editor.action.marker.nextInFiles']);
		assert.deepStrictEqual(await cmds('[b'), ['workbench.action.previousEditor']);
		assert.deepStrictEqual(await cmds('ZZ'), ['devhubVim.update', 'workbench.action.closeActiveEditor', 'devhubVim.tabpage.closeIfEmpty']);
		assert.deepStrictEqual(await cmds('ZQ'), ['workbench.action.revertAndCloseActiveEditor', 'devhubVim.tabpage.closeIfEmpty']);
		// in visual mode gra acts on the selection, then visual mode ends
		const v = new Vim('|abc').keys('vlgra');
		await flush();
		assert.deepStrictEqual(v.host.commands.map(c => [c.command, c.selection]), [['editor.action.quickFix', { start: { line: 0, col: 0 }, end: { line: 0, col: 2 } }]]);
		assert.strictEqual(v.vim.mode, 'normal');
	});
});

suite('DevHub Vim: counts are keybindings; devhubVim.run and devhubVim.repeat take them as args', () => {

	const N = 'textInputFocus && devhubVim.active && devhubVim.acceptsMotion && devhubVim.mode == \'normal\'';
	const calls = async (v: Vim) => {
		await flush();
		return v.host.commands.map(c => [c.command, c.args]);
	};

	test('a count is the digit keys\' devhubVim.count: before an operator, between it and the motion, in visual mode', () => {
		check('|a b c d e f g h', '2d3w', '|g h');
		check('|a b c d e f g h', 'd2w', '|c d e f g h');
		check('|a\nb\nc\nd\ne', 'V2jd', '|d\ne');
		check('|abcdef', '10x', '|');
		// 0 is a digit after one, the line start otherwise
		check('abc|def', '0', '|abcdef');
		const digits = DEFAULT_KEYBINDINGS.filter(b => b.command === 'devhubVim.count').map(b => b.key).sort();
		assert.deepStrictEqual(digits, ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
	});

	test('run: ${count} / ${rawCount} / ${register} are put into the args when the key runs it, then consumed', async () => {
		const user = [{ key: 'g t', command: 'devhubVim.run', args: { command: 'workbench.action.openEditorAtIndex', args: '${count}' }, when: N },
			{ key: 'g shift+t', command: 'devhubVim.run', args: { command: 'x.raw', args: { n: '${rawCount}', label: 'n=${rawCount} r=${register}' } }, when: N }];
		let v = new Vim('|abc', user).keys('3gt');
		assert.deepStrictEqual(await calls(v), [['workbench.action.openEditorAtIndex', 3]]);
		assert.strictEqual(v.vim.context().hasCount, false);
		v = new Vim('|abc', user).keys('gt');
		assert.deepStrictEqual(await calls(v), [['workbench.action.openEditorAtIndex', 1]]);
		v = new Vim('|abc', user).keys('gT');
		assert.deepStrictEqual(await calls(v), [['x.raw', { n: null, label: 'n= r="' }]]);
		v = new Vim('|abc', user).keys('"a12gT');
		assert.deepStrictEqual(await calls(v), [['x.raw', { n: 12, label: 'n=12 r=a' }]]);
		// the next command has no count left
		v = new Vim('|abcdef', user).keys('3gtx');
		await flush();
		assert.strictEqual(v.state(), '|bcdef');
	});

	test('repeat: a literal count, a ${count} count, ${it} and ${index}', async () => {
		const user = [{ key: 'ctrl+n', command: 'devhubVim.repeat', args: { command: 'editor.action.marker.next', count: '${count}' }, when: N },
			{ key: 'g a', command: 'devhubVim.repeat', args: { command: 'x.it', args: { it: '${it}', index: '${index}', s: '#${it}' }, count: 3 }, when: N },
			{ key: 'g b', command: 'devhubVim.repeat', args: { command: 'devhubVim.motion', args: { motion: 'right' }, count: '${count}' }, when: N }];
		let v = new Vim('|abc', user).keys('3<C-n>');
		assert.deepStrictEqual(await calls(v), [['editor.action.marker.next', undefined], ['editor.action.marker.next', undefined], ['editor.action.marker.next', undefined]]);
		v = new Vim('|abc', user).keys('<C-n>');
		assert.deepStrictEqual((await calls(v)).length, 1);
		v = new Vim('|abc', user).keys('5ga');
		assert.deepStrictEqual(await calls(v), [['x.it', { it: 1, index: 0, s: '#1' }], ['x.it', { it: 2, index: 1, s: '#2' }], ['x.it', { it: 3, index: 2, s: '#3' }]]);
		v = new Vim('|abcdef', user).keys('3gb');
		assert.strictEqual(v.state(), 'abc|def');
		// a literal count of 0 runs nothing
		v = new Vim('|abcdef', [{ key: 'g b', command: 'devhubVim.repeat', args: { command: 'devhubVim.motion', args: { motion: 'right' }, count: 0 }, when: N }]).keys('gb');
		assert.strictEqual(v.state(), '|abcdef');
	});

	test('repeat of run: one Vim action, nested repeats see their own ${it}', async () => {
		const user = [{
			key: 'g a', when: N, command: 'devhubVim.repeat', args: {
				count: 2, command: 'devhubVim.repeat', args: { count: '${it}', command: 'x.inner', args: { inner: '${it}' } },
			},
		}, {
			key: 'g b', when: 'textInputFocus && devhubVim.active && devhubVim.acceptsMotion', command: 'devhubVim.repeat',
			args: { command: 'devhubVim.run', args: { command: 'x.sel', args: '${it}' }, count: '${count}' },
		}];
		let v = new Vim('|abc', user).keys('ga');
		// the outer loop's ${it} is the inner count (1, then 2); inside, the inner loop's
		assert.deepStrictEqual(await calls(v), [['x.inner', { inner: 1 }], ['x.inner', { inner: 1 }], ['x.inner', { inner: 2 }]]);
		v = new Vim('|abc', user).keys('vl2gb');
		const sel = { start: { line: 0, col: 0 }, end: { line: 0, col: 2 } };
		await flush();
		assert.deepStrictEqual(v.host.commands.map(c => [c.command, c.args, c.selection]), [['x.sel', 1, sel], ['x.sel', 2, sel]]);
		assert.strictEqual(v.vim.mode, 'normal');
	});

	test('a macro replays the expanded values; the count is consumed once', async () => {
		const user = [{ key: 'g t', command: 'devhubVim.run', args: { command: 'x.tab', args: '${count}' }, when: N }];
		const v = new Vim('|abc', user).keys('qa4gtq');
		await flush();
		v.host.commands = [];
		v.keys('@a');
		assert.deepStrictEqual(await calls(v), [['x.tab', 4]]);
		v.host.commands = [];
		// a count on @a replays the macro that many times, each with the value recorded
		v.keys('2@a');
		assert.deepStrictEqual(await calls(v), [['x.tab', 4], ['x.tab', 4]]);
	});

	test('${char} after awaitChar', async () => {
		const user = [{ key: 'g c', command: 'devhubVim.awaitChar', args: { then: { command: 'devhubVim.run', args: { command: 'x.char', args: { c: '${char}', n: '${count}' } } } }, when: N },
			{ key: 'g d', command: 'devhubVim.awaitChar', args: { then: { command: 'x.direct', args: { c: 'got ${char}' } } }, when: N }];
		let v = new Vim('|abc', user).keys('2gcz');
		assert.deepStrictEqual(await calls(v), [['x.char', { c: 'z', n: 2 }]]);
		v = new Vim('|abc', user).keys('gdq');
		assert.deepStrictEqual(await calls(v), [['x.direct', { c: 'got q', char: 'q' }]]);
	});

	test('the default keymap: a count repeats ]d, is dropped by K', async () => {
		const repeated = DEFAULT_KEYBINDINGS.find(b => b.key === '[Backslash] d')!;
		assert.deepStrictEqual([repeated.command, repeated.args], ['devhubVim.repeat', { command: 'devhubVim.run', args: { command: 'editor.action.marker.next' }, count: '${count}' }]);
		const once = DEFAULT_KEYBINDINGS.find(b => b.key === 'shift+k')!;
		assert.deepStrictEqual([once.command, once.args], ['devhubVim.run', { command: 'editor.action.showHover' }]);
		const v = new Vim('|abc').keys('3K');
		assert.deepStrictEqual(await calls(v), [['editor.action.showHover', undefined]]);
	});
});

suite('Neovim macros and repeats', () => {

	test('Q replays the last recorded register (Q-default); @@', () => {
		check('|a\nb\nc\nd', 'qaA;<Esc>jqQ', 'a;\nb;\n|c\nd');
		check('|a\nb\nc\nd', 'qaA;<Esc>jq2Q', 'a;\nb;\nc;\n|d');
		check('|a\nb\nc\nd', 'qaA;<Esc>jq@a@@', 'a;\nb;\nc;\n|d');
	});

	test('a register holding text runs as keys; @: repeats the command line', () => {
		check('|dw\nx y z', '"ayiwj@a', 'dw\n|y z');
		check('|a\nb\nc', ':s/$/!/<CR>j@:j@@', 'a!\nb!\n|c!');
	});

	test('& repeats :s on the line with the same flags (&-default), g& on every line', () => {
		check('|aa\naa', ':s/a/b/g<CR>j&', 'bb\n|bb');
		check('|aa\naa\naa', ':s/a/b/<CR>g&', 'bb\nba\n|ba');
	});
});

suite('Neovim ex commands', () => {

	test(':s with flags g i n e and ranges % \'<,\'> N,M and a count', () => {
		check('|aaa', ':s/a/b/<CR>', '|baa');
		check('|aaa', ':s/a/b/g<CR>', '|bbb');
		check('|AaA', ':s/a/x/gi<CR>', '|xxx');
		check('|a\na\na', ':%s/a/b/<CR>', 'b\nb\n|b');
		check('|a\na\na\na', ':2,3s/a/b/<CR>', 'a\nb\n|b\na');
		check('a\n|a\na\na', 'Vj:s/a/c/<CR>', 'a\nc\n|c\na');
		check('|a\na\na\na', ':s/a/b/ 2<CR>', 'b\n|b\na\na');
		const n = new Vim('|aaa\na').keys(':%s/a//gn<CR>');
		assert.strictEqual(n.host.lines.join('\n'), 'aaa\na');
		assert.ok(n.vim.status().includes('4 matches on 2 lines'), n.vim.status());
		const nf = new Vim('|a').keys(':s/x/y/<CR>');
		assert.ok(nf.vim.status().includes('E486'), nf.vim.status());
		const e = new Vim('|a').keys(':s/x/y/e<CR>');
		assert.ok(!e.vim.status().includes('E486'), e.vim.status());
	});

	test(':s is VS Code\'s find: JavaScript regex, the range and its lines only, smartcase, i / I', () => {
		check('|a1 a2\nb a3\na4', ':1,2s/a(\\d)/<$1>/g<CR>', '<1> <2>\n|b <3>\na4');
		check('|x.y xzy', ':s/x\\.y/Q/g<CR>', '|Q xzy');
		check('|Ab ab', ':set ic scs<CR>:s/ab/X/g<CR>', '|X X');
		check('|Ab ab', ':set ic scs<CR>:s/Ab/X/g<CR>', '|X ab');
		check('|Ab ab', ':s/ab/X/gi<CR>', '|X X');
		check('|Ab ab', ':set ic<CR>:s/ab/X/gI<CR>', '|Ab X');
		// a multiline match: one edit, one undo step
		const v = new Vim('|a\nb\na\nb').keys(':%s/a\\nb/ab/<CR>');
		assert.strictEqual(v.host.state(), 'ab\n|ab');
		v.keys('u');
		assert.strictEqual(v.host.lines.join('\n'), 'a\nb\na\nb');
		// an invalid pattern is an error, the text stays
		const w = new Vim('|a(b').keys(':s/(/x/<CR>');
		assert.strictEqual(w.host.state(), '|a(b');
		assert.match(w.vim.status(), /E383/);
	});

	test('inccommand: what :s would do while it is typed, matches only while the pattern is, nothing after Esc or Enter', () => {
		const v = new Vim('|a1 a2\nb a3\na4');
		const shown = () => v.host.preview?.map(x => `${x.range.start.line}:${x.range.start.col}-${x.range.end.line}:${x.range.end.col}=${x.text ?? '(match)'}`);
		v.keys(':%s/a');
		assert.deepStrictEqual(shown(), ['0:0-0:1=(match)', '1:2-1:3=(match)', '2:0-2:1=(match)']);
		v.keys('(\\d');
		// half typed: no preview, no error
		assert.strictEqual(v.host.preview, undefined);
		v.keys(')/[$1]');
		assert.deepStrictEqual(shown(), ['0:0-0:2=[1]', '1:2-1:4=[3]', '2:0-2:2=[4]']);
		v.keys('/g');
		assert.deepStrictEqual(shown(), ['0:0-0:2=[1]', '0:3-0:5=[2]', '1:2-1:4=[3]', '2:0-2:2=[4]']);
		v.keys('<Esc>');
		assert.strictEqual(v.host.preview, undefined);
		assert.strictEqual(v.host.lines.join('\n'), 'a1 a2\nb a3\na4');
		// the range: only its lines; Enter replaces and the preview goes
		v.keys(':2,3s/a/X/');
		assert.deepStrictEqual(shown(), ['1:2-1:3=X', '2:0-2:1=X']);
		v.keys('<CR>');
		assert.strictEqual(v.host.preview, undefined);
		assert.strictEqual(v.host.lines.join('\n'), 'a1 a2\nb X3\nX4');
		// not :s, or off: nothing
		v.keys(':sort');
		assert.strictEqual(v.host.preview, undefined);
		v.keys('<Esc>');
		const off = new VimSharedState();
		off.inccommand = '';
		const w = new Vim('|a', [], off).keys(':s/a/b/');
		assert.strictEqual(w.host.preview, undefined);
	});

	test('inccommand shows the lines on screen (and a few around), at most a thousand', () => {
		const v = new Vim(lines(400, () => 'aaaa'));
		v.host.visible = 10;
		v.keys(':%s/a/b/g');
		const p = v.host.preview!;
		assert.ok(p.length > 0 && p.length <= 1000, String(p.length));
		assert.ok(p.every(x => x.range.start.line <= 9 + 50), 'only around the window');
	});

	test(':s///c asks for every match: y n a q l <Esc>', () => {
		check('|aaa\naa', ':%s/a/b/gc<CR>yny', 'bab\n|aa');
		check('|aaa\naa', ':%s/a/b/gc<CR>ya', 'bbb\n|bb');
		check('|aaa\naa', ':%s/a/b/gc<CR>nq', '|aaa\naa');
		check('|aaa\naa', ':%s/a/b/gc<CR>nl', '|aba\naa');
		check('a|aa\naa', ':%s/a/b/gc<CR>nnnnn', 'a|aa\naa');
		check('|aaa\naa', ':%s/a/b/c<CR>yy', 'baa\n|ba');
		const v = new Vim('|aaa').keys(':s/a/b/gc<CR>y');
		assert.ok(v.vim.status().includes('(y/n/a/q/l)'), v.vim.status());
		assert.deepStrictEqual(v.host.incsearch, { start: { line: 0, col: 1 }, end: { line: 0, col: 2 } });
		v.keys('<Esc>');
		assert.strictEqual(v.state(), '|baa');
		assert.strictEqual(v.vim.pending, false);
		assert.strictEqual(v.host.incsearch, undefined);
		v.keys('u');
		assert.strictEqual(v.host.lines[0], 'aaa');
	});

	test(':s replacement specials: & \\0 \\1 \\u \\U \\r ~, other delimiters, empty pattern', () => {
		check('|ab', ':s/(a)(b)/$2$1/<CR>', '|ba');
		check('|abc', ':s/b/[$&]/<CR>', '|a[b]c');
		check('|abc', ':s/b/&/<CR>', '|a&c');
		check('|a,b,c', ':s/,/\\n/g<CR>', 'a\nb\n|c');
		check('|a\nb\nc', ':%s/a\\nb/x/<CR>', '|x\nc');
		check('|a/b', ':s#/#-#<CR>', '|a-b');
		check('|x a a', '/a<CR>:s//b/g<CR>', '|x b b');
		check('|ab\nab', ':s/a/X/<CR>j:s/b/~Y/<CR>', 'Xb\n|a~Y');
	});

	test(':g :v with :d :s :normal :m0, one undo step', () => {
		check('|a1\nb\na2\nc', ':g/a/d<CR>', 'b\n|c');
		check('|a1\nb\na2\nc', ':v/a/d<CR>', 'a1\n|a2');
		check('|a1\nb\na2', ':g/a/s/\\d/X/<CR>', 'aX\nb\n|aX');
		check('|a\nb\nc', ':g/^/m0<CR>', '|c\nb\na');
		check('|a\nb\nc', ':g/[ac]/normal Ax<CR>', 'ax\nb\nc|x');
		const v = new Vim('|a1\nb\na2\nc').keys(':g/a/d<CR>u');
		assert.strictEqual(v.host.lines.join('\n'), 'a1\nb\na2\nc');
	});

	test(':d :y :m :t :co :j :> :pu :normal :k with ranges and counts', () => {
		check('|a\nb\nc\nd', ':2,3d<CR>', 'a\n|d');
		check('|a\nb\nc\nd', ':d 2<CR>', '|c\nd');
		check('|a\nb', ':y x<CR>"xp', 'a\n|a\nb');
		check('|a\nb\nc', ':m$<CR>', 'b\nc\n|a');
		check('a\nb\n|c', ':m0<CR>', '|c\na\nb');
		check('|a\nb\nc', ':1,2m$<CR>', 'c\na\n|b');
		check('|a\nb', ':t.<CR>', 'a\n|a\nb');
		check('|a\nb', ':co$<CR>', 'a\nb\n|a');
		check('|a\nb\nc', ':j<CR>', '|a b\nc');
		check('|a\nb\nc', ':1,3j!<CR>', '|abc');
		check('|a\nb', ':><CR>', '\t|a\nb');
		check('|a\nb', ':%><CR>', '\ta\n\t|b');
		check('|a', 'yy:pu<CR>', 'a\n|a');
		check('|a\nb', ':%norm Ax<CR>', 'ax\nb|x');
		check('|a\nb\nc', ':3ka<CR>gg\'add', 'a\n|b');
		check('|a\nb\nc', ':2<CR>dd', 'a\n|c');
	});

	test(':sort with ! i n u r /pat/', () => {
		check('|c\na\nb', ':sort<CR>', '|a\nb\nc');
		check('|c\na\nb', ':sort!<CR>', '|c\nb\na');
		check('|b\nA\nc', ':sort i<CR>', '|A\nb\nc');
		check('|x10\nx9\nx100', ':sort n<CR>', '|x9\nx10\nx100');
		check('|b\na\nb\na', ':sort u<CR>', '|a\nb');
		check('|a3 z\nb1 y\nc2 x', ':sort /[a-z]\\d /<CR>', '|c2 x\nb1 y\na3 z');
		check('|a3\nb1\nc2', ':sort /\\d/ r<CR>', '|b1\nc2\na3');
	});

	test(':set, abbreviations, | between commands', () => {
		const v = new Vim('|a');
		v.keys(':set ic?<CR>');
		assert.strictEqual(v.vim.status(), 'NORMAL  noignorecase');
		v.keys(':se ic<CR>:set ic?<CR>');
		assert.strictEqual(v.vim.status(), 'NORMAL  ignorecase');
		v.keys(':set noic tw=20<CR>:set tw?<CR>');
		assert.strictEqual(v.vim.status(), 'NORMAL  textwidth=20');
		v.keys(':set nonsense<CR>');
		assert.ok(v.vim.status().includes('E518'), v.vim.status());
		check('|a\nb\nc', ':1d|1d<CR>', '|c');
		const s = new Vim('|a').keys(':sp<CR>');
		// (the second step, devhubVim.open, runs once the split is awaited)
		assert.deepStrictEqual(s.host.commands.map(c => c.command), ['workbench.action.splitEditorUp']);
		const w = new Vim('|a').keys(':wri<CR>');
		assert.deepStrictEqual(w.host.commands.map(c => c.command), ['workbench.action.files.save']);
	});

	test('{count}: is .,.+N-1', () => {
		const v = new Vim('|a\nb\nc\nd').keys('3:');
		assert.strictEqual(v.promptText(), '.,.+2');
		assert.deepStrictEqual(v.vim.cmdlineState && { kind: v.vim.cmdlineState.kind, text: v.vim.cmdlineState.text }, { kind: ':', text: '.,.+2' });
		v.keys('d<CR>');
		assert.strictEqual(v.state(), '|d');
	});

	test('devhub.vim.options sets options at startup', () => {
		const shared = new VimSharedState();
		shared.setOptions({ ignorecase: true, smartcase: true, tw: 30 });
		assert.strictEqual(shared.options.ignorecase, true);
		assert.strictEqual(shared.options.textwidth, 30);
		const v = new Vim('|x Foo foo', [], shared).keys('/foo<CR>');
		assert.strictEqual(v.state(), 'x |Foo foo');
	});
});

suite('Neovim keymap details', () => {

	test('Esc from every new pending state is plain normal mode', () => {
		for (const keys of ['m', '`', '\'', 'gr', 'z', '[', ']', 'R', '<C-v>', 'dv', 'g', 'gu', 'gc', 'Z', 'i<C-r>', 'i<C-o>', 'v<C-v>', 'cgn']) {
			const { vim, v } = run('ab|c\ndef', keys);
			for (let i = 0; i < 4; i++) {
				v.press('<Esc>');
			}
			assert.strictEqual(vim.mode, 'normal', keys);
			assert.strictEqual(vim.pending, false, keys);
		}
	});

	test('JIS: g* [( ]) & ) are ordinary chords', () => {
		const jis = (text: string, keys: string) => new Vim(text).keys(keys).state();
		assert.strictEqual(jis('|foo foobar foo', 'g*'), 'foo |foobar foo');
		assert.strictEqual(jis('f(a, (b|), c)', '[('), 'f(a, |(b), c)');
		assert.strictEqual(jis('f(a, (b), |c)', '])'), 'f(a, (b), c|)');
		assert.strictEqual(jis('|aa\naa', ':s/a/b/<CR>j&'), 'ba\n|ba');
		assert.strictEqual(jis('|One. Two', ')'), 'One. |Two');
	});

	test(':normal runs keys through the default keymap', () => {
		check('|a b c', ':normal dw<CR>', '|b c');
		check('|abc', ':exe<CR>', '|abc');
		check('|abc', ':norm! 2x<CR>', '|c');
		const v = new Vim('|a\nb');
		v.vim.feedKeys('ix<Esc>j.');
		assert.strictEqual(v.state(), 'xa\n|xb');
		// <Esc> typed into the prompt ends it, as in Vim
		check('|a\nb', ':norm! ix<Esc>', '|a\nb');
	});
});

// The expected results of the single-line cases (and of the multi-line ones
// where DevHub does what vim-surround does) are what Vim 9.1 with
// tpope/vim-surround and vim-repeat produce from the same text and keys
// (`vim -Nu NONE`: no 'indentexpr', so no s:reindent; 'noexpandtab', as the
// test host).
suite('vim-surround (tpope/vim-surround)', () => {

	test('ds: brackets (opening ones take the blanks inside), quotes, tags, punctuation, a C comment; a count is the n-th pair out', () => {
		check('foo( |bar ) baz', 'ds(', 'foo|bar baz');
		check('foo( |bar ) baz', 'ds)', 'foo| bar  baz');
		check('foo( |bar ) baz', 'dsb', 'foo| bar  baz');
		check('x = { |a: 1 };', 'ds{', 'x = |a: 1;');
		check('x = { |a: 1 };', 'ds}', 'x = | a: 1 ;');
		check('x = { |a: 1 };', 'dsB', 'x = | a: 1 ;');
		check('a[ |1 ]', 'ds[', 'a|1');
		check('a[ |1 ]', 'ds]', 'a| 1 ');
		check('a[ |1 ]', 'dsr', 'a| 1 ');
		check('List< |T >', 'ds<', 'List|T');
		check('List< |T >', 'ds>', 'List| T ');
		check('List< |T >', 'dsa', 'List| T ');
		check('say "hel|lo" now', 'ds"', 'say |hello now');
		check('say \'hel|lo\' now', 'ds\'', 'say |hello now');
		check('say `hel|lo` now', 'ds`', 'say |hello now');
		check('|say "hello" now', 'ds"', 'say |hello now');
		check('f(a, (b|c))', 'ds(', 'f(a, |bc)');
		check('f(a, (b|c))', '2ds(', 'f|a, (bc)');
		check('f(a, (b|c))', 'ds2(', 'f|a, (bc)');
		// d2s( too (the count of `d`, as `2ds(`; vim-surround has no such key)
		check('f(a, (b|c))', 'd2s(', 'f|a, (bc)');
		check('<div><p>t|ext</p></div>', 'dst', '<div>|text</div>');
		check('<div><p>t|ext</p></div>', '2dst', '|<p>text</p>');
		check('<a href="x">li|nk</a>', 'dst', '|link');
		check('a *b|old* c', 'ds*', 'a |bold c');
		check('a *|bold* c', 'ds*', 'a |bold c');
		check('a |*bold* c', 'ds*', 'a |bold c');
		check('a _x|_ c', 'ds_', 'a |x c');
		check('a +|x+ c', 'ds+', 'a |x c');
		// (the first `|` is the cursor; vim-surround's `:normal` takes this one as a command separator)
		check('a ||x| c', 'ds|', 'a |x c');
		check('a \\|x\\ c', 'ds\\', 'a |x c');
		check('x /* com|ment */ y', 'ds/', 'x |comment y');
		check('( |a )', 'ds )', '|a');
	});

	test('ds that finds nothing to remove does nothing (and is not what . repeats)', () => {
		check('(|)', 'ds(', '(|)');
		check('f(|)', 'ds(', 'f(|)');
		check('foo(|bar)', 'dsx', 'foo(|bar)');
		check('foo b|ar baz', 'dsw', 'foo |bar baz');
		check('a |b c', 'ds(', 'a |b c');
		check('(a) |b (c)', 'ds(', '(a) |b (c)');
		check('(|a) b (c)', 'ds(Wds(W.', 'a b |c');
	});

	test('cs: the old pair for a new one; a tag replacement asks for the tag and keeps the old attributes unless it ends in >', () => {
		check('call( |x )', 'cs([', 'call|[ x ]');
		check('call( |x )', 'cs(]', 'call|[x]');
		check('call( |x )', 'cs){', 'call|{  x  }');
		check('call( |x )', 'cs(}', 'call|{x}');
		check('call( |x )', 'cs(b', 'call|(x)');
		check('call( |x )', 'cs(B', 'call|{x}');
		check('call( |x )', 'cs(r', 'call|[x]');
		check('call( |x )', 'cs(a', 'call|<x>');
		check('call( |x )', 'cs(>', 'call|<x>');
		check('call( |x )', 'cs("', 'call|"x"');
		check('say "h|i" now', 'cs"\'', 'say |\'hi\' now');
		check('say \'h|i\' now', 'cs\'`', 'say |`hi` now');
		check('say "h|i" now', 'cs"(', 'say |( hi ) now');
		check('say "h|i" now', 'cs")', 'say |(hi) now');
		check('call( |x )', 'cs(*', 'call|*x*');
		check('call( |x )', 'cs(1', 'call|1x1');
		check('call( |x )', 'cs(x', 'call|x');
		check('call( |x )', 'cs(s', 'call| x');
		check('call( |x )', 'cs(:', 'call|:x');
		check('call( |x )', 'cs(p', 'cal|l\nx\n\n');
		check('call( |x )', 'cs( (', 'call|(  x  )');
		check('say "h|i" now', 'cs"t<lt>em>', 'say |<<em>hi</<em> now');
		check('say "h|i" now', 'cs"tem>', 'say |<em>hi</em> now');
		check('say "h|i" now', 'cs"tem<CR>', 'say |<em>hi</em> now');
		check('say "h|i" now', 'cs"<lt>em>', 'say |<em>hi</em> now');
		check('<p id="a">h|i</p>', 'csttdiv>', '|<div>hi</div>');
		check('<p id="a">h|i</p>', 'csttdiv class="x"<CR>', '|<div class="x" id="a">hi</div>');
		check('<p id="a">h|i</p>', 'csttdiv class="x">', '|<div class="x">hi</div>');
		check('<p id="a">h|i</p>', 'cst"', '|"hi"');
		check('<p id="a">h|i</p>', 'csttbr/>', '|<br />hi');
		check('(h|i)', 'cs(tbr/>', '|<br />hi');
		check('f(a, (b|c))', '2cs([', 'f|[ a, (bc) ]');
		check('f(a, (b|c))', 'cs2([', 'f|[ a, (bc) ]');
	});

	test('cs w / W / s / p surround the text object (csw( is ysiw(); cS puts the pair on lines of its own', () => {
		check('foo b|ar baz', 'csw(', 'foo |( bar ) baz');
		check('foo b|ar baz', 'csW"', 'foo |"bar" baz');
		check('foo b|ar baz', 'csw (', 'foo |(  bar  ) baz');
		check('foo b|ar baz', 'csw  ', 'foo | bar  baz');
		check('call( |x )', 'cS([', 'call|[\n\tx\n]');
		check('  call(|x)', 'cS({', '  call|{\n\t  x\n  }');
	});

	test('ys{motion} / ys{text object}: an opening bracket puts blanks inside, a closing one does not; counts on ys and on the motion', () => {
		check('foo |bar baz', 'ysiw(', 'foo |( bar ) baz');
		check('foo |bar baz', 'ysiw)', 'foo |(bar) baz');
		check('foo |bar baz', 'ysiwb', 'foo |(bar) baz');
		check('foo |bar baz', 'ysiw{', 'foo |{ bar } baz');
		check('foo |bar baz', 'ysiw}', 'foo |{bar} baz');
		check('foo |bar baz', 'ysiwB', 'foo |{bar} baz');
		check('foo |bar baz', 'ysiw[', 'foo |[ bar ] baz');
		check('foo |bar baz', 'ysiw]', 'foo |[bar] baz');
		check('foo |bar baz', 'ysiwr', 'foo |[bar] baz');
		check('foo |bar baz', 'ysiw>', 'foo |<bar> baz');
		check('foo |bar baz', 'ysiwa', 'foo |<bar> baz');
		check('foo |bar baz', 'ysiw"', 'foo |"bar" baz');
		check('foo |bar baz', 'ysiw\'', 'foo |\'bar\' baz');
		check('foo |bar baz', 'ysiw`', 'foo |`bar` baz');
		check('foo |bar baz', 'ysiw*', 'foo |*bar* baz');
		check('foo |bar baz', 'ysiw_', 'foo |_bar_ baz');
		check('foo |bar baz', 'ysiw-', 'foo |-bar- baz');
		check('foo |bar baz', 'ysiw1', 'foo |1bar1 baz');
		check('foo |bar baz', 'ysiwx', 'foo |bar baz');
		check('foo |bar baz', 'ysiws', 'foo | bar baz');
		check('foo |bar baz', 'ysiw:', 'foo |:bar baz');
		check('foo |bar baz', 'ysiw (', 'foo |(  bar  ) baz');
		check('foo |bar baz', 'ysiw )', 'foo |( bar ) baz');
		check('foo |bar baz', 'ysiw  ', 'foo | bar  baz');
		check('foo |bar baz', 'ysw)', 'foo |(bar) baz');
		check('foo |bar baz', 'ys2w)', 'foo |(bar baz)');
		check('foo |bar baz', '2ysw)', 'foo |(bar baz)');
		check('foo |bar baz', 'ys$"', 'foo |"bar baz"');
		check('foo |bar baz', 'ys3l"', 'foo |"bar" baz');
		check('foo |bar baz', 'ysfa*', 'foo |*ba*r baz');
		check('foo |bar baz', 'ysta*', 'foo |*b*ar baz');
		check('foo |bar   baz', 'ysw)', 'foo |(bar)   baz');
		check('foo |bar baz', 'ysaw)', 'foo |(bar) baz');
		check('foo b|ar baz', 'ysiW]', 'foo |[bar] baz');
		check('f(|a, b)', 'ysi("', 'f(|"a, b")');
		check('f(|a, b)', 'ysa("', 'f|"(a, b)"');
		check('|foo bar', 'ys/b<CR>)', '|(foo) bar');
	});

	test('ys with a tag: t or < asks for it, > or Enter ends it, a trailing / makes it self-closing, an empty one surrounds with nothing', () => {
		check('foo |bar baz', 'ysiwtdiv>', 'foo |<div>bar</div> baz');
		check('foo |bar baz', 'ysiw<lt>div class="x">', 'foo |<div class="x">bar</div> baz');
		check('foo |bar baz', 'ysiw<lt>div class="x"<CR>', 'foo |<div class="x">bar</div> baz');
		check('foo |bar baz', 'ysiwtbr/>', 'foo |<br />bar baz');
		check('foo |bar baz', 'ysiwt<CR>', 'foo |bar baz');
		// T offers the tag ds / cs removed last
		const v = new Vim('<p id="a">|x</p> y').keys('dstWysiwT');
		assert.strictEqual(v.promptText(), 'p id="a"');
		v.keys('<CR>');
		assert.strictEqual(v.state(), 'x |<p id="a">y</p>');
		// the prompt's history is Vim's input history, not the search's
		assert.deepStrictEqual(v.shared.history['@'], ['p id="a"']);
		assert.deepStrictEqual(v.shared.history['/'], []);
	});

	test('yss / ySS: the line from its first non-blank (blanks at its end stay out), with a count that many lines; yS / ySS on lines of their own, indented', () => {
		check('  foo |bar  ', 'yss)', '  |(foo bar)  ');
		check('  foo |bar  ', 'yss(', '  |( foo bar )  ');
		check('  foo |bar', 'yss"', '  |"foo bar"');
		check('a|b\ncd\nef', '2yss)', '|(ab\ncd)\nef');
		check('|', 'yss)', '|()');
		check('  |  ', 'yss)', '|()    ');
		check('  foo |bar', 'ySS{', '|  {\n\t  foo bar\n  }');
		check('  foo |bar', 'ySs{', '|  {\n\t  foo bar\n  }');
		check('  foo |bar', 'yS$(', '  foo |(\n\t  bar\n  )');
		check('  foo |bar', 'ySiwtp>', '  foo |<p>\n\t  bar\n  </p>');
		// the indent is the buffer's: a 'shiftwidth' of spaces with 'expandtab'
		const v = new Vim('  foo |bar');
		v.host.indent = { tabSize: 4, indentSize: 2, insertSpaces: true };
		v.keys('ySS{');
		assert.strictEqual(v.state(), '|  {\n    foo bar\n  }');
	});

	test('a linewise motion or text object: the pair on lines of its own at the indent of the first line', () => {
		check('  |foo\n  bar\n\nbaz', 'ysip{', '|  {\n  foo\n  bar\n  }\n\nbaz');
		check('  |foo\n  bar\n\nbaz', 'ySip{', '|  {\n\t  foo\n\t  bar\n  }\n\nbaz');
		check('  |foo\n  bar', 'ysj(', '|  (\n  foo\n  bar\n  )');
		check('  |foo\n  bar', 'yS2j{', '|  {\n\t  foo\n\t  bar\n  }');
		check('|foo\nbar', 'ysj"', '|"\nfoo\nbar\n"');
		check('|foo\nbar', 'ysjtdiv>', '|<div>\nfoo\nbar\n</div>');
		check('  |foo\n  bar', 'ysjp', '|  \n  foo\n  bar\n  \n  ');
		check('|foo\nbar', 'ysj (', '|(\nfoo\nbar\n)');
	});

	test('visual S: characterwise around the selection, linewise on lines of their own (indented), blockwise on each line; gS the other way round', () => {
		check('foo |bar baz', 'veS)', 'foo |(bar) baz');
		check('foo |bar baz', 'veS(', 'foo |( bar ) baz');
		check('foo |bar baz', 'veS"', 'foo |"bar" baz');
		check('foo |bar baz', 'vegS{', 'foo |{\n\tbar\n} baz');
		check('foo |bar baz', 'veStem>', 'foo |<em>bar</em> baz');
		check('foo |bar  baz', 'vlllS)', 'foo |(bar ) baz');
		check('  |foo\n  bar', 'VjS{', '|  {\n\t  foo\n\t  bar\n  }');
		check('  |foo\n  bar', 'VjgS{', '|  {\n  foo\n  bar\n  }');
		check('  |foo\n  bar', 'VS"', '|  "\n\t  foo\n  "\n  bar');
		check('  |foo\n  bar', 'VjStdiv>', '|  <div>\n\t  foo\n\t  bar\n  </div>');
		check('|abc\ndef\nghi', '<C-v>jlS)', '|(ab)c\n(de)f\nghi');
		check('|abc\ndef\nghi', '<C-v>jlS(', '|( ab )c\n( de )f\nghi');
		check('x|abc\nydef', '<C-v>jlS"', 'x|"ab"c\ny"de"f');
		check('|ab\nabcd', '<C-v>j$S]', '|[ab]\n[abcd]');
		// S is no longer substitute-line in visual mode; R still is, and S in normal mode
		check('|ab\ncd', 'VRx<Esc>', '|x\ncd');
		check('|ab\ncd', 'Sx<Esc>', '|x\ncd');
	});

	test('several lines: ds takes away the lines the pair was alone on, cs keeps the lines as they are', () => {
		// (vim-surround joins the first line inside to the line of the opening bracket and leaves blank lines)
		check('foo(() => {\n  |bar();\n});', 'ds{', 'foo(() =>\n  |bar();\n);');
		check('<div>\n  |x\n</div>', 'dst', '|  x');
		check('<div>\n  |a\n  b\n</div>', 'dst', '|  a\n  b');
		check('foo(\n  |a,\n  b\n)', 'ds(', 'foo\n  |a,\n  b');
		check('{\n  |b\n}', 'ds{', '|  b');
		check('foo(() => {\n  |bar();\n});', 'cs{(', 'foo(() => |(\n  bar();\n));');
		check('if (a) {\n  |b\n}', 'cs{[', 'if (a) |[\n  b\n]');
		check('<div>\n  |x\n</div>', 'csttsection>', '|<section>\n  x\n</section>');
		check('(a,\n |b)', 'ds(', '|a,\n b');
	});

	test('one undo step each', () => {
		const undo = (text: string, keys: string, changed: string) => {
			const v = new Vim(text).keys(keys);
			assert.strictEqual(v.state(), changed, keys);
			v.keys('u');
			assert.strictEqual(v.host.lines.join('\n'), text.replace('|', ''), `${keys} u`);
			v.keys('<C-r>');
			assert.strictEqual(v.host.lines.join('\n'), changed.replace('|', ''), `${keys} u <C-r>`);
		};
		undo('a (|b) c', 'ds(', 'a |b c');
		undo('a (|b) c', 'cs([', 'a |[ b ] c');
		undo('a <p>|b</p> c', 'csttdiv class="x">', 'a |<div class="x">b</div> c');
		undo('a |b c', 'ysiw)', 'a |(b) c');
		undo('  a |b', 'ySS{', '|  {\n\t  a b\n  }');
		undo('|ab\ncd', '<C-v>jS"', '|"a"b\n"c"d');
		undo('{\n  |b\n}', 'ds{', '|  b');
	});

	test('. repeats ds, cs and ys (with the tag, without asking again), with their count; visual S on as much text from the cursor', () => {
		check('(|a) (b)', 'ds(w.', 'a |b');
		check('(|a) (b)', 'cs([f(.', '[ a ] |[ b ]');
		check('|a b', 'ysiw)W.', '(a) |(b)');
		check('|a\nb', 'yss)j.', '(a)\n|(b)');
		check('|a b c', 'ysiw"W.W.', '"a" "b" |"c"');
		check('((|a)) ((b))', '2ds(fb.', '(a) |(b)');
		check('|a\nb\nc\nd', '2yss)jj.', '(a\nb)\n|(c\nd)');
		check('<p>|a</p> <p>b</p>', 'csttem>fb.', '<em>a</em> |<em>b</em>');
		check('|a b', 'ysiwtx>W.', '<x>a</x> |<x>b</x>');
		check('|a b', 'ysiw (fb.', '(  a  ) |(  b  )');
		check('|ab cd', 'vlS)W.', '(ab) |(cd)');
		check('|ab\ncd', 'VS"3j.', '"\n\tab\n"\n|"\n\tcd\n"');
		// a count with . replaces the one recorded
		check('|a b c d', 'ysw)W3.', '(a) |(b c d)');
		// the prompt was not opened again
		const v = new Vim('|a b').keys('ysiwtx>W');
		v.keys('.');
		assert.strictEqual(v.vim.cmdlineOpen, false);
	});

	test('macros record the completed surround commands, the tag included', () => {
		let v = new Vim('|a b c').keys('qqysiwtem>Wq');
		v.keys('@q');
		assert.strictEqual(v.state(), '<em>a</em> <em>b</em> |c');
		v = new Vim('|(a) (b) (c)').keys('qqcs(]Wq2@q');
		assert.strictEqual(v.state(), '[a] [b] [c|]');
		v = new Vim('|"a" "b"').keys('qqds"Wq@q');
		assert.strictEqual(v.state(), 'a |b');
	});

	test(':normal and a register run as keys type the tag into the prompt too', async () => {
		let v = new Vim('|a\nb').keys(':%norm ysiwtem><CR>');
		await flush();
		assert.strictEqual(v.host.lines.join('\n'), '<em>a</em>\n<em>b</em>');
		v = new Vim('ysiwtp>\n|x y').keys('k"ay$j@a');
		assert.strictEqual(v.state(), 'ysiwtp>\n|<p>x</p> y');
	});

	test('Esc, or a key that is no character, cancels at every step, and nothing changes', () => {
		for (const keys of ['ys<Esc>', 'ysiw<Esc>', 'yss<Esc>', 'ds<Esc>', 'cs<Esc>', 'cs(<Esc>', 'ysiw <Esc>', 'ysiwt<Esc>', 'ysiwtdiv<Esc>', 'cs(t<Esc>', 'veS<Esc>', 'ysiw<Left>']) {
			const v = new Vim('(a |b c)').keys(keys);
			assert.strictEqual(v.host.lines.join('\n'), '(a b c)', keys);
			assert.strictEqual(v.vim.pending, false, keys);
			assert.strictEqual(v.vim.mode, 'normal', keys);
			assert.strictEqual(v.vim.cmdlineOpen, false, keys);
		}
		// and . still repeats what came before
		check('(|a) (b) (c)', 'ds(Wcs(<Esc>.', 'a |b (c)');
	});

	test('the grammar as context keys and showcmd: ys is an operator, its character and ds / cs\'s are awaited', () => {
		const v = new Vim('a |b c').keys('y');
		v.keys('s');
		assert.strictEqual(v.vim.context().pendingOperator, 'surround');
		assert.strictEqual(v.vim.context().mode, 'operatorPending');
		assert.ok(v.vim.status().endsWith('ys'), v.vim.status());
		v.keys('iw');
		assert.strictEqual(v.vim.context().awaitingChar, true);
		v.keys(')');
		assert.strictEqual(v.state(), 'a |(b) c');
		v.keys('yS');
		assert.strictEqual(v.vim.context().pendingOperator, 'surroundLines');
		v.keys('<Esc>cs');
		assert.strictEqual(v.vim.context().awaitingChar, true);
		v.keys('(');
		assert.ok(v.vim.status().endsWith('cs('), v.vim.status());
		assert.strictEqual(v.vim.context().awaitingChar, true);
		v.keys('<Esc>');
		assert.strictEqual(v.vim.pending, false);
	});

	test('the keys are native keybindings: s / S after d c y, s / S after ys / yS, S and gS in visual mode, > in the tag prompt', () => {
		const find = (key: string, ctx: Record<string, unknown>) => DEFAULT_KEYBINDINGS.filter(b => b.key === key && evaluateWhen(b.when, { textInputFocus: true, 'devhubVim.active': true, 'devhubVim.acceptsMotion': true, ...ctx })).map(b => [b.command, b.args]);
		const op = (name: string) => ({ 'devhubVim.mode': 'operatorPending', 'devhubVim.pendingOperator': name });
		assert.deepStrictEqual(find('s', op('delete')), [['devhubVim.awaitChar', { then: { command: 'devhubVim.surround', args: { action: 'delete' } } }]]);
		assert.deepStrictEqual(find('s', op('change')), [['devhubVim.awaitChar', { then: { command: 'devhubVim.surround', args: { action: 'change' } } }]]);
		assert.deepStrictEqual(find('shift+s', op('change')), [['devhubVim.awaitChar', { then: { command: 'devhubVim.surround', args: { action: 'change', lines: true } } }]]);
		assert.deepStrictEqual(find('s', op('yank')), [['devhubVim.operator', { operator: 'surround' }]]);
		assert.deepStrictEqual(find('shift+s', op('yank')), [['devhubVim.operator', { operator: 'surroundLines' }]]);
		assert.deepStrictEqual(find('s', op('surround')), [['devhubVim.operator', { operator: 'surround' }]]);
		assert.deepStrictEqual(find('s', op('surroundLines')), [['devhubVim.operator', { operator: 'surroundLines' }]]);
		assert.deepStrictEqual(find('shift+s', op('surroundLines')), [['devhubVim.operator', { operator: 'surroundLines' }]]);
		assert.deepStrictEqual(find('shift+s', { 'devhubVim.mode': 'visual', 'devhubVim.visual': true }), [['devhubVim.operator', { operator: 'surround' }]]);
		assert.deepStrictEqual(find('g shift+s', { 'devhubVim.mode': 'visualLine', 'devhubVim.visual': true }), [['devhubVim.operator', { operator: 'surroundLines' }]]);
		assert.deepStrictEqual(find('shift+s', { 'devhubVim.mode': 'normal' }), [['devhubVim.action', { action: 'substituteLine' }]]);
		assert.deepStrictEqual(find('s', op('format')), []);
		const prompt = CMDLINE_KEYBINDINGS.filter(b => b.key === 'shift+[Period]');
		assert.deepStrictEqual(prompt.map(b => [b.command, b.args, b.when]), [['devhubVim.cmdline.submit', { insert: '>' }, 'devhubVim.cmdlineFocus && devhubVim.cmdlineKind == \'<\'']]);
	});

	test('a key of one\'s own: devhubVim.surround waits for its characters by itself; the defaults can be removed', () => {
		let v = new Vim('(a |b)', [{ key: 'ctrl+k', command: 'devhubVim.surround', args: { action: 'delete' } }]).keys('<C-k>(');
		assert.strictEqual(v.state(), '|a b');
		v = new Vim('a |b', [{ key: 'ctrl+k', command: 'devhubVim.run', args: { commands: [{ command: 'devhubVim.operator', args: { operator: 'surround' } }, { command: 'devhubVim.textObject', args: { object: 'word', kind: 'inner' } }] } }]).keys('<C-k>]');
		assert.strictEqual(v.state(), 'a |[b]');
		// without the default, `s` after `d` is no key: the pending `d` is cancelled and `(` is the motion
		v = new Vim('(a |b)', [{ key: 's', command: '-devhubVim.awaitChar' }]).keys('ds(');
		assert.strictEqual(v.state(), '|(a b)');
	});
});

suite('DevHub Vim: tab pages are keys and ex commands (browser/vimTabPages.ts does the switching)', () => {

	const calls = async (keys: string) => {
		const v = new Vim('|abc').keys(keys);
		await flush();
		return v.host.commands.map(c => c.args === undefined ? [c.command] : [c.command, c.args]);
	};

	test('gt {count}gt gT {count}gT', async () => {
		assert.deepStrictEqual(await calls('gt'), [['devhubVim.tabpage.next', { count: null }]]);
		assert.deepStrictEqual(await calls('3gt'), [['devhubVim.tabpage.next', { count: 3 }]]);
		assert.deepStrictEqual(await calls('gT'), [['devhubVim.tabpage.previous', { count: 1 }]]);
		assert.deepStrictEqual(await calls('2gT'), [['devhubVim.tabpage.previous', { count: 2 }]]);
		// keybindings like every other key, on the letter keys (no JIS remapping)
		const keys = DEFAULT_KEYBINDINGS.filter(b => b.command === 'devhubVim.run' && String((b.args as { command?: string }).command).startsWith('devhubVim.tabpage.')).map(b => b.key).sort();
		assert.deepStrictEqual(keys, ['g shift+t', 'g t']);
	});

	test('an empty editor group\'s empty buffer takes the normal-mode keys; elsewhere (a list, the side bar) only `:` gt gT {N}gt CTRL-O CTRL-I', () => {
		const at = (key: string, ctx: Record<string, unknown>) => DEFAULT_KEYBINDINGS.filter(b => b.key === key && evaluateWhen(b.when, ctx)).map(b => b.args === undefined ? [b.command] : [b.command, b.args]);
		// the empty buffer of a focused empty group is a Vim buffer (DevhubVim.update): no text input, devhubVim.active
		const emptyGroup = { 'devhubVim.active': true, 'devhubVim.acceptsMotion': true, 'devhubVim.mode': 'normal' };
		const editor = { ...emptyGroup, textInputFocus: true };
		for (const key of ['g t', '[Quote]', 'ctrl+o', 'j', 'd', 'u', '3']) {
			assert.deepStrictEqual(at(key, emptyGroup), at(key, editor), key);
			assert.strictEqual(at(key, emptyGroup).length, 1, key);
		}
		assert.deepStrictEqual(at('g t', emptyGroup), [['devhubVim.run', { command: 'devhubVim.tabpage.next', args: { count: '${rawCount}' } }]]);
		assert.deepStrictEqual(at('[Quote]', emptyGroup), [['devhubVim.cmdline', { kind: ':' }]]);
		// elsewhere: normal mode (nothing that takes typing has the focus), no Vim buffer
		const list = { 'devhubVim.active': false, 'devhubVim.acceptsMotion': true, 'devhubVim.mode': 'normal', listFocus: true };
		assert.deepStrictEqual(at('[Quote]', list), [['devhubVim.cmdline', { kind: ':' }]]);
		assert.deepStrictEqual(at('g t', list), [['devhubVim.tabpage.next']]);
		assert.deepStrictEqual(at('g shift+t', list), [['devhubVim.tabpage.previous']]);
		assert.deepStrictEqual(at('3 g t', list), [['devhubVim.tabpage.next', { count: 3 }]]);
		assert.deepStrictEqual(at('9 g shift+t', list), [['devhubVim.tabpage.previous', { count: 9 }]]);
		assert.deepStrictEqual(at('0 g t', list), []);
		assert.deepStrictEqual(at('ctrl+o', list), [['workbench.action.navigateBack']]);
		assert.deepStrictEqual(at('ctrl+i', list), [['workbench.action.navigateForward']]);
		// a list keeps its other keys (Enter, Space, arrows, letters, Tab): no Vim buffer takes them
		for (const key of ['enter', 'space', 'down', 'j', 'tab', 'escape', 'u']) {
			assert.deepStrictEqual(at(key, list), [], key);
		}
		assert.deepStrictEqual(at('3 g t', { ...list, ...emptyGroup }), []);
		for (const ctx of [
			{ ...list, 'devhubVim.mode': 'nav' }, // after CTRL-W, g is that prefix's key
			{ ...list, 'devhubVim.mode': 'insert' }, // an input, a plain editor, the terminal
			{ ...list, 'devhubVim.mode': '' }, // a webview: its page has the keys
			{ ...list, 'devhubVim.mode': 'cmdline' },
		]) {
			assert.deepStrictEqual(at('g t', ctx), [], JSON.stringify(ctx));
			assert.deepStrictEqual(at('[Quote]', ctx), [], JSON.stringify(ctx));
		}
		assert.deepStrictEqual(VIM_WHEN.elsewhere, `devhubVim.mode == 'normal' && !devhubVim.active`);
		assert.deepStrictEqual(VIM_WHEN.normal, `devhubVim.active && devhubVim.acceptsMotion && devhubVim.mode == 'normal'`);
	});

	test(':tab* commands and their counts and arguments', async () => {
		const next = (count: number, arg = '') => [['devhubVim.tabpage.next', { count, arg }]];
		assert.deepStrictEqual(await calls(':tabn<CR>'), next(0));
		assert.deepStrictEqual(await calls(':tabnext 3<CR>'), next(3));
		assert.deepStrictEqual(await calls(':3tabn<CR>'), next(3));
		assert.deepStrictEqual(await calls(':tabne $<CR>'), next(0, '$'));
		assert.deepStrictEqual(await calls(':tabn +2<CR>'), next(0, '+2'));
		assert.deepStrictEqual(await calls(':tabp<CR>'), [['devhubVim.tabpage.previous', { count: 0 }]]);
		assert.deepStrictEqual(await calls(':tabN 2<CR>'), [['devhubVim.tabpage.previous', { count: 2 }]]);
		assert.deepStrictEqual(await calls(':tabc<CR>'), [['devhubVim.tabpage.close', { count: 0, arg: '' }]]);
		assert.deepStrictEqual(await calls(':tabclose 2<CR>'), [['devhubVim.tabpage.close', { count: 2, arg: '' }]]);
		assert.deepStrictEqual(await calls(':tabc! $<CR>'), [['devhubVim.tabpage.close', { count: 0, arg: '$' }]]);
		assert.deepStrictEqual(await calls(':tabo<CR>'), [['devhubVim.tabpage.only']]);
		assert.deepStrictEqual(await calls(':tabfir<CR>'), [['devhubVim.tabpage.first']]);
		assert.deepStrictEqual(await calls(':tabr<CR>'), [['devhubVim.tabpage.first']]);
		assert.deepStrictEqual(await calls(':tabl<CR>'), [['devhubVim.tabpage.last']]);
		assert.deepStrictEqual(await calls(':tabm<CR>'), [['devhubVim.tabpage.move', { arg: '' }]]);
		assert.deepStrictEqual(await calls(':tabmove +1<CR>'), [['devhubVim.tabpage.move', { arg: '+1' }]]);
		assert.deepStrictEqual(await calls(':tabm 0<CR>'), [['devhubVim.tabpage.move', { arg: '0' }]]);
		assert.deepStrictEqual(await calls(':tabs<CR>'), [['devhubVim.tabpage.list']]);
		assert.deepStrictEqual(await calls(':tabnew<CR>'), [['devhubVim.tabpage.new', { file: '' }], ['devhubVim.open', { file: '' }]]);
		assert.deepStrictEqual(await calls(':q<CR>'), [['workbench.action.closeActiveEditor'], ['devhubVim.tabpage.closeIfEmpty']]);
		assert.deepStrictEqual(await calls(':clo<CR>'), [['devhubVim.tabpage.closeWindow']]);
		// Vim's errors for what these do not take
		const v = new Vim('|abc').keys(':tabs 2<CR>');
		assert.ok(v.vim.status().includes('E488'), v.vim.status());
	});

	test('names and abbreviations: no clash with the other tab* names', () => {
		const name = (typed: string) => { const r = BUILTIN_EX_REGISTRY.lookup(typed); return 'error' in r ? r.error : r.name; };
		assert.strictEqual(name('tabm'), 'tabmove');
		assert.strictEqual(name('tabmo'), 'tabmove');
		assert.strictEqual(name('tabs'), 'tabs');
		assert.strictEqual(name('tabn'), 'tabnext');
		assert.strictEqual(name('tabne'), 'tabnext');
		assert.strictEqual(name('tabnew'), 'tabnew');
		assert.strictEqual(name('tabe'), 'tabedit');
		assert.strictEqual(name('tabr'), 'tabfirst');
		assert.strictEqual(name('tabfir'), 'tabfirst');
		assert.strictEqual(name('tabl'), 'tablast');
		assert.strictEqual(name('tabc'), 'tabclose');
		assert.strictEqual(name('tabo'), 'tabonly');
		assert.strictEqual(name('tabp'), 'tabprevious');
		assert.ok(name('tab').startsWith('E492'));
		assert.ok(name('tabf').startsWith('E492'));
	});
});
