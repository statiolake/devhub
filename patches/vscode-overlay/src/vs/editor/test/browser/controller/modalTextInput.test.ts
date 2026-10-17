/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ModalTextInput } from '../../../browser/controller/editContext/modalTextInput.js';
import { PastePayload } from '../../../browser/editorBrowser.js';
import { Range } from '../../../common/core/range.js';
import { CompositionTypePayload, Handler, ReplacePreviousCharPayload, TypePayload } from '../../../common/editorCommon.js';
import { ITestCodeEditor, withTestCodeEditor } from '../testCodeEditor.js';

suite('DevHub modal text input', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function typeEverything(editor: ITestCodeEditor): void {
		editor.trigger('keyboard', Handler.Type, { text: 'x' } satisfies TypePayload);
		editor.trigger('keyboard', Handler.CompositionStart, {});
		editor.trigger('keyboard', Handler.ReplacePreviousChar, { text: 'う', replaceCharCnt: 0 } satisfies ReplacePreviousCharPayload);
		editor.trigger('keyboard', Handler.CompositionType, { text: 'な', replacePrevCharCnt: 0, replaceNextCharCnt: 0, positionDelta: 0 } satisfies CompositionTypePayload);
		editor.trigger('keyboard', Handler.CompositionEnd, {});
		editor.trigger('keyboard', Handler.Paste, { text: 'pasted', pasteOnNewLine: false, multicursorText: null, mode: null, isBlock: false } satisfies PastePayload);
		editor.trigger('someExtension', Handler.Type, { text: 'y' } satisfies TypePayload);
	}

	test('no typed text, composition or paste reaches a modal editor; commands still edit', () => {
		withTestCodeEditor('abc', {}, editor => {
			const id = editor.getId();
			try {
				ModalTextInput.set(id, true);
				assert.strictEqual(ModalTextInput.isModal(id), true);
				editor.setPosition({ lineNumber: 1, column: 1 });
				typeEverything(editor);
				assert.strictEqual(editor.getModel().getValue(), 'abc');
				assert.strictEqual(editor.inComposition, false);

				editor.executeEdits('vim', [{ range: new Range(1, 4, 1, 4), text: '!' }]);
				assert.strictEqual(editor.getModel().getValue(), 'abc!');

				ModalTextInput.set(id, false);
				editor.setPosition({ lineNumber: 1, column: 1 });
				editor.trigger('keyboard', Handler.Type, { text: 'x' } satisfies TypePayload);
				assert.strictEqual(editor.getModel().getValue(), 'xabc!');
			} finally {
				ModalTextInput.set(id, false);
			}
		});
	});

	test('the switch is per editor and fires only on a change', () => {
		const fired: string[] = [];
		const listener = ModalTextInput.onDidChange(id => fired.push(id));
		try {
			ModalTextInput.set('a', true);
			ModalTextInput.set('a', true);
			ModalTextInput.set('b', false);
			assert.strictEqual(ModalTextInput.isModal('a'), true);
			assert.strictEqual(ModalTextInput.isModal('b'), false);
			ModalTextInput.set('a', false);
			assert.deepStrictEqual(fired, ['a', 'a']);
		} finally {
			listener.dispose();
			ModalTextInput.set('a', false);
		}
	});

	test('a commit is reported only when there is text', () => {
		const commits: string[] = [];
		const listener = ModalTextInput.onDidCommitText(e => commits.push(`${e.editorId}:${e.text}`));
		try {
			ModalTextInput.commit('a', '');
			ModalTextInput.commit('a', 'あ');
			assert.deepStrictEqual(commits, ['a:あ']);
		} finally {
			listener.dispose();
			ModalTextInput.set('a', false);
		}
	});
});
