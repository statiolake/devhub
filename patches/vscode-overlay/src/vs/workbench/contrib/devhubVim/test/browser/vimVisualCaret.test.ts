/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: in Vim's visual modes the block caret is drawn on the character the
// Vim cursor is on (the selection's last character on the cursor's side), as
// in Vim, not after a forward selection's last character where VS Code puts
// its caret; the VS Code selection itself is the text Vim selected
// (editor/common/cursor/modalCursor.ts, the hook in viewCursors.ts). These
// drive the engine and read the editor's real ViewCursors.

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CoreNavigationCommands } from '../../../../../editor/browser/coreCommands.js';
import { LineNumbersOverlay } from '../../../../../editor/browser/viewParts/lineNumbers/lineNumbers.js';
import { ViewCursors } from '../../../../../editor/browser/viewParts/viewCursors/viewCursors.js';
import { IEditorConfiguration } from '../../../../../editor/common/config/editorConfiguration.js';
import { IEditorOptions } from '../../../../../editor/common/config/editorOptions.js';
import { IPosition, Position } from '../../../../../editor/common/core/position.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { EditorContextKeys } from '../../../../../editor/common/editorContextKeys.js';
import { ViewContext } from '../../../../../editor/common/viewModel/viewContext.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { TestCodeEditor, createCodeEditorServices } from '../../../../../editor/test/browser/testCodeEditor.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { TestColorTheme } from '../../../../../platform/theme/test/common/testThemeService.js';
import { IStatusbarEntryAccessor, IStatusbarService } from '../../../../services/statusbar/browser/statusbar.js';
import { DevhubVim } from '../../browser/devhubVim.contribution.js';

