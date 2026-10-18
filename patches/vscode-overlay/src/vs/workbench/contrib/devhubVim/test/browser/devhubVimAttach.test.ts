/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub: with DevHub Vim on, an editor is a Vim editor from its first key —
// modal, in normal mode, with Vim's caret and an engine that `i` takes into
// insert mode — the moment its constructor returns, because the contribution
// attaches in onCodeEditorAdd, which fires at the end of that constructor. It
// is never modal without an engine. (An earlier design made the editor core
// start editors modal until the engine claimed them; an editor left in that
// state — reported in the SCM commit message box — typed nothing and `i` did
// nothing.)

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ModalTextInput } from '../../../../../editor/browser/controller/editContext/modalTextInput.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { EditorOption, cursorStyleToString } from '../../../../../editor/common/config/editorOptions.js';
import { Handler, TypePayload } from '../../../../../editor/common/editorCommon.js';
import { EditorContextKeys } from '../../../../../editor/common/editorContextKeys.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { ITestCodeEditor, TestCodeEditor, createCodeEditorServices } from '../../../../../editor/test/browser/testCodeEditor.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { KeybindingsRegistry } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IStatusbarEntryAccessor, IStatusbarService } from '../../../../services/statusbar/browser/statusbar.js';
import { DevhubVim } from '../../browser/devhubVim.contribution.js';
import { VIM_WHEN } from '../../common/vimKeymap.js';

const SETTING = 'devhub.vim.enabled';

/** A test editor (focus is set by hand) with a model. */
type VimTestEditor = TestCodeEditor & ITestCodeEditor;

/**
 * A simple widget, as the SCM input, the debug console input, chat and comment
 * inputs are (`isSimpleWidget: true`). TestCodeEditor's test configuration
 * drops that option, so it is put back here: CodeEditorWidget then never sets
 * `editorTextFocus` / `editorFocus` for it, as in the workbench.
 */
class TestSimpleWidget extends TestCodeEditor {
	override get isSimpleWidget(): boolean {
		return true;
	}
}

class TestStatusbarService extends mock<IStatusbarService>() {
	override addEntry(): IStatusbarEntryAccessor {
		return { update() { }, dispose() { } };
	}
}

