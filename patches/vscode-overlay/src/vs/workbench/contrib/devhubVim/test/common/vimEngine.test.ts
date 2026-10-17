/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { IVimHost, VimEdit, VimPos, VimRange } from '../../common/vimEngine.js';
import { VimEngine, VimSharedState } from '../../common/vimEngine.js';
import { completeExName, parseExLine, substituteExArgs, validateUserExCommands } from '../../common/vimEx.js';
import type { VimKeybinding } from '../../common/vimKeymap.js';
import { DEFAULT_KEYBINDINGS, INSERT_ESCAPE_DISMISSES, JIS_KEYS, VIM_WEIGHTS, VIM_WHEN, evaluateWhen, jisKeys, keyForChar } from '../../common/vimKeymap.js';
import type { VimRegex } from '../../common/vimRegex.js';
import type { VimKeyEvent, VimNavFocus } from '../../common/vimKeys.js';
import { VimNavPrefix, captureKey, typedChar, vimCursorStyle } from '../../common/vimKeys.js';

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
	highlighted: VimRegex | undefined;
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
	setCursor(p: VimPos) { this.cursor = p; this.selection = undefined; this.selections = undefined; }
	getSelection() { return this.selection ? { anchor: this.selection.start, active: this.selection.end } : { anchor: this.cursor, active: this.cursor }; }
	setSelection(start: VimPos, end: VimPos, atStart: boolean) { this.selection = { start, end }; this.selections = undefined; this.cursor = atStart ? start : end; }
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
	indentUnit() { return '\t'; }
	tabSize() { return 4; }
	visibleLines() { return { top: this.top, bottom: Math.min(this.lines.length - 1, this.top + this.visible - 1) }; }
	scrollToLine(line: number, at: 'top' | 'center' | 'bottom') {
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
	highlightSearch(r: VimRegex | undefined) { this.highlighted = r; }
	showIncSearch(r: VimRange | undefined) { this.incsearch = r; }
	lineComment() { return this.comment; }
	hasRangeFormatter() { return this.formatter; }
	fileName() { return 'test.txt'; }
	executeCommand(command: string, args: unknown) {
		this.commands.push({ command, args, selection: this.selection });
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

	/** One key: a character, or <Esc> <CR> <BS> <Tab> <C-x> <Left> <Right> <Up> <Down> ... */
	press(k: string): void {
		// the editor's own keydown: a waiting command's character, the prompt
		if (this.vim.cmdlineOpen && !this.vim.awaitingChar) {
			this.vim.cmdlineKey(k);
			return;
		}
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
		assert.deepStrictEqual(wq.host.commands.map(c => c.command), ['workbench.action.files.save', 'workbench.action.closeActiveEditor']);
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
											'true': true, editorTextFocus: true, 'devhubVim.active': true, 'devhubVim.mode': mode,
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

	test('parsing', () => {
		assert.deepStrictEqual(parseExLine('w'), { range: undefined, name: 'w', bang: false, args: '' });
		assert.deepStrictEqual(parseExLine(':q!'), { range: undefined, name: 'q', bang: true, args: '' });
		assert.deepStrictEqual(parseExLine('\'<,\'>Sort! u  x'), { range: ['\'<', '\'>'], name: 'Sort', bang: true, args: 'u  x' });
		assert.deepStrictEqual(parseExLine('%Fmt'), { range: ['1', '$'], name: 'Fmt', bang: false, args: '' });
		assert.deepStrictEqual(parseExLine('12'), { range: ['12', '12'], name: '', bang: false, args: '' });
		assert.deepStrictEqual(parseExLine('.,.+2Grep foo'), { range: ['.', '.+2'], name: 'Grep', bang: false, args: 'foo' });
	});

	test('user names must start with an uppercase letter; a built-in name may be overridden', () => {
		const t = validateUserExCommands({ Sort: 'editor.action.sortLinesAscending', lower: 'x.y', w: { command: 'my.save' }, Bad: 42 });
		// `w` overrides :write (any abbreviation names the same command)
		assert.deepStrictEqual([...t.table.keys()], ['Sort', 'write']);
		assert.deepStrictEqual([...t.errors.keys()], ['lower', 'Bad']);
		const shared = new VimSharedState();
		shared.setUserExCommands({ Sort: 'editor.action.sortLinesAscending', lower: 'x.y', w: { command: 'my.save' } });
		let v = new Vim('|a', [], shared).keys(':Sort<CR>');
		assert.deepStrictEqual(v.host.commands.map(c => c.command), ['editor.action.sortLinesAscending']);
		v = new Vim('|a', [], shared).keys(':lower<CR>');
		assert.deepStrictEqual(v.host.commands, []);
		assert.ok(v.vim.status().includes('uppercase'), v.vim.status());
		v = new Vim('|a', [], shared).keys(':w<CR>');
		assert.deepStrictEqual(v.host.commands.map(c => c.command), ['my.save']);
	});

	test('args, range and bang reach the command', async () => {
		const shared = new VimSharedState();
		shared.setUserExCommands({
			Grep: { command: 'workbench.action.findInFiles', args: { query: '${args}', words: '${argList}', isRegex: '${bang}', range: '${range}', label: 'L${line1}-${line2}${bang}' } },
			Two: [{ command: 'first' }, { command: 'second', args: ['${args}'] }],
			Del: { run: { command: 'del', args: { force: false } }, bang: { command: 'del', args: { force: true } } },
			Line: { command: 'devhubVim.motion', args: { motion: 'fileEnd' } },
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
		assert.deepStrictEqual(v.host.commands.map(c => c.args), [{ force: false }, { force: true }]);
		// an engine command in the table runs in the engine
		v = new Vim('|a\nb\nc', [], shared).keys(':Line<CR>');
		assert.strictEqual(v.state(), 'a\nb\n|c');
	});

	test(':\'<,\'> from visual mode passes the selected lines', () => {
		const shared = new VimSharedState();
		shared.setUserExCommands({ Sort: { command: 'editor.action.sortLinesAscending', args: { range: '${range}' } } });
		const v = new Vim('x\n|c\nb\na\ny', [], shared).keys('Vjj:');
		assert.strictEqual(v.vim.status(), ':\'<,\'>');
		v.keys('Sort<CR>');
		assert.deepStrictEqual(v.host.commands[0].args, { range: { start: 2, end: 4 } });
		assert.deepStrictEqual(v.host.commands[0].selection, { start: { line: 1, col: 0 }, end: { line: 3, col: 1 } });
		assert.strictEqual(v.vim.mode, 'normal');
	});

	test('substitution leaves other strings and unknown placeholders alone', () => {
		const inv = { args: 'a b', bang: false, range: undefined, cursorLine: 7 };
		assert.deepStrictEqual(substituteExArgs({ n: 1, s: 'x', u: '${nope}', l: ['${line1}', '${bang}x'] }, inv), { n: 1, s: 'x', u: '${nope}', l: [7, 'x'] });
	});

	test('Tab completes ex command names in the prompt', () => {
		assert.deepStrictEqual(completeExName('w', ['w', 'wa', 'wq', 'x', 'Write']), ['w', 'wa', 'wq']);
		const shared = new VimSharedState();
		shared.setUserExCommands({ Sort: 'a', Split: 'b' });
		const v = new Vim('|a', [], shared).keys(':S<Tab>');
		assert.ok(v.vim.status().startsWith(':Sort'), v.vim.status());
		v.keys('<Tab>');
		assert.ok(v.vim.status().startsWith(':Split'), v.vim.status());
		v.keys('<CR>');
		assert.deepStrictEqual(v.host.commands.map(c => c.command), ['b']);
		const r = new Vim('|a', [], shared).keys(':');
		for (const ch of '\'<,\'>So') {
			r.press(ch);
		}
		r.press('<Tab>');
		assert.ok(r.vim.status().startsWith(':\'<,\'>Sort'), r.vim.status());
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

	test('the / prompt takes all of it', () => {
		const r = run('|abc 日本語', '/');
		r.vim.handleText('日本');
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

	test('jumps: CTRL-O CTRL-I \'\' ``', async () => {
		const v = new Vim(lines(20));
		v.keys('5G');
		v.keys('G');
		v.keys('<C-o>');
		assert.strictEqual(v.host.cursor.line, 4);
		v.keys('<C-o>');
		assert.strictEqual(v.host.cursor.line, 0);
		v.keys('<C-i>');
		assert.strictEqual(v.host.cursor.line, 4);
		v.keys('<Tab>');
		assert.strictEqual(v.host.cursor.line, 19);
		v.keys('\'\'');
		assert.strictEqual(v.host.cursor.line, 4);
		v.keys('``');
		assert.strictEqual(v.host.cursor.line, 19);
		// at the start of the list CTRL-O goes back in VS Code's history
		const w = new Vim('a\nb');
		w.keys('<C-o>');
		await flush();
		assert.deepStrictEqual(w.host.commands.map(c => c.command), ['workbench.action.navigateBack']);
	});

	test('the change list: g; g,', () => {
		const v = new Vim(lines(10)).keys('2Gx8GxggG');
		v.keys('g;');
		assert.strictEqual(v.host.cursor.line, 7);
		v.keys('g;');
		assert.strictEqual(v.host.cursor.line, 1);
		v.keys('g,');
		assert.strictEqual(v.host.cursor.line, 7);
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

	test('case sensitivity: \\c \\C, ignorecase, smartcase', () => {
		check('|x Foo foo', '/foo<CR>', 'x Foo |foo');
		check('|x Foo foo', '/foo\\c<CR>', 'x |Foo foo');
		check('|x foo Foo', ':set ic<CR>/Foo<CR>', 'x |foo Foo');
		check('|x foo Foo', ':set ic scs<CR>/Foo<CR>', 'x foo |Foo');
	});

	test('Vim regex syntax in / and :s', () => {
		check('|x foobar foo', '/\\<foo\\><CR>', 'x foobar |foo');
		check('|ab aab', '/a\\{2}<CR>', 'ab |aab');
		check('|cat dog', '/\\(dog\\|cat\\)s\\=<CR>', 'cat |dog');
		check('|a1 b22', '/\\d\\+<CR>n', 'a1 b|22');
		check('|foo=bar', '/=\\zsbar<CR>', 'foo=|bar');
		check('|x foo(1)', '/\\Vfoo(<CR>', 'x |foo(1)');
		check('|x a+b', '/\\va\\+<CR>', 'x |a+b');
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
		assert.deepStrictEqual(await cmds('ZZ'), ['workbench.action.files.save', 'workbench.action.closeActiveEditor']);
		assert.deepStrictEqual(await cmds('ZQ'), ['workbench.action.revertAndCloseActiveEditor']);
		// in visual mode gra acts on the selection, then visual mode ends
		const v = new Vim('|abc').keys('vlgra');
		await flush();
		assert.deepStrictEqual(v.host.commands.map(c => [c.command, c.selection]), [['editor.action.quickFix', { start: { line: 0, col: 0 }, end: { line: 0, col: 2 } }]]);
		assert.strictEqual(v.vim.mode, 'normal');
	});
});

suite('DevHub Vim: counts are keybindings; devhubVim.run and devhubVim.repeat take them as args', () => {

	const N = 'editorTextFocus && devhubVim.active && devhubVim.acceptsMotion && devhubVim.mode == \'normal\'';
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
			key: 'g b', when: 'editorTextFocus && devhubVim.active && devhubVim.acceptsMotion', command: 'devhubVim.repeat',
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
		check('|ab', ':s/\\(a\\)\\(b\\)/\\2\\1/<CR>', '|ba');
		check('|abc', ':s/b/[&]/<CR>', '|a[b]c');
		check('|foo bar', ':s/\\w\\+/\\u&/g<CR>', '|Foo Bar');
		check('|foo bar', ':s/foo/\\U&\\E!/<CR>', '|FOO! bar');
		check('|a,b,c', ':s/,/\\r/g<CR>', 'a\nb\n|c');
		check('|a/b', ':s#/#-#<CR>', '|a-b');
		check('|x a a', '/a<CR>:s//b/g<CR>', '|x b b');
		check('|ab\nab', ':s/a/X/<CR>j:s/b/~Y/<CR>', 'Xb\n|aXY');
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
		check('|a3 z\nb1 y\nc2 x', ':sort /\\a\\d /<CR>', '|c2 x\nb1 y\na3 z');
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
		assert.deepStrictEqual(s.host.commands.map(c => c.command), ['workbench.action.splitEditorUp']);
		const w = new Vim('|a').keys(':wri<CR>');
		assert.deepStrictEqual(w.host.commands.map(c => c.command), ['workbench.action.files.save']);
	});

	test('{count}: is .,.+N-1', () => {
		const v = new Vim('|a\nb\nc\nd').keys('3:');
		assert.strictEqual(v.vim.status(), ':.,.+2');
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
