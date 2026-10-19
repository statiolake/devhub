/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: VS Code's own word operations end words where the script changes
// (`devhub.editor.wordBoundariesByScript`, editor/common/core/scriptWordBoundaries.ts):
// Alt+Left / Alt+Right, Alt+Backspace / Alt+Delete, double-click selection,
// the word under the cursor (Cmd+D, the word highlight) and whole-word
// matches. Off, and on a line of ASCII only, they are VS Code's.

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CoreNavigationCommands } from '../../../../browser/coreCommands.js';
import { ICodeEditor } from '../../../../browser/editorBrowser.js';
import { EditorCommand } from '../../../../browser/editorExtensions.js';
import { EditorOption } from '../../../../common/config/editorOptions.js';
import { Position } from '../../../../common/core/position.js';
import { ScriptWordBoundaries } from '../../../../common/core/scriptWordBoundaries.js';
import { Selection } from '../../../../common/core/selection.js';
import { createCodeEditorServices, withTestCodeEditor } from '../../../../test/browser/testCodeEditor.js';
import { createTextModel } from '../../../../test/common/testTextModel.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { CursorWordEndRight, CursorWordLeft, DeleteWordLeft, DeleteWordRight } from '../../browser/wordOperations.js';
import { deserializePipePositions, serializePipePositions, testRepeatedActionAndExtractPositions } from './wordTestUtils.js';

suite('DevHub: word boundaries between scripts in VS Code\'s word operations', () => {

	let disposables: DisposableStore;
	let instantiationService: TestInstantiationService;

	setup(() => {
		disposables = new DisposableStore();
		instantiationService = createCodeEditorServices(disposables);
		ScriptWordBoundaries.setEnabled(true);
	});

	teardown(() => {
		ScriptWordBoundaries.setEnabled(false);
		disposables.dispose();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	function run(editor: ICodeEditor, command: EditorCommand): void {
		instantiationService.invokeFunction(accessor => command.runEditorCommand(accessor, editor, null));
	}

	/** Alt+Left (macOS) from the end, every stop. */
	function stopsLeft(expected: string, options = {}): string {
		const [text] = deserializePipePositions(expected);
		const stops = testRepeatedActionAndExtractPositions(text, new Position(1000, 1000), ed => run(ed, new CursorWordLeft()), ed => ed.getPosition()!, ed => ed.getPosition()!.equals(new Position(1, 1)), options);
		return serializePipePositions(text, stops);
	}

	/** Alt+Right (macOS) from the start, every stop. */
	function stopsRight(expected: string, options = {}): string {
		const [text] = deserializePipePositions(expected);
		const end = new Position(1, text.length + 1);
		const stops = testRepeatedActionAndExtractPositions(text, new Position(1, 1), ed => run(ed, new CursorWordEndRight()), ed => ed.getPosition()!, ed => ed.getPosition()!.equals(end), options);
		return serializePipePositions(text, stops);
	}

	test('Alt+Left: kanji / hiragana / katakana / fullwidth letters / ASCII / punctuation / emoji', () => {
		for (const expected of [
			'|漢字|ひらがな',
			'|カタカナ|漢字',
			'|全角|ＡＢＣ１２３|です',
			'|foo|バー|baz_qux',
			'|漢字|、。「|かな|」',
			'|絵文字|😀😀|だ',
			'|日本語|の|文章|を|カタカナ|で|書|く',
			'|すごーい',
		]) {
			assert.strictEqual(stopsLeft(expected), expected);
		}
	});

	test('Alt+Right stops at the end of each script run', () => {
		assert.strictEqual(stopsRight('漢字|ひらがな|'), '漢字|ひらがな|');
		assert.strictEqual(stopsRight('foo|バー|.baz|'), 'foo|バー|.baz|');
	});

	test('ASCII is VS Code\'s (editor.wordSeparators), and off it is VS Code\'s everywhere', () => {
		assert.strictEqual(stopsLeft('|foo-|bar.|baz |qux'), '|foo-|bar.|baz |qux');
		ScriptWordBoundaries.setEnabled(false);
		assert.strictEqual(stopsLeft('|漢字ひらがな'), '|漢字ひらがな');
	});

	test('with editor.wordSegmenterLocales its words are split at script changes too', () => {
		assert.strictEqual(stopsLeft('|これ|は|テスト|です', { wordSegmenterLocales: 'ja' }), '|これ|は|テスト|です');
		// without the locales the script runs alone: これは is one hiragana run
		assert.strictEqual(stopsLeft('|これは|テスト|です'), '|これは|テスト|です');
	});

	test('Alt+Backspace / Alt+Delete delete one script run', () => {
		withTestCodeEditor('漢字ひらがなカタカナ', {}, editor => {
			editor.setPosition(new Position(1, 11));
			run(editor, new DeleteWordLeft());
			assert.strictEqual(editor.getModel()!.getValue(), '漢字ひらがな');
			editor.setPosition(new Position(1, 1));
			run(editor, new DeleteWordRight());
			assert.strictEqual(editor.getModel()!.getValue(), 'ひらがな');
		});
	});

	test('double-click selects the script run', () => {
		withTestCodeEditor('日本語の文章', {}, (editor, viewModel) => {
			const position = new Position(1, 6);
			CoreNavigationCommands.WordSelect.runCoreEditorCommand(viewModel, { position, viewPosition: position, revealType: 0 });
			assert.deepStrictEqual(editor.getSelection(), new Selection(1, 5, 1, 7));
		});
	});

	test('the word under the cursor (Cmd+D, the word highlight) is the script run at the cursor', () => {
		const model = disposables.add(createTextModel('漢字ひらがな foo'));
		assert.deepStrictEqual(model.getWordAtPosition(new Position(1, 1)), { word: '漢字', startColumn: 1, endColumn: 3 });
		assert.deepStrictEqual(model.getWordAtPosition(new Position(1, 3)), { word: 'ひらがな', startColumn: 3, endColumn: 7 });
		assert.deepStrictEqual(model.getWordAtPosition(new Position(1, 7)), { word: 'ひらがな', startColumn: 3, endColumn: 7 }, 'at the end: the word before');
		assert.deepStrictEqual(model.getWordAtPosition(new Position(1, 9)), { word: 'foo', startColumn: 8, endColumn: 11 });
		ScriptWordBoundaries.setEnabled(false);
		assert.deepStrictEqual(model.getWordAtPosition(new Position(1, 1)), { word: '漢字ひらがな', startColumn: 1, endColumn: 7 });
	});

	test('a whole-word match (Cmd+D\'s next one, the highlight\'s occurrences) ends where the script changes', () => {
		withTestCodeEditor('漢字ひらがな、漢字カタカナ 漢字x', {}, editor => {
			const model = editor.getModel()!;
			const separators = editor.getOption(EditorOption.wordSeparators);
			const matches = model.findMatches('漢字', false, false, true, separators, false).map(m => m.range.startColumn);
			assert.deepStrictEqual(matches, [1, 8, 15]);
			assert.deepStrictEqual(model.findMatches('ひら', false, false, true, separators, false), [], 'not part of a run');
			ScriptWordBoundaries.setEnabled(false);
			assert.deepStrictEqual(model.findMatches('漢字', false, false, true, separators, false), []);
		});
	});
});
