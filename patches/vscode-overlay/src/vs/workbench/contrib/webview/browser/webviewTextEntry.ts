/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: whether the focus inside a webview's page is text entry.
//
// A webview's page is another document (two frames down: the host frame,
// pre/index.html, and the page's own frame in it), so the workbench sees only
// its <iframe> as the focused element. The host frame tells: with every key
// it forwards (`did-keydown`, before the workbench resolves the key) and
// whenever the focus moves inside the page (`did-devhub-text-entry`), it says
// whether the page's focused element takes typing — an input, a textarea, a
// select, contenteditable, role textbox / searchbox / combobox, a frame of
// its own it cannot look into — patches/vscode/0008-devhub-vim.patch.
// WebviewElement records it here per <iframe>; DevHub Vim reads it
// (devhubVim.contribution.ts) so that normal-mode keys apply in a webview
// while the page is not being typed into, and the page's typing is left
// alone while it is.

import { Emitter } from '../../../../base/common/event.js';

const state = new WeakMap<Element, boolean>();
const onDidChange = new Emitter<Element>();

export const WebviewTextEntry = {
	/** The focus moved into or out of a text field in a webview's page (the webview's <iframe>). */
	onDidChange: onDidChange.event,

	/** What the host frame of the webview whose <iframe> this is said last. */
	set(frame: Element, textEntry: boolean): void {
		if (state.get(frame) !== textEntry) {
			state.set(frame, textEntry);
			onDidChange.fire(frame);
		}
	},

	/** Whether the focus in the page of this webview <iframe> is text entry; undefined when it is no webview's, or its page has said nothing yet. */
	get(frame: Element): boolean | undefined {
		return state.get(frame);
	},
};
