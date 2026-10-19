/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: Vim's last search and VS Code's find state are one search. A Vim
// search is the editor's FindReplaceState (regex on, Match Case from
// 'ignorecase' / 'smartcase', Whole Word for * and #) without opening the
// widget, so F3 finds the same; a search made in the widget is the last
// search `n` follows; while the widget is open its FindModel highlights the
// matches and 'hlsearch' does not draw them again; :noh closes the widget.

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { EditorContributionCtor, EditorContributionInstantiation, IEditorContributionDescription } from '../../../../../editor/browser/editorExtensions.js';
import { IEditorContribution } from '../../../../../editor/common/editorCommon.js';
import { EditorContextKeys } from '../../../../../editor/common/editorContextKeys.js';
import { CommonFindController, NextMatchFindAction } from '../../../../../editor/contrib/find/browser/findController.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { TestCodeEditor, createCodeEditorServices } from '../../../../../editor/test/browser/testCodeEditor.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { BrandedService, IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IStorageService, InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IStatusbarEntryAccessor, IStatusbarService } from '../../../../services/statusbar/browser/statusbar.js';
import { DevhubVim } from '../../browser/devhubVim.contribution.js';

interface Env {
	vim: DevhubVim;
	instantiation: IInstantiationService;
	storage: InMemoryStorageService;
	/** A Vim editor with VS Code's find controller; the first one made has the focus. */
	editor(text: string): TestCodeEditor;
	focus(editor: TestCodeEditor): void;
}

/** VS Code's find controller without its widget (CommonFindController: the find state, F3's FindModel and its highlights), as the workbench makes it: eagerly. */
function eager<S extends BrandedService[]>(id: string, ctor: new (editor: ICodeEditor, ...services: S) => IEditorContribution): IEditorContributionDescription {
	return { id, ctor: ctor as EditorContributionCtor, instantiation: EditorContributionInstantiation.Eager };
}

