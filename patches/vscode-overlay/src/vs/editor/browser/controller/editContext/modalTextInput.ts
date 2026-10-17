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
// A new editor starts modal (ModalEditorStart). The owner of the modes (the
// workbench contribution) attaches to an editor when ICodeEditorService
// announces it, at the end of its constructor, but an editor can exist before
// its owner does (and the owner may be late: it is a workbench contribution).
// So the owner gives a start policy when its module loads (`setStartPolicy`),
// and CodeEditorWidget asks it while it is being constructed: an editor the
// policy says yes to is, before it can see a key, modal, has a block caret and
// the scoped context keys `devhubVim.active` / `devhubVim.attached` = true and
// `devhubVim.mode` = 'normal' (so the editor's typing keys are gated, see
// EditorContextKeys.devhubVimAllowsTyping). The owner then `claim`s it (it
// takes over that state: the scoped keys go, its own global ones and caret
// apply) or `release`s it (an editor the modes do not drive: it is put back
// as it was asked for). Without a policy, or when it says no, nothing of this
// happens.
//
// Kept in this one file plus a few guarded lines at each input surface, so an
// upstream bump only has to re-place those lines.

import { Emitter, Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorOptions } from '../../../common/config/editorOptions.js';

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

	private _startPolicy: ModalStartPolicy | undefined;
	private readonly _starts = new Map<string, ModalEditorStart>();

	/** Whether a new editor starts modal (the owner of the modes sets it once, when its module loads). */
	setStartPolicy(policy: ModalStartPolicy | undefined): void {
		this._startPolicy = policy;
	}

	/** CodeEditorWidget, while it is constructed: does this editor start modal? */
	startsModal(instantiationService: IInstantiationService, domElement: HTMLElement): boolean {
		const policy = this._startPolicy;
		if (!policy) {
			return false;
		}
		try {
			return instantiationService.invokeFunction(accessor => policy(accessor, domElement));
		} catch {
			return false; // a service the policy reads is missing (a test, an embedder): plain editor
		}
	}

	/** Whether the editor still has the state it started with, owned by no one yet. */
	isStarting(editorId: string): boolean {
		return this._starts.has(editorId);
	}

	/** The owner takes the editor over: from now on it decides its modality, caret and context keys. */
	claim(editorId: string): void {
		this._starts.get(editorId)?.end(true);
	}

	/** The owner does not drive this editor: it takes text again, with the caret it was given. */
	release(editorId: string): void {
		this._starts.get(editorId)?.end(false);
	}

	/** @internal ModalEditorStart */
	_track(editorId: string, start: ModalEditorStart | undefined): void {
		if (start) {
			this._starts.set(editorId, start);
		} else {
			this._starts.delete(editorId);
		}
	}
}

/** `domElement` is the editor's own container, as passed to CodeEditorWidget. */
export type ModalStartPolicy = (accessor: ServicesAccessor, domElement: HTMLElement) => boolean;

export const ModalTextInput = new ModalTextInputImpl();

/**
 * The state an editor starts with when ModalTextInput's start policy says so,
 * until its owner claims or releases it. Created by CodeEditorWidget's
 * constructor; synchronous, a few context keys and a set entry.
 */
export class ModalEditorStart implements IDisposable {

	/** The caret style of a modal editor no one has claimed yet (Vim's normal mode). */
	static readonly CURSOR_STYLE = 'block';

	private readonly _keys: IContextKey<boolean | string>[];
	private _ended = false;

	constructor(
		private readonly _editorId: string,
		contextKeyService: IContextKeyService,
		/** The caret style the editor's creator asked for, put back on release. */
		private _requestedCursorStyle: IEditorOptions['cursorStyle'],
		private readonly _applyCursorStyle: (style: NonNullable<IEditorOptions['cursorStyle']>) => void,
	) {
		// No default value: `reset` removes the key from the editor's scope, so
		// the owner's global keys apply after a claim.
		const key = <T extends boolean | string>(name: string, value: T) => {
			const k = contextKeyService.createKey<T>(name, undefined);
			k.set(value);
			return k;
		};
		this._keys = [key('devhubVim.active', true), key('devhubVim.attached', true), key('devhubVim.mode', 'normal')];
		ModalTextInput._track(_editorId, this);
		ModalTextInput.set(_editorId, true);
	}

	/** Options given to the editor before it is claimed: the caret stays the modal one, the request is kept. */
	filterOptions(options: Readonly<IEditorOptions>): Readonly<IEditorOptions> {
		if (this._ended || options.cursorStyle === undefined) {
			return options;
		}
		this._requestedCursorStyle = options.cursorStyle;
		return { ...options, cursorStyle: ModalEditorStart.CURSOR_STYLE };
	}

	end(claimed: boolean): void {
		if (this._ended) {
			return;
		}
		this._ended = true;
		ModalTextInput._track(this._editorId, undefined);
		for (const k of this._keys) {
			k.reset();
		}
		if (!claimed) {
			ModalTextInput.set(this._editorId, false);
			this._applyCursorStyle(this._requestedCursorStyle ?? 'line');
		}
	}

	dispose(): void {
		if (!this._ended) {
			this._ended = true;
			ModalTextInput._track(this._editorId, undefined);
			ModalTextInput.set(this._editorId, false);
		}
	}
}
