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
// The caret of a visual mode is drawn on a character too: the one the Vim
// cursor is on, the last character of the selection on the cursor's side.
// The selection itself is VS Code's, exclusive at its end (so copy, find in
// selection, every command reading it sees the text Vim selected), and VS Code
// draws a caret at the selection's active end: after a forward selection's
// last character, one cell to the right of Vim's cursor. So the caret is
// placed where it is drawn, not by changing the selection: ViewCursors (and
// LineNumbers, for the active and relative numbers) take each caret's view
// position from `viewPositions`, which, while the owner says a visual mode is
// on (`setVisual`), puts it on
//   * the owner's cursor character for the primary selection the owner made
//     (`V` keeps the cursor's column though the selection covers whole lines,
//     CTRL-V's cursor is the corner it is on);
//   * one grapheme left of the active end for any other forward selection
//     (an active end at column 1 is the end of the line above: the newline is
//     the selection's last character);
//   * the active end of a backward selection, which is on its first character.
// Everything else (the cursor state, events, the IME's anchor, accessibility)
// stays the selection's.
//
// In visual-block mode (`block`) Vim has one cursor, while the selection is one
// range per line to highlight the block: only the primary caret is drawn, so
// `viewPositions` returns just the primary's position and the view part drops
// the secondary carets (the selections themselves, and so the highlight, are
// untouched). Outside it, and for any cursors that are not the block's, every
// caret is drawn as before.
//
// The caret can move where the selection does not (`V` then `l`: the lines
// are the same, the cursor's column is not). The cursor states are the same
// then, so the cursor would tell no one; `redraw` has CursorsController
// (cursor.ts) give them to the view all the same, and only to the view.
//
// Kept in this one file plus a line or two in each of oneCursor.ts, cursor.ts,
// coreCommands.ts, codeEditorWidget.ts, viewCursors.ts and lineNumbers.ts, so an upstream bump
// only has to re-place those lines.

import { nextCharLength, prevCharLength } from '../../../base/common/strings.js';
import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ICoordinatesConverter } from '../coordinatesConverter.js';
import { Position } from '../core/position.js';
import { Range } from '../core/range.js';
import { Selection, SelectionDirection } from '../core/selection.js';
import { SingleCursorState } from '../cursorCommon.js';
import { ITextModel, PositionAffinity } from '../model.js';
import { CursorContext } from './cursorContext.js';

/** What the owner of the modes says while a visual mode is on. */
export interface IModalVisual {
	/**
	 * The primary selection the owner made for it, and the character the mode's
	 * cursor is on (model coordinates). Used while that is still the editor's
	 * primary selection.
	 */
	readonly primary?: { readonly selection: Selection; readonly cursor: Position };
	/**
	 * Visual-block mode: the selections (one per line) are there to highlight
	 * the block, and Vim has one cursor, so only the primary caret is drawn.
	 * Applies while the primary selection is the one the owner made.
	 */
	readonly block?: boolean;
}

class ModalCursorImpl {

	/** View model → the id of the editor it belongs to. */
	private readonly _editors = new WeakMap<object, string>();
	/** Editor id → whether its caret must sit on a character right now. */
	private readonly _onCharacter = new Map<string, () => boolean>();
	/** Editor id → its visual mode, undefined outside one. */
	private readonly _visual = new Map<string, () => IModalVisual | undefined>();

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

	/** Editor ids whose cursor states are being put by `redraw`. */
	private readonly _redraw = new Set<string>();

	/**
	 * Runs `fn` (which puts the editor's cursor states) so that the view hears
	 * of them even when they equal the old ones: the visual cursor moved where
	 * the selection did not (`V` then `l`, `o` on one line). Only the view does;
	 * there is no cursor event for an unchanged selection.
	 */
	redraw(editorId: string, fn: () => void): void {
		this._redraw.add(editorId);
		try {
			fn();
		} finally {
			this._redraw.delete(editorId);
		}
	}

	/** CursorsController: whether unchanged cursor states still go to the view. */
	redraws(viewModel: object): boolean {
		if (this._redraw.size === 0) {
			return false;
		}
		const editorId = this._editors.get(viewModel);
		return editorId !== undefined && this._redraw.has(editorId);
	}

	/** While `visual()` answers, that editor's carets are drawn on the visual cursor's character. */
	setVisual(editorId: string, visual: () => IModalVisual | undefined): IDisposable {
		this._visual.set(editorId, visual);
		return toDisposable(() => {
			if (this._visual.get(editorId) === visual) {
				this._visual.delete(editorId);
			}
		});
	}

	/**
	 * ViewCursors, LineNumbers: the view position each caret is drawn at, for
	 * the cursor state's view and model selections (same order, primary first).
	 */
	viewPositions(viewModel: { readonly model: ITextModel; readonly coordinatesConverter: ICoordinatesConverter }, viewSelections: readonly Selection[], modelSelections: readonly Selection[]): Position[] {
		const positions = viewSelections.map(s => s.getPosition());
		const editorId = this._visual.size ? this._editors.get(viewModel) : undefined;
		const visual = editorId === undefined ? undefined : this._visual.get(editorId)?.();
		if (!visual) {
			return positions;
		}
		for (let i = 0; i < modelSelections.length && i < positions.length; i++) {
			const sel = modelSelections[i];
			const primary = i === 0 && visual.primary && visual.primary.selection.equalsSelection(sel) ? visual.primary.cursor : undefined;
			if (!primary && (sel.isEmpty() || sel.getDirection() === SelectionDirection.RTL)) {
				continue;
			}
			const caret = primary ? onGrapheme(viewModel.model, primary) : beforePosition(viewModel.model, sel.getPosition());
			const onChar = caret.column < viewModel.model.getLineMaxColumn(caret.lineNumber);
			// on a character: past any injected text before it, and on the view line a wrap starts with it
			positions[i] = viewModel.coordinatesConverter.convertModelPositionToViewPosition(caret, onChar ? PositionAffinity.Right : PositionAffinity.None);
		}
		if (visual.block && visual.primary && modelSelections.length && visual.primary.selection.equalsSelection(modelSelections[0])) {
			return positions.slice(0, 1); // one caret, the block's per-line selections stay highlighted
		}
		return positions;
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

/** The start of the grapheme `p` is in (a wide character, a surrogate pair, a character and its combining marks: one cell). */
function onGrapheme(model: ITextModel, p: Position): Position {
	const lineNumber = Math.min(Math.max(1, p.lineNumber), model.getLineCount());
	const content = model.getLineContent(lineNumber);
	const offset = Math.max(0, p.column - 1);
	if (offset >= content.length) {
		return new Position(lineNumber, content.length + 1);
	}
	const end = offset + nextCharLength(content, offset);
	return new Position(lineNumber, end - prevCharLength(content, end) + 1);
}

/** The character before `p`: the previous grapheme, or the newline ending the line above when `p` starts a line. */
function beforePosition(model: ITextModel, p: Position): Position {
	if (p.column > 1) {
		const content = model.getLineContent(p.lineNumber);
		return new Position(p.lineNumber, p.column - prevCharLength(content, p.column - 1));
	}
	return p.lineNumber > 1 ? new Position(p.lineNumber - 1, model.getLineMaxColumn(p.lineNumber - 1)) : p;
}
