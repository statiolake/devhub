/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: modal text input, for Vim's normal/visual/operator-pending modes
// (src/vs/workbench/contrib/devhubVim).
//
// A keybinding layer (what an extension such as VSCodeVim can do) only sees
// keydown. Text reaches the model by other routes too: an IME composition is
// drawn into the model as it is typed (EditContext's `textupdate`, or the
// hidden <textarea>'s composition events), `beforeinput` turns Enter into a
// newline, paste and drop insert text, and any contribution can call
// `editor.trigger(.., 'type', ..)`. So while an editor is modal its text
// input is cut where it enters the editor core:
//
// * CodeEditorWidget drops `type`, `replacePreviousChar`, `compositionType`,
//   `compositionStart` and `paste` (from the keyboard or from any other
//   caller), marks paste events handled (so paste-as providers stay out too)
//   and refuses drops. Edits that are commands (the Vim engine's own
//   `executeEdits`, undo, formatting, code actions, cut) are untouched: this
//   gates typed text, not the model.
// * The input surfaces let the OS input method run (as in terminal Vim, an
//   IME that is on composes; its keys are not reinterpreted as commands) but
//   keep the composition out of the editor: nothing is drawn inline, no
//   composition decoration is left behind, and when the composition ends the
//   input surface is put back to the model's text. The committed text is
//   handed to `onDidCommitText` instead, so the mode's owner can give it to a
//   command that waits for a character (Vim's f/t/r, the `/` prompt) and
//   drop it otherwise.
//
// The switch is per editor (keyed by `ICodeEditor.getId()`, as the EditContext
// registries are) and independent of the global `IME` toggle the keybinding
// service flips for chords, so the two never undo each other.
//
// Who switches an editor is the owner of the modes (the workbench
// contribution), and nothing here decides it on its own: the owner attaches to
// an editor when ICodeEditorService announces it, synchronously at the end of
// the editor's constructor — before the editor can have focus, a key or its
// first frame — and sets it modal right there, so an editor the modes drive is
// modal from its first key. An editor no owner attached to is an ordinary
// editor. (An earlier design started editors modal in their constructor, with
// scoped context keys and a block caret of their own, until the owner claimed
// or released them; an editor the owner never claimed was left stuck: modal,
// with no engine to leave normal mode.)
//
// Kept in this one file plus a few guarded lines at each input surface, so an
// upstream bump only has to re-place those lines.

import { Emitter, Event } from '../../../../base/common/event.js';

export interface IModalCommittedText {
	readonly editorId: string;
	readonly text: string;
}

class ModalTextInputImpl {

	private readonly _modal = new Set<string>();
	private readonly _onDidChange = new Emitter<string>();
	/** Fires with the editor id whose modal state changed. */
	readonly onDidChange: Event<string> = this._onDidChange.event;

	private readonly _onDidCommitText = new Emitter<IModalCommittedText>();
	/** Text an input method committed in a modal editor; it did not reach the model. */
	readonly onDidCommitText: Event<IModalCommittedText> = this._onDidCommitText.event;

	isModal(editorId: string): boolean {
		return this._modal.has(editorId);
	}

	/** While `modal`, no typed text, IME composition, paste or drop reaches that editor's model. */
	set(editorId: string, modal: boolean): void {
		if (modal === this._modal.has(editorId)) {
			return;
		}
		if (modal) {
			this._modal.add(editorId);
		} else {
			this._modal.delete(editorId);
		}
		this._onDidChange.fire(editorId);
	}

	/** Called by the input surfaces when a composition ends in a modal editor. */
	commit(editorId: string, text: string): void {
		if (text) {
			this._onDidCommitText.fire({ editorId, text });
		}
	}
}

export const ModalTextInput = new ModalTextInputImpl();