suite('DevHub Vim: the last search is VS Code\'s find state', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	async function withVim(fn: (env: Env) => Promise<void>, settings: Record<string, unknown> = {}): Promise<void> {
		const disposables = new DisposableStore();
		try {
			const configurationService = new TestConfigurationService({ 'devhub.vim.enabled': true, ...settings });
			const contextKeyService = disposables.add(new ContextKeyService(configurationService));
			const storage = disposables.add(new InMemoryStorageService());
			const instantiation = createCodeEditorServices(disposables, new ServiceCollection(
				[IConfigurationService, configurationService],
				[IContextKeyService, contextKeyService],
				[IStorageService, storage],
				[IStatusbarService, new class extends mock<IStatusbarService>() { override addEntry(): IStatusbarEntryAccessor { return { update() { }, dispose() { } }; } }],
				[ILabelService, new class extends mock<ILabelService>() { }],
			));
			const vim = disposables.add(instantiation.createInstance(DevhubVim));
			const editors: TestCodeEditor[] = [];
			const focus = (editor: TestCodeEditor) => {
				for (const e of editors) {
					e.setHasTextFocus(e === editor);
					const keys = e.invokeWithinContext(a => a.get(IContextKeyService));
					EditorContextKeys.editorTextFocus.bindTo(keys).set(e === editor);
					EditorContextKeys.textInputFocus.bindTo(keys).set(e === editor);
				}
				vim.update();
			};
			const editor = (text: string) => {
				const e = disposables.add(instantiation.createInstance(TestCodeEditor, document.createElement('div'), {}, {
					contributions: [eager(CommonFindController.ID, CommonFindController)],
				}));
				e.setModel(disposables.add(createTextModel(text)));
				editors.push(e);
				if (editors.length === 1) {
					focus(e);
				}
				return e;
			};
			await fn({ vim, instantiation, storage, editor, focus });
		} finally {
			disposables.dispose();
		}
	}

	const state = (editor: TestCodeEditor) => CommonFindController.get(editor)!.getState();
	const find = (editor: TestCodeEditor) => {
		const s = state(editor);
		return { searchString: s.searchString, isRegex: s.isRegex, matchCase: s.matchCase, wholeWord: s.wholeWord, isRevealed: s.isRevealed };
	};
	const at = (editor: TestCodeEditor) => `${editor.getPosition()}`;
	/** The editor's find highlights: 'hlsearch' ones and the find widget's FindModel ones. */
	const highlights = (editor: TestCodeEditor) => {
		const all = editor.getModel()!.getAllDecorations().map(d => d.options.description);
		return { hlsearch: all.filter(d => d === 'devhub-vim-hlsearch').length, findWidget: all.filter(d => d === 'find-match' || d === 'current-find-match').length };
	};

	test('/foo<CR> is the find state without opening the widget: regex on, Match Case from ignorecase / smartcase; * is Whole Word', () => withVim(async ({ vim, editor }) => {
		const e = editor('foo Foo f.o foo');
		vim.execute('devhubVim.search', { pattern: 'foo' });
		assert.deepStrictEqual(find(e), { searchString: 'foo', isRegex: true, matchCase: false, wholeWord: false, isRevealed: false });
		assert.strictEqual(at(e), '(1,5)', 'ignorecase: Foo');
		vim.execute('devhubVim.search', { pattern: 'Foo' });
		assert.deepStrictEqual(find(e), { searchString: 'Foo', isRegex: true, matchCase: true, wholeWord: false, isRevealed: false });
		e.setPosition({ lineNumber: 1, column: 1 });
		vim.execute('devhubVim.motion', { motion: 'searchWordForward' });
		assert.deepStrictEqual(find(e), { searchString: 'foo', isRegex: true, matchCase: false, wholeWord: true, isRevealed: false });
		vim.execute('devhubVim.ex', { command: 's/f\\.o/x/' });
		assert.deepStrictEqual(find(e), { searchString: 'f\\.o', isRegex: true, matchCase: false, wholeWord: false, isRevealed: false });
	}, { 'devhub.vim.options': { ignorecase: true, smartcase: true } }));

	test('F3 after a Vim search finds what n finds; the open widget highlights the matches and hlsearch steps aside; :noh closes it', () => withVim(async ({ vim, instantiation, editor }) => {
		const e = editor('xa a xa a');
		vim.execute('devhubVim.search', { pattern: '\\ba' });
		assert.strictEqual(at(e), '(1,4)');
		await timeout(60);
		assert.deepStrictEqual(highlights(e), { hlsearch: 2, findWidget: 0 });
		// VS Code's Find Next selects the match the cursor is at first, then the next one
		await instantiation.invokeFunction(a => NextMatchFindAction.runEditorCommand(a, e, undefined));
		assert.deepStrictEqual(`${e.getSelection()}`, '[1,4 -> 1,5]', 'F3: the \\ba n went to');
		await instantiation.invokeFunction(a => NextMatchFindAction.runEditorCommand(a, e, undefined));
		assert.deepStrictEqual(`${e.getSelection()}`, '[1,9 -> 1,10]', 'F3: the next \\ba');
		assert.strictEqual(state(e).isRevealed, true);
		await timeout(60);
		assert.deepStrictEqual(highlights(e), { hlsearch: 0, findWidget: 2 }, 'one highlight per match, the widget\'s');
		vim.execute('devhubVim.ex', { command: 'noh' });
		await timeout(60);
		assert.strictEqual(state(e).isRevealed, false);
		assert.deepStrictEqual(highlights(e), { hlsearch: 0, findWidget: 0 });
		assert.strictEqual(state(e).searchString, '\\ba', 'the search stays for F3 and n');
	}));

	test('closing the widget (Esc) leaves hlsearch on the same search, as Vim\'s highlight stays until :noh', () => withVim(async ({ instantiation, editor }) => {
		const e = editor('a b a');
		await instantiation.invokeFunction(a => NextMatchFindAction.runEditorCommand(a, e, undefined));
		state(e).change({ searchString: 'a' }, false);
		await timeout(60);
		assert.deepStrictEqual(highlights(e), { hlsearch: 0, findWidget: 2 });
		CommonFindController.get(e)!.closeFindWidget();
		await timeout(60);
		assert.deepStrictEqual(highlights(e), { hlsearch: 2, findWidget: 0 });
	}));

	test('a search typed in the widget is the last search: n goes forward, its regex / Match Case / Whole Word toggles count', () => withVim(async ({ vim, editor }) => {
		const e = editor('a.b axb A.B a.b');
		vim.execute('devhubVim.search', { pattern: 'x', backwards: true });
		// typed with the regex toggle off: a literal string
		state(e).change({ searchString: 'a.b', isRegex: false }, false);
		e.setPosition({ lineNumber: 1, column: 1 });
		vim.execute('devhubVim.motion', { motion: 'searchNext' });
		assert.strictEqual(at(e), '(1,13)', 'forward, literally, matching case as the widget does');
		vim.execute('devhubVim.motion', { motion: 'searchPrevious' });
		assert.strictEqual(at(e), '(1,1)');
		assert.deepStrictEqual(find(e), { searchString: 'a.b', isRegex: false, matchCase: true, wholeWord: false, isRevealed: false }, 'as typed in the widget');
		CommonFindController.get(e)!.toggleRegex();
		vim.execute('devhubVim.motion', { motion: 'searchNext' });
		assert.strictEqual(at(e), '(1,5)', 'regex on: a.b matches axb');
		state(e).change({ matchCase: false }, false);
		vim.execute('devhubVim.motion', { motion: 'searchNext' });
		assert.strictEqual(at(e), '(1,9)', 'Match Case off: A.B');
		state(e).change({ searchString: 'b', wholeWord: true }, false);
		e.setPosition({ lineNumber: 1, column: 1 });
		vim.execute('devhubVim.motion', { motion: 'searchNext' });
		assert.strictEqual(at(e), '(1,3)', 'Whole Word: the b of a.b, not axb\'s');
		vim.execute('devhubVim.motion', { motion: 'searchNext' });
		assert.strictEqual(at(e), '(1,11)');
		// n catching up with the find state changes nothing the widget would see, a literal search included
		assert.deepStrictEqual(find(e), { searchString: 'b', isRegex: true, matchCase: false, wholeWord: true, isRevealed: false });
	}));

	test('the last search is global: another editor\'s find state catches up at n; the toggles a new model restores are nobody\'s search', () => withVim(async ({ vim, storage, editor, focus }) => {
		const a = editor('x foo foo');
		const b = editor('foo bar Foo foo');
		vim.execute('devhubVim.search', { pattern: 'foo' });
		assert.strictEqual(state(b).searchString, '', 'not until n runs there');
		focus(b);
		vim.execute('devhubVim.motion', { motion: 'searchNext' });
		assert.strictEqual(at(b), '(1,13)');
		assert.deepStrictEqual(find(b), { searchString: 'foo', isRegex: true, matchCase: true, wholeWord: false, isRevealed: false });
		// a search in b's widget is n's in a
		state(b).change({ searchString: 'fo+' }, false);
		focus(a);
		vim.execute('devhubVim.motion', { motion: 'searchNext' });
		assert.strictEqual(at(a), '(1,7)');
		assert.strictEqual(state(a).searchString, 'fo+');
		// another file in b: the controller restores the stored toggles (Match Case off here); Vim's search keeps its case
		storage.store('editor.matchCase', false, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		focus(b);
		b.setModel(createTextModel('x Foo foo'));
		assert.strictEqual(state(b).matchCase, false);
		vim.execute('devhubVim.motion', { motion: 'searchNext' });
		assert.strictEqual(at(b), '(1,7)', 'fo+ matching case, as it was searched');
		assert.strictEqual(state(b).matchCase, true);
		b.getModel()!.dispose();
	}));
});
