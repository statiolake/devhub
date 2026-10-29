/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub Vim: VS Code's editors are Vim's buffers, on VS Code's own editor
// parts: the numbers, `:ls`, `:b`, `:bn` / `:bp`, CTRL-^, `:bd`, and the
// quit that a modified buffer stops (E37 / E162, the buffer made current).

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { InMemoryStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../common/editor.js';
import { IResourceEditorInput } from '../../../../../platform/editor/common/editor.js';
import { IAuxiliaryWindowService } from '../../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { GroupDirection, IEditorGroup, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { IWorkingCopy } from '../../../../services/workingCopy/common/workingCopy.js';
import { IWorkingCopyService } from '../../../../services/workingCopy/common/workingCopyService.js';
import { createEditorParts, registerTestEditor, TestEditorParts, TestFileEditorInput, TestServiceAccessor, workbenchInstantiationService, workbenchTeardown } from '../../../../test/browser/workbenchTestServices.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { BUFFERS_STORAGE_KEY, VimBuffers } from '../../browser/vimBuffers.js';
import { VimTabPages } from '../../browser/vimTabPages.js';

suite('DevHub Vim buffers on VS Code\'s editor parts', () => {

	const TEST_EDITOR_ID = 'devhubVimBuffersTestEditor';
	const TEST_INPUT_ID = 'devhubVimBuffersTestInput';
	const disposables = new DisposableStore();
	let instantiationService: TestInstantiationService;
	let parts: TestEditorParts;
	let storage: InMemoryStorageService;
	let picked: number | undefined;
	let pickedFrom: string[];
	let loose: IWorkingCopy[];
	/** What the buffers opened again from their resources (editorService.openEditor). */
	let reopened: string[];
	const inputs = new Map<string, TestFileEditorInput>();

	const input = (path: string) => {
		let i = inputs.get(path);
		if (!i || i.isDisposed()) {
			i = disposables.add(new TestFileEditorInput(URI.file(`/work/${path}`), TEST_INPUT_ID));
			inputs.set(path, i);
		}
		return i;
	};
	const open = async (path: string, group: IEditorGroup = parts.activeGroup, dirty = false) => {
		const i = input(path);
		await group.openEditor(i, { pinned: true });
		i.dirty = dirty;
		return i;
	};
	const shown = () => parts.groups.map(g => g.editors.map(e => e.resource!.path.replace('/work/', '') + (g.activeEditor === e ? '*' : '') + (e.isDirty() ? '+' : '')));

	const create = () => disposables.add(new VimBuffers(parts as IEditorGroupsService,
		new class extends mock<IEditorService>() {
			override onDidActiveEditorChange = Event.None;
			override openEditor = (async (editor: IResourceEditorInput, group: IEditorGroup) => {
				const path = editor.resource.path.replace('/work/', '');
				reopened.push(path);
				const i = input(path);
				await group.openEditor(i, { pinned: true });
				return undefined;
			}) as never;
		},
		storage,
		new class extends mock<ILabelService>() {
			override getUriLabel(uri: URI, options?: { relative?: boolean }) { return options?.relative ? uri.path.replace('/work/', '') : uri.path; }
		},
		new class extends mock<IQuickInputService>() {
			override async pick<T extends IQuickPickItem>(items: T[]) {
				pickedFrom = items.map(i => i.label);
				return (picked === undefined ? undefined : items[picked]) as never;
			}
		},
		new class extends mock<IWorkingCopyService>() { override get modifiedWorkingCopies() { return loose; } }));

	setup(async () => {
		disposables.add(registerTestEditor(TEST_EDITOR_ID, [new SyncDescriptor(TestFileEditorInput)], TEST_INPUT_ID));
		instantiationService = workbenchInstantiationService(undefined, disposables);
		instantiationService.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));
		instantiationService.stub(IAuxiliaryWindowService, new class extends mock<IAuxiliaryWindowService>() { override getWindow() { return undefined; } });
		parts = await createEditorParts(instantiationService, disposables);
		instantiationService.stub(IEditorGroupsService, parts);
		storage = disposables.add(new InMemoryStorageService());
		picked = undefined;
		pickedFrom = [];
		loose = [];
		reopened = [];
		inputs.clear();
	});

	teardown(async () => {
		for (const i of inputs.values()) {
			i.dirty = false;
		}
		await workbenchTeardown(instantiationService);
		disposables.clear();
	});

	test('every editor is a buffer with a number for good: :ls lists them in every group with % # a h +, the same file opened again is the same number', async () => {
		await open('a.ts');
		const buffers = create();
		await open('b.ts');
		const right = parts.addGroup(parts.activeGroup, GroupDirection.RIGHT);
		await open('c.ts', right, true);
		await open('a.ts', right);
		parts.activateGroup(right);
		assert.deepStrictEqual(buffers.lines(), [
			'  1 %a   "a.ts"                         line 1',
			'  2  a   "b.ts"                         line 1',
			'  3 #h + "c.ts"                         line 1',
		]);
		// closing an editor yourself unlists it (:ls! shows it), opening it again lists it under its number
		input('c.ts').dirty = false;
		await parts.activeGroup.closeEditor(input('c.ts'));
		assert.deepStrictEqual(buffers.entries().map(b => [b.nr, b.listed]), [[1, true], [2, true], [3, false]]);
		// still the window's alternate buffer
		assert.strictEqual(buffers.lines(true)[2].slice(0, 9), '  3u#    ');
		await open('c.ts', right);
		await open('d.ts', right);
		assert.deepStrictEqual(buffers.entries().map(b => [b.nr, b.name, b.listed]), [[1, 'a.ts', true], [2, 'b.ts', true], [3, 'c.ts', true], [4, 'd.ts', true]]);
		// kept in workspace storage: a workbench opened again (a reload, hibernation) has the same numbers, the unlisted ones too
		await parts.groups[0].closeEditor(input('b.ts'));
		await storage.flush();
		assert.ok(storage.get(BUFFERS_STORAGE_KEY, StorageScope.WORKSPACE));
		buffers.dispose();
		const again = create();
		assert.deepStrictEqual(again.entries().map(b => [b.nr, b.name, b.listed]), [[1, 'a.ts', true], [2, 'b.ts', false], [3, 'c.ts', true], [4, 'd.ts', true]]);
		await open('e.ts', right);
		assert.strictEqual(again.entries().at(-1)?.nr, 5, 'a number is never given twice');
	});

	test(':b N / :b {name} in the current window: an editor of this group is made active; one another window hides is moved here; one another window shows is opened here too', async () => {
		const left = parts.activeGroup;
		await open('a.ts', left);
		await open('b.ts', left);
		const right = parts.addGroup(left, GroupDirection.RIGHT);
		await open('c.ts', right);
		await open('d.ts', right);
		const buffers = create();
		parts.activateGroup(left);
		await buffers.gotoArg('', 1);
		assert.deepStrictEqual(shown(), [['a.ts*', 'b.ts'], ['c.ts', 'd.ts*']]);
		// c.ts is a hidden buffer of the right window: it comes here
		await buffers.gotoArg('c', undefined);
		assert.deepStrictEqual(shown().map(g => g.sort()), [['a.ts', 'b.ts', 'c.ts*'], ['d.ts*']]);
		// d.ts is shown on the right: both windows show it
		await buffers.gotoArg('d.ts', undefined);
		assert.deepStrictEqual(shown().map(g => g.sort()), [['a.ts', 'b.ts', 'c.ts', 'd.ts*'], ['d.ts*']]);
		await assert.rejects(buffers.gotoArg('9', undefined), /E86: Buffer 9 does not exist/);
		await assert.rejects(buffers.gotoArg('.ts', undefined), /E93: More than one match for \.ts/);
		await assert.rejects(buffers.gotoArg('zzz', undefined), /E94: No matching buffer for zzz/);
		// :ls in a quick pick; picking one is :b N
		picked = 1;
		await buffers.list(false, '');
		assert.deepStrictEqual(pickedFrom.map(l => l.slice(0, 6)), ['  1  h', '  2  h', '  3 #h', '  4 %a']);
		assert.strictEqual(parts.activeGroup.activeEditor, input('b.ts'));
	});

	test(':bn :bp [N] go round the listed buffers by number; CTRL-^ and :b# are the window\'s alternate buffer; {N}CTRL-^ is :b N; E23', async () => {
		await open('a.ts');
		await open('b.ts');
		await open('c.ts');
		const buffers = create();
		await assert.rejects(buffers.alternate(undefined), /E23: No alternate file/);
		await buffers.step(1, undefined);
		assert.strictEqual(parts.activeGroup.activeEditor, input('a.ts'), 'from the last to the first');
		await buffers.step(1, 2);
		assert.strictEqual(parts.activeGroup.activeEditor, input('c.ts'));
		await buffers.step(-1, undefined);
		assert.strictEqual(parts.activeGroup.activeEditor, input('b.ts'));
		await buffers.alternate(undefined);
		assert.strictEqual(parts.activeGroup.activeEditor, input('c.ts'));
		await buffers.alternate(undefined);
		assert.strictEqual(parts.activeGroup.activeEditor, input('b.ts'));
		await buffers.gotoArg('#', undefined);
		assert.strictEqual(parts.activeGroup.activeEditor, input('c.ts'));
		await buffers.alternate(1);
		assert.strictEqual(parts.activeGroup.activeEditor, input('a.ts'));
		await buffers.edge(true);
		assert.strictEqual(parts.activeGroup.activeEditor, input('c.ts'));
		await buffers.edge(false);
		assert.strictEqual(parts.activeGroup.activeEditor, input('a.ts'));
		// a split's new window starts with the alternate buffer of the one it was split from
		const right = parts.copyGroup(parts.activeGroup, parts.activeGroup, GroupDirection.RIGHT);
		parts.activateGroup(right);
		assert.deepStrictEqual(buffers.marks(), { current: 1, alternate: 3 });
	});

	test(':b never lets VS Code\'s preview editor be replaced: the current one is pinned first, so no buffer is closed by a switch', async () => {
		await open('a.ts');
		const preview = input('p.ts');
		await parts.activeGroup.openEditor(preview, { pinned: false });
		const buffers = create();
		await buffers.gotoArg('a', undefined);
		assert.ok(parts.activeGroup.contains(preview));
		assert.strictEqual(parts.activeGroup.isPinned(preview), true);
	});

	test(':bd closes the buffer\'s editors in every group (it is unlisted); E89 on a modified one, :bd! drops its changes; :bw forgets its number', async () => {
		const left = parts.activeGroup;
		await open('a.ts', left);
		const right = parts.addGroup(left, GroupDirection.RIGHT);
		await open('a.ts', right);
		await open('b.ts', right, true);
		const buffers = create();
		await assert.rejects(buffers.delete('b', undefined, false, false), /E89: No write since last change for buffer 2 \(add ! to override\)/);
		await buffers.delete('1', undefined, false, false);
		assert.ok(!parts.groups.some(g => g.contains(input('a.ts'))));
		assert.deepStrictEqual(buffers.entries().map(b => [b.nr, b.listed]), [[1, false], [2, true]]);
		await buffers.delete(undefined, 2, true, true);
		assert.strictEqual(input('b.ts').isDirty(), false);
		assert.deepStrictEqual(buffers.entries().map(b => b.nr), [1]);
		// an unlisted buffer is opened again from its resource by :b N
		await buffers.gotoArg('', 1);
		assert.deepStrictEqual(reopened, ['a.ts']);
		assert.deepStrictEqual(buffers.entries().map(b => [b.nr, b.listed]), [[1, true]]);
	});

	test('quitting (the last window): a modified current buffer stops it with E37 / E162 where it is', async () => {
		await open('a.ts', parts.activeGroup, true);
		const buffers = create();
		await assert.rejects(buffers.refuseQuit(false), /^Error: E37: No write since last change {2}E162: No write since last change for buffer "a\.ts"$/);
		assert.deepStrictEqual(shown(), [['a.ts*+']]);
	});

	test('quitting: a modified hidden buffer stops :q and :q! alike, and is made current in the current window at once (no :ls, no :b)', async () => {
		await open('hidden.ts', parts.activeGroup, true);
		await open('a.ts');
		const buffers = create();
		await assert.rejects(buffers.refuseQuit(true), /E162: No write since last change for buffer "hidden\.ts"/);
		assert.strictEqual(parts.activeGroup.activeEditor, input('hidden.ts'));
		// a modified buffer another window shows: :q goes to that window; :q! only checks the hidden ones
		const right = parts.addGroup(parts.activeGroup, GroupDirection.RIGHT);
		await open('shown.ts', right, true);
		input('hidden.ts').dirty = false;
		parts.activateGroup(parts.groups[0]);
		await buffers.refuseQuit(true);
		await assert.rejects(buffers.refuseQuit(false), /E162: No write since last change for buffer "shown\.ts"/);
		assert.strictEqual(parts.activeGroup, right);
		input('shown.ts').dirty = false;
		await buffers.refuseQuit(false);
	});

	test('quitting: a file modified with no editor (a refactoring\'s edit) stops it too, and is opened', async () => {
		await open('a.ts');
		const buffers = create();
		loose = [{ resource: URI.file('/work/edited.ts'), typeId: '', name: 'edited.ts' } as IWorkingCopy, { resource: URI.parse('vscode-notebook:/x'), typeId: 'notebook/x', name: 'x' } as IWorkingCopy];
		await assert.rejects(buffers.refuseQuit(false), /E162: No write since last change for buffer "edited\.ts"/);
		assert.deepStrictEqual(reopened, ['edited.ts']);
	});

	test('a tab page switch hides the editors it closes (still listed, shown in that page\'s window: a); closing them yourself unlists them', async () => {
		const accessor = instantiationService.createInstance(TestServiceAccessor);
		const log = console.log;
		console.log = () => { };
		try {
			const pages = disposables.add(new VimTabPages(parts as IEditorGroupsService,
				new class extends mock<IEditorService>() { override onDidActiveEditorChange = Event.None; override onDidVisibleEditorsChange = Event.None; },
				storage,
				new class extends mock<IWorkbenchLayoutService>() { override hasFocus() { return true; } },
				new class extends mock<IQuickInputService>() { },
				accessor.untitledTextEditorService,
				new class extends mock<ICommandService>() { }));
			await open('a.ts');
			await open('b.ts');
			const buffers = create();
			await pages.newPage('c.ts');
			await open('c.ts');
			assert.deepStrictEqual(shown(), [['c.ts*']]);
			assert.deepStrictEqual(buffers.entries().map(b => [b.nr, b.name, b.listed, b.loaded, b.shown]), [
				[1, 'a.ts', true, false, false],
				[2, 'b.ts', true, false, true],
				[3, 'c.ts', true, true, true],
			]);
			const lines = buffers.lines();
			assert.strictEqual(lines[0], '  1      "a.ts"                         line 0');
			// b.ts was current in the window the new page's came after (Vim: the alternate file)
			assert.match(lines[1], /^ {2}2 [ #]a {3}"b\.ts" +line 0$/);
			assert.strictEqual(lines[2], '  3 %a   "c.ts"                         line 1');
			await parts.activeGroup.closeEditor(input('c.ts'));
			assert.deepStrictEqual(buffers.entries().map(b => [b.nr, b.listed]), [[1, true], [2, true], [3, false]]);
		} finally {
			console.log = log;
		}
	});
});
