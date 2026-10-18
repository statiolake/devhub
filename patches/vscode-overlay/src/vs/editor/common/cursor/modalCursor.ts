/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: the caret of a modal editor (Vim's normal, visual and
// operator-pending modes, src/vs/workbench/contrib/devhubVim) sits on a
// character. Past the last character of a line there is no character, so a
// caret there is not a state such an editor can be in, however it was put
// there: a click past the end of the line, a view state restored with the
// caret at the end of a line, undo putting back the selection a change started
// from, an edit pushing the caret, setPosition / setSelections from any
// contribution (find, go to definition, references, search results, the
// outline, breadcrumbs), multiple cursors or a column selection.
//
// So the rule is applied where every one of those becomes a cursor state:
// Cursor._setState (oneCursor.ts) hands each validated model state to
// `ModalCursor.clamp` before the view state is derived from it, and a
// collapsed caret at the end of a non-empty line comes back on the start of
// the line's last grapheme (a wide character, a surrogate pair, a base
// character and its combining marks or an emoji sequence: the whole cell). The
// cursor state the editor emits, renders and restores is that one; there is
// never an event, a frame or a stored view state with the caret past the
// end, and nothing corrects it afterwards. An empty line keeps its caret at
// column 1, and a selection (Vim's visual modes put theirs as VS Code ranges
// whose end is exclusive, so it may well end at the end of the line) is left
// alone.
//
// Who says when the rule applies is the owner of the modes, per editor and by
// a predicate it answers from its own state, so the answer is right at every
// cursor move, including the ones a mode change makes (`A` enters insert mode
// and then puts the caret at the end of the line; Esc leaves insert mode and
// then moves it one left). An editor nobody set a predicate for is an
// ordinary one. The editor ties its view model to its id
// (CodeEditorWidget._attachModel), which is how a cursor finds its editor.
//
// Kept in this one file plus one line in each of oneCursor.ts and
// codeEditorWidget.ts, so an upstream bump only has to re-place those lines.

import { prevCharLength } from '../../../base/common/strings.js';
import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { Position } from '../core/position.js';
import { Range } from '../core/range.js';
import { SingleCursorState } from '../cursorCommon.js';
import { CursorContext } from './cursorContext.js';

class ModalCursorImpl {

	/** View model → the id of the editor it belongs to. */
	private readonly _editors = new WeakMap<object, string>();
	/** Editor id → whether its caret must sit on a character right now. */
	private readonly _onCharacter = new Map<string, () => boolean>();

	/** Called by the editor for each view model it makes. */
	bind(viewModel: object, editorId: string): void {
		this._editors.set(viewModel, editorId);
	}

	/**
	 * While `onCharacter()` answers true, every collapsed caret of that editor
	 * on a non-empty line is on a character, never past the last one.
	 */
	set(editorId: string, onCharacter: () => boolean): IDisposable {
		this._onCharacter.set(editorId, onCharacter);
		return toDisposable(() => {
			if (this._onCharacter.get(editorId) === onCharacter) {
				this._onCharacter.delete(editorId);
			}
		});
	}

	/** Whether the caret of that editor must sit on a character now. */
	applies(editorId: string): boolean {
		const onCharacter = this._onCharacter.get(editorId);
		return !!onCharacter && onCharacter();
	}

	/**
	 * Cursor._setState: the (validated) model state as the editor may hold it,
	 * with `viewState` dropped (to be derived again) when it was changed.
	 */
	clamp(context: CursorContext, modelState: SingleCursorState, viewState: SingleCursorState | null): [SingleCursorState, SingleCursorState | null] {
		if (this._onCharacter.size === 0 || modelState.hasSelection()) {
			return [modelState, viewState];
		}
		const editorId = this._editors.get(context.viewModel);
		if (editorId === undefined || !this.applies(editorId)) {
			return [modelState, viewState];
		}
		const { lineNumber, column } = modelState.position;
		const maxColumn = context.model.getLineMaxColumn(lineNumber);
		if (maxColumn === 1 || column < maxColumn) {
			return [modelState, viewState];
		}
		const content = context.model.getLineContent(lineNumber);
		const last = new Position(lineNumber, maxColumn - prevCharLength(content, content.length));
		return [new SingleCursorState(Range.fromPositions(last), modelState.selectionStartKind, 0, last, 0), null];
	}
}

export const ModalCursor = new ModalCursorImpl();
