/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub Vim: undo is VS Code's. `u` and CTRL-R run the `undo` / `redo`
// commands on the model's own undo stack, so an undo step is whatever VS Code
// made one (a format on save, a code action). The engine makes Vim's steps by
// closing the stack element where a change begins and ends, and while an
// insert is open typing does not close it at every word
// (ModalCursor.setUndoGroup, cursor.ts): one insert, one step. After an undo
// or redo, from any key or menu, a Vim editor outside insert mode is in
// normal mode with one collapsed caret.

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CoreEditingCommands } from '../../../../../editor/browser/coreCommands.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { Handler, TypePayload } from '../../../../../editor/common/editorCommon.js';
import { EditorContextKeys } from '../../../../../editor/common/editorContextKeys.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { TestCodeEditor, createCodeEditorServices } from '../../../../../editor/test/browser/testCodeEditor.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IStatusbarEntryAccessor, IStatusbarService } from '../../../../services/statusbar/browser/statusbar.js';
import { DevhubVim } from '../../browser/devhubVim.contribution.js';

suite('DevHub Vim: undo is VS Code\'s, in Vim\'s steps', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	interface Env {
		readonly vim: DevhubVim;
		readonly editor: TestCodeEditor;
		text(): string;
		mode(): unknown;
		/** The `undo` / `redo` command, as `u` / CTRL-R / Cmd+Z run it in the focused editor. */
		undo(): Promise<void>;
		redo(): Promise<void>;
	}

	const settle = () => new Promise(r => setTimeout(r, 0));

	async function withVim(text: string, fn: (env: Env) => Promise<void>, vimOn = true): Promise<void> {
		const disposables = new DisposableStore();
		let editor: TestCodeEditor;
		try {
			const configurationService = new TestConfigurationService({ 'devhub.vim.enabled': vimOn });
			const contextKeyService = disposables.add(new ContextKeyService(configurationService));
			const instantiation = createCodeEditorServices(disposables, new ServiceCollection(
				[IConfigurationService, configurationService],
				[IContextKeyService, contextKeyService],
				[IStatusbarService, new class extends mock<IStatusbarService>() { override addEntry(): IStatusbarEntryAccessor { return { update() { }, dispose() { } }; } }],
				[ILabelService, new class extends mock<ILabelService>() { }],
				// commands run as the workbench runs them: the registered handler, in the editor's services
				[ICommandService, new class extends mock<ICommandService>() {
					override async executeCommand<T>(id: string, ...args: unknown[]): Promise<T> {
						return await editor.invokeWithinContext(a => CommandsRegistry.getCommand(id)!.handler(a, ...args)) as T;
					}
				}],
			));
			const vim = disposables.add(instantiation.createInstance(DevhubVim));
			editor = disposables.add(instantiation.createInstance(TestCodeEditor, document.createElement('div'), {}, { contributions: [] }));
			editor.setModel(disposables.add(createTextModel(text)));
			editor.setHasTextFocus(true);
			editor.getViewModel()!.setHasFocus(true);
			const keys = editor.invokeWithinContext(a => a.get(IContextKeyService));
			EditorContextKeys.editorTextFocus.bindTo(keys).set(true);
			EditorContextKeys.textInputFocus.bindTo(keys).set(true);
			vim.update();
			const run = async (cmd: typeof CoreEditingCommands.Undo) => {
				await editor.invokeWithinContext(a => cmd.runEditorCommand(a, editor, null));
				await settle();
			};
			await fn({
				vim, editor,
				text: () => editor.getModel()!.getValue(),
				mode: () => keys.getContextKeyValue('devhubVim.mode'),
				undo: () => run(CoreEditingCommands.Undo),
				redo: () => run(CoreEditingCommands.Redo),
			});
		} finally {
			disposables.dispose();
		}
	}

	const type = (editor: TestCodeEditor, text: string) => {
		for (const ch of text) {
			editor.trigger('keyboard', Handler.Type, { text: ch } satisfies TypePayload);
		}
	};

	test('an insert, words, spaces, newlines and backspaces typed in it, is one undo step', () => withVim('x', async ({ vim, editor, text, mode, undo, redo }) => {
		vim.execute('devhubVim.mode', { to: 'insert', at: 'before' });
		type(editor, 'foo bar.baz\n  qux');
		editor.trigger('keyboard', 'deleteLeft', null);
		type(editor, 'x');
		editor.trigger('keyboard', 'tab', null);
		type(editor, 'y');
		vim.execute('devhubVim.escape', undefined);
		assert.strictEqual(text(), 'foo bar.baz\n  qux   yx');
		await undo();
		assert.strictEqual(text(), 'x');
		assert.strictEqual(mode(), 'normal');
		await redo();
		assert.strictEqual(text(), 'foo bar.baz\n  qux   yx');
		assert.strictEqual(mode(), 'normal');
		assert.ok(editor.getSelection()!.isEmpty());
	}));

	test('without Vim the same typing is VS Code\'s several steps (the rule is Vim\'s only)', () => withVim('x', async ({ editor, text, undo }) => {
		type(editor, 'foo bar baz');
		await undo();
		assert.notStrictEqual(text(), 'x');
	}, false));

	test('each normal-mode change is one step; an edit made with its own undo stops (format on save) is its own', () => withVim('a b c d', async ({ vim, editor, text, undo, redo }) => {
		vim.execute('devhubVim.operator', { operator: 'delete' });
		vim.execute('devhubVim.motion', { motion: 'wordForward' });
		vim.execute('devhubVim.action', { action: 'deleteChar' });
		assert.strictEqual(text(), ' c d');
		// what format on save does: its own element
		const model = editor.getModel()!;
		model.pushStackElement();
		model.pushEditOperations(null, [{ range: new Range(1, 1, 1, 2), text: '' }], () => null);
		model.pushStackElement();
		assert.strictEqual(text(), 'c d');
		await undo();
		assert.strictEqual(text(), ' c d');
		await undo();
		assert.strictEqual(text(), 'b c d');
		await undo();
		assert.strictEqual(text(), 'a b c d');
		await redo();
		assert.strictEqual(text(), 'b c d');
	}));

	test('`u` is the native command with a count, as the keymap runs it (devhubVim.repeat)', () => withVim('a b c d', async ({ vim, text, mode }) => {
		for (let i = 0; i < 3; i++) {
			vim.execute('devhubVim.action', { action: 'deleteChar' });
		}
		assert.strictEqual(text(), ' c d');
		vim.execute('devhubVim.repeat', { command: 'undo', count: 2 });
		await settle();
		await settle();
		assert.strictEqual(text(), ' b c d');
		vim.execute('devhubVim.repeat', { command: 'redo', count: 1 });
		await settle();
		assert.strictEqual(text(), 'b c d');
		assert.strictEqual(mode(), 'normal');
	}));

	test('undo after a visual-mode change, and undo in visual mode: normal mode, the caret collapsed to the start', () => withVim('abc def ghi', async ({ vim, editor, text, mode, undo }) => {
		vim.execute('devhubVim.motion', { motion: 'wordForward' });
		vim.execute('devhubVim.mode', { to: 'visual' });
		vim.execute('devhubVim.motion', { motion: 'wordEnd' });
		vim.execute('devhubVim.operator', { operator: 'delete' });
		assert.strictEqual(text(), 'abc  ghi');
		await undo();
		assert.strictEqual(text(), 'abc def ghi');
		assert.strictEqual(mode(), 'normal');
		assert.deepStrictEqual(editor.getSelections(), [new Selection(1, 5, 1, 5)]);

		// Cmd+Z while a visual selection is up
		vim.execute('devhubVim.action', { action: 'deleteChar' });
		vim.execute('devhubVim.mode', { to: 'visual' });
		vim.execute('devhubVim.motion', { motion: 'lineEnd' });
		assert.strictEqual(mode(), 'visual');
		await undo();
		assert.strictEqual(text(), 'abc def ghi');
		assert.strictEqual(mode(), 'normal');
		assert.ok(editor.getSelection()!.isEmpty());
	}));

	test('Cmd+Z in insert mode stays in insert mode, as in VS Code', () => withVim('x', async ({ vim, editor, text, mode, undo }) => {
		vim.execute('devhubVim.mode', { to: 'insert', at: 'before' });
		type(editor, 'ab cd');
		await undo();
		assert.strictEqual(text(), 'x');
		assert.strictEqual(mode(), 'insert');
		type(editor, 'z');
		vim.execute('devhubVim.escape', undefined);
		assert.strictEqual(text(), 'zx');
	}));
});
