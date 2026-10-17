/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: with DevHub Vim on, an editor is modal (normal mode, block caret,
// typing keys gated) from its constructor on, before the owner of the modes
// (the workbench contribution) attaches, so the first key of an editor created
// before that owner, or while it is late, types nothing.

import assert from 'assert';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../platform/configuration/test/common/testConfigurationService.js';
import { ContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { ModalTextInput } from '../../../browser/controller/editContext/modalTextInput.js';
import { ICodeEditorService } from '../../../browser/services/codeEditorService.js';
import { EditorOption, cursorStyleToString } from '../../../common/config/editorOptions.js';
import { Handler, TypePayload } from '../../../common/editorCommon.js';
import { EditorContextKeys } from '../../../common/editorContextKeys.js';
import { createTextModel } from '../../common/testTextModel.js';
import { ITestCodeEditor, createCodeEditorServices, instantiateTestCodeEditor } from '../testCodeEditor.js';

const SETTING = 'devhub.vim.enabled';

/** What the owner of the modes would see if it attached in onCodeEditorAdd (the earliest it can). */
interface IAtAdd { modal: boolean; starting: boolean; active: unknown; mode: unknown; cursor: string; gated: boolean }

suite('DevHub: an editor starts modal when DevHub Vim is on', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function withEditor(vimOn: boolean | undefined, policy: boolean, fn: (editor: ITestCodeEditor, keys: IContextKeyService, atAdd: IAtAdd | undefined) => void): void {
		const disposables = new DisposableStore();
		const configurationService = new TestConfigurationService(vimOn === undefined ? {} : { [SETTING]: vimOn });
		const contextKeyService = disposables.add(new ContextKeyService(configurationService));
		if (policy) {
			ModalTextInput.setStartPolicy(accessor => !!accessor.get(IConfigurationService).getValue<boolean>(SETTING));
		}
		let atAdd: IAtAdd | undefined;
		let editor: ITestCodeEditor | undefined;
		try {
			const model = disposables.add(createTextModel('abc'));
			const services = new ServiceCollection(
				[IConfigurationService, configurationService],
				[IContextKeyService, contextKeyService],
			);
			const instantiationService = createCodeEditorServices(disposables, services);
			// Read the state at the moment ICodeEditorService announces the editor, i.e.
			// inside its constructor, where DevHub Vim attaches, before it could have done anything.
			disposables.add(instantiationService.get(ICodeEditorService).onCodeEditorAdd(e => {
				const scoped = e.invokeWithinContext(a => a.get(IContextKeyService));
				atAdd = {
					modal: ModalTextInput.isModal(e.getId()),
					starting: ModalTextInput.isStarting(e.getId()),
					active: scoped.getContextKeyValue('devhubVim.active'),
					mode: scoped.getContextKeyValue('devhubVim.mode'),
					cursor: cursorStyleToString(e.getOption(EditorOption.cursorStyle)),
					gated: !scoped.contextMatchesRules(EditorContextKeys.devhubVimAllowsTyping),
				};
			}));
			editor = instantiateTestCodeEditor(instantiationService, model);
			fn(editor, editor.invokeWithinContext(a => a.get(IContextKeyService)), atAdd);
		} finally {
			ModalTextInput.setStartPolicy(undefined);
			editor?.dispose();
			disposables.dispose();
		}
	}

	function type(editor: ITestCodeEditor, text: string): void {
		editor.setPosition({ lineNumber: 1, column: 1 });
		editor.trigger('keyboard', Handler.Type, { text } satisfies TypePayload);
	}

	test('modal, in normal mode, with a block caret, before anyone attaches; typing is swallowed', () => {
		withEditor(true, true, (editor, keys, atAdd) => {
			assert.deepStrictEqual(atAdd, { modal: true, starting: true, active: true, mode: 'normal', cursor: 'block', gated: true });
			type(editor, 'x');
			assert.strictEqual(editor.getModel().getValue(), 'abc');
			// the editor's creator re-applying its options does not bring the line caret back
			editor.updateOptions({ cursorStyle: 'line' });
			assert.strictEqual(cursorStyleToString(editor.getOption(EditorOption.cursorStyle)), 'block');
			assert.strictEqual(keys.contextMatchesRules(EditorContextKeys.devhubVimAllowsTyping), false);
		});
	});

	test('a claim hands the state to the owner: still modal, the scoped keys give way to its global ones', () => {
		withEditor(true, true, (editor, keys) => {
			ModalTextInput.claim(editor.getId());
			assert.strictEqual(ModalTextInput.isStarting(editor.getId()), false);
			assert.strictEqual(ModalTextInput.isModal(editor.getId()), true);
			assert.strictEqual(keys.getContextKeyValue('devhubVim.active'), undefined);
			assert.strictEqual(keys.getContextKeyValue('devhubVim.mode'), undefined);
			type(editor, 'x');
			assert.strictEqual(editor.getModel().getValue(), 'abc');
			// the owner's caret now: options pass through
			editor.updateOptions({ cursorStyle: 'underline' });
			assert.strictEqual(cursorStyleToString(editor.getOption(EditorOption.cursorStyle)), 'underline');
		});
	});

	test('a release puts back a plain editor, with the caret its creator asked for last', () => {
		withEditor(true, true, (editor, keys) => {
			editor.updateOptions({ cursorStyle: 'line-thin' });
			ModalTextInput.release(editor.getId());
			assert.strictEqual(ModalTextInput.isModal(editor.getId()), false);
			assert.strictEqual(keys.getContextKeyValue('devhubVim.active'), undefined);
			assert.strictEqual(cursorStyleToString(editor.getOption(EditorOption.cursorStyle)), 'line-thin');
			type(editor, 'x');
			assert.strictEqual(editor.getModel().getValue(), 'xabc');
		});
	});

	test('disposed before anyone claimed it: nothing is left modal', () => {
		let id = '';
		withEditor(true, true, editor => { id = editor.getId(); });
		assert.strictEqual(ModalTextInput.isModal(id), false);
		assert.strictEqual(ModalTextInput.isStarting(id), false);
	});

	for (const [what, vimOn, policy] of [['Vim off', false, true], ['setting absent', undefined, true], ['no start policy (Vim not in this build)', true, false]] as const) {
		test(`${what}: an upstream editor`, () => {
			withEditor(vimOn, policy, (editor, keys, atAdd) => {
				assert.deepStrictEqual(atAdd, { modal: false, starting: false, active: undefined, mode: undefined, cursor: 'line', gated: false });
				type(editor, 'x');
				assert.strictEqual(editor.getModel().getValue(), 'xabc');
				editor.updateOptions({ cursorStyle: 'underline' });
				assert.strictEqual(cursorStyleToString(editor.getOption(EditorOption.cursorStyle)), 'underline');
			});
		});
	}

});
