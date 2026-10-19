/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { IVimCmdlineCompletionSources, IVimCmdlineTarget, IVimCmdlineUi, VimCmdlineKind } from '../../common/vimCmdline.js';
import { CMDLINE_KEYBINDINGS, VIM_CMDLINE_COMMANDS, VIM_CMDLINE_CONTEXT, VimCmdlineController, VimStringLine, cmdlineCompletionContext, cmdlineCompletions, registerAsLine, splitFileArg, wordBeforeCaret } from '../../common/vimCmdline.js';
import type { IVimHost, VimPos, VimRange } from '../../common/vimEngine.js';
import { VimEngine, VimSharedState } from '../../common/vimEngine.js';
import { vimFindHost } from './vimFindHost.js';
import { ExRegistry } from '../../common/vimEx.js';
import { DEFAULT_KEYBINDINGS, VIM_WEIGHTS, evaluateWhen, keysOf } from '../../common/vimKeymap.js';

/** What the controller tells the engine, recorded. */
class TestTarget implements IVimCmdlineTarget {
	readonly calls: string[] = [];
	readonly registers = new Map<string, string>([['a', 'alpha'], ['l', 'line one\n']]);
	constructor(readonly entries: Record<'colon' | 'search', string[]> = { colon: [], search: [] }) { }
	history(kind: VimCmdlineKind) { return kind === ':' ? this.entries.colon : this.entries.search; }
	changed(text: string) { this.calls.push(`changed ${text}`); }
	submit(text: string) { this.calls.push(`submit ${text}`); }
	cancel() { this.calls.push('cancel'); }
	registerText(name: string) { return this.registers.get(name); }
	prepareRegisters() { this.calls.push('prepare'); }
}

function prompt(kind: VimCmdlineKind, text = '', caret = text.length, target = new TestTarget(), sources?: IVimCmdlineCompletionSources, ui?: IVimCmdlineUi) {
	const line = new VimStringLine(text, caret);
	const c = new VimCmdlineController(kind, line, target, sources, ui);
	return {
		c, line, target,
		keys(keys: string) { for (const k of keysOf(keys)) { c.feedKey(k); } return this; },
		/** The line with the caret as `|`. */
		get shown() { return line.text.slice(0, line.caret) + '|' + line.text.slice(line.caret); },
	};
}

const SOURCES: IVimCmdlineCompletionSources = (() => {
	const shared = new VimSharedState();
	shared.setUserExCommands({ Fmt: 'editor.action.formatDocument', Grep: { command: 'workbench.action.findInFiles', description: 'Search the workspace' }, w: { commands: ['editor.action.formatDocument', 'workbench.action.files.save'] } });
	shared.setOptions({ ignorecase: true });
	return {
		exCommands: () => shared.exCommandList(),
		options: () => shared.optionList(),
		buffers: () => [{ name: 'main.ts', detail: 'src' }, { name: 'README.md', detail: '' }, { name: 'vimMain.ts', detail: 'src/vim' }],
		registry: () => shared.registry,
	};
})();

