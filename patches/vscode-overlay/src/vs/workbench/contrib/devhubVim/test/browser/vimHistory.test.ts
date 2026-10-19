/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: Vim has no jump list of its own. CTRL-O / CTRL-I are VS Code's Go
// Back / Go Forward, and a Vim jump (G gg / n % `a :{n} H M L ...) puts the
// cursor with TextEditorSelectionSource.JUMP, as Go to Definition does, so
// VS Code's history records it as a jump: an entry even a few lines away,
// and both ends in the navigation locations. Every other move is the
// user's own ('devhubVim'), which the history records only 10 lines away.

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { EditorContextKeys } from '../../../../../editor/common/editorContextKeys.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { TestCodeEditor, createCodeEditorServices } from '../../../../../editor/test/browser/testCodeEditor.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { TextEditorSelectionSource } from '../../../../../platform/editor/common/editor.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IStatusbarEntryAccessor, IStatusbarService } from '../../../../services/statusbar/browser/statusbar.js';
import { DevhubVim } from '../../browser/devhubVim.contribution.js';

suite('DevHub Vim: jumps are VS Code jumps, for its history', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function withVim(text: string, fn: (vim: DevhubVim, sources: () => string[]) => void): void {
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
			let seen: string[] = [];
			disposables.add(editor.onDidChangeCursorPosition(e => seen.push(`${e.position.lineNumber}:${e.source}`)));
			fn(vim, () => { const r = seen; seen = []; return r; });
		} finally {
			disposables.dispose();
		}
	}

	const JUMP = TextEditorSelectionSource.JUMP;

	test('G gg and a mark are jumps; j k are not', () => withVim('a\nb\nc\nd', (vim, sources) => {
		vim.execute('devhubVim.motion', { motion: 'fileEnd' });
		assert.deepStrictEqual(sources(), [`4:${JUMP}`]);
		vim.execute('devhubVim.motion', { motion: 'up' });
		assert.deepStrictEqual(sources(), ['3:devhubVim']);
		vim.execute('devhubVim.mark', { char: 'a' });
		vim.execute('devhubVim.motion', { motion: 'fileStart' });
		assert.deepStrictEqual(sources(), [`1:${JUMP}`]);
		vim.execute('devhubVim.motion', { motion: 'down' });
		assert.deepStrictEqual(sources(), ['2:devhubVim']);
		vim.execute('devhubVim.motion', { motion: 'mark', char: 'a' });
		assert.deepStrictEqual(sources(), [`3:${JUMP}`]);
	}));

	test('a jump in visual mode is a jump too', () => withVim('a\nb\nc', (vim, sources) => {
		vim.execute('devhubVim.mode', { to: 'visual' });
		sources();
		vim.execute('devhubVim.motion', { motion: 'fileEnd' });
		assert.deepStrictEqual(sources(), [`3:${JUMP}`]);
	}));
});
