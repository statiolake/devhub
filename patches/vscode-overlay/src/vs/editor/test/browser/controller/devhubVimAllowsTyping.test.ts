/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: the editor's keys that type or erase at the caret apply only where
// typed text reaches the model (EditorContextKeys.devhubVimAllowsTyping): always
// without DevHub Vim, in Vim's insert and replace mode with it.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IContext } from '../../../../platform/contextkey/common/contextkey.js';
import { KeybindingsRegistry } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { EditorContextKeys } from '../../../common/editorContextKeys.js';
import '../../../browser/coreCommands.js';
import '../../../contrib/caretOperations/browser/transpose.js';
import '../../../contrib/linesOperations/browser/linesOperations.js';
import '../../../contrib/wordOperations/browser/wordOperations.js';
import '../../../contrib/wordPartOperations/browser/wordPartOperations.js';

/** Commands whose default keys are character input (some only have macOS keys). */
const GATED = [
	'deleteLeft', 'deleteRight', 'tab', 'outdent', 'lineBreakInsert',
	'deleteWordLeft', 'deleteWordRight', 'deleteWordPartLeft', 'deleteWordPartRight',
	'deleteAllLeft', 'deleteAllRight', 'editor.action.insertLineAfter', 'editor.action.insertLineBefore',
	'editor.action.transposeLetters',
];
/** Bound on every platform, so this test always sees their keys. */
const GATED_EVERYWHERE = ['deleteLeft', 'deleteRight', 'tab', 'outdent', 'deleteWordLeft', 'deleteWordRight', 'editor.action.insertLineAfter', 'editor.action.insertLineBefore'];
/** Line-level commands: not character input, they run in any Vim mode. */
const UNGATED = ['editor.action.deleteLines', 'editor.action.moveLinesUpAction', 'editor.action.moveLinesDownAction', 'editor.action.copyLinesUpAction', 'editor.action.copyLinesDownAction', 'editor.action.indentLines', 'editor.action.outdentLines'];

function context(values: Record<string, unknown>): IContext {
	const all: Record<string, unknown> = { editorTextFocus: true, textInputFocus: true, editorFocus: true, ...values };
	return { getValue: <T>(key: string) => all[key] as T };
}

/** [what, context keys, the editor's typing keys apply] */
const CASES: [string, Record<string, unknown>, boolean][] = [
	['no Vim (keys never set)', {}, true],
	['Vim off', { 'devhubVim.active': false, 'devhubVim.mode': '' }, true],
	['a plain input while Vim is on', { 'devhubVim.active': false, 'devhubVim.mode': 'insert' }, true],
	['insert mode', { 'devhubVim.active': true, 'devhubVim.mode': 'insert' }, true],
	['replace mode', { 'devhubVim.active': true, 'devhubVim.mode': 'replace' }, true],
	['normal mode', { 'devhubVim.active': true, 'devhubVim.mode': 'normal' }, false],
	['visual mode', { 'devhubVim.active': true, 'devhubVim.mode': 'visual' }, false],
	['visual line mode', { 'devhubVim.active': true, 'devhubVim.mode': 'visualLine' }, false],
	['visual block mode', { 'devhubVim.active': true, 'devhubVim.mode': 'visualBlock' }, false],
	['operator-pending mode', { 'devhubVim.active': true, 'devhubVim.mode': 'operatorPending' }, false],
	['the : / prompt', { 'devhubVim.active': true, 'devhubVim.mode': 'cmdline' }, false],
	['<C-w> waiting in a Vim editor', { 'devhubVim.active': true, 'devhubVim.mode': 'nav' }, false],
	['<C-w> waiting in a plain input', { 'devhubVim.active': false, 'devhubVim.mode': 'nav' }, false],
];

suite('DevHub Vim: the editor\'s typing keys apply only where text is typed', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the shared expression', () => {
		// test/common/vimEngine.test.ts (devhubVim) models the editor's keys with this same string
		assert.strictEqual(EditorContextKeys.devhubVimAllowsTyping.serialize(),
			'devhubVim.mode == \'insert\' || devhubVim.mode == \'replace\' || !devhubVim.active && devhubVim.mode != \'nav\'');
		for (const [what, values, applies] of CASES) {
			assert.strictEqual(EditorContextKeys.devhubVimAllowsTyping.evaluate(context(values)), applies, what);
		}
	});

	test('every default key of the character-input commands carries it (the Keyboard Shortcuts editor shows it)', () => {
		const items = KeybindingsRegistry.getDefaultKeybindings();
		for (const id of GATED_EVERYWHERE) {
			assert.ok(items.some(i => i.command === id), `${id} has a default key`);
		}
		for (const item of items.filter(i => GATED.includes(i.command ?? ''))) {
			assert.ok(item.when?.keys().includes('devhubVim.mode'), `${item.command}: ${item.when?.serialize()}`);
			for (const [what, values, applies] of CASES) {
				assert.strictEqual(item.when!.evaluate(context({ editorTabMovesFocus: false, ...values })), applies, `${item.command} in ${what}: ${item.when!.serialize()}`);
			}
		}
	});

	test('line-level commands are not character input and keep their upstream when', () => {
		const items = KeybindingsRegistry.getDefaultKeybindings().filter(i => UNGATED.includes(i.command ?? ''));
		assert.ok(items.length >= UNGATED.length);
		for (const item of items) {
			assert.ok(!item.when?.keys().some(k => k.startsWith('devhubVim.')), `${item.command}: ${item.when?.serialize()}`);
		}
	});
});
