/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: Vim's scroll commands (CTRL-D CTRL-U CTRL-F CTRL-B PageDown PageUp
// CTRL-E CTRL-Y zt zz zb) scroll as VS Code's own editorScroll does: one
// scroll per command, animated exactly when `editor.smoothScrolling` is on,
// with the cursor put without a reveal of its own (a second scroll, which
// fought the animation and left an afterimage), and a command repeated while
// the last one still animates going on from where that one ends.

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { INewScrollPosition, ScrollType } from '../../../../../editor/common/editorCommon.js';
import { EditorContextKeys } from '../../../../../editor/common/editorContextKeys.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { TestCodeEditor, TestCodeEditorCreationOptions, createCodeEditorServices } from '../../../../../editor/test/browser/testCodeEditor.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IStatusbarEntryAccessor, IStatusbarService } from '../../../../services/statusbar/browser/statusbar.js';
import { DevhubVim } from '../../browser/devhubVim.contribution.js';

/** The test editor's line height (TestConfiguration's font). */
const LINE = 19;

suite('DevHub Vim: scrolling follows editor.smoothScrolling, one scroll per command', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	interface Env {
		readonly vim: DevhubVim;
		readonly editor: TestCodeEditor;
		/** Every scroll the editor was asked for since the last `take()`, and every reveal. */
		take(): { scrolls: [number | undefined, ScrollType][]; reveals: number };
		/** The 1-based cursor line. */
		line(): number;
		/** Where the window is going (the animation's target, or where it is). */
		futureTop(): number;
	}

	function withEditor(smoothScrolling: boolean, fn: (env: Env) => void): void {
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
			const element = document.createElement('div');
			// ten lines in the window: 190px at 19px a line
			const options: TestCodeEditorCreationOptions = { smoothScrolling, scrollBeyondLastLine: true, envConfig: { outerHeight: 10 * LINE, outerWidth: 600 } };
			const editor = disposables.add(instantiation.createInstance(TestCodeEditor, element, options, { contributions: [] }));
			editor.setModel(disposables.add(createTextModel(Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n'))));
			editor.setHasTextFocus(true);
			EditorContextKeys.editorTextFocus.bindTo(editor.invokeWithinContext(a => a.get(IContextKeyService))).set(true);
			vim.update();

			const vm = editor._getViewModel()!;
			let scrolls: [number | undefined, ScrollType][] = [];
			let reveals = 0;
			const setScrollPosition = vm.viewLayout.setScrollPosition.bind(vm.viewLayout);
			vm.viewLayout.setScrollPosition = (p: INewScrollPosition, type: ScrollType) => {
				scrolls.push([p.scrollTop, type]);
				setScrollPosition(p, type);
			};
			const revealRange = vm.revealRange.bind(vm);
			vm.revealRange = (...args: Parameters<typeof vm.revealRange>) => {
				reveals++;
				revealRange(...args);
			};
			fn({
				vim, editor,
				take: () => {
					const r = { scrolls, reveals };
					scrolls = [];
					reveals = 0;
					return r;
				},
				line: () => editor.getPosition()!.lineNumber,
				futureTop: () => vm.viewLayout.getFutureViewport().top,
			});
		} finally {
			disposables.dispose();
		}
	}

	const scroll = (vim: DevhubVim, args: Record<string, unknown>) => vim.execute('devhubVim.scroll', args);

	test('with smoothScrolling on, CTRL-D is one smooth scroll and no reveal; CTRL-D again retargets from where the first one ends', () => withEditor(true, ({ vim, take, line, futureTop }) => {
		scroll(vim, { by: 'halfPage', direction: 'down' });
		assert.deepStrictEqual(take(), { scrolls: [[5 * LINE, ScrollType.Smooth]], reveals: 0 });
		assert.strictEqual(line(), 6);
		assert.strictEqual(futureTop(), 5 * LINE);
		// pressed again (key repeat) while the first still animates: from its target, not from the frame on screen
		scroll(vim, { by: 'halfPage', direction: 'down' });
		assert.deepStrictEqual(take(), { scrolls: [[10 * LINE, ScrollType.Smooth]], reveals: 0 });
		assert.strictEqual(line(), 11);
		scroll(vim, { by: 'halfPage', direction: 'up' });
		assert.deepStrictEqual(take(), { scrolls: [[5 * LINE, ScrollType.Smooth]], reveals: 0 });
		assert.strictEqual(line(), 6);
	}));

	test('PageDown / CTRL-F, PageUp / CTRL-B: a single smooth scroll each, never an immediate one, and no reveal', () => withEditor(true, ({ vim, take, line }) => {
		scroll(vim, { by: 'page', direction: 'down' });
		assert.deepStrictEqual(take(), { scrolls: [[8 * LINE, ScrollType.Smooth]], reveals: 0 });
		assert.strictEqual(line(), 9);
		scroll(vim, { by: 'page', direction: 'down' });
		assert.deepStrictEqual(take(), { scrolls: [[16 * LINE, ScrollType.Smooth]], reveals: 0 });
		assert.strictEqual(line(), 17);
		scroll(vim, { by: 'page', direction: 'up' });
		assert.deepStrictEqual(take(), { scrolls: [[8 * LINE, ScrollType.Smooth]], reveals: 0 });
	}));

	test('CTRL-E moves the cursor that would leave the window without revealing it; zz zt are smooth too', () => withEditor(true, ({ vim, editor, take, line }) => {
		scroll(vim, { by: 'line', direction: 'down' });
		assert.deepStrictEqual(take(), { scrolls: [[LINE, ScrollType.Smooth]], reveals: 0 });
		assert.strictEqual(line(), 2);
		editor.setPosition({ lineNumber: 30, column: 1 });
		take();
		scroll(vim, { to: 'top' });
		assert.deepStrictEqual(take(), { scrolls: [[29 * LINE, ScrollType.Smooth]], reveals: 0 });
		scroll(vim, { to: 'center' });
		const { scrolls } = take();
		assert.deepStrictEqual(scrolls.map(s => s[1]), [ScrollType.Smooth]);
	}));

	test('with smoothScrolling off, the same commands scroll immediately', () => withEditor(false, ({ vim, editor, take, line }) => {
		scroll(vim, { by: 'halfPage', direction: 'down' });
		assert.deepStrictEqual(take(), { scrolls: [[5 * LINE, ScrollType.Immediate]], reveals: 0 });
		assert.strictEqual(editor.getScrollTop(), 5 * LINE);
		assert.strictEqual(line(), 6);
		scroll(vim, { by: 'page', direction: 'down' });
		assert.deepStrictEqual(take(), { scrolls: [[13 * LINE, ScrollType.Immediate]], reveals: 0 });
		// a cursor motion still reveals, with the editor's scroll type
		vim.execute('devhubVim.motion', { motion: 'fileEnd' });
		const r = take();
		assert.strictEqual(r.reveals, 1);
		assert.strictEqual(line(), 100);
	}));
});