suite('DevHub Vim: an editor is a Vim editor from its first key', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	/** The contribution, then `fn` with a way to make editors in it. */
	function withVim(vimOn: boolean, fn: (create: (kind: 'editor' | 'scm') => VimTestEditor, vim: DevhubVim) => void): void {
		const disposables = new DisposableStore();
		try {
			const configurationService = new TestConfigurationService({ [SETTING]: vimOn });
			const contextKeyService = disposables.add(new ContextKeyService(configurationService));
			const instantiationService = createCodeEditorServices(disposables, new ServiceCollection(
				[IConfigurationService, configurationService],
				[IContextKeyService, contextKeyService],
				[IStatusbarService, new TestStatusbarService()],
				[ILabelService, new class extends mock<ILabelService>() { }],
			));
			const vim = disposables.add(instantiationService.createInstance(DevhubVim));
			const create = (kind: 'editor' | 'scm') => {
				const outer = document.createElement('div');
				const element = outer.appendChild(document.createElement('div'));
				let services: IInstantiationService = instantiationService;
				if (kind === 'scm') {
					// What SCMInputWidget does: a context of its own scoped to its
					// element, a child instantiation service carrying it, and a
					// simple widget in a container inside that element.
					const scoped = disposables.add(contextKeyService.createScoped(outer));
					services = disposables.add(instantiationService.createChild(new ServiceCollection([IContextKeyService, scoped])));
				}
				const editor = disposables.add(services.createInstance(kind === 'scm' ? TestSimpleWidget : TestCodeEditor, element, { cursorStyle: 'line' }, { isSimpleWidget: kind === 'scm', contributions: [] }));
				editor.setModel(disposables.add(createTextModel('abc')));
				return editor as VimTestEditor;
			};
			fn(create, vim);
		} finally {
			disposables.dispose();
		}
	}

	/** The contribution's privates this test reads: its editors, its service, its switch. */
	interface Internals {
		readonly editors: Map<ICodeEditor, unknown>;
		readonly codeEditorService: ICodeEditorService;
		setEnabled(enabled: boolean): void;
	}
	const internals = (vim: DevhubVim) => vim as unknown as Internals;

	function engineOf(vim: DevhubVim, editor: ICodeEditor): boolean {
		return internals(vim).editors.has(editor);
	}

	function type(editor: VimTestEditor, text: string): void {
		editor.setPosition({ lineNumber: 1, column: 1 });
		editor.trigger('keyboard', Handler.Type, { text } satisfies TypePayload);
	}

	/**
	 * What a focus does to the state Vim reads (a test editor has no view to be
	 * focused): the editor's own focus keys as CodeEditorWidget sets them —
	 * `textInputFocus` always, `editorTextFocus` / `editorFocus` only for a full
	 * editor, never for a simple widget such as the SCM input — and the other
	 * editors' focus gone.
	 */
	function focus(vim: DevhubVim, editor: VimTestEditor, others: VimTestEditor[] = []): void {
		for (const [e, has] of [...others.map(o => [o, false] as const), [editor, true] as const]) {
			e.setHasTextFocus(has);
			const keys = e.invokeWithinContext(a => a.get(IContextKeyService));
			EditorContextKeys.textInputFocus.bindTo(keys).set(has);
			EditorContextKeys.editorTextFocus.bindTo(keys).set(has && !e.isSimpleWidget);
			EditorContextKeys.focus.bindTo(keys).set(has && !e.isSimpleWidget);
		}
		vim.update();
	}

	/** The default keybinding of `command` with `args`, as the dispatcher would resolve it in `editor` (its when holds there). */
	function bindingHolds(editor: ICodeEditor, command: string, args: unknown): boolean {
		const keys = editor.invokeWithinContext(a => a.get(IContextKeyService));
		const rules = KeybindingsRegistry.getDefaultKeybindings().filter(k => k.command === command && JSON.stringify(k.commandArgs) === JSON.stringify(args));
		assert.ok(rules.length > 0, `${command} ${JSON.stringify(args)} is a default keybinding`);
		return rules.some(r => keys.contextMatchesRules(r.when ?? undefined));
	}

	/** A key's command run as the dispatcher runs it: the registered command, not the contribution directly. */
	function runCommand(editor: VimTestEditor, command: string, args: unknown): void {
		editor.invokeWithinContext(a => CommandsRegistry.getCommand(command)!.handler(a, args));
	}

	for (const kind of ['editor', 'scm'] as const) {
		test(`${kind}: modal with an engine as its constructor returns, and \`i\` enters insert mode`, () => {
			withVim(true, (create, vim) => {
				// The state at onCodeEditorAdd, i.e. inside the constructor, after Vim's own listener.
				let atAdd: { modal: boolean; engine: boolean; cursor: string } | undefined;
				store.add(internals(vim).codeEditorService.onCodeEditorAdd(e => {
					atAdd = { modal: ModalTextInput.isModal(e.getId()), engine: engineOf(vim, e), cursor: cursorStyleToString(e.getOption(EditorOption.cursorStyle)) };
				}));
				const editor = create(kind);
				assert.deepStrictEqual(atAdd, { modal: true, engine: true, cursor: 'block' });

				// The first key: nothing types; the normal-mode `i` applies there.
				focus(vim, editor);
				const keys = editor.invokeWithinContext(a => a.get(IContextKeyService));
				type(editor, 'x');
				assert.strictEqual(editor.getModel()?.getValue(), 'abc');
				assert.strictEqual(keys.contextMatchesRules(ContextKeyExpr.deserialize(VIM_WHEN.normal)), true);
				assert.strictEqual(keys.contextMatchesRules(EditorContextKeys.devhubVimAllowsTyping), false);

				// `i`: insert mode, and typing reaches the model.
				vim.execute('devhubVim.mode', { to: 'insert', at: 'before' });
				assert.strictEqual(ModalTextInput.isModal(editor.getId()), false);
				assert.strictEqual(keys.getContextKeyValue('devhubVim.mode'), 'insert');
				assert.strictEqual(keys.contextMatchesRules(EditorContextKeys.devhubVimAllowsTyping), true);
				type(editor, 'x');
				assert.strictEqual(editor.getModel()?.getValue(), 'xabc');
			});
		});
	}

	test('with a full editor open and the SCM input focused, `i` holds in the SCM input and changes only its mode; typing then reaches it', () => {
		withVim(true, (create, vim) => {
			const main = create('editor');
			const scm = create('scm');
			// the main editor was focused first (the "active" editor), then the commit message box
			focus(vim, main);
			focus(vim, scm, [main]);
			const scmKeys = scm.invokeWithinContext(a => a.get(IContextKeyService));
			assert.strictEqual(scmKeys.getContextKeyValue('editorTextFocus'), false, 'a simple widget never has editorTextFocus');
			assert.strictEqual(scmKeys.getContextKeyValue('devhubVim.mode'), 'normal');
			assert.strictEqual(bindingHolds(scm, 'devhubVim.mode', { to: 'insert', at: 'before' }), true, '`i` applies in the SCM input');
			runCommand(scm, 'devhubVim.mode', { to: 'insert', at: 'before' });
			assert.strictEqual(scmKeys.getContextKeyValue('devhubVim.mode'), 'insert');
			assert.strictEqual(ModalTextInput.isModal(scm.getId()), false);
			assert.strictEqual(ModalTextInput.isModal(main.getId()), true, 'the main editor stays in normal mode');
			type(scm, 'x');
			assert.strictEqual(scm.getModel()?.getValue(), 'xabc');
			type(main, 'x');
			assert.strictEqual(main.getModel()?.getValue(), 'abc');
			// Esc and the next keys are the SCM input's too
			assert.strictEqual(bindingHolds(scm, 'devhubVim.escape', undefined), true);
			runCommand(scm, 'devhubVim.escape', undefined);
			assert.strictEqual(ModalTextInput.isModal(scm.getId()), true);
			// back in the main editor: its own mode, its own keys
			focus(vim, main, [scm]);
			assert.strictEqual(bindingHolds(main, 'devhubVim.mode', { to: 'insert', at: 'before' }), true);
			runCommand(main, 'devhubVim.mode', { to: 'insert', at: 'before' });
			assert.strictEqual(ModalTextInput.isModal(main.getId()), false);
			assert.strictEqual(ModalTextInput.isModal(scm.getId()), true);
		});
	});

	test('the SCM input swapping its model (another repository) keeps a working Vim editor', () => {
		withVim(true, (create, vim) => {
			const scm = create('scm');
			focus(vim, scm);
			runCommand(scm, 'devhubVim.mode', { to: 'insert', at: 'before' });
			scm.setModel(store.add(createTextModel('other')));
			// a new model starts in normal mode, modal, and `i` works on it
			assert.strictEqual(ModalTextInput.isModal(scm.getId()), true);
			assert.strictEqual(bindingHolds(scm, 'devhubVim.mode', { to: 'insert', at: 'before' }), true);
			runCommand(scm, 'devhubVim.mode', { to: 'insert', at: 'before' });
			type(scm, 'y');
			assert.strictEqual(scm.getModel()?.getValue(), 'yother');
		});
	});

	test('an editor made while Vim is off is a plain one, and becomes a Vim editor when Vim is turned on', () => {
		withVim(false, (create, vim) => {
			const editor = create('scm');
			assert.strictEqual(ModalTextInput.isModal(editor.getId()), false);
			assert.strictEqual(cursorStyleToString(editor.getOption(EditorOption.cursorStyle)), 'line');
			type(editor, 'x');
			assert.strictEqual(editor.getModel()?.getValue(), 'xabc');
			internals(vim).setEnabled(true);
			assert.strictEqual(ModalTextInput.isModal(editor.getId()), true);
			assert.strictEqual(engineOf(vim, editor), true);
			internals(vim).setEnabled(false);
			assert.strictEqual(ModalTextInput.isModal(editor.getId()), false);
		});
	});

	test('a disposed Vim editor leaves nothing modal', () => {
		let id = '';
		withVim(true, create => { id = create('editor').getId(); });
		assert.strictEqual(ModalTextInput.isModal(id), false);
	});

	test('no editor is ever modal without an engine', () => {
		withVim(true, (create, vim) => {
			const editors = [create('editor'), create('scm'), create('editor')];
			for (const editor of editors) {
				assert.strictEqual(!ModalTextInput.isModal(editor.getId()) || engineOf(vim, editor), true);
			}
		});
	});
});