suite('DevHub Vim prompt: the line\'s commands', () => {

	test('Enter submits the line, wherever the caret is; the prompt is over then', () => {
		const p = prompt(':', 'sp', 1).keys('<CR>');
		assert.deepStrictEqual(p.target.calls, ['submit sp']);
		assert.strictEqual(p.c.done, true);
		p.keys('x<CR><Esc>');
		assert.deepStrictEqual(p.target.calls, ['submit sp']);
		for (const k of ['<C-m>', '<C-j>']) {
			assert.deepStrictEqual(prompt('/', 'foo').keys(k).target.calls, ['submit foo']);
		}
	});

	test('Esc, CTRL-C and CTRL-[ cancel; <BS> and CTRL-H cancel only an empty line', () => {
		for (const k of ['<Esc>', '<C-c>', '<C-[>']) {
			assert.deepStrictEqual(prompt(':', 'abc').keys(k).target.calls, ['cancel'], k);
		}
		const p = prompt('/', 'ab').keys('<BS>');
		assert.strictEqual(p.line.text, 'a');
		p.keys('<C-h>');
		assert.strictEqual(p.line.text, '');
		assert.strictEqual(p.c.done, false);
		p.keys('<BS>');
		assert.strictEqual(p.c.done, true);
		assert.deepStrictEqual(p.target.calls, ['changed a', 'changed ', 'cancel']);
		assert.strictEqual(prompt(':').keys('<C-h>').target.calls[0], 'cancel');
	});

	test('typing and the caret: in the middle of the line, as an editor', () => {
		const p = prompt(':', 'sbar').keys('<Home><Right>/foo/<End>/');
		assert.strictEqual(p.shown, 's/foo/bar/|');
		p.keys('<C-b>X<C-e>Y');
		assert.strictEqual(p.shown, 'Xs/foo/bar/Y|');
	});

	test('CTRL-W deletes the word before the caret (blanks first, then word characters or other non-blanks), CTRL-U all before the caret', () => {
		assert.strictEqual(wordBeforeCaret('foo bar', 7), 4);
		assert.strictEqual(wordBeforeCaret('foo bar  ', 9), 4);
		assert.strictEqual(wordBeforeCaret('s/foo/', 6), 5);
		assert.strictEqual(wordBeforeCaret('s/foo', 5), 2);
		assert.strictEqual(wordBeforeCaret('日本語 で', 5), 4);
		assert.strictEqual(wordBeforeCaret('', 0), 0);
		assert.strictEqual(prompt(':', 'e foo/bar.ts').keys('<C-w>').shown, 'e foo/bar.|');
		assert.strictEqual(prompt(':', 'e foo bar', 5).keys('<C-w>').shown, 'e | bar');
		assert.strictEqual(prompt(':', 's/a/b/g', 4).keys('<C-u>').shown, '|b/g');
		// on an empty line neither cancels (only <BS> does)
		assert.strictEqual(prompt(':').keys('<C-w><C-u>').c.done, false);
	});

	test('<Up> / <Down>: the entries that start with the text before the caret; past the newest, the line as it was', () => {
		const target = new TestTarget({ colon: ['set ic', 'sp', 'set hls', 'w'], search: [] });
		const p = prompt(':', 'se', 2, target);
		p.keys('<Up>');
		assert.strictEqual(p.line.text, 'set hls');
		p.keys('<Up>');
		assert.strictEqual(p.line.text, 'set ic');
		p.keys('<Up>');
		assert.strictEqual(p.line.text, 'set ic', 'nothing older: stays');
		p.keys('<Down>');
		assert.strictEqual(p.line.text, 'set hls');
		p.keys('<Down>');
		assert.strictEqual(p.line.text, 'se');
		p.keys('<Down>');
		assert.strictEqual(p.line.text, 'se');
		// an edit starts a new walk with the new prefix
		p.keys('<C-u>s<Up>');
		assert.strictEqual(p.line.text, 'set hls');
	});

	test('CTRL-P / CTRL-N, <S-Up> / <S-Down>, <PageUp> / <PageDown>: all of the history', () => {
		const target = new TestTarget({ colon: ['set ic', 'sp', 'w'], search: [] });
		const p = prompt(':', 's', 1, target);
		p.keys('<C-p>');
		assert.strictEqual(p.line.text, 'w');
		p.keys('<S-Up>');
		assert.strictEqual(p.line.text, 'sp');
		p.keys('<PageUp>');
		assert.strictEqual(p.line.text, 'set ic');
		p.keys('<C-n><PageDown><S-Down>');
		assert.strictEqual(p.line.text, 's');
	});

	test('/ and ? read the search history, : its own', () => {
		const target = new TestTarget({ colon: ['w'], search: ['foo'] });
		assert.strictEqual(prompt('?', '', 0, target).keys('<Up>').line.text, 'foo');
		assert.strictEqual(prompt(':', '', 0, target).keys('<Up>').line.text, 'w');
	});

	test('CTRL-R {register} inserts the register at the caret, as one line; Esc only ends the wait', () => {
		const p = prompt('/', 'xy', 1).keys('<C-r>');
		assert.strictEqual(p.c.awaitingRegister, true);
		assert.ok(p.target.calls.includes('prepare'));
		assert.strictEqual(evaluateWhen('devhubVim.cmdlineAwaitingRegister', p.c.context()), true);
		p.keys('a');
		assert.strictEqual(p.shown, 'xalpha|y');
		p.keys('<C-r>l');
		assert.strictEqual(p.shown, 'xalphaline one|y');
		p.keys('<C-r><Esc>');
		assert.strictEqual(p.c.done, false);
		assert.strictEqual(p.c.awaitingRegister, false);
		p.keys('<C-r>z');
		assert.strictEqual(p.shown, 'xalphaline one|y', 'an empty register inserts nothing');
		assert.strictEqual(registerAsLine('a\nb\n'), 'a b');
		// with the register as an argument there is no wait
		const q = prompt(':');
		q.c.run('devhubVim.cmdline.insertRegister', { register: 'a' });
		assert.strictEqual(q.shown, 'alpha|');
	});

	test('Enter with the completion menu open takes the match the user picked first', () => {
		const order: string[] = [];
		const target = new TestTarget();
		const ui: IVimCmdlineUi = { complete: () => true, acceptCompletion: () => order.push('accept'), awaitingRegister: () => { } };
		const p = prompt(':', 'spl', 3, target, SOURCES, ui);
		const picked = p.c.context(true, true);
		const enter = CMDLINE_KEYBINDINGS.filter(b => b.key === 'enter' && evaluateWhen(b.when, picked));
		assert.strictEqual(enter.length, 1);
		p.c.run(enter[0].command, enter[0].args);
		target.calls.forEach(c => order.push(c));
		assert.deepStrictEqual(order, ['accept', 'submit spl']);
	});

	test('Enter with the menu that showed as you type, nothing picked in it, runs exactly what was typed', () => {
		const order: string[] = [];
		const target = new TestTarget();
		const ui: IVimCmdlineUi = { complete: () => true, acceptCompletion: () => order.push('accept'), awaitingRegister: () => { } };
		const p = prompt(':', 'w', 1, target, SOURCES, ui);
		const menu = p.c.context(true, false);
		const enter = CMDLINE_KEYBINDINGS.filter(b => b.key === 'enter' && evaluateWhen(b.when, menu));
		assert.deepStrictEqual(enter.map(b => [b.command, b.args]), [['devhubVim.cmdline.submit', undefined]]);
		p.c.run(enter[0].command, enter[0].args);
		target.calls.forEach(c => order.push(c));
		assert.deepStrictEqual(order, ['submit w']);
	});

	test('<Up> walks the history over a menu with nothing picked (and closes it); <Down> and Tab pick in it', () => {
		const closed: string[] = [];
		const target = new TestTarget({ colon: ['edit a', 'write'], search: [] });
		const ui: IVimCmdlineUi = { complete: () => true, acceptCompletion: () => { }, awaitingRegister: () => { }, closeCompletion: () => closed.push('close') };
		const p = prompt(':', 'e', 1, target, SOURCES, ui);
		const menu = p.c.context(true, false);
		const up = CMDLINE_KEYBINDINGS.filter(b => b.key === 'up' && evaluateWhen(b.when, menu));
		assert.deepStrictEqual(up.map(b => b.command), ['devhubVim.cmdline.historyPrev']);
		p.c.run(up[0].command, up[0].args);
		assert.strictEqual(p.line.text, 'edit a');
		assert.deepStrictEqual(closed, ['close']);
		assert.deepStrictEqual(CMDLINE_KEYBINDINGS.filter(b => b.key === 'down' && evaluateWhen(b.when, menu)), [], 'the menu\'s own Down selects');
		assert.deepStrictEqual(CMDLINE_KEYBINDINGS.filter(b => b.key === 'tab' && evaluateWhen(b.when, menu)).map(b => b.command), ['devhubVim.cmdline.complete']);
	});

	test('Tab: the completion menu of the browser line; the controller cycles itself only without one', () => {
		const asked: string[] = [];
		const ui: IVimCmdlineUi = { complete: d => { asked.push(d); return true; }, acceptCompletion: () => { }, awaitingRegister: () => { } };
		const p = prompt(':', 'sp', 2, new TestTarget(), SOURCES, ui).keys('<Tab><S-Tab>');
		assert.deepStrictEqual(asked, ['next', 'previous']);
		assert.strictEqual(p.line.text, 'sp');
		// no Tab binding in a search: Tab is typed
		assert.strictEqual(prompt('/', 'a', 1, new TestTarget(), SOURCES, ui).keys('<Tab>').line.text, 'a\t');
	});
});