suite('DevHub Vim: a visual mode\'s caret is drawn on the cursor character', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	interface Env {
		readonly editor: TestCodeEditor;
		/** Run a Vim command. */
		run(command: string, args?: unknown): void;
		/** Where the carets are drawn (view coordinates), primary first. */
		drawn(): string[];
		/** The primary caret's position as drawn. */
		caret(): string;
		/** The selection, `[anchor -> active]`. */
		sel(): string;
		/** The line number LineNumbers shows as the active one. */
		activeLine(): number;
		/** The positions revealed since the last call. */
		revealed(): string[];
		mode(): unknown;
	}

	async function withVim(text: string, fn: (env: Env) => void | Promise<void>, options: IEditorOptions = {}, vimOn = true): Promise<void> {
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
			const editor = disposables.add(instantiation.createInstance(TestCodeEditor, document.createElement('div'), options, { contributions: [] }));
			let revealed: string[] = [];
			editor.revealPosition = (p: IPosition) => { revealed.push(`${Position.lift(p)}`); };
			editor.setModel(disposables.add(createTextModel(text)));
			editor.setHasTextFocus(true);
			const keys = editor.invokeWithinContext(a => a.get(IContextKeyService));
			EditorContextKeys.editorTextFocus.bindTo(keys).set(true);
			EditorContextKeys.textInputFocus.bindTo(keys).set(true);
			vim.update();
			const configuration = (editor as unknown as { _configuration: IEditorConfiguration })._configuration;
			const context = new ViewContext(configuration, new TestColorTheme(), editor._getViewModel()!);
			const cursors = disposables.add(new ViewCursors(context));
			const lineNumbers = disposables.add(new LineNumbersOverlay(context));
			const parts = cursors as unknown as { _primaryCursor: { getPosition(): Position }; _secondaryCursors: { getPosition(): Position }[] };
			const drawn = () => [parts._primaryCursor, ...parts._secondaryCursors].map(c => `${c.getPosition()}`);
			await fn({
				editor,
				run: (command, args) => vim.execute(command, args),
				drawn,
				caret: () => drawn()[0],
				sel: () => { const s = editor.getSelection()!; return `[${s.getSelectionStart()} -> ${s.getPosition()}]`; },
				activeLine: () => (lineNumbers as unknown as { _activeModelLineNumber: number })._activeModelLineNumber,
				revealed: () => { const r = revealed; revealed = []; return r; },
				mode: () => keys.getContextKeyValue('devhubVim.mode'),
			});
		} finally {
			disposables.dispose();
		}
	}

	const motion = (env: Env, name: string) => env.run('devhubVim.motion', { motion: name });
	const visual = (env: Env, to: 'visual' | 'visualLine' | 'visualBlock' = 'visual') => env.run('devhubVim.mode', { to });

	test('`v`: the block is on the character the cursor is on, the selection is that character', () => withVim('abcdef', env => {
		env.editor.setPosition({ lineNumber: 1, column: 3 });
		visual(env);
		assert.strictEqual(env.mode(), 'visual');
		assert.strictEqual(env.sel(), '[(1,3) -> (1,4)]');
		assert.strictEqual(env.caret(), '(1,3)');
	}));

	test('`l` and `h` move the block one cell at a time, also where the selection turns around', () => withVim('abcdef', env => {
		env.editor.setPosition({ lineNumber: 1, column: 3 });
		visual(env);
		const carets: string[] = [];
		for (const m of ['right', 'left', 'left', 'left', 'right', 'right', 'right']) {
			motion(env, m);
			carets.push(env.caret());
		}
		assert.deepStrictEqual(carets, ['(1,4)', '(1,3)', '(1,2)', '(1,1)', '(1,2)', '(1,3)', '(1,4)']);
		assert.strictEqual(env.sel(), '[(1,3) -> (1,5)]', 'c and d: the selection is Vim\'s, inclusive');
		motion(env, 'left');
		motion(env, 'left');
		assert.strictEqual(env.sel(), '[(1,4) -> (1,2)]', 'b and c, backwards');
		assert.strictEqual(env.caret(), '(1,2)');
	}));

	test('`o` puts the block on the other end\'s character, and back', () => withVim('abcdef', env => {
		env.editor.setPosition({ lineNumber: 1, column: 2 });
		visual(env);
		motion(env, 'right');
		motion(env, 'right');
		assert.strictEqual(env.caret(), '(1,4)');
		env.run('devhubVim.action', { action: 'swapVisualEnds' });
		assert.strictEqual(env.caret(), '(1,2)');
		assert.strictEqual(env.sel(), '[(1,5) -> (1,2)]');
		env.run('devhubVim.action', { action: 'swapVisualEnds' });
		assert.strictEqual(env.caret(), '(1,4)');
		assert.strictEqual(env.sel(), '[(1,2) -> (1,5)]');
	}));

	test('`V`: whole lines are selected, the block is on the cursor\'s column; `l`, `j`, `o` move it though the lines may stay the same', () => withVim('abcdef\nghijkl', env => {
		env.editor.setPosition({ lineNumber: 1, column: 3 });
		visual(env, 'visualLine');
		assert.strictEqual(env.sel(), '[(1,1) -> (1,7)]');
		assert.strictEqual(env.caret(), '(1,3)');
		motion(env, 'right');
		assert.strictEqual(env.sel(), '[(1,1) -> (1,7)]');
		assert.strictEqual(env.caret(), '(1,4)');
		env.run('devhubVim.action', { action: 'swapVisualEnds' });
		assert.strictEqual(env.sel(), '[(1,7) -> (1,1)]', 'the same line, backwards now');
		assert.strictEqual(env.caret(), '(1,3)', 'the cursor goes back to where `V` started');
		env.run('devhubVim.action', { action: 'swapVisualEnds' });
		assert.strictEqual(env.caret(), '(1,4)');
		motion(env, 'down');
		assert.strictEqual(env.sel(), '[(1,1) -> (2,7)]');
		assert.strictEqual(env.caret(), '(2,4)');
		assert.strictEqual(env.activeLine(), 2);
		env.run('devhubVim.action', { action: 'swapVisualEnds' });
		assert.strictEqual(env.sel(), '[(2,7) -> (1,1)]');
		assert.strictEqual(env.caret(), '(1,3)', 'the other end: where `V` started');
		assert.strictEqual(env.activeLine(), 1);
	}));

	test('CTRL-V: the primary block is on the cursor\'s corner, each line\'s caret on its edge on the cursor\'s side', () => withVim('abcdef\nabcdef\nabcdef', env => {
		env.editor.setPosition({ lineNumber: 1, column: 2 });
		visual(env, 'visualBlock');
		motion(env, 'right');
		motion(env, 'down');
		assert.deepStrictEqual(env.editor.getSelections()!.map(s => `${s}`), ['[2,2 -> 2,4]', '[1,2 -> 1,4]']);
		assert.deepStrictEqual(env.drawn(), ['(2,3)', '(1,3)']);
		env.run('devhubVim.action', { action: 'swapVisualEnds' });
		assert.deepStrictEqual(env.drawn(), ['(1,2)', '(2,2)']);
		env.run('devhubVim.action', { action: 'swapVisualCorner' });
		assert.strictEqual(env.caret(), '(1,3)');
		motion(env, 'lineEnd');
		assert.strictEqual(env.caret(), '(1,6)', '`$`: the last character of the cursor\'s line');
	}));

	test('`$`: the block is on the last character, in `v` and in `V`', () => withVim('abc\nxyz', env => {
		visual(env);
		motion(env, 'lineEnd');
		assert.strictEqual(env.sel(), '[(1,1) -> (1,4)]');
		assert.strictEqual(env.caret(), '(1,3)');
		assert.strictEqual(env.activeLine(), 1);
		motion(env, 'left');
		assert.strictEqual(env.caret(), '(1,2)');
		env.run('devhubVim.escape');
		visual(env, 'visualLine');
		motion(env, 'lineEnd');
		assert.strictEqual(env.caret(), '(1,3)');
	}));

	test('an empty line: the block is at column 1 of it, not on the line below', () => withVim('abc\n\nxyz', env => {
		env.editor.setPosition({ lineNumber: 1, column: 2 });
		visual(env);
		motion(env, 'down');
		assert.strictEqual(env.sel(), '[(1,2) -> (3,1)]');
		assert.strictEqual(env.caret(), '(2,1)');
		assert.strictEqual(env.activeLine(), 2);
	}));

	test('the position revealed is the caret\'s', () => withVim('abcdef\nghijkl', env => {
		env.editor.setPosition({ lineNumber: 1, column: 3 });
		env.revealed();
		visual(env);
		motion(env, 'right');
		assert.deepStrictEqual(env.revealed(), ['(1,3)', '(1,4)']);
		env.run('devhubVim.escape');
		visual(env, 'visualLine');
		env.revealed();
		motion(env, 'down');
		assert.deepStrictEqual(env.revealed(), ['(2,4)']);
	}));

	test('a wrapped line: on the view line the character is on', () => withVim('abcdefgh', env => {
		env.editor.setPosition({ lineNumber: 1, column: 4 });
		visual(env);
		assert.strictEqual(env.caret(), '(1,4)');
		motion(env, 'right');
		assert.strictEqual(env.caret(), '(2,1)', 'e starts the second view line');
	}, { wordWrap: 'wordWrapColumn', wordWrapColumn: 4, wrappingIndent: 'none' }));

	test('wide characters: one block per character', () => withVim('a日本x', env => {
		env.editor.setPosition({ lineNumber: 1, column: 2 });
		visual(env);
		assert.strictEqual(env.caret(), '(1,2)');
		motion(env, 'right');
		assert.strictEqual(env.caret(), '(1,3)');
		assert.strictEqual(env.sel(), '[(1,2) -> (1,4)]');
	}));

	test('a mouse drag and `gv`: the block is on the head the engine has', () => withVim('abcdef', env => {
		const vm = env.editor._getViewModel()!;
		const at = (column: number) => { const position = new Position(1, column); return { source: 'mouse', position, viewPosition: position }; };
		CoreNavigationCommands.MoveTo.runCoreEditorCommand(vm, at(2));
		CoreNavigationCommands.MoveToSelect.runCoreEditorCommand(vm, at(5));
		assert.strictEqual(env.mode(), 'visual');
		assert.strictEqual(env.sel(), '[(1,2) -> (1,5)]');
		assert.strictEqual(env.caret(), '(1,4)');
		env.run('devhubVim.escape');
		assert.strictEqual(env.caret(), '(1,4)');
		env.run('devhubVim.action', { action: 'reselect' });
		assert.strictEqual(env.sel(), '[(1,2) -> (1,5)]');
		assert.strictEqual(env.caret(), '(1,4)');
	}));

	test('normal mode, and Vim off: the caret is where VS Code puts it', () => withVim('abcdef', env => {
		env.editor.setPosition({ lineNumber: 1, column: 3 });
		assert.strictEqual(env.caret(), '(1,3)');
		env.editor.setSelection(new Selection(1, 2, 1, 4));
		assert.strictEqual(env.caret(), '(1,4)');
	}, {}, false));
});
