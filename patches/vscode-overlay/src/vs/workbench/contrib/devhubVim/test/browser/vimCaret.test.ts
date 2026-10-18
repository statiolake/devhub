/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: in normal, visual and operator-pending mode a Vim editor's caret is
// on a character and never past the end of a line, however it got there (a
// click, a restored view state, undo, another contribution), as a state of
// the editor core (editor/common/cursor/modalCursor.ts), not a correction
// made after the fact. Insert mode is VS Code's caret: `a` `A` and a click put
// it after the last character, and Esc moves it one left, once.

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CoreNavigationCommands } from '../../../../../editor/browser/coreCommands.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { Handler, ICursorState, TypePayload } from '../../../../../editor/common/editorCommon.js';
import { EditorContextKeys } from '../../../../../editor/common/editorContextKeys.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { TestCodeEditor, createCodeEditorServices } from '../../../../../editor/test/browser/testCodeEditor.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IStatusbarEntryAccessor, IStatusbarService } from '../../../../services/statusbar/browser/statusbar.js';
import { DevhubVim } from '../../browser/devhubVim.contribution.js';

suite('DevHub Vim: outside insert mode the caret is on a character', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	interface Env {
		readonly vim: DevhubVim;
		readonly editor: TestCodeEditor;
		/** The caret, `(line,column)`. */
		at(): string;
		mode(): unknown;
		/** Every caret position the editor announced since the last call. */
		seen(): string[];
		setEnabled(enabled: boolean): void;
	}

	async function withVim(text: string, fn: (env: Env) => void | Promise<void>, vimOn = true): Promise<void> {
		const disposables = new DisposableStore();
		try {
			const configurationService = new TestConfigurationService({ 'devhub.vim.enabled': vimOn });
			const contextKeyService = disposables.add(new ContextKeyService(configurationService));
			const instantiation = createCodeEditorServices(disposables, new ServiceCollection(
				[IConfigurationService, configurationService],
				[IContextKeyService, contextKeyService],
				[IStatusbarService, new class extends mock<IStatusbarService>() { override addEntry(): IStatusbarEntryAccessor { return { update() { }, dispose() { } }; } }],
				[ILabelService, new class extends mock<ILabelService>() { }],
			));
			const vim = disposables.add(instantiation.createInstance(DevhubVim));
			const editor = disposables.add(instantiation.createInstance(TestCodeEditor, document.createElement('div'), {}, { contributions: [] }));
			editor.setModel(disposables.add(createTextModel(text)));
			editor.setHasTextFocus(true);
			const keys = editor.invokeWithinContext(a => a.get(IContextKeyService));
			EditorContextKeys.editorTextFocus.bindTo(keys).set(true);
			EditorContextKeys.textInputFocus.bindTo(keys).set(true);
			vim.update();
			let seen: string[] = [];
			disposables.add(editor.onDidChangeCursorPosition(e => seen.push(`${e.position}`)));
			await fn({
				vim, editor,
				at: () => `${editor.getPosition()}`,
				mode: () => keys.getContextKeyValue('devhubVim.mode'),
				seen: () => { const r = seen; seen = []; return r; },
				setEnabled: enabled => (vim as unknown as { setEnabled(enabled: boolean): void }).setEnabled(enabled),
			});
		} finally {
			disposables.dispose();
		}
	}

	function click(editor: TestCodeEditor, lineNumber: number, column: number, select = false): void {
		const position = new Position(lineNumber, column);
		(select ? CoreNavigationCommands.MoveToSelect : CoreNavigationCommands.MoveTo).runCoreEditorCommand(editor._getViewModel()!, { source: 'mouse', position, viewPosition: position });
	}

	const type = (editor: TestCodeEditor, text: string) => editor.trigger('keyboard', Handler.Type, { text } satisfies TypePayload);

	test('a click past the end of the line in normal mode lands on the last character, with no event past it', () => withVim('abc\n\nxyz', ({ editor, at, mode, seen }) => {
		seen();
		click(editor, 1, 9);
		assert.strictEqual(at(), '(1,3)');
		assert.deepStrictEqual(seen(), ['(1,3)']);
		assert.strictEqual(mode(), 'normal');
		// an empty line: column 1
		click(editor, 2, 1);
		assert.strictEqual(at(), '(2,1)');
	}));

	test('a drag past the end of the line in normal mode is visual mode up to and including the last character', () => withVim('abc', ({ vim, editor, at, mode }) => {
		click(editor, 1, 1);
		click(editor, 1, 9, true);
		assert.strictEqual(mode(), 'visual');
		assert.deepStrictEqual(editor.getSelection(), new Selection(1, 1, 1, 4));
		vim.execute('devhubVim.escape', undefined);
		assert.strictEqual(mode(), 'normal');
		assert.strictEqual(at(), '(1,3)');
	}));

	test('`A` and `a` put the caret after the last character; a click there in insert mode stays there; Esc moves it one left, once', () => withVim('abc', ({ vim, editor, at, mode, seen }) => {
		vim.execute('devhubVim.mode', { to: 'insert', at: 'lineEnd' });
		assert.strictEqual(mode(), 'insert');
		assert.strictEqual(at(), '(1,4)');
		click(editor, 1, 1);
		click(editor, 1, 9);
		assert.strictEqual(at(), '(1,4)');
		type(editor, 'd');
		assert.strictEqual(at(), '(1,5)');
		seen();
		vim.execute('devhubVim.escape', undefined);
		assert.strictEqual(mode(), 'normal');
		assert.strictEqual(at(), '(1,4)');
		assert.deepStrictEqual(seen(), ['(1,4)'], 'one move, from after the `d` onto it');
		vim.execute('devhubVim.mode', { to: 'insert', at: 'after' });
		assert.strictEqual(at(), '(1,5)');
		vim.execute('devhubVim.escape', undefined);
		assert.strictEqual(at(), '(1,4)');
	}));

	test('CTRL-O at the end of the line: on the last character for the command, back after it in insert mode', () => withVim('abc', ({ vim, at, mode }) => {
		vim.execute('devhubVim.mode', { to: 'insert', at: 'lineEnd' });
		vim.execute('devhubVim.insert', { action: 'oneCommand' });
		assert.strictEqual(at(), '(1,3)');
		vim.execute('devhubVim.motion', { motion: 'lineEnd' });
		assert.strictEqual(mode(), 'insert');
		assert.strictEqual(at(), '(1,4)');
	}));

	test('a view state restored with the caret at the end of a line, and setPosition / setSelections from other contributions', () => withVim('abc\ndef', ({ editor, at, seen }) => {
		const state: ICursorState[] = [{ inSelectionMode: false, selectionStart: { lineNumber: 2, column: 4 }, position: { lineNumber: 2, column: 4 } }];
		seen();
		// the cursor half of CodeEditorWidget.restoreViewState (a test editor has no view)
		editor.getViewModel()!.restoreCursorState(state);
		assert.strictEqual(at(), '(2,3)');
		assert.deepStrictEqual(seen(), ['(2,3)']);
		editor.setPosition({ lineNumber: 1, column: 4 }, 'gotoDefinition');
		assert.strictEqual(at(), '(1,3)');
		editor.setSelections([new Selection(1, 4, 1, 4), new Selection(2, 4, 2, 4)], 'references');
		assert.deepStrictEqual(editor.getSelections()!.map(s => `${s.getPosition()}`), ['(1,3)', '(2,3)']);
	}));

	test('`u` putting back the caret a change started from, after the last character', () => withVim('abc', async ({ vim, editor, at, mode }) => {
		vim.execute('devhubVim.mode', { to: 'insert', at: 'lineEnd' });
		type(editor, 'd');
		vim.execute('devhubVim.escape', undefined);
		assert.strictEqual(editor.getModel()!.getValue(), 'abcd');
		vim.execute('devhubVim.action', { action: 'undo' });
		await new Promise(r => setTimeout(r, 0));
		assert.strictEqual(editor.getModel()!.getValue(), 'abc');
		assert.strictEqual(mode(), 'normal');
		assert.strictEqual(at(), '(1,3)');
	}));

	test('`x` on the last character leaves the caret on the new last one', () => withVim('abc', ({ vim, editor, at, seen }) => {
		vim.execute('devhubVim.motion', { motion: 'lineEnd' });
		seen();
		vim.execute('devhubVim.action', { action: 'deleteChar' });
		assert.strictEqual(editor.getModel()!.getValue(), 'ab');
		assert.strictEqual(at(), '(1,2)');
		assert.deepStrictEqual(seen().filter(p => p === '(1,3)'), [], 'never after the last character');
	}));

	test('with Vim off the caret goes past the end as in VS Code; turning Vim on puts it on the last character', () => withVim('abc', ({ editor, at, setEnabled }) => {
		click(editor, 1, 9);
		assert.strictEqual(at(), '(1,4)');
		editor.setPosition({ lineNumber: 1, column: 4 });
		assert.strictEqual(at(), '(1,4)');
		setEnabled(true);
		assert.strictEqual(at(), '(1,3)');
		setEnabled(false);
		editor.setPosition({ lineNumber: 1, column: 4 });
		assert.strictEqual(at(), '(1,4)');
	}, false));
});