suite('DevHub Vim prompt: completion', () => {

	test('the word Tab completes: the command name after the range, a file, an option, a buffer', () => {
		assert.deepStrictEqual(cmdlineCompletionContext('', 0), { kind: 'command', start: 0, typed: '' });
		assert.deepStrictEqual(cmdlineCompletionContext('spl', 3), { kind: 'command', start: 0, typed: 'spl' });
		assert.deepStrictEqual(cmdlineCompletionContext('\'<,\'>So', 7), { kind: 'command', start: 5, typed: 'So' });
		assert.deepStrictEqual(cmdlineCompletionContext('%s', 2), { kind: 'command', start: 1, typed: 's' });
		assert.deepStrictEqual(cmdlineCompletionContext('.,.+2d', 6), { kind: 'command', start: 5, typed: 'd' });
		assert.deepStrictEqual(cmdlineCompletionContext('e src/ma', 8), { kind: 'file', start: 2, typed: 'src/ma', command: 'edit' });
		assert.deepStrictEqual(cmdlineCompletionContext('e! x', 4), { kind: 'file', start: 3, typed: 'x', command: 'edit' });
		for (const c of ['sp', 'vs', 'tabnew', 'tabe', 'new', 'vne', 'sav']) {
			assert.strictEqual(cmdlineCompletionContext(`${c} `, c.length + 1)?.kind, 'file', c);
		}
		assert.deepStrictEqual(cmdlineCompletionContext('set ic no', 9), { kind: 'option', start: 7, typed: 'no', command: 'set' });
		assert.strictEqual(cmdlineCompletionContext('set tw=', 7), undefined);
		assert.deepStrictEqual(cmdlineCompletionContext('b mai', 5), { kind: 'buffer', start: 2, typed: 'mai', command: 'buffer' });
		// the caret, not the end of the line, decides
		assert.deepStrictEqual(cmdlineCompletionContext('sp foo', 2), { kind: 'command', start: 0, typed: 'sp' });
		assert.strictEqual(cmdlineCompletionContext('s/foo/', 6), undefined);
		assert.strictEqual(cmdlineCompletionContext('noh ', 4), undefined);
		assert.deepStrictEqual(cmdlineCompletionContext(':  3,5d', 7), { kind: 'command', start: 6, typed: 'd' });
		assert.deepStrictEqual(splitFileArg('src/vs/ba'), { dir: 'src/vs/', base: 'ba' });
		assert.deepStrictEqual(splitFileArg('ba'), { dir: '', base: 'ba' });
	});

	test('the line is read with the engine\'s parser: after a `|`, by what the command\'s spec says it completes', () => {
		const reg = new ExRegistry({
			Open: { command: 'x.open', args: '${args}', nargs: '1', complete: 'file' },
			Tags: { command: 'x.tags', args: '${argList}', complete: 'command:x.listTags' },
			Run: { command: 'x.run', args: '${args}', bar: false, complete: 'command' },
		});
		// the second command of the line
		assert.deepStrictEqual(cmdlineCompletionContext('noh | e src/m', 13, reg), { kind: 'file', start: 8, typed: 'src/m', command: 'edit' });
		assert.deepStrictEqual(cmdlineCompletionContext('w | sp', 6, reg), { kind: 'command', start: 4, typed: 'sp' });
		// nargs 1: the whole argument; * : the last word; a command that lists its own
		assert.deepStrictEqual(cmdlineCompletionContext('Open a b', 8, reg), { kind: 'file', start: 5, typed: 'a b', command: 'Open' });
		assert.deepStrictEqual(cmdlineCompletionContext('Tags x y', 8, reg), { kind: 'custom', start: 7, typed: 'y', command: 'Tags', source: 'x.listTags' });
		// a unique prefix of a user command is that command
		assert.deepStrictEqual(cmdlineCompletionContext('Op a', 4, reg), { kind: 'file', start: 3, typed: 'a', command: 'Open' });
		// `|` is its argument for a command without bar: no next command
		assert.deepStrictEqual(cmdlineCompletionContext('Run a | noh', 11, reg), { kind: 'command', start: 8, typed: 'noh', command: 'Run' });
		// `:g` takes the rest of the line
		assert.strictEqual(cmdlineCompletionContext('g/x/ | e ', 9, reg), undefined);
	});

	test('ex command names: Vim\'s by prefix with their abbreviation and what they run, and the user\'s with a detail', () => {
		const items = cmdlineCompletions({ kind: 'command', start: 0, typed: 'sp' }, SOURCES);
		assert.deepStrictEqual(items.map(i => i.label), ['split']);
		assert.strictEqual(items[0].detail, ':sp[lit] - workbench.action.splitEditorUp, devhubVim.open');
		const subst = cmdlineCompletions({ kind: 'command', start: 0, typed: 'substitute' }, SOURCES);
		assert.strictEqual(subst[0].detail, ':s[ubstitute] - Vim');
		const user = cmdlineCompletions({ kind: 'command', start: 0, typed: 'G' }, SOURCES);
		assert.deepStrictEqual(user.map(i => [i.label, i.detail]), [['Grep', 'Search the workspace']]);
		assert.deepStrictEqual(cmdlineCompletions({ kind: 'command', start: 0, typed: 'F' }, SOURCES).map(i => [i.label, i.detail]), [['Fmt', 'editor.action.formatDocument']]);
		// an override of a built-in says so
		const write = cmdlineCompletions({ kind: 'command', start: 0, typed: 'write' }, SOURCES);
		assert.strictEqual(write[0].detail, ':w[rite] - editor.action.formatDocument, workbench.action.files.save (devhub.vim.exCommands)');
		const all = cmdlineCompletions({ kind: 'command', start: 0, typed: '' }, SOURCES).map(i => i.label);
		assert.ok(all.includes('nohlsearch') && all.includes('Fmt') && all.includes('tabnew'));
		assert.deepStrictEqual(all, [...all].sort());
		assert.strictEqual(new Set(all).size, all.length);
	});

	test(':set option names, their short names, and `no` / `inv` for the boolean ones, with the current value', () => {
		const items = cmdlineCompletions({ kind: 'option', start: 4, typed: 'i' }, SOURCES);
		assert.deepStrictEqual(items.map(i => [i.label, i.detail]), [['ignorecase', 'on'], ['ic', 'on'], ['incsearch', 'on'], ['is', 'on']]);
		assert.deepStrictEqual(cmdlineCompletions({ kind: 'option', start: 4, typed: 'noh' }, SOURCES).map(i => i.label), ['nohlsearch', 'nohls']);
		assert.deepStrictEqual(cmdlineCompletions({ kind: 'option', start: 4, typed: 'invws' }, SOURCES).map(i => i.label), ['invws']);
		assert.deepStrictEqual(cmdlineCompletions({ kind: 'option', start: 4, typed: 'tw' }, SOURCES).map(i => [i.label, i.detail]), [['tw', '=0']]);
		assert.deepStrictEqual(cmdlineCompletions({ kind: 'option', start: 4, typed: 'notw' }, SOURCES), []);
	});

	test('the values of fenc= ff= and of ++enc= ++ff=: VS Code\'s encoding ids, unix and dos', () => {
		assert.deepStrictEqual(cmdlineCompletionContext('set fenc=sj', 11), { kind: 'value', value: 'encoding', start: 9, typed: 'sj', command: 'set' });
		assert.deepStrictEqual(cmdlineCompletionContext('set ts=2 fileencoding=', 22), { kind: 'value', value: 'encoding', start: 22, typed: '', command: 'set' });
		assert.deepStrictEqual(cmdlineCompletionContext('setl ff=d', 9), { kind: 'value', value: 'fileformat', start: 8, typed: 'd', command: 'set' });
		assert.deepStrictEqual(cmdlineCompletionContext('e ++enc=eu', 10), { kind: 'value', value: 'encoding', start: 8, typed: 'eu', command: 'edit' });
		assert.deepStrictEqual(cmdlineCompletionContext('e! ++encoding=', 14), { kind: 'value', value: 'encoding', start: 14, typed: '', command: 'edit' });
		assert.deepStrictEqual(cmdlineCompletionContext('w ++ff=u', 8), { kind: 'value', value: 'fileformat', start: 7, typed: 'u', command: 'write' });
		assert.deepStrictEqual(cmdlineCompletionContext('sav ++enc=cp9', 13), { kind: 'value', value: 'encoding', start: 10, typed: 'cp9', command: 'saveas' });
		assert.deepStrictEqual(cmdlineCompletionContext('r ++enc=l', 9), { kind: 'value', value: 'encoding', start: 8, typed: 'l', command: 'read' });
		// after `|` it is the next command
		assert.deepStrictEqual(cmdlineCompletionContext('set ts=2 | e ++ff=', 18), { kind: 'value', value: 'fileformat', start: 18, typed: '', command: 'edit' });
		// the file after the ++ words is a file, without them
		assert.deepStrictEqual(cmdlineCompletionContext('e ++enc=sjis src/ma', 19), { kind: 'file', start: 13, typed: 'src/ma', command: 'edit' });
		assert.deepStrictEqual(cmdlineCompletionContext('e ++enc=sjis ++ff=dos src/ma', 28), { kind: 'file', start: 22, typed: 'src/ma', command: 'edit' });
		// other options keep their `=` meaning; a shell command is a shell command
		assert.strictEqual(cmdlineCompletionContext('set tw=8', 8), undefined);
		assert.notStrictEqual(cmdlineCompletionContext('!ls ++enc=x', 11)?.kind, 'value');
		const sources = { ...SOURCES };
		assert.deepStrictEqual(cmdlineCompletions({ kind: 'value', value: 'encoding', start: 9, typed: 'sj' }, sources), [{ label: 'shiftjis', detail: 'Japanese (Shift JIS)', kind: 'value' }]);
		assert.deepStrictEqual(cmdlineCompletions({ kind: 'value', value: 'encoding', start: 9, typed: 'utf-1' }, sources).map(i => i.label), ['utf16le', 'utf16be']);
		assert.deepStrictEqual(cmdlineCompletions({ kind: 'value', value: 'fileformat', start: 8, typed: '' }, sources).map(i => [i.label, i.detail]), [['unix', 'LF'], ['dos', 'CRLF']]);
		assert.deepStrictEqual(cmdlineCompletions({ kind: 'value', value: 'fileformat', start: 8, typed: 'D' }, sources).map(i => i.label), ['dos']);
	});

	test(':b open editors by substring, ignoring case', () => {
		assert.deepStrictEqual(cmdlineCompletions({ kind: 'buffer', start: 2, typed: 'MAIN' }, SOURCES).map(i => [i.label, i.detail]), [['main.ts', 'src'], ['vimMain.ts', 'src/vim']]);
		assert.deepStrictEqual(cmdlineCompletions({ kind: 'file', start: 2, typed: 'x' }, SOURCES), []);
	});
});

