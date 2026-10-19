/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub Vim: Cmd+C / Cmd+X / Cmd+V are VS Code's clipboard actions in every
// mode, as in a GUI editor. The modal text input lets a paste through
// (modalTextInput.ts): in normal mode it goes in at the caret as VS Code's
// paste does, one undo step, and the editor stays in normal mode with the
// caret on a character; over a visual selection it replaces the selection and
// visual mode ends, as a cut of it does. Copy changes nothing, so visual mode
// stays. Insert mode is VS Code's.

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PastePayload } from '../../../../../editor/browser/editorBrowser.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { Handler } from '../../../../../editor/common/editorCommon.js';
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

suite('DevHub Vim: the clipboard works in every mode', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	interface Env {
		readonly vim: DevhubVim;
		readonly editor: TestCodeEditor;
		text(): string;
		mode(): unknown;
		/** What VS Code's paste action ends in (the edit context's paste event, or the paste-as controller's default). */
		paste(text: string): Promise<void>;
		/** What Cmd+X ends in. */
		cut(): Promise<void>;
	}

	const settle = () => new Promise(r => setTimeout(r, 0));

	async function withVim(text: string, fn: (env: Env) => Promise<void>): Promise<void> {
		const disposables = new DisposableStore();
		try {
			const configurationService = new TestConfigurationService({ 'devhub.vim.enabled': true });
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
			await fn({
				vim, editor,
				text: () => editor.getModel()!.getValue(),
				mode: () => keys.getContextKeyValue('devhubVim.mode'),
				paste: async text => {
					editor.trigger('keyboard', Handler.Paste, { text, pasteOnNewLine: false, multicursorText: null, mode: null, isBlock: false } satisfies PastePayload);
					await settle();
				},
				cut: async () => {
					editor.trigger('keyboard', Handler.Cut, null);
					await settle();
				},
			});
		} finally {
			disposables.dispose();
		}
	}

	test('normal mode: Cmd+V goes in at the caret, stays in normal mode, one undo step, the caret on a character', () => withVim('abc', async ({ vim, editor, text, mode, paste }) => {
		vim.execute('devhubVim.motion', { motion: 'right' });
		await paste('XY');
		assert.strictEqual(text(), 'aXYbc');
		assert.strictEqual(mode(), 'normal');
		assert.strictEqual(`${editor.getPosition()}`, '(1,4)', 'after the pasted text, as VS Code puts it: on the character after it');
		vim.execute('devhubVim.motion', { motion: 'lineEnd' });
		await paste('Z');
		assert.strictEqual(text(), 'aXYbZc');
		assert.strictEqual(mode(), 'normal');
		// one paste, one undo step
		editor.getModel()!.undo();
		assert.strictEqual(text(), 'aXYbc');
		editor.getModel()!.undo();
		assert.strictEqual(text(), 'abc');
		assert.strictEqual(mode(), 'normal');
	}));

	test('visual mode: Cmd+V replaces the selection and ends visual mode', () => withVim('abc def ghi', async ({ vim, editor, text, mode, paste }) => {
		vim.execute('devhubVim.motion', { motion: 'wordForward' });
		vim.execute('devhubVim.mode', { to: 'visual' });
		vim.execute('devhubVim.motion', { motion: 'wordEnd' });
		assert.strictEqual(mode(), 'visual');
		assert.strictEqual(editor.getModel()!.getValueInRange(editor.getSelection()!), 'def', 'Cmd+C copies exactly the visual text');
		await paste('XYZ');
		assert.strictEqual(text(), 'abc XYZ ghi');
		assert.strictEqual(mode(), 'normal');
		assert.ok(editor.getSelection()!.isEmpty());
		// visual line mode
		vim.execute('devhubVim.mode', { to: 'visualLine' });
		await paste('new');
		assert.strictEqual(mode(), 'normal');
		assert.ok(editor.getSelection()!.isEmpty());
	}));

	test('visual mode: Cmd+X cuts the selection and ends visual mode; in normal mode it is VS Code\'s', () => withVim('abc def\nxyz', async ({ vim, editor, text, mode, cut }) => {
		vim.execute('devhubVim.mode', { to: 'visual' });
		vim.execute('devhubVim.motion', { motion: 'wordEnd' });
		await cut();
		assert.strictEqual(text(), ' def\nxyz');
		assert.strictEqual(mode(), 'normal');
		assert.deepStrictEqual(editor.getSelections(), [new Selection(1, 1, 1, 1)]);
		// an edit Vim made itself, or one that is not over the selection, leaves the mode alone
		vim.execute('devhubVim.mode', { to: 'visual' });
		editor.executeEdits('other', [{ range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 1 }, text: '>' }]);
		await settle();
		assert.strictEqual(mode(), 'visual');
	}));

	test('insert mode: paste is VS Code\'s and stays in insert mode', () => withVim('abc', async ({ vim, text, mode, paste }) => {
		vim.execute('devhubVim.mode', { to: 'insert', at: 'lineEnd' });
		await paste('!');
		assert.strictEqual(text(), 'abc!');
		assert.strictEqual(mode(), 'insert');
	}));
});
