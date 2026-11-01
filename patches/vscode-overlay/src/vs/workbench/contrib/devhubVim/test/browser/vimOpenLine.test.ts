/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub Vim: `o` / `O` open the line with the indentation VS Code's Enter
// gives there (editor.autoIndent, the language's brackets, indentation rules
// and onEnterRules), as Vim does with 'indentexpr': `o` after a line ending
// in `{` is one level deeper, `O` above a `}` is inside the block. A count
// repeats the typed line with the same start.

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Handler, TypePayload } from '../../../../../editor/common/editorCommon.js';
import { EditorContextKeys } from '../../../../../editor/common/editorContextKeys.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { ILanguageConfigurationService } from '../../../../../editor/common/languages/languageConfigurationRegistry.js';
import { IndentAction } from '../../../../../editor/common/languages/languageConfiguration.js';
import { instantiateTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { TestCodeEditor, createCodeEditorServices } from '../../../../../editor/test/browser/testCodeEditor.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IStatusbarEntryAccessor, IStatusbarService } from '../../../../services/statusbar/browser/statusbar.js';
import { DevhubVim } from '../../browser/devhubVim.contribution.js';

suite('DevHub Vim: o / O indent as VS Code\'s Enter', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const LANG = 'devhubVimOpenLineLang';

	function withVim(text: string, autoIndent: string, fn: (env: { vim: DevhubVim; editor: TestCodeEditor; text(): string }) => void): void {
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
			disposables.add(instantiation.get(ILanguageService).registerLanguage({ id: LANG }));
			disposables.add(instantiation.get(ILanguageConfigurationService).register(LANG, {
				brackets: [['{', '}'], ['(', ')']],
				indentationRules: { increaseIndentPattern: /[{(]\s*$/, decreaseIndentPattern: /^\s*[})]/ },
				onEnterRules: [{ beforeText: /^\s*\/\*\*(?!\/)([^*]|\*(?!\/))*$/, action: { indentAction: IndentAction.None, appendText: ' * ' } }],
			}));
			const vim = disposables.add(instantiation.createInstance(DevhubVim));
			const editor = disposables.add(instantiation.createInstance(TestCodeEditor, document.createElement('div'), { autoIndent: autoIndent as 'full' }, { contributions: [] }));
			const model = disposables.add(instantiateTextModel(instantiation, text, LANG, { insertSpaces: true, tabSize: 2, indentSize: 2, detectIndentation: false }));
			editor.setModel(model);
			editor.setHasTextFocus(true);
			editor.getViewModel()!.setHasFocus(true);
			const keys = editor.invokeWithinContext(a => a.get(IContextKeyService));
			EditorContextKeys.editorTextFocus.bindTo(keys).set(true);
			EditorContextKeys.textInputFocus.bindTo(keys).set(true);
			vim.update();
			fn({ vim, editor, text: () => model.getValue() });
		} finally {
			disposables.dispose();
		}
	}

	const type = (editor: TestCodeEditor, text: string) => {
		for (const ch of text) {
			editor.trigger('keyboard', Handler.Type, { text: ch } satisfies TypePayload);
		}
	};

	function open(env: { vim: DevhubVim; editor: TestCodeEditor }, line: number, key: 'o' | 'O', typed: string, count?: number): void {
		env.editor.setPosition({ lineNumber: line, column: 1 });
		if (count) {
			env.vim.execute('devhubVim.count', { digit: count });
		}
		env.vim.execute('devhubVim.mode', { to: 'insert', at: key === 'o' ? 'lineBelow' : 'lineAbove' });
		type(env.editor, typed);
		env.vim.execute('devhubVim.escape', undefined);
	}

	test('o after a line ending in { is one level deeper; O above a } is inside the block', () => withVim('function f() {\n}', 'advanced', env => {
		open(env, 1, 'o', 'a();');
		assert.strictEqual(env.text(), 'function f() {\n  a();\n}');
		open(env, 3, 'O', 'b();');
		assert.strictEqual(env.text(), 'function f() {\n  a();\n  b();\n}');
	}));

	test('O on a line under a { opens inside the block; o after a plain line keeps its indentation', () => withVim('if (x) {\n  y();\n}', 'full', env => {
		open(env, 2, 'O', 'w();');
		assert.strictEqual(env.text(), 'if (x) {\n  w();\n  y();\n}');
		open(env, 3, 'o', 'z();');
		assert.strictEqual(env.text(), 'if (x) {\n  w();\n  y();\n  z();\n}');
	}));

	test('a count repeats the typed line with the same indentation (3o)', () => withVim('{\n}', 'advanced', env => {
		open(env, 1, 'o', 'x', 3);
		assert.strictEqual(env.text(), '{\n  x\n  x\n  x\n}');
	}));

	test('an onEnterRule\'s text continues, as Enter does (a doc comment\'s " * ")', () => withVim('/**', 'advanced', env => {
		open(env, 1, 'o', 'doc');
		assert.strictEqual(env.text(), '/**\n * doc');
	}));

	test('O on the first line keeps its indentation; editor.autoIndent "keep" copies the line\'s, "none" puts none', () => {
		withVim('  a {', 'advanced', env => {
			open(env, 1, 'O', 'b');
			assert.strictEqual(env.text(), '  b\n  a {');
		});
		withVim('  a {', 'keep', env => {
			open(env, 1, 'o', 'b');
			assert.strictEqual(env.text(), '  a {\n  b');
		});
		withVim('  a {', 'none', env => {
			open(env, 1, 'o', 'b');
			assert.strictEqual(env.text(), '  a {\nb');
		});
	});
});
