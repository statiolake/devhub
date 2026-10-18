/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: while an editor's owner says a visual mode is on (Vim's v, V,
// CTRL-V), its carets are drawn on the cursor's character, the selection's
// last one on the cursor's side, not after it; the selection itself is
// unchanged (common/cursor/modalCursor.ts, the hook in viewCursors.ts).

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TestColorTheme } from '../../../../platform/theme/test/common/testThemeService.js';
import { ViewCursors } from '../../../browser/viewParts/viewCursors/viewCursors.js';
import { IEditorConfiguration } from '../../../common/config/editorConfiguration.js';
import { IEditorOptions } from '../../../common/config/editorOptions.js';
import { Position } from '../../../common/core/position.js';
import { Selection } from '../../../common/core/selection.js';
import { IModalVisual, ModalCursor } from '../../../common/cursor/modalCursor.js';
import { ViewContext } from '../../../common/viewModel/viewContext.js';
import { ITestCodeEditor, withTestCodeEditor } from '../testCodeEditor.js';

interface ICaretView {
	/** The positions the carets are drawn at (view coordinates), primary first. */
	readonly drawn: () => string[];
}

/**
 * `fn` with an editor on `text`, the editor's real ViewCursors over its view
 * model, and the editor's visual mode as `state.visual` says.
 */
export function withCarets(text: string, options: IEditorOptions, fn: (editor: ITestCodeEditor, view: ICaretView, state: { visual: IModalVisual | undefined }) => void): void {
	withTestCodeEditor(text, options, (editor, viewModel) => {
		const state: { visual: IModalVisual | undefined } = { visual: {} };
		const policy = ModalCursor.setVisual(editor.getId(), () => state.visual);
		const configuration = (editor as unknown as { _configuration: IEditorConfiguration })._configuration;
		const cursors = new ViewCursors(new ViewContext(configuration, new TestColorTheme(), viewModel));
		try {
			const parts = cursors as unknown as { _primaryCursor: { getPosition(): Position }; _secondaryCursors: { getPosition(): Position }[] };
			fn(editor, { drawn: () => [parts._primaryCursor, ...parts._secondaryCursors].map(c => `${c.getPosition()}`) }, state);
		} finally {
			cursors.dispose();
			policy.dispose();
		}
	});
}

