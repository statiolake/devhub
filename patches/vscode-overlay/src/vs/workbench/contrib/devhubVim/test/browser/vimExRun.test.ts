/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub Vim: ex commands in a real editor, on the workbench's services.

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { EditorContextKeys } from '../../../../../editor/common/editorContextKeys.js';
import { createTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { TestCodeEditor, createCodeEditorServices } from '../../../../../editor/test/browser/testCodeEditor.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IStatusbarEntryAccessor, IStatusbarService } from '../../../../services/statusbar/browser/statusbar.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { EncodingMode, ITextFileEditorModel, ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { DevhubVim } from '../../browser/devhubVim.contribution.js';

export interface VimExEnv {
	readonly vim: DevhubVim;
	readonly editor: TestCodeEditor;
	readonly configurationService: TestConfigurationService;
	/** Commands run that no handler is registered for here, with their args. */
	readonly ran: { id: string; args: unknown[] }[];
	text(): string;
	/** `:{line}` and Enter, then whatever it started settles. */
	ex(line: string): Promise<void>;
	status(): string;
}

const settle = () => new Promise(r => setTimeout(r, 0));

/**
 * A Vim editor with `text`, the workbench's command service running registered
 * handlers in the editor's services (and recording the others), and
 * `services` added.
 */
export async function withVimEditor(text: string, fn: (env: VimExEnv) => Promise<void>, services: [unknown, unknown][] = [], settings: Record<string, unknown> = {}, handlers: Record<string, (...args: unknown[]) => unknown> = {}): Promise<void> {
	const disposables = new DisposableStore();
	let editor: TestCodeEditor;
	const ran: { id: string; args: unknown[] }[] = [];
	let status = '';
	try {
		const configurationService = new TestConfigurationService({ 'devhub.vim.enabled': true, ...settings });
		const contextKeyService = disposables.add(new ContextKeyService(configurationService));
		const collection = new ServiceCollection(
			[IConfigurationService, configurationService],
			[IContextKeyService, contextKeyService],
			[IStatusbarService, new class extends mock<IStatusbarService>() {
				override addEntry(): IStatusbarEntryAccessor { return { update(p) { status = p.text; }, dispose() { } }; }
			}],
			[ILabelService, new class extends mock<ILabelService>() { override getUriLabel() { return 'file.txt'; } }],
			[ICommandService, new class extends mock<ICommandService>() {
				override async executeCommand<T>(id: string, ...args: unknown[]): Promise<T> {
					if (handlers[id]) {
						return await handlers[id](...args) as T;
					}
					const command = CommandsRegistry.getCommand(id);
					if (!command) {
						ran.push({ id, args });
						return undefined as T;
					}
					return await editor.invokeWithinContext(a => command.handler(a, ...args)) as T;
				}
			}],
		);
		for (const [id, instance] of services) {
			collection.set(id as never, instance);
		}
		const instantiation = createCodeEditorServices(disposables, collection);
		const vim = disposables.add(instantiation.createInstance(DevhubVim));
		editor = disposables.add(instantiation.createInstance(TestCodeEditor, document.createElement('div'), {}, { contributions: [] }));
		editor.setModel(disposables.add(createTextModel(text)));
		editor.setHasTextFocus(true);
		editor.getViewModel()!.setHasFocus(true);
		const keys = editor.invokeWithinContext(a => a.get(IContextKeyService));
		EditorContextKeys.editorTextFocus.bindTo(keys).set(true);
		EditorContextKeys.textInputFocus.bindTo(keys).set(true);
		vim.update();
		await fn({
			vim, editor, configurationService, ran,
			text: () => editor.getModel()!.getValue(),
			ex: async line => {
				vim.execute('devhubVim.ex', { command: line });
				for (let i = 0; i < 5; i++) {
					await settle();
				}
			},
			status: () => status,
		});
	} finally {
		disposables.dispose();
	}
}

suite('DevHub Vim: :set ts= sw= et are the model\'s options', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('VS Code\'s tab size, indent size and insert spaces follow, and :set ...? reads them back', async () => {
		await withVimEditor('\tx\n  y', async env => {
			const o = () => { const m = env.editor.getModel()!.getOptions(); return [m.tabSize, m.originalIndentSize, m.insertSpaces]; };
			await env.ex('set ts=2 sw=0 et');
			assert.deepStrictEqual(o(), [2, 'tabSize', true]);
			await env.ex('set sw=3 noet');
			assert.deepStrictEqual(o(), [2, 3, false]);
			await env.ex('set ts+=6 invet');
			assert.deepStrictEqual(o(), [8, 3, true]);
			await env.ex('set ts? sw? et?');
			assert.ok(env.status().includes('tabstop=8  shiftwidth=3  expandtab'), env.status());
			// :retab and >> use them
			await env.ex('set ts=4 et | retab');
			assert.strictEqual(env.text(), '    x\n  y');
			await env.ex('set ts=0');
			assert.ok(env.status().includes('E487'), env.status());
		});
	});

	test(':set ts& is what the settings say for the file', async () => {
		await withVimEditor('x', async env => {
			await env.ex('set ts=3 et');
			await env.ex('set ts& et&');
			const m = env.editor.getModel()!.getOptions();
			assert.deepStrictEqual([m.tabSize, m.insertSpaces], [8, false]);
		}, [], { editor: { tabSize: 8, insertSpaces: false } });
	});
});

suite('DevHub Vim: :set ff= fenc= bomb are VS Code\'s line endings and encoding', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** The services `_devhubVim.fileOptions` reads, on the editor\'s own model and a text file model that records what it is asked. */
	function fileServices(holder: { editor?: TestCodeEditor }, encoding: { current: string }, calls: [string, EncodingMode][]): [unknown, unknown][] {
		const file = {
			isDirty: () => false, isResolved: () => true,
			getEncoding: () => encoding.current,
			setEncoding: async (e: string, mode: EncodingMode) => { calls.push([e, mode]); encoding.current = e; },
		} as unknown as ITextFileEditorModel;
		return [
			[IModelService, new class extends mock<IModelService>() { override getModel() { return holder.editor?.getModel() ?? null; } }],
			[ITextFileService, new class extends mock<ITextFileService>() {
				override readonly files = { get: () => file } as unknown as ITextFileService['files'];
				override readonly untitled = { get: () => undefined } as unknown as ITextFileService['untitled'];
				override getEncoding() { return encoding.current; }
			}],
			[IEditorService, new class extends mock<IEditorService>() { }],
			[IEditorGroupsService, new class extends mock<IEditorGroupsService>() { }],
			[IFileService, new class extends mock<IFileService>() { }],
			[IPathService, new class extends mock<IPathService>() { }],
			[IWorkspaceContextService, new class extends mock<IWorkspaceContextService>() { }],
		];
	}

	test(':set ff=dos / unix change the model\'s line endings as one undo step (VS Code\'s "Change End of Line Sequence"); ff? shows it', async () => {
		const holder: { editor?: TestCodeEditor } = {};
		await withVimEditor('a\nb\nc', async env => {
			holder.editor = env.editor;
			const model = env.editor.getModel()!;
			assert.strictEqual(model.getEOL(), '\n');
			await env.ex('set ff?');
			assert.ok(env.status().includes('fileformat=unix'), env.status());
			await env.ex('set ff=dos');
			assert.strictEqual(model.getEOL(), '\r\n');
			assert.strictEqual(env.text(), 'a\r\nb\r\nc');
			await env.ex('set fileformat?');
			assert.ok(env.status().includes('fileformat=dos'), env.status());
			// undoable, as VS Code\'s own change
			await env.ex('undo');
			assert.strictEqual(model.getEOL(), '\n');
			await env.ex('set ff=dos | set ff=unix');
			assert.strictEqual(model.getEOL(), '\n');
			// already in that format: no undo step is added
			const version = model.getAlternativeVersionId();
			await env.ex('set ff=unix');
			assert.strictEqual(model.getAlternativeVersionId(), version);
			// mac is not one of VS Code\'s
			await env.ex('set ff=mac');
			assert.ok(env.status().includes('E474') && env.status().includes('CR'), env.status());
			assert.strictEqual(model.getEOL(), '\n');
		}, fileServices(holder, { current: 'utf8' }, []));
	});

	test(':set fenc= is setEncoding in Encode mode; fenc? and bomb show VS Code\'s encoding; an unknown name is E474', async () => {
		const holder: { editor?: TestCodeEditor } = {};
		const calls: [string, EncodingMode][] = [];
		const encoding = { current: 'utf8' };
		await withVimEditor('a', async env => {
			holder.editor = env.editor;
			await env.ex('set fenc?');
			assert.ok(env.status().includes('fileencoding=utf8'), env.status());
			await env.ex('set fenc=cp932');
			assert.deepStrictEqual(calls, [['shiftjis', EncodingMode.Encode]]);
			await env.ex('set fenc? bomb?');
			assert.ok(env.status().includes('fileencoding=shiftjis  nobomb'), env.status());
			await env.ex('set fenc=utf-8 bomb');
			assert.deepStrictEqual(calls.slice(1), [['utf8', EncodingMode.Encode], ['utf8bom', EncodingMode.Encode]]);
			await env.ex('set bomb?');
			assert.ok(env.status().includes('bomb') && !env.status().includes('nobomb'), env.status());
			await env.ex('set nobomb');
			assert.strictEqual(encoding.current, 'utf8');
			await env.ex('set fenc=klingon');
			assert.ok(env.status().includes('E474: Invalid argument: fenc=klingon'), env.status());
			assert.strictEqual(calls.length, 4);
		}, fileServices(holder, encoding, calls));
	});
});
