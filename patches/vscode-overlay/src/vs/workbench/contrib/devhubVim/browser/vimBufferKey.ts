/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub native Vim: which buffer an editor is. Two editors are one buffer
// when they are the same kind of editor (type and editor id) on the same
// resources: the same file opened in two groups, or opened again after it was
// closed, is the same buffer with the same number (vimBuffers.ts). An editor
// with no resource is a buffer of its own while it lives.

import { EditorInput } from '../../../common/editor/editorInput.js';
import { SideBySideEditorInput } from '../../../common/editor/sideBySideEditorInput.js';
import { DiffEditorInput } from '../../../common/editor/diffEditorInput.js';
import { StoredBufferOpen } from '../common/vimBuffers.js';

const anonymous = new WeakMap<EditorInput, string>();
let nextAnonymous = 1;

/** The buffer key of an editor. */
export function bufferKey(editor: EditorInput): string {
	if (editor instanceof SideBySideEditorInput) {
		const p = editor.primary.resource, s = editor.secondary.resource;
		if (p && s) {
			return `${editor.typeId}|${editor.editorId ?? ''}|${s.toString()}|${p.toString()}`;
		}
	} else if (editor.resource) {
		return `${editor.typeId}|${editor.editorId ?? ''}|${editor.resource.toString()}`;
	}
	let key = anonymous.get(editor);
	if (!key) {
		key = `#${nextAnonymous++}`;
		anonymous.set(editor, key);
	}
	return key;
}

/** Whether the buffer can be opened again from its key alone (it has resources), so it is kept once its editor is closed. */
export function isDurableKey(key: string): boolean {
	return !key.startsWith('#');
}

/** How to open the editor again once it is closed (its resources and editor id), or undefined. */
export function reopenData(editor: EditorInput): StoredBufferOpen | undefined {
	if (editor instanceof SideBySideEditorInput) {
		const p = editor.primary.resource, s = editor.secondary.resource;
		return p && s ? { primary: p.toString(), secondary: s.toString(), diff: editor instanceof DiffEditorInput } : undefined;
	}
	const override = editor.editorId;
	return editor.resource ? { resource: editor.resource.toString(), ...(override && override !== 'default' ? { override } : {}) } : undefined;
}