suite('DevHub modal cursor: a visual mode\'s caret is drawn on its cursor character', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a forward selection: on its last character, one cell left of the active end; the selection is unchanged', () => {
		withCarets('abcdef', {}, (editor, view) => {
			editor.setSelection(new Selection(1, 2, 1, 3)); // `v` on b
			assert.deepStrictEqual(view.drawn(), ['(1,2)']);
			assert.deepStrictEqual(editor.getSelection(), new Selection(1, 2, 1, 3));
			editor.setSelection(new Selection(1, 2, 1, 4)); // `vl`
			assert.deepStrictEqual(view.drawn(), ['(1,3)']);
		});
	});

	test('a backward selection: at its active end, its first character', () => {
		withCarets('abcdef', {}, (editor, view) => {
			editor.setSelection(new Selection(1, 3, 1, 2)); // `vh` from c: b c selected, cursor on b
			assert.deepStrictEqual(view.drawn(), ['(1,2)']);
		});
	});

	test('an active end at column 1: the selection ends with the newline of the line above, the caret is after its last character (or on an empty line)', () => {
		withCarets('abc\n\nxyz', {}, (editor, view) => {
			editor.setSelection(new Selection(1, 1, 2, 1));
			assert.deepStrictEqual(view.drawn(), ['(1,4)']);
			editor.setSelection(new Selection(1, 1, 3, 1));
			assert.deepStrictEqual(view.drawn(), ['(2,1)']);
		});
	});

	test('the owner\'s cursor character for the primary selection it made, while that is the selection', () => {
		withCarets('abcdef\nghijkl', {}, (editor, view, state) => {
			// `V` with the cursor on line 2, column 3: whole lines selected
			const lines = new Selection(1, 1, 2, 7);
			state.visual = { primary: { selection: lines, cursor: new Position(2, 3) } };
			editor.setSelection(lines);
			assert.deepStrictEqual(view.drawn(), ['(2,3)']);
			// any other selection: the rule
			editor.setSelection(new Selection(1, 1, 1, 3));
			assert.deepStrictEqual(view.drawn(), ['(1,2)']);
		});
	});

	test('redraw: the caret moves where the selection does not, and nothing but the view hears of it', () => {
		withCarets('abcdef\nghijkl', {}, (editor, view, state) => {
			const lines = new Selection(1, 1, 2, 7);
			state.visual = { primary: { selection: lines, cursor: new Position(2, 3) } };
			editor.setSelection(lines);
			const seen: string[] = [];
			const listener = editor.onDidChangeCursorSelection(e => seen.push(`${e.selection}`));
			try {
				state.visual = { primary: { selection: lines, cursor: new Position(2, 4) } };
				editor.setSelection(lines);
				assert.deepStrictEqual(view.drawn(), ['(2,3)'], 'an unchanged selection is not drawn again');
				ModalCursor.redraw(editor.getId(), () => editor.setSelection(lines));
				assert.deepStrictEqual(view.drawn(), ['(2,4)']);
				assert.deepStrictEqual(seen, []);
			} finally {
				listener.dispose();
			}
		});
	});

	test('one grapheme: a wide character, a surrogate pair, combining marks, an emoji sequence', () => {
		withCarets('a日本x\nx\u{1F600}y\nxe\u0301y\nx\u{1F44D}\u{1F3FD}y', {}, (editor, view, state) => {
			editor.setSelection(new Selection(1, 1, 1, 4)); // a日本
			assert.deepStrictEqual(view.drawn(), ['(1,3)']);
			editor.setSelection(new Selection(2, 1, 2, 4)); // x😀
			assert.deepStrictEqual(view.drawn(), ['(2,2)']);
			editor.setSelection(new Selection(3, 1, 3, 4)); // xé (e + U+0301)
			assert.deepStrictEqual(view.drawn(), ['(3,2)']);
			editor.setSelection(new Selection(4, 1, 4, 6)); // x👍🏽
			assert.deepStrictEqual(view.drawn(), ['(4,2)']);
			// the owner's cursor inside a grapheme: drawn on the grapheme
			const sel = new Selection(2, 1, 2, 4);
			state.visual = { primary: { selection: sel, cursor: new Position(2, 3) } };
			editor.setSelection(new Selection(2, 1, 2, 1));
			editor.setSelection(sel);
			assert.deepStrictEqual(view.drawn(), ['(2,2)']);
		});
	});

	test('a wrapped line: on the view line the character is drawn on', () => {
		withCarets('abcdefgh', { wordWrap: 'wordWrapColumn', wordWrapColumn: 4, wrappingIndent: 'none' }, (editor, view) => {
			// view lines: `abcd` `efgh`
			editor.setSelection(new Selection(1, 1, 1, 6)); // a..e: e starts the second view line
			assert.deepStrictEqual(view.drawn(), ['(2,1)']);
			editor.setSelection(new Selection(1, 1, 1, 5)); // a..d: the end of the first
			assert.deepStrictEqual(view.drawn(), ['(1,4)']);
		});
	});

	test('every cursor: each forward selection one left, each backward one at its active end, empty ones as they are', () => {
		withCarets('abcdef\nabcdef\nabcdef', {}, (editor, view) => {
			editor.setSelections([new Selection(1, 2, 1, 4), new Selection(2, 4, 2, 2), new Selection(3, 3, 3, 3)]);
			const drawn = view.drawn();
			assert.strictEqual(drawn[0], '(1,3)');
			assert.deepStrictEqual([...drawn.slice(1)].sort(), ['(2,2)', '(3,3)']);
		});
	});

	test('outside a visual mode, and without an owner, the caret is at the active end as in VS Code', () => {
		withCarets('abcdef', {}, (editor, view, state) => {
			state.visual = undefined;
			editor.setSelection(new Selection(1, 2, 1, 4));
			assert.deepStrictEqual(view.drawn(), ['(1,4)']);
		});
		withTestCodeEditor('abcdef', {}, (editor, viewModel) => {
			const configuration = (editor as unknown as { _configuration: IEditorConfiguration })._configuration;
			const cursors = new ViewCursors(new ViewContext(configuration, new TestColorTheme(), viewModel));
			try {
				editor.setSelection(new Selection(1, 2, 1, 4));
				assert.strictEqual(`${(cursors as unknown as { _primaryCursor: { getPosition(): Position } })._primaryCursor.getPosition()}`, '(1,4)');
			} finally {
				cursors.dispose();
			}
		});
	});
});