suite('DevHub Vim prompt: keybindings', () => {

	test('every prompt command is a keybinding, and every prompt keybinding needs the prompt\'s focus', () => {
		const bound = new Set(CMDLINE_KEYBINDINGS.map(b => b.command));
		for (const id of VIM_CMDLINE_COMMANDS) {
			assert.ok(bound.has(id), id);
		}
		for (const b of CMDLINE_KEYBINDINGS) {
			assert.ok(b.when.startsWith(VIM_CMDLINE_CONTEXT.focus + ' ') || b.when === VIM_CMDLINE_CONTEXT.focus, `${b.key}: ${b.when}`);
			assert.strictEqual(b.weight, 'cmdline');
			assert.strictEqual(evaluateWhen(b.when, {}), false, `${b.key} applies without the prompt`);
		}
		assert.strictEqual(VIM_WEIGHTS.cmdline, 255);
		// CTRL-[ is on the JIS key, as in the Vim keymap
		assert.ok(CMDLINE_KEYBINDINGS.some(b => b.key === 'ctrl+[BracketRight]' && b.command === 'devhubVim.cmdline.cancel'));
	});

	test('one Esc (CTRL-C, CTRL-[) abandons the line, also while the completion menu or any other editor widget shows', () => {
		// VS Code 1.141's Esc bindings that can hold in a focused one-line editor: [command, weight, when]
		const upstream: [string, number, string][] = [
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
		const others: Record<string, [string, number, string][]> = {
			'escape': upstream,
			'ctrl+[BracketRight]': [['editor.action.outdentLines', 100, 'editorTextFocus']],
			'ctrl+c': [['editor.action.clipboardCopyAction', 100, 'textInputFocus'], ['hideSuggestWidget', 190, 'suggestWidgetVisible && textInputFocus']],
		};
		/** The binding the dispatcher runs: the highest weight whose when holds (later registration on a tie). */
		const winner = (key: string, ctx: Record<string, unknown>) => {
			const all = [...(others[key] ?? []), ...CMDLINE_KEYBINDINGS.filter(b => b.key === key).map(b => [b.command, VIM_WEIGHTS[b.weight ?? 'default'], b.when] as [string, number, string])]
				.filter(([, , when]) => evaluateWhen(when, ctx));
			all.sort((a, b) => a[1] - b[1]);
			return all.at(-1)?.[0];
		};
		const widgets = ['suggestWidgetVisible', 'inlineSuggestionVisible', 'inlineEditIsVisible', 'LinkedEditingInputVisible', 'parameterHintsVisible', 'markersNavigationVisible', 'inSnippetMode', 'messageVisible', 'findWidgetVisible', 'cancellableOperation', 'inPeekEditor', 'referenceSearchVisible'];
		for (const kind of [':', '/', '?'] as const) {
			for (const text of ['', 'e src/ma']) {
				for (const widget of [undefined, ...widgets]) {
					const ctx = { ...new VimCmdlineController(kind, new VimStringLine(text), new TestTarget()).context(widget === 'suggestWidgetVisible'), editorFocus: true, ...(widget ? { [widget]: true } : {}) };
					for (const key of ['escape', 'ctrl+[BracketRight]', 'ctrl+c']) {
						assert.strictEqual(winner(key, ctx), 'devhubVim.cmdline.cancel', `${key} in ${kind}${text} with ${widget}`);
					}
				}
			}
		}
		// fed keys (`:normal :e x<Esc>`, a register) take the same binding with the menu open
		const target = new TestTarget();
		const c = new VimCmdlineController(':', new VimStringLine('e x'), target);
		const ctx = c.context(true);
		assert.deepStrictEqual(CMDLINE_KEYBINDINGS.filter(b => b.key === 'escape' && evaluateWhen(b.when, ctx)).map(b => b.command), ['devhubVim.cmdline.cancel']);
		// once a match is picked, <Up> / <Down> give way to the menu: they step through it
		const picked = c.context(true, true);
		for (const k of ['up', 'down']) {
			assert.deepStrictEqual(CMDLINE_KEYBINDINGS.filter(b => b.key === k && evaluateWhen(b.when, picked)), [], k);
		}
	});

	test('the Vim keymap does not apply in the prompt line: it is not a Vim editor', () => {
		const ctx = new VimCmdlineController(':', new VimStringLine(''), new TestTarget()).context();
		const applying = DEFAULT_KEYBINDINGS.filter(b => evaluateWhen(b.when, ctx));
		assert.deepStrictEqual(applying.map(b => b.key), []);
	});

	test('one key, one prompt binding, in every state the prompt has', () => {
		const states = [
			{ menu: false, text: '', kind: ':' as const },
			{ menu: false, text: 'x', kind: ':' as const },
			{ menu: true, text: 'x', kind: ':' as const },
			{ menu: true, picked: true, text: 'x', kind: ':' as const },
			{ menu: false, text: 'x', kind: '/' as const },
		];
		for (const st of states) {
			const ctx = new VimCmdlineController(st.kind, new VimStringLine(st.text), new TestTarget()).context(st.menu, 'picked' in st && st.picked);
			const seen = new Map<string, string>();
			for (const b of CMDLINE_KEYBINDINGS.filter(b => evaluateWhen(b.when, ctx))) {
				assert.ok(!seen.has(b.key), `${b.key} twice: ${seen.get(b.key)} and ${b.command} (${JSON.stringify(st)})`);
				seen.set(b.key, b.command);
			}
		}
	});
});

// ---- the engine with the prompt ------------------------------------------------------------

class Host {
	lines: string[];
	cursor: VimPos = { line: 0, col: 0 };
	incsearch: VimRange | undefined;
	commands: { command: string; args: unknown }[] = [];
	constructor(text: string) { this.lines = text.split('\n'); }
}

function engine(text: string, shared = new VimSharedState()) {
	const h = new Host(text);
	const host: IVimHost = Object.assign(h, {
		lineCount: () => h.lines.length, lineText: (l: number) => h.lines[l], getCursor: () => h.cursor,
		setCursor: (p: VimPos) => { h.cursor = p; }, getSelection: () => ({ anchor: h.cursor, active: h.cursor }),
		setSelection: () => { }, setSelections: () => { },
		applyEdits: (edits: readonly { start: VimPos; end: VimPos; text: string }[]) => {
			for (const e of [...edits].reverse()) {
				const head = h.lines[e.start.line].slice(0, e.start.col);
				const tail = h.lines[e.end.line].slice(e.end.col);
				h.lines.splice(e.start.line, e.end.line - e.start.line + 1, ...(head + e.text + tail).split('\n'));
			}
		},
		beginChange: () => { }, endChange: () => { }, undo: () => { }, redo: () => { }, indentUnit: () => '\t', tabSize: () => 4, indentOptions: () => ({ tabSize: 4, indentSize: 'tabSize' as const, insertSpaces: false }), setIndentOptions: () => { }, defaultIndentOptions: () => ({ tabSize: 4, indentSize: 'tabSize' as const, insertSpaces: false }),
		visibleLines: () => ({ top: 0, bottom: h.lines.length - 1 }), scrollToLine: () => { }, isLineHidden: () => false,
		displayLineMove: () => undefined, setClipboard: () => { }, getClipboard: () => '', prefetchClipboard: () => { },
		highlightSearch: () => { }, showIncSearch: (r: VimRange | undefined) => { h.incsearch = r; }, lineComment: () => '//',
		...vimFindHost(() => h.lines), previewSubstitute: () => { },
		hasRangeFormatter: () => false, fileName: () => 'f.txt',
		executeCommand: (command: string, args: unknown) => { h.commands.push({ command, args }); return Promise.resolve(undefined); },
		refresh: () => { },
	});
	const vim = new VimEngine(host, shared);
	const line = () => {
		const s = vim.cmdlineState!;
		return new VimCmdlineController(s.kind, new VimStringLine(s.text), vim.cmdlineTarget(), vim.cmdlineSources());
	};
	return { h, vim, line };
}

suite('DevHub Vim prompt: the engine', () => {

	test('opening: `:` from visual mode starts with \'<,\'>, a count with .,.+N-1; / keeps the operator, count and register waiting', () => {
		const a = engine('a\nb\nc');
		a.vim.execute('devhubVim.mode', { to: 'visualLine' });
		a.vim.execute('devhubVim.cmdline', { kind: ':' });
		assert.strictEqual(a.vim.cmdlineState?.text, '\'<,\'>');
		assert.strictEqual(a.vim.mode, 'normal');
		const b = engine('a\nb\nc');
		b.vim.execute('devhubVim.count', { digit: 3 });
		b.vim.execute('devhubVim.cmdline', { kind: ':' });
		assert.deepStrictEqual({ ...b.vim.cmdlineState, id: 0 }, { kind: ':', text: '.,.+2', id: 0 });
		assert.strictEqual(b.vim.context().mode, 'cmdline');
		const c = engine('one two three');
		c.vim.execute('devhubVim.operator', { operator: 'delete' });
		c.vim.execute('devhubVim.cmdline', { kind: '/' });
		assert.strictEqual(c.vim.status(), 'd', 'the status bar shows what waits; the line shows the text');
		const p = c.line();
		p.insertText('thr');
		assert.deepStrictEqual(c.h.incsearch, { start: { line: 0, col: 8 }, end: { line: 0, col: 11 } });
		p.submit();
		assert.deepStrictEqual(c.h.lines, ['three']);
		assert.strictEqual(c.h.incsearch, undefined);
		assert.strictEqual(c.vim.cmdlineOpen, false);
	});

	test('each prompt has its own number, so the workbench shows it once', () => {
		const e = engine('a');
		e.vim.execute('devhubVim.cmdline', { kind: '/' });
		const first = e.vim.cmdlineState!.id;
		e.line().cancel();
		e.vim.execute('devhubVim.cmdline', { kind: '/' });
		assert.ok(e.vim.cmdlineState!.id > first);
	});

	test('submitting: `:` runs devhubVim.ex and goes into the history, / and ? search; cancelling clears what waited', () => {
		const shared = new VimSharedState();
		const e = engine('foo bar foo', shared);
		e.vim.execute('devhubVim.cmdline', { kind: ':' });
		const p = e.line();
		p.insertText('  wall ');
		p.submit();
		assert.deepStrictEqual(e.h.commands.map(c => c.command), ['workbench.action.files.saveAll']);
		assert.deepStrictEqual(shared.history[':'], ['wall']);
		e.vim.execute('devhubVim.cmdline', { kind: '?' });
		const q = e.line();
		q.insertText('bar');
		q.submit();
		assert.deepStrictEqual(e.h.cursor, { line: 0, col: 4 });
		assert.deepStrictEqual(shared.history['/'], ['bar']);
		e.vim.execute('devhubVim.operator', { operator: 'delete' });
		e.vim.execute('devhubVim.cmdline', { kind: '/' });
		e.line().cancel();
		assert.strictEqual(e.vim.pending, false);
		assert.strictEqual(e.vim.cmdlineOpen, false);
	});

	test('CTRL-R reads the engine\'s registers, the read-only ones too', () => {
		const e = engine('word');
		e.vim.execute('devhubVim.cmdline', { kind: ':' });
		const p = e.line();
		p.feedKey('<C-r>');
		p.feedKey('%');
		assert.strictEqual(p.line.text, 'f.txt');
	});

	test('fed keys type into the engine\'s own line: :normal /foo<CR>, and a register run with @ that leaves the prompt open', () => {
		const e = engine('a foo b foo');
		e.vim.execute('devhubVim.ex', { command: 'normal /foo<CR>n' });
		assert.deepStrictEqual(e.h.cursor, { line: 0, col: 8 });
		e.vim.feedKeys(':s/b/X/<CR>');
		assert.deepStrictEqual(e.h.lines, ['a foo X foo']);
		e.vim.feedKeys('/fo');
		assert.deepStrictEqual(e.vim.cmdlineState && { kind: e.vim.cmdlineState.kind, text: e.vim.cmdlineState.text }, { kind: '/', text: 'fo' });
	});
});
