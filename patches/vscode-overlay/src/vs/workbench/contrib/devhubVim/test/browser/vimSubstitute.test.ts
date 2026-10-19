/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: `:s`, `/` and the other patterns are VS Code's find on the editor's
// model (JavaScript regular expressions, multiline as the find widget's),
// and `:s` replacement strings are the find widget's (parseReplaceString:
// $1 $& \n \t and the case operators \u \U \l \L); the range, the count and
// the flags are Vim's.

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
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IStatusbarEntryAccessor, IStatusbarService } from '../../../../services/statusbar/browser/statusbar.js';
import { DevhubVim } from '../../browser/devhubVim.contribution.js';

suite('DevHub Vim: :s and search are VS Code\'s find and replace', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function withVim(text: string, fn: (vim: DevhubVim, editor: TestCodeEditor) => void, settings: Record<string, unknown> = {}): void {
		const disposables = new DisposableStore();
		try {
			const configurationService = new TestConfigurationService({ 'devhub.vim.enabled': true, ...settings });
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
			fn(vim, editor);
		} finally {
			disposables.dispose();
		}
	}

	function sub(text: string, ex: string, expected: string, settings?: Record<string, unknown>): void {
		withVim(text, (vim, editor) => {
			vim.execute('devhubVim.ex', { command: ex });
			assert.strictEqual(editor.getModel()!.getValue(), expected, ex);
		}, settings);
	}

	test('groups, $& and the case operators of the find widget', () => {
		sub('ab', 's/(a)(b)/$2$1/', 'ba');
		sub('abc', 's/b/[$&]/', 'a[b]c');
		sub('foo bar', 's/(\\w+)/\\u$1/g', 'Foo Bar');
		sub('foo bar', 's/(foo)/\\U$1!/', 'FOO! bar');
		sub('FOO', 's/(F)(OO)/$1\\L$2/', 'Foo');
		sub('a,b', 's/,/\\n/', 'a\nb');
		sub('a,b', 's/,/\\t/', 'a\tb');
		sub('a.b', 's/\\./$$/', 'a$b');
	});

	test('multiline patterns, ranges, flags and smartcase', () => {
		sub('a\nb\nc', '%s/a\\nb/x/', 'x\nc');
		sub('a1\na2\na3', '2,3s/a/b/', 'a1\nb2\nb3');
		sub('aa\naa', '%s/a/b/', 'ba\nba');
		sub('aa\naa', '%s/a/b/g', 'bb\nbb');
		sub('Aa', 's/a/x/gi', 'xx');
		sub('Aa', 's/a/x/gI', 'Ax', { 'devhub.vim.options': { ignorecase: true } });
		sub('Aa', 's/a/x/g', 'xx', { 'devhub.vim.options': { ignorecase: true, smartcase: true } });
		sub('Aa', 's/A/x/g', 'xa', { 'devhub.vim.options': { ignorecase: true, smartcase: true } });
		sub('foo foobar', 's/\\bfoo\\b/X/g', 'X foobar');
	});

	test('one undo step', () => withVim('a\na\na', (vim, editor) => {
		vim.execute('devhubVim.ex', { command: '%s/a/b/' });
		assert.strictEqual(editor.getModel()!.getValue(), 'b\nb\nb');
		editor.getModel()!.undo();
		assert.strictEqual(editor.getModel()!.getValue(), 'a\na\na');
	}));

	test('* is VS Code\'s Match Whole Word; / is multiline as the find widget', () => withVim('foo foobar foo\nx', (vim, editor) => {
		vim.execute('devhubVim.motion', { motion: 'searchWordForward' });
		assert.strictEqual(`${editor.getPosition()}`, '(1,12)');
		editor.setPosition({ lineNumber: 1, column: 1 });
		vim.execute('devhubVim.search', { pattern: 'foo\\nx' });
		assert.strictEqual(`${editor.getPosition()}`, '(1,12)');
	}));
});
