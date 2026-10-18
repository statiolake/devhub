/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: while an editor's owner says so (Vim outside insert mode), its caret
// is on a character however it is put, and is never past the end of a line,
// not even for one event or one frame (common/cursor/modalCursor.ts).

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CoreNavigationCommands } from '../../../browser/coreCommands.js';
import { Position } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import { Selection } from '../../../common/core/selection.js';
import { ModalCursor } from '../../../common/cursor/modalCursor.js';
import { ICursorState } from '../../../common/editorCommon.js';
import { ITestCodeEditor, withTestCodeEditor } from '../testCodeEditor.js';

suite('DevHub modal cursor: the caret sits on a character', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** `fn` with an editor on `text` whose caret must be on a character while `state.on`. */
	function withModal(text: string, fn: (editor: ITestCodeEditor, state: { on: boolean }) => void, on = true): void {
		withTestCodeEditor(text, {}, editor => {
			const state = { on };
			const policy = ModalCursor.set(editor.getId(), () => state.on);
			try {
				fn(editor, state);
			} finally {
				policy.dispose();
			}
		});
	}

	const at = (editor: ITestCodeEditor) => editor.getPosition()!.toString();

	function click(editor: ITestCodeEditor, lineNumber: number, column: number): void {
		const position = new Position(lineNumber, column);
		CoreNavigationCommands.MoveTo.runCoreEditorCommand(editor._getViewModel()!, { source: 'mouse', position, viewPosition: position });
	}

	function drag(editor: ITestCodeEditor, lineNumber: number, column: number): void {
		const position = new Position(lineNumber, column);
		CoreNavigationCommands.MoveToSelect.runCoreEditorCommand(editor._getViewModel()!, { source: 'mouse', position, viewPosition: position });
	}

	test('a click past the end of the line puts the caret on the last character, and no event ever says otherwise', () => {
		withModal('abc\n\nxy', editor => {
			const seen: string[] = [];
			const listener = editor.onDidChangeCursorPosition(e => seen.push(`${e.position} ${e.source}`));
			try {
				click(editor, 1, 4);
				assert.strictEqual(at(editor), '(1,3)');
				click(editor, 3, 3);
				assert.strictEqual(at(editor), '(3,2)');
				assert.deepStrictEqual(seen, ['(1,3) mouse', '(3,2) mouse']);
			} finally {
				listener.dispose();
			}
		});
	});

	test('an empty line keeps its caret at column 1', () => {
		withModal('abc\n\nxy', editor => {
			click(editor, 2, 1);
			assert.strictEqual(at(editor), '(2,1)');
			editor.setPosition({ lineNumber: 2, column: 5 });
			assert.strictEqual(at(editor), '(2,1)');
		});
	});

	test('a drag past the end of the line is a selection, left as it is; back on the anchor it is a caret on a character', () => {
		withModal('abc', editor => {
			click(editor, 1, 1);
			drag(editor, 1, 4);
			assert.deepStrictEqual(editor.getSelection(), new Selection(1, 1, 1, 4));
			click(editor, 1, 4);
			assert.strictEqual(at(editor), '(1,3)');
			drag(editor, 1, 1);
			assert.deepStrictEqual(editor.getSelection(), new Selection(1, 3, 1, 1));
		});
	});

	test('a double click past the end of the line selects the last word', () => {
		withModal('ab cd', editor => {
			const position = new Position(1, 6);
			CoreNavigationCommands.WordSelect.runCoreEditorCommand(editor._getViewModel()!, { source: 'mouse', position, viewPosition: position });
			assert.deepStrictEqual(editor.getSelection(), new Selection(1, 4, 1, 6));
		});
	});

	test('a view state restored with the caret at the end of a line', () => {
		// what CodeEditorWidget.restoreViewState does with the cursor part (a test editor has no view to restore)
		let saved: ICursorState[] = [];
		withTestCodeEditor('abc\ndef', {}, editor => {
			editor.setPosition({ lineNumber: 2, column: 4 });
			saved = editor.getViewModel()!.saveCursorState();
		});
		withModal('abc\ndef', editor => {
			const seen: string[] = [];
			const listener = editor.onDidChangeCursorPosition(e => seen.push(`${e.position}`));
			try {
				editor.getViewModel()!.restoreCursorState(saved);
				assert.strictEqual(at(editor), '(2,3)');
				assert.deepStrictEqual(seen, ['(2,3)']);
			} finally {
				listener.dispose();
			}
		});
	});

	test('setPosition / setSelections from any other caller, every cursor', () => {
		withModal('abc\nde\n', editor => {
			editor.setPosition({ lineNumber: 1, column: 4 }, 'someContribution');
			assert.strictEqual(at(editor), '(1,3)');
			editor.setSelections([new Selection(1, 4, 1, 4), new Selection(2, 3, 2, 3), new Selection(3, 1, 3, 1)]);
			assert.deepStrictEqual(editor.getSelections()!.map(s => s.getPosition().toString()), ['(1,3)', '(2,2)', '(3,1)']);
			// a selection (Vim's visual mode is one, with its end exclusive) is left as it is
			editor.setSelection(new Selection(1, 2, 1, 4));
			assert.deepStrictEqual(editor.getSelection(), new Selection(1, 2, 1, 4));
		});
	});

	test('undo putting back a caret at the end of a line', () => {
		withModal('abc', (editor, state) => {
			state.on = false; // inserting: the caret may be after the last character
			editor.setPosition({ lineNumber: 1, column: 4 });
			editor.pushUndoStop();
			editor.executeEdits('test', [{ range: new Range(1, 4, 1, 4), text: 'd' }]);
			editor.pushUndoStop();
			state.on = true;
			editor.setPosition({ lineNumber: 1, column: 1 });
			editor.getModel().undo();
			assert.strictEqual(editor.getModel().getValue(), 'abc');
			assert.strictEqual(at(editor), '(1,3)');
		}, false);
	});

	test('an edit pushing the caret to the end of the line', () => {
		withModal('abc', editor => {
			editor.setPosition({ lineNumber: 1, column: 3 });
			editor.executeEdits('test', [{ range: new Range(1, 3, 1, 4), text: '' }]);
			assert.strictEqual(editor.getModel().getValue(), 'ab');
			assert.strictEqual(at(editor), '(1,2)');
		});
	});

	test('the last character is the last grapheme: a wide character, a surrogate pair, combining marks, an emoji sequence', () => {
		withModal('a日本\nx😀\nxé\nx👍🏽', editor => {
			const lastOf = (lineNumber: number) => {
				editor.setPosition({ lineNumber, column: editor.getModel().getLineMaxColumn(lineNumber) });
				return editor.getPosition()!.column;
			};
			assert.strictEqual(lastOf(1), 3);
			assert.strictEqual(lastOf(2), 2);
			assert.strictEqual(lastOf(3), 2);
			assert.strictEqual(lastOf(4), 2);
		});
	});

	test('while the owner says no (insert mode), and without an owner, the caret goes past the end as in VS Code', () => {
		withModal('abc', (editor, state) => {
			click(editor, 1, 4);
			assert.strictEqual(at(editor), '(1,4)');
			editor.setPosition({ lineNumber: 1, column: 4 });
			assert.strictEqual(at(editor), '(1,4)');
			state.on = true;
			editor.setPosition({ lineNumber: 1, column: 4 });
			assert.strictEqual(at(editor), '(1,3)');
		}, false);
		withTestCodeEditor('abc', {}, editor => {
			click(editor, 1, 4);
			assert.strictEqual(at(editor), '(1,4)');
		});
	});

	test('the rule is per editor', () => {
		withModal('abc', modal => {
			withTestCodeEditor('abc', {}, plain => {
				modal.setPosition({ lineNumber: 1, column: 4 });
				plain.setPosition({ lineNumber: 1, column: 4 });
				assert.strictEqual(at(modal), '(1,3)');
				assert.strictEqual(at(plain), '(1,4)');
			});
		});
	});
});
