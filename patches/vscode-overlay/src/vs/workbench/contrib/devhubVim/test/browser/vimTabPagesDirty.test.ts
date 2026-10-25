/*---------------------------------------------------------------------------------------------
 *  Copyright (c) DevHub contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// DevHub Vim: tab pages on VS Code's own editor parts (EditorParts, the
// working sets and EditorPart.applyState as they ship): a modified editor is
// never asked about and never closed by a switch.

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ConfirmResult } from '../../../../../platform/dialogs/common/dialogs.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../../common/editor.js';
import { GroupDirection, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IAuxiliaryWindowService } from '../../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { createEditorParts, registerTestEditor, TestFileEditorInput, TestServiceAccessor, workbenchInstantiationService, workbenchTeardown } from '../../../../test/browser/workbenchTestServices.js';
import { VimTabPages } from '../../browser/vimTabPages.js';

suite('DevHub Vim tab pages: modified editors on VS Code\'s editor parts', () => {

	const TEST_EDITOR_ID = 'devhubVimTabPagesTestEditor';
	const TEST_INPUT_ID = 'devhubVimTabPagesTestInput';
	const disposables = new DisposableStore();

	teardown(() => disposables.clear());

	test('switching away from a page with a modified editor asks nothing and keeps it open (in the page switched to)', async () => {
		disposables.add(registerTestEditor(TEST_EDITOR_ID, [new SyncDescriptor(TestFileEditorInput)], TEST_INPUT_ID));
		const instantiationService = workbenchInstantiationService(undefined, disposables);
		instantiationService.invokeFunction(accessor => Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor));
		// no auxiliary windows (the working sets ask for them)
		instantiationService.stub(IAuxiliaryWindowService, new class extends mock<IAuxiliaryWindowService>() { override getWindow() { return undefined; } });
		const parts = await createEditorParts(instantiationService, disposables);
		instantiationService.stub(IEditorGroupsService, parts);
		const accessor = instantiationService.createInstance(TestServiceAccessor);
		let asked = 0;
		accessor.fileDialogService.showSaveConfirm = async () => { asked++; return ConfirmResult.CANCEL; };

		const log = console.log;
		console.log = () => { };
		try {
			const pages = disposables.add(new VimTabPages(parts as IEditorGroupsService,
				new class extends mock<IEditorService>() { override onDidActiveEditorChange = Event.None; override onDidVisibleEditorsChange = Event.None; },
				disposables.add(new InMemoryStorageService()),
				new class extends mock<IWorkbenchLayoutService>() { override hasFocus() { return true; } },
				new class extends mock<IQuickInputService>() { }));

			const clean = disposables.add(new TestFileEditorInput(URI.file('/clean.txt'), TEST_INPUT_ID));
			const dirty = disposables.add(new TestFileEditorInput(URI.file('/dirty.txt'), TEST_INPUT_ID));
			const other = disposables.add(new TestFileEditorInput(URI.file('/other.txt'), TEST_INPUT_ID));
			await parts.activeGroup.openEditor(clean, { pinned: true });
			const right = parts.addGroup(parts.activeGroup, GroupDirection.RIGHT);
			await right.openEditor(dirty, { pinned: true });
			dirty.dirty = true;

			await pages.newPage();
			assert.strictEqual(asked, 0, 'no save confirmation');
			assert.strictEqual(dirty.isDisposed(), false);
			assert.ok(parts.groups.some(g => g.contains(dirty)), 'the modified editor went along into the new page');
			assert.ok(!parts.groups.some(g => g.contains(clean)), 'the saved one stayed in its page');
			await parts.activeGroup.openEditor(other, { pinned: true });
			// the tab line is above the groups, which get the rest of the part's 800 pixels (patches/vscode/0008-devhub-vim.patch)
			const part = parts.testMainPart;
			assert.ok(part.element.querySelector(':scope > .devhub-vim-tabline + .content'));
			assert.strictEqual((part.element.querySelector(':scope > .content') as HTMLElement).style.height, '778px');

			await pages.previous(null);
			assert.strictEqual(asked, 0);
			assert.strictEqual(parts.groups.length, 2, 'the first page\'s two windows are back');
			assert.ok(parts.groups[0].contains(clean));
			assert.ok(parts.groups[1].contains(dirty));
			assert.strictEqual(parts.groups.filter(g => g.contains(dirty)).length, 1, 'once');

			// closing the page with it: still asks nothing, still open
			await pages.close();
			assert.strictEqual(asked, 0);
			assert.strictEqual(part.element.querySelector('.devhub-vim-tabline'), null);
			assert.strictEqual((part.element.querySelector(':scope > .content') as HTMLElement).style.height, '800px');
			assert.ok(parts.groups.some(g => g.contains(dirty)));
			assert.ok(parts.groups.some(g => g.contains(other)));
			assert.strictEqual(dirty.isDirty(), true);
			dirty.dirty = false;
		} finally {
			console.log = log;
			await workbenchTeardown(instantiationService);
		}
	});
});
